import 'server-only';
import { z } from 'zod';
import type { MailProvider } from '../mailbox-contract';
export const MAX_MAIL_BYTES = 10 * 1024 * 1024;
export const CredentialsSchema = z.object({
  accessToken: z.string().min(1).max(20000),
  refreshToken: z.string().min(1).max(20000),
  expiresAt: z.number(),
  scopes: z.array(z.string()).max(30),
});
export type MailCredentials = z.infer<typeof CredentialsSchema>;
export class MailboxError extends Error {
  constructor(
    public code: string,
    public retryAfter = 0,
  ) {
    super(code);
  }
}
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
export const MICROSOFT_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Read',
];
export function providerConfiguration(provider: MailProvider) {
  const keys =
    provider === 'gmail'
      ? ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
      : [
          'MICROSOFT_CLIENT_ID',
          'MICROSOFT_CLIENT_SECRET',
          'MICROSOFT_TENANT_ID',
        ];
  const missing = keys.filter(
    (key) =>
      !process.env[key] ||
      /^(TODO|REPLACE|CHANGE[_-]?ME)/i.test(process.env[key]!),
  );
  const tenant = process.env.MICROSOFT_TENANT_ID;
  if (
    provider === 'microsoft' &&
    tenant &&
    !/^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
      tenant,
    ) &&
    !missing.includes('MICROSOFT_TENANT_ID')
  )
    missing.push('MICROSOFT_TENANT_ID');
  return { id: provider, configured: missing.length === 0, missing };
}
export function oauthSettings(provider: MailProvider) {
  if (!providerConfiguration(provider).configured)
    throw new MailboxError('PROVIDER_NOT_CONFIGURED');
  return provider === 'gmail'
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        scopes: GOOGLE_SCOPES,
      }
    : {
        clientId: process.env.MICROSOFT_CLIENT_ID!,
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
        authorize: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize`,
        token: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
        scopes: MICROSOFT_SCOPES,
      };
}
export async function boundedResponse(
  response: Response,
  limit: number,
): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > limit) {
    await response.body?.cancel();
    throw new MailboxError('MESSAGE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new MailboxError('MESSAGE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function providerFetch(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(url, {
    ...init,
    redirect: 'error',
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const retrySeconds = retry
      ? /^\d+$/.test(retry)
        ? Number(retry)
        : Math.ceil((Date.parse(retry) - Date.now()) / 1000)
      : 0;
    await response.body?.cancel();
    throw new MailboxError(
      response.status === 401
        ? 'REAUTH_REQUIRED'
        : response.status === 403
          ? 'PROVIDER_FORBIDDEN'
          : response.status === 404 || response.status === 410
            ? 'PROVIDER_NOT_FOUND'
            : response.status === 429
              ? 'PROVIDER_RATE_LIMIT'
              : 'PROVIDER_UNAVAILABLE',
      Number.isFinite(retrySeconds)
        ? Math.min(86400, Math.max(0, retrySeconds))
        : 0,
    );
  }
  return response;
}
export async function exchangeTokens(
  provider: MailProvider,
  values: Record<string, string>,
  previous?: MailCredentials,
  fetcher: typeof fetch = fetch,
): Promise<MailCredentials> {
  const settings = oauthSettings(provider);
  const response = await fetcher(settings.token, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      ...values,
    }),
  });
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse((await boundedResponse(response, 65536)).toString());
  } catch {
    throw new MailboxError('TOKEN_RESPONSE_INVALID');
  }
  if (!response.ok)
    throw new MailboxError(
      payload.error === 'invalid_grant'
        ? 'REAUTH_REQUIRED'
        : 'TOKEN_EXCHANGE_FAILED',
    );
  const parsed = z
    .object({
      access_token: z.string().min(1).max(20000),
      refresh_token: z.string().min(1).max(20000).optional(),
      expires_in: z.number().int().min(30).max(86400),
      scope: z.string().max(3000).optional(),
      token_type: z.string(),
    })
    .safeParse(payload);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== 'bearer')
    throw new MailboxError('TOKEN_RESPONSE_INVALID');
  const scopes =
    parsed.data.scope?.split(/\s+/).filter(Boolean) ?? previous?.scopes;
  const normalize = (scope: string) =>
    scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase();
  const allowed =
    provider === 'gmail'
      ? GOOGLE_SCOPES.map(normalize)
      : [...MICROSOFT_SCOPES, 'openid', 'profile', 'email'].map(normalize);
  if (
    !scopes ||
    scopes.some((scope) => !allowed.includes(normalize(scope))) ||
    !(provider === 'gmail'
      ? scopes.includes(GOOGLE_SCOPES[0])
      : scopes.map(normalize).includes('mail.read') &&
        scopes.map(normalize).includes('user.read'))
  )
    throw new MailboxError('SCOPES_NOT_GRANTED');
  const refreshToken = parsed.data.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new MailboxError('OFFLINE_ACCESS_REQUIRED');
  return CredentialsSchema.parse({
    accessToken: parsed.data.access_token,
    refreshToken,
    expiresAt: Date.now() + parsed.data.expires_in * 1000,
    scopes,
  });
}
export async function providerIdentity(
  provider: MailProvider,
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const url =
    provider === 'gmail'
      ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
      : 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName';
  const response = await providerFetch(
    url,
    { headers: { Authorization: 'Bearer ' + token } },
    fetcher,
  );
  const raw = JSON.parse((await boundedResponse(response, 65536)).toString());
  if (provider === 'gmail') {
    const data = z.object({ emailAddress: z.email() }).parse(raw);
    return {
      id: data.emailAddress.toLowerCase(),
      email: data.emailAddress.toLowerCase(),
      name: data.emailAddress,
    };
  }
  const data = z
    .object({
      id: z.string().min(1).max(200),
      mail: z.email().nullable().optional(),
      userPrincipalName: z.string().max(300),
      displayName: z.string().max(200).nullable().optional(),
    })
    .parse(raw);
  const email = z
    .email()
    .parse(data.mail ?? data.userPrincipalName)
    .toLowerCase();
  return { id: data.id, email, name: data.displayName || email };
}
