import 'server-only';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { MailProvider } from '../mailbox-contract';
import { lifecycleContext } from './lifecycle-context';
import {
  CredentialsSchema,
  MailboxError,
  exchangeTokens,
  oauthSettings,
  providerConfiguration,
  providerIdentity,
} from './mailbox-provider';

const BROKER_URL = 'http://mailbox-worker:8010';
const EXCHANGE_PATH = '/oauth/exchange';
const REQUEST_LIMIT = 16384;
const RESPONSE_LIMIT = 65536;
const OPERATION_MS = 45000;
const RequestSchema = z
  .object({
    provider: z.enum(['gmail', 'microsoft']),
    code: z
      .string()
      .min(1)
      .max(8192)
      .refine(
        (value) =>
          !Array.from(value).some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      ),
    verifier: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
    callback: z.string().max(2048),
    expectedClientId: z.string().min(1).max(2048),
  })
  .strict();
type ExchangeRequest = z.infer<typeof RequestSchema>;
const ResultSchema = z
  .object({
    credentials: CredentialsSchema.strict(),
    identity: z
      .object({
        id: z.string().min(1).max(320),
        email: z.email().max(320),
        name: z.string().min(1).max(320),
      })
      .strict(),
  })
  .strict();

function tokenValue(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9_+/=-]{32,256}$/.test(value))
    throw new MailboxError('BROKER_NOT_CONFIGURED');
  return value;
}
function originValue(value: string | undefined) {
  if (!value) throw new MailboxError('BROKER_NOT_CONFIGURED');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new MailboxError('BROKER_NOT_CONFIGURED');
  return value;
}
export function mailboxOAuthTransport(): 'direct' | 'broker' {
  const mode = process.env.MAILBOX_OAUTH_TRANSPORT;
  if (mode === undefined) return 'direct';
  if (mode === 'disabled')
    throw new MailboxError('MAILBOX_CONNECTIONS_DISABLED');
  if (mode !== 'broker' || process.env.MAILBOX_BROKER_URL !== BROKER_URL)
    throw new MailboxError('BROKER_NOT_CONFIGURED');
  tokenValue(process.env.MAILBOX_BROKER_TOKEN);
  return 'broker';
}

export function mailboxConnectionConfiguration(provider: MailProvider) {
  const configuration = providerConfiguration(provider);
  try {
    mailboxOAuthTransport();
    return configuration;
  } catch {
    return {
      ...configuration,
      configured: false,
      missing: [
        ...configuration.missing,
        'Mailbox connections are disabled or unavailable in this installation; contact your administrator.',
      ],
    };
  }
}

/** Direct sockets deliberately ignore HTTP(S)_PROXY and Node's global fetch dispatcher.
 * Each operation supplies an exact URL allowlist; redirects are never followed. */
export function mailboxDirectFetch(
  allowed: readonly string[],
  signal: AbortSignal,
): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      !allowed.includes(url) ||
      !['GET', 'POST'].includes(init.method ?? 'GET')
    )
      throw new MailboxError('BROKER_DESTINATION_INVALID');
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      !['http:', 'https:'].includes(parsed.protocol)
    )
      throw new MailboxError('BROKER_DESTINATION_INVALID');
    const body =
      init.body instanceof URLSearchParams ? init.body.toString() : init.body;
    if (body !== undefined && body !== null && typeof body !== 'string')
      throw new MailboxError('BROKER_REQUEST_INVALID');
    if (body && Buffer.byteLength(body) > RESPONSE_LIMIT)
      throw new MailboxError('BROKER_REQUEST_INVALID');
    const abort = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    return new Promise<Response>((resolve, reject) => {
      const request = (
        parsed.protocol === 'https:' ? httpsRequest : httpRequest
      )(
        parsed,
        {
          method: init.method ?? 'GET',
          headers,
          agent: false,
          signal: abort,
        },
        (response) => {
          const status = response.statusCode ?? 502;
          if (
            status < 200 ||
            status > 599 ||
            (status >= 300 && status < 400) ||
            Number(response.headers['content-length'] ?? 0) > RESPONSE_LIMIT
          ) {
            response.destroy();
            reject(new MailboxError('BROKER_RESPONSE_INVALID'));
            return;
          }
          let length = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > RESPONSE_LIMIT)
              response.destroy(new MailboxError('BROKER_RESPONSE_INVALID'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () =>
            resolve(
              new Response(
                [204, 205].includes(status) ? null : Buffer.concat(chunks),
                {
                  status,
                  headers: {
                    'content-type':
                      response.headers['content-type'] ?? 'application/json',
                  },
                },
              ),
            ),
          );
        },
      );
      request.on('error', reject);
      request.end(body ?? undefined);
    });
  }) as typeof fetch;
}

function providerDestinations(provider: MailProvider) {
  return [
    oauthSettings(provider).token,
    provider === 'gmail'
      ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
      : 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName',
  ];
}
async function exchange(input: ExchangeRequest, fetcher: typeof fetch) {
  const credentials = await exchangeTokens(
    input.provider,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.callback,
      code_verifier: input.verifier,
    },
    undefined,
    fetcher,
  );
  const identity = await providerIdentity(
    input.provider,
    credentials.accessToken,
    fetcher,
  );
  return ResultSchema.parse({ credentials, identity });
}

