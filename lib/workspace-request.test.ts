import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  fetch: vi.fn(),
  cleanups: [] as (() => void)[],
}));
// Isolate request sequencing from rendering. Real React mount/unmount and the
// Operations refresh/denial/retry flow are also exercised in browser QA.
vi.mock('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useCallback: (callback: unknown) => callback,
  useEffect: (setup: () => () => void) => fixture.cleanups.push(setup()),
}));
vi.mock('../components/aster/workspace-context', () => ({
  useWorkspace: () => ({
    state: {
      identity: {
        organizationId: 'synthetic-office',
        user: { id: 'synthetic-reviewer' },
        role: 'owner',
      },
    },
  }),
}));
import {
  useWorkspaceRequest,
  WorkspaceRequestError,
} from '../components/aster/use-workspace-request';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  fixture.fetch.mockReset();
  vi.stubGlobal('fetch', fixture.fetch);
  vi.stubGlobal('window', {
    location: { origin: 'https://synthetic.example.invalid' },
  });
});
afterEach(() => {
  fixture.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

describe('office-bound administrative request authorization', () => {
  it.each([401, 403])(
    'rejects an older success after a newer %i and permits an explicit retry',
    async (status) => {
      const first = deferred<Response>();
      fixture.fetch
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(new Response('{malformed', { status }))
        .mockResolvedValueOnce(Response.json({ result: 'fresh retry' }));
      const { request } = useWorkspaceRequest();
      const old = request('/api/operations').catch((error: unknown) => error);
      await expect(request('/api/operations')).rejects.toMatchObject({
        status,
      });
      const oldSignal = fixture.fetch.mock.calls[0][1].signal as AbortSignal;
      expect(oldSignal.aborted).toBe(true);
      expect(oldSignal.reason).toBeInstanceOf(WorkspaceRequestError);
      first.resolve(Response.json({ result: 'stale private response' }));
      expect(await old).toMatchObject({ status });
      await expect(request('/api/operations')).resolves.toEqual({
        result: 'fresh retry',
      });
    },
  );

  it('invalidates an older response whose headers arrived but whose JSON body is still pending', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const bodyRead = deferred<void>();
    fixture.fetch
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            },
            pull() {
              bodyRead.resolve();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 403 }));
    const { request } = useWorkspaceRequest();
    const old = request('/api/operations').catch((error: unknown) => error);
    await bodyRead.promise;
    await expect(request('/api/operations')).rejects.toMatchObject({
      status: 403,
    });
    body.enqueue(new TextEncoder().encode('{"result":"stale body"}'));
    body.close();
    expect(await old).toMatchObject({ status: 403 });
  });

  it('uses denial headers immediately without reading a stalled body', async () => {
    const cancelled = vi.fn();
    fixture.fetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel: cancelled,
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );
    const { request } = useWorkspaceRequest();
    const result = await Promise.race([
      request('/api/operations').catch((error: unknown) => error),
      new Promise((resolve) =>
        setTimeout(() => resolve('denial delayed by body'), 100),
      ),
    ]);
    expect(result).toMatchObject({ status: 403 });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('keeps the displayed office binding and refuses off-installation requests', async () => {
    fixture.fetch.mockResolvedValue(Response.json({ ok: true }));
    const { request } = useWorkspaceRequest();
    await request('/api/team', {
      headers: { 'x-aster-organization': 'foreign-office' },
    });
    const options = fixture.fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(options.headers).get('x-aster-organization')).toBe(
      'synthetic-office',
    );
    expect(options).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    await expect(
      request('https://elsewhere.invalid/api/team'),
    ).rejects.toMatchObject({ status: 400 });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });
});
