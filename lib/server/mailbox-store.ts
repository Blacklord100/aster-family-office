import 'server-only';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { withTenant } from './db';
import { AccessError, type WorkspaceContext } from './access';
import { authEnvironment } from './auth';
import { audit, rateLimit } from './audit';
import { decrypt, encrypt, sha256 } from './crypto';
import {
  MailboxConnectSchema,
  MailboxActionSchema,
  type MailProvider,
  type MailboxResponse,
  type MailboxInfo,
} from '../mailbox-contract';
import {
  exchangeTokens,
  oauthSettings,
  providerConfiguration,
  providerIdentity,
  MailboxError,
} from './mailbox-provider';

export async function listMailboxes(
  context: WorkspaceContext,
): Promise<MailboxResponse> {
  return withTenant(context.organizationId, async (client) => {
    const result = await client.query<MailboxInfo>(
      `SELECT m.id,m.provider,m.email,m.display_name AS "displayName",m.status,m.connected_by AS "connectedBy",m.imported_count AS "importedCount",m.skipped_count AS "skippedCount",m.last_synced_at AS "lastSyncedAt",m.error_code AS "errorCode",m.history_days AS "historyDays",q.available_at AS "nextSyncAt" FROM app_mailboxes m LEFT JOIN app_mailbox_queue q ON q.id=m.id WHERE m.organization_id=$1 ORDER BY m.created_at,m.id LIMIT 100`,
      [context.organizationId],
    );
    return {
      providers: [
        providerConfiguration('gmail'),
        providerConfiguration('microsoft'),
      ],
      mailboxes: result.rows.map((row) => ({
        ...row,
        historyDays: row.historyDays ?? 'all',
        currentUserCanManage:
          context.role !== 'viewer' &&
          (row.connectedBy === context.user.id ||
            ['owner', 'admin'].includes(context.role)),
      })),
    };
  });
}
export async function startMailboxAuthorization(
  context: WorkspaceContext,
  input: z.infer<typeof MailboxConnectSchema>,
) {
  const settings = oauthSettings(input.provider),
    state =
      context.organizationId + '.' + randomBytes(32).toString('base64url'),
    hash = sha256(state),
    verifier = randomBytes(32).toString('base64url');
  const callback =
    authEnvironment().origin + '/api/mailboxes/callback/' + input.provider;
  await withTenant(context.organizationId, async (client) => {
    if (
      !(await rateLimit(client, 'mailbox-oauth:' + context.user.id, 10, 3600))
    )
      throw new AccessError(
        429,
        'RATE_LIMIT',
        'Please wait before connecting another account.',
      );
    await client.query(
      'DELETE FROM app_mailbox_oauth_states WHERE organization_id=$1 AND (expires_at<now() OR user_id=$2)',
      [context.organizationId, context.user.id],
    );
    const payload = {
      verifier,
      historyDays: input.historyDays,
      clientId: settings.clientId,
      callback,
    };
    await client.query(
      'INSERT INTO app_mailbox_oauth_states(state_hash,organization_id,user_id,session_id,provider,payload) VALUES($1,$2,$3,$4,$5,$6)',
      [
        hash,
        context.organizationId,
        context.user.id,
        context.sessionId,
        input.provider,
        encrypt(
          JSON.stringify(payload),
          'mailbox-state:' + context.organizationId + ':' + hash,
        ),
      ],
    );
  });
  const url = new URL(settings.authorize);
  for (const [key, value] of Object.entries({
    client_id: settings.clientId,
    redirect_uri: callback,
    response_type: 'code',
    scope: settings.scopes.join(' '),
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...(input.provider === 'gmail'
      ? { access_type: 'offline', prompt: 'consent select_account' }
      : { response_mode: 'query', prompt: 'select_account' }),
  }))
    url.searchParams.set(key, value);
  return { authorizationUrl: url.toString() };
}
export async function finishMailboxAuthorization(
  context: WorkspaceContext,
  provider: MailProvider,
  state: string,
  code: string,
  fetcher: typeof fetch = fetch,
) {
  const hash = sha256(state),
    settings = oauthSettings(provider);
  const payload = await withTenant(context.organizationId, async (client) => {
    const result = await client.query<{ payload: Buffer }>(
      'DELETE FROM app_mailbox_oauth_states WHERE state_hash=$1 AND organization_id=$2 AND user_id=$3 AND session_id=$4 AND provider=$5 AND expires_at>now() RETURNING payload',
      [
        hash,
        context.organizationId,
        context.user.id,
        context.sessionId,
        provider,
      ],
    );
    if (!result.rows[0]) throw new MailboxError('INVALID_OAUTH_STATE');
    return z
      .object({
        verifier: z.string(),
        historyDays: MailboxConnectSchema.shape.historyDays,
        clientId: z.string(),
        callback: z.string(),
      })
      .parse(
        JSON.parse(
          decrypt(
            result.rows[0].payload,
            'mailbox-state:' + context.organizationId + ':' + hash,
          ).toString(),
        ),
      );
  });
  const callback =
    authEnvironment().origin + '/api/mailboxes/callback/' + provider;
  if (payload.clientId !== settings.clientId || payload.callback !== callback)
    throw new MailboxError('INVALID_OAUTH_STATE');
  const credentials = await exchangeTokens(
    provider,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback,
      code_verifier: payload.verifier,
    },
    undefined,
    fetcher,
  );
  const identity = await providerIdentity(
    provider,
    credentials.accessToken,
    fetcher,
  );
  return withTenant(context.organizationId, async (client) => {
    await client.query(
      'SELECT id FROM app_organizations WHERE id=$1 FOR UPDATE',
      [context.organizationId],
    );
    const session = await client.query(
      `SELECT 1 FROM auth_session s JOIN app_memberships m ON m.user_id=s."userId" WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now() AND s."mfaVerifiedAt" IS NOT NULL AND m.organization_id=$3 AND m.revoked_at IS NULL AND m.role IN ('owner','admin','analyst') FOR SHARE OF m`,
      [context.sessionId, context.user.id, context.organizationId],
    );
    if (!session.rowCount) throw new MailboxError('SESSION_EXPIRED');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      context.organizationId + ':' + provider + ':' + identity.id,
    ]);
    const existing = await client.query<{ id: string; connected_by: string }>(
      'SELECT id,connected_by FROM app_mailboxes WHERE organization_id=$1 AND provider=$2 AND provider_account_id=$3 FOR UPDATE',
      [context.organizationId, provider, identity.id],
    );
    const old = existing.rows[0];
    if (
      old &&
      old.connected_by !== context.user.id &&
      !['owner', 'admin'].includes(context.role)
    )
      throw new AccessError(
        403,
        'FORBIDDEN',
        'An administrator manages this existing connection.',
      );
    const count = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM app_mailboxes WHERE organization_id=$1',
      [context.organizationId],
    );
    if (!old && count.rows[0].count >= 100)
      throw new AccessError(
        409,
        'MAILBOX_LIMIT',
        'This workspace has reached its mailbox limit.',
      );
    const id = old?.id ?? randomUUID(),
      encrypted = encrypt(
        JSON.stringify(credentials),
        'mailbox-credentials:' + context.organizationId + ':' + id,
      );
    if (old)
      await client.query(
        "UPDATE app_mailboxes SET email=$2,display_name=$3,connected_by=$4,credentials=$5,cursor=null,history_days=$6,status='active',generation=generation+1,error_code=null,updated_at=now() WHERE id=$1",
        [
          id,
          identity.email,
          identity.name,
          context.user.id,
          encrypted,
          payload.historyDays === 'all' ? null : payload.historyDays,
        ],
      );
    else
      await client.query(
        'INSERT INTO app_mailboxes(id,organization_id,provider,provider_account_id,email,display_name,connected_by,credentials,history_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          id,
          context.organizationId,
          provider,
          identity.id,
          identity.email,
          identity.name,
          context.user.id,
          encrypted,
          payload.historyDays === 'all' ? null : payload.historyDays,
        ],
      );
    await client.query(
      'INSERT INTO app_mailbox_queue(id,organization_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET available_at=now(),lease_owner=null,lease_until=null,attempts=0',
      [id, context.organizationId],
    );
    await audit(
      client,
      context.organizationId,
      context.user.id,
      'mailbox.connected',
      id,
      { provider, historyDays: String(payload.historyDays) },
    );
    return { id };
  });
}
export async function updateMailbox(
  context: WorkspaceContext,
  id: string,
  action: z.infer<typeof MailboxActionSchema>['action'],
) {
  return withTenant(context.organizationId, async (client) => {
    const result = await client.query<{
      connected_by: string;
      status: string;
      credentials: Buffer | null;
    }>(
      'SELECT connected_by,status,credentials FROM app_mailboxes WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [id, context.organizationId],
    );
    const row = result.rows[0];
    if (!row) throw new AccessError(404, 'NOT_FOUND', 'Mailbox not found.');
    if (
      context.role === 'viewer' ||
      (row.connected_by !== context.user.id &&
        !['owner', 'admin'].includes(context.role))
    )
      throw new AccessError(
        403,
        'FORBIDDEN',
        'You cannot manage this connection.',
      );
    if (action === 'sync' || action === 'resume') {
      if (
        !row.credentials ||
        ['disconnected', 'reauth_required'].includes(row.status)
      )
        throw new AccessError(
          409,
          'RECONNECT_REQUIRED',
          'Reconnect this account to continue.',
        );
      if (action === 'sync' && row.status === 'paused')
        throw new AccessError(409, 'PAUSED', 'Resume this mailbox first.');
      if (!(await rateLimit(client, 'mailbox-sync:' + id, 30, 3600)))
        throw new AccessError(
          429,
          'RATE_LIMIT',
          'Please wait before requesting another synchronization.',
        );
      await client.query(
        "UPDATE app_mailboxes SET status='active',error_code=null,updated_at=now() WHERE id=$1",
        [id],
      );
      await client.query(
        'INSERT INTO app_mailbox_queue(id,organization_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET available_at=LEAST(app_mailbox_queue.available_at,now()),attempts=0',
        [id, context.organizationId],
      );
    } else {
      await client.query(
        "UPDATE app_mailboxes SET status=$2,generation=generation+1,credentials=CASE WHEN $2='disconnected' THEN null ELSE credentials END,cursor=CASE WHEN $2='disconnected' THEN null ELSE cursor END,error_code=null,updated_at=now() WHERE id=$1",
        [id, action === 'pause' ? 'paused' : 'disconnected'],
      );
      await client.query(
        'DELETE FROM app_mailbox_queue WHERE id=$1 AND organization_id=$2',
        [id, context.organizationId],
      );
    }
    await audit(
      client,
      context.organizationId,
      context.user.id,
      'mailbox.' + action,
      id,
    );
    return { updated: true };
  });
}