/** Called only after the web callback consumed its session/provider-bound OAuth state. */
export async function completeMailboxAuthorization(
  input: ExchangeRequest,
  nativeFetcher: typeof fetch = fetch,
) {
  RequestSchema.parse(input);
  if (mailboxOAuthTransport() === 'direct')
    return exchange(input, nativeFetcher);
  const signal = AbortSignal.any([
    AbortSignal.timeout(OPERATION_MS),
    ...(lifecycleContext.getStore()?.signal
      ? [lifecycleContext.getStore()!.signal!]
      : []),
  ]);
  try {
    const response = await mailboxDirectFetch(
      [BROKER_URL + EXCHANGE_PATH],
      signal,
    )(BROKER_URL + EXCHANGE_PATH, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + tokenValue(process.env.MAILBOX_BROKER_TOKEN),
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new MailboxError('BROKER_UNAVAILABLE');
    return ResultSchema.parse(await response.json());
  } catch {
    // No provider fallback and no upstream payload/code/token in errors or logs.
    throw new MailboxError('BROKER_UNAVAILABLE');
  }
}

type Admission = (
  run: (signal: AbortSignal) => Promise<void>,
) => Promise<boolean>;
type BrokerOptions = {
  token: string;
  origin: string;
  admit: Admission;
  // Only synthetic tests inject a provider transport; production uses exact direct sockets.
  providerFetcher?: typeof fetch;
};
export function createMailboxBroker(options: BrokerOptions): {
  server: Server;
  close: () => Promise<void>;
} {
  const expected = Buffer.from('Bearer ' + tokenValue(options.token));
  const origin = originValue(options.origin);
  const active = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  let stopping = false;
  const server = createServer(
    {
      maxHeaderSize: 8192,
      requestTimeout: 10000,
      headersTimeout: 10000,
      keepAliveTimeout: 1000,
    },
    (request, response) => {
      const reply = (status: number, value: unknown) => {
        if (response.destroyed) return;
        response.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          connection: 'close',
        });
        response.end(JSON.stringify(value));
      };
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        reply(401, { error: 'UNAUTHORIZED' });
        return;
      }
      if (
        request.method !== 'POST' ||
        request.url !== EXCHANGE_PATH ||
        request.headers['content-type'] !== 'application/json'
      ) {
        reply(400, { error: 'INVALID_REQUEST' });
        return;
      }
      if (stopping || active.size >= 2) {
        reply(503, { error: 'UNAVAILABLE' });
        return;
      }
      const controller = new AbortController();
      active.add(controller);
      const timer = setTimeout(() => controller.abort(), OPERATION_MS);
      const abort = () => {
        controller.abort();
        request.destroy();
        response.destroy();
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      response.on('close', () => {
        if (!response.writableFinished) controller.abort();
      });
      const task = (async () => {
        try {
          if (Number(request.headers['content-length'] ?? 0) > REQUEST_LIMIT)
            throw new MailboxError('BROKER_REQUEST_INVALID');
          let size = 0;
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            size += chunk.length;
            if (size > REQUEST_LIMIT)
              throw new MailboxError('BROKER_REQUEST_INVALID');
            chunks.push(Buffer.from(chunk));
          }
          const input = RequestSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          );
          if (
            input.callback !==
              origin + '/api/mailboxes/callback/' + input.provider ||
            input.expectedClientId !== oauthSettings(input.provider).clientId
          )
            throw new MailboxError('BROKER_REQUEST_INVALID');
          let result: z.infer<typeof ResultSchema> | undefined;
          const allowed = await options.admit(async (lifecycleSignal) => {
            const signal = AbortSignal.any([
              controller.signal,
              lifecycleSignal,
            ]);
            signal.throwIfAborted();
            const fetcher =
              options.providerFetcher ??
              mailboxDirectFetch(providerDestinations(input.provider), signal);
            // The wrapper propagates lifecycle/disconnect cancellation even through provider timeouts.
            const boundFetch = ((url, init = {}) =>
              fetcher(url, {
                ...init,
                signal: init.signal
                  ? AbortSignal.any([signal, init.signal])
                  : signal,
              })) as typeof fetch;
            result = await exchange(input, boundFetch);
            signal.throwIfAborted();
          });
          if (!allowed || !result || controller.signal.aborted) {
            reply(503, { error: 'UNAVAILABLE' });
            return;
          }
          reply(200, result);
        } catch {
          reply(400, { error: 'EXCHANGE_REJECTED' });
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', abort);
          active.delete(controller);
        }
      })();
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
    },
  );
  server.maxConnections = 16;
  return {
    server,
    close: async () => {
      stopping = true;
      for (const controller of active) controller.abort();
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error &&
          (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')
            ? reject(error)
            : resolve(),
        ),
      );
      await Promise.allSettled(pending);
    },
  };
}

export async function startMailboxBroker(admit: Admission) {
  const port = process.env.MAILBOX_BROKER_LISTEN_PORT;
  if (
    !port &&
    !process.env.MAILBOX_BROKER_ORIGIN &&
    !process.env.MAILBOX_BROKER_TOKEN
  )
    return undefined;
  if (port !== '8010') throw new MailboxError('BROKER_NOT_CONFIGURED');
  const broker = createMailboxBroker({
    token: tokenValue(process.env.MAILBOX_BROKER_TOKEN),
    origin: originValue(process.env.MAILBOX_BROKER_ORIGIN),
    admit,
  });
  await new Promise<void>((resolve, reject) => {
    broker.server.once('error', reject);
    broker.server.listen(8010, '0.0.0.0', () => {
      broker.server.removeListener('error', reject);
      resolve();
    });
  });
  return broker;
}
