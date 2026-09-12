import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
vi.mock('server-only', () => ({}));
import {
  completeMailboxAuthorization,
  createMailboxBroker,
  mailboxDirectFetch,
  mailboxOAuthTransport,
  mailboxConnectionConfiguration,
  startMailboxBroker,
} from './mailbox-broker';
import { lifecycleContext } from './lifecycle-context';

const TOKEN = 'synthetic_broker_token_12345678901234567890123456789';
const ORIGIN = 'https://aster.synthetic.invalid';
const input = {
  provider: 'gmail' as const,
  code: 'synthetic-code',
  verifier: 'v'.repeat(43),
  callback: ORIGIN + '/api/mailboxes/callback/gmail',
  expectedClientId: 'synthetic-client',
};
const cleanups: Array<() => Promise<void>> = [];
function providers(scope = 'https://www.googleapis.com/auth/gmail.readonly') {
  return vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if ((url instanceof Request ? url.url : String(url)).includes('/token'))
      return Response.json({
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope,
      });
    return Response.json({ emailAddress: 'mailbox@synthetic.invalid' });
  });
}
async function start(
  options: Partial<Parameters<typeof createMailboxBroker>[0]> = {},
) {
  const providerFetcher = options.providerFetcher ?? providers();
  const broker = createMailboxBroker({
    token: TOKEN,
    origin: ORIGIN,
    admit: async (run) => {
      await run(new AbortController().signal);
      return true;
    },
    ...options,
    providerFetcher,
  });
  await new Promise<void>((resolve) =>
    broker.server.listen(0, '127.0.0.1', resolve),
  );
  cleanups.push(broker.close);
  const url = `http://127.0.0.1:${(broker.server.address() as AddressInfo).port}/oauth/exchange`;
  const send = (body: unknown = input, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + TOKEN,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { ...broker, url, send, providerFetcher };
}
beforeEach(() => {
  vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-client-secret');
  vi.stubEnv('MAILBOX_OAUTH_TRANSPORT', undefined);
  vi.stubEnv('MAILBOX_BROKER_TOKEN', undefined);
  vi.stubEnv('MAILBOX_BROKER_LISTEN_PORT', undefined);
  vi.stubEnv('MAILBOX_BROKER_ORIGIN', undefined);
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.unstubAllEnvs();
});

describe('internal mailbox OAuth broker', () => {
  it('exchanges only an authorization code and resolves the provider identity inside one admitted operation', async () => {
    const events: string[] = [];
    const fetcher = providers();
    const broker = await start({
      providerFetcher: fetcher,
      admit: async (run) => {
        events.push('admit');
        await run(new AbortController().signal);
        events.push('finish');
        return true;
      },
    });
    const response = await broker.send();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json();
    expect(result.identity.email).toBe('mailbox@synthetic.invalid');
    expect(result.credentials.refreshToken).toBe('synthetic-refresh');
    expect(events).toEqual(['admit', 'finish']);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    ]);
    const form = fetcher.mock.calls[0][1]!.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({
      client_id: 'synthetic-client',
      client_secret: 'synthetic-client-secret',
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.callback,
      code_verifier: input.verifier,
    });
  });
  it('uses fixed Microsoft token and identity endpoints and read-only scopes', async () => {
    vi.stubEnv('MICROSOFT_CLIENT_ID', 'synthetic-ms');
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', 'synthetic-ms-secret');
    vi.stubEnv('MICROSOFT_TENANT_ID', 'organizations');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      (url instanceof Request ? url.url : String(url)).includes('/token')
        ? Response.json({
            access_token: 'synthetic-access',
            refresh_token: 'synthetic-refresh',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'offline_access User.Read Mail.Read',
          })
        : Response.json({
            id: 'synthetic-user',
            mail: 'mailbox@synthetic.invalid',
            userPrincipalName: 'mailbox@synthetic.invalid',
            displayName: 'Synthetic User',
          }),
    );
    const broker = await start({ providerFetcher: fetcher });
    expect(
      (
        await broker.send({
          ...input,
          provider: 'microsoft',
          expectedClientId: 'synthetic-ms',
          callback: ORIGIN + '/api/mailboxes/callback/microsoft',
        })
      ).status,
    ).toBe(200);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName',
    ]);
  });
  it.each(['', 'Bearer wrong', 'Bearer ' + TOKEN + 'extra'])(
    'rejects invalid authentication before lifecycle/provider access',
    async (authorization) => {
      const admit = vi.fn();
      const broker = await start({ admit });
      expect((await broker.send(input, { authorization })).status).toBe(401);
      expect(admit).not.toHaveBeenCalled();
      expect(broker.providerFetcher).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...input, provider: 'arbitrary' },
    { ...input, expectedClientId: 'different-registered-client' },
    {
      ...input,
      callback: 'https://other.invalid/api/mailboxes/callback/gmail',
    },
    { ...input, callback: input.callback + '?next=other' },
    { ...input, callback: ORIGIN + '/api/mailboxes/callback/microsoft' },
    { ...input, url: 'https://other.invalid' },
    { ...input, grant_type: 'refresh_token' },
    { ...input, verifier: 'short' },
    { ...input, code: 'line\nbreak' },
  ])(
    'rejects malformed authority or payload before admission %#',
    async (body) => {
      const admit = vi.fn();
      const broker = await start({ admit });
      expect((await broker.send(body)).status).toBe(400);
      expect(admit).not.toHaveBeenCalled();
      expect(broker.providerFetcher).not.toHaveBeenCalled();
    },
  );
  it('rejects oversized and wrong-route requests without provider calls, then still accepts a valid request', async () => {
    const broker = await start();
    expect(
      (await broker.send({ ...input, code: 'x'.repeat(20000) })).status,
    ).toBe(400);
    expect(
      (
        await fetch(broker.url + '?next=provider', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + TOKEN,
            'content-type': 'application/json',
          },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(400);
    expect(broker.providerFetcher).not.toHaveBeenCalled();
    expect((await broker.send()).status).toBe(200);
  });
  it('refuses widened provider scopes without exposing credentials or provider payloads', async () => {
    const broker = await start({
      providerFetcher: providers(
        'https://www.googleapis.com/auth/gmail.modify',
      ),
    });
    const response = await broker.send();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"error":"EXCHANGE_REJECTED"}');
    expect(broker.providerFetcher).toHaveBeenCalledTimes(1);
  });
  it('refuses drained lifecycle admission without an external request', async () => {
    const broker = await start({ admit: async () => false });
    expect((await broker.send()).status).toBe(503);
    expect(broker.providerFetcher).not.toHaveBeenCalled();
  });
  it('bounds concurrency and aborts pending provider calls during shutdown', async () => {
    let entered = 0;
    const signals: AbortSignal[] = [];
    const broker = await start({
      providerFetcher: vi.fn<typeof fetch>(async (_url, init) => {
        entered++;
        const signal = init!.signal!;
        signals.push(signal);
        return await new Promise<Response>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      }),
    });
    const first = broker.send().catch(() => null),
      second = broker.send().catch(() => null);
    await vi.waitFor(() => expect(entered).toBe(2));
    expect((await broker.send()).status).toBe(503);
    await broker.close();
    await Promise.all([first, second]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('propagates lifecycle cancellation and withholds any credential response', async () => {
    const lifecycle = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const broker = await start({
      admit: async (run) => {
        await run(lifecycle.signal);
        return true;
      },
      providerFetcher: vi.fn<typeof fetch>(async (_url, init) => {
        providerSignal = init!.signal!;
        return await new Promise<Response>((_resolve, reject) =>
          providerSignal!.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      }),
    });
    const pending = broker.send();
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    lifecycle.abort();
    const response = await pending;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('accessToken');
    expect(providerSignal!.aborted).toBe(true);
  });
  it('cancels provider work when the web client disconnects', async () => {
    let providerSignal: AbortSignal | undefined;
    const broker = await start({
      providerFetcher: vi.fn<typeof fetch>(async (_url, init) => {
        providerSignal = init!.signal!;
        return await new Promise<Response>((_resolve, reject) =>
          providerSignal!.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          ),
        );
      }),
    });
    const client = new AbortController();
    const pending = fetch(broker.url, {
      method: 'POST',
      signal: client.signal,
      headers: {
        authorization: 'Bearer ' + TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    }).catch(() => null);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    client.abort();
    await pending;
    await vi.waitFor(() => expect(providerSignal!.aborted).toBe(true));
  });
});

describe('broker transport configuration and direct sockets', () => {
  it('preserves explicit native transport and rejects disabled/unknown appliance modes', async () => {
    expect(mailboxOAuthTransport()).toBe('direct');
    const fetcher = providers();
    expect(
      (await completeMailboxAuthorization(input, fetcher)).identity.email,
    ).toBe('mailbox@synthetic.invalid');
    vi.stubEnv('MAILBOX_OAUTH_TRANSPORT', 'disabled');
    expect(mailboxConnectionConfiguration('gmail')).toMatchObject({
      configured: false,
      missing: [expect.stringContaining('contact your administrator')],
    });
    expect(() => mailboxOAuthTransport()).toThrow(
      'MAILBOX_CONNECTIONS_DISABLED',
    );
    vi.stubEnv('MAILBOX_OAUTH_TRANSPORT', 'direct');
    expect(() => mailboxOAuthTransport()).toThrow('BROKER_NOT_CONFIGURED');
  });
  it('fails closed for unavailable broker without invoking native provider transport', async () => {
    vi.stubEnv('MAILBOX_OAUTH_TRANSPORT', 'broker');
    vi.stubEnv('MAILBOX_BROKER_URL', 'http://mailbox-worker:8010');
    vi.stubEnv('MAILBOX_BROKER_TOKEN', TOKEN);
    const fetcher = providers();
    await expect(
      lifecycleContext.run(
        { mode: 'open', readOnly: false, signal: AbortSignal.abort() },
        () => completeMailboxAuthorization(input, fetcher),
      ),
    ).rejects.toThrow('BROKER_UNAVAILABLE');
    expect(fetcher).not.toHaveBeenCalled();
    vi.stubEnv('MAILBOX_BROKER_URL', 'http://other.invalid:8010');
    expect(() => mailboxOAuthTransport()).toThrow('BROKER_NOT_CONFIGURED');
  });
  it('keeps the listener disabled for native installs and refuses partial configuration', async () => {
    expect(await startMailboxBroker(async () => false)).toBeUndefined();
    vi.stubEnv('MAILBOX_BROKER_LISTEN_PORT', '8011');
    await expect(startMailboxBroker(async () => false)).rejects.toThrow(
      'BROKER_NOT_CONFIGURED',
    );
    expect(() =>
      createMailboxBroker({
        token: TOKEN,
        origin: ORIGIN + '/',
        admit: async () => false,
      }),
    ).toThrow('BROKER_NOT_CONFIGURED');
  });
  it('ignores proxy environment, refuses redirects/oversized responses and prevents arbitrary destinations', async () => {
    let proxyCalls = 0,
      targetCalls = 0;
    const proxy = createServer((_request, response) => {
      proxyCalls++;
      response.end('unexpected');
    });
    const target = createServer((request, response) => {
      targetCalls++;
      if (request.url === '/redirect') {
        response.writeHead(302, { location: 'http://other.invalid' });
        response.end();
      } else if (request.url === '/large') response.end('x'.repeat(70000));
      else response.end('{"ok":true}');
    });
    await Promise.all(
      [proxy, target].map(
        (server) =>
          new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
          ),
      ),
    );
    cleanups.push(
      ...[proxy, target].map(
        (server) => () =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    const proxyURL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const url = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    for (const name of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
    ])
      vi.stubEnv(name, proxyURL);
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    const transport = mailboxDirectFetch(
      [url + '/', url + '/redirect', url + '/large'],
      AbortSignal.timeout(3000),
    );
    expect(await (await transport(url + '/')).json()).toEqual({ ok: true });
    await expect(transport(url + '/redirect')).rejects.toThrow(
      'BROKER_RESPONSE_INVALID',
    );
    await expect(transport(url + '/large')).rejects.toThrow();
    await expect(transport('http://other.invalid')).rejects.toThrow(
      'BROKER_DESTINATION_INVALID',
    );
    expect(proxyCalls).toBe(0);
    expect(targetCalls).toBe(3);
  });
});
