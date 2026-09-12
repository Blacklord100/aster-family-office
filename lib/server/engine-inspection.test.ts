import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  role: 'owner',
  tenant: '00000000-0000-4000-8000-000000000001',
  profile: '00000000-0000-4000-8000-000000000002',
  query: vi.fn(),
  active: vi.fn(),
  load: vi.fn(),
  fetch: vi.fn(),
  inTransaction: false,
  limited: false,
}));
vi.mock('server-only', () => ({}));
vi.mock('./access', () => {
  class AccessError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessError,
    requireWorkspace: async (_request: Request, permission: string) => {
      expect(permission).toBe('admin');
      if (f.role !== 'owner') throw new AccessError(403, 'FORBIDDEN', 'Denied');
      return { organizationId: f.tenant };
    },
    errorResponse: (error: AccessError) =>
      Response.json({ code: error.code }, { status: error.status ?? 500 }),
  };
});
vi.mock('./db', () => ({
  withTenant: async (
    tenant: string,
    action: (client: unknown) => Promise<unknown>,
  ) => {
    expect(tenant).toBe(f.tenant);
    f.inTransaction = true;
    try {
      return await action({ query: f.query });
    } finally {
      f.inTransaction = false;
    }
  },
}));
vi.mock('./engine-store', () => ({
  activeEngine: f.active,
  loadEngineRevision: f.load,
  executionFor: (provider: string) =>
    provider === 'ollama' ? 'local' : 'cloud',
  assertEngineEnabled: vi.fn(),
  processorEndpoint: () => 'http://127.0.0.1:8000',
}));
vi.mock('./audit', () => ({ rateLimit: async () => !f.limited }));
import { POST } from '../../app/api/engines/inspect/route';
import { processorControl } from './engine-processor';
import { EngineInfoSchema } from '../engine-inspection';
const config = {
  name: 'Fixture',
  provider: 'ollama' as const,
  model: 'gemma4:fixture',
};
const selected = (profileId: string | null = f.profile, revision = 2) => ({
  config,
  snapshot: { ...config, execution: 'local', profileId, revision },
});
const info = () =>
  EngineInfoSchema.parse({
    provider: config.provider,
    model: config.model,
    execution: 'local',
    checkedAt: '2026-09-09T12:00:00Z',
    vision: {
      advertised: 'supported',
      effective: 'enabled',
      basis: 'local_metadata',
      imageTested: false,
    },
    observedDigest: null,
    digestPinned: false,
    generationPerformed: false,
    autoDownload: false,
    limits: {
      maxFileBytes: 10485760,
      maxPages: 40,
      maxTextCharacters: 120000,
      ocrEnabled: true,
      maxOcrPages: 4,
      maxNestedEmailDepth: 3,
      maxEmailParts: 32,
      maxEmailAttachments: 8,
      visualPagesEnabled: true,
      maxVisualPages: 6,
      maxVisualBytes: 8388608,
      maxAgentSteps: 32,
      maxModelCalls: 64,
      maxPageExtractions: 2,
      decodeTimeoutSeconds: 75,
      documentTimeoutSeconds: 590,
      contextTokens: 16384,
      outputTokens: 3200,
      maxPromptBytes: 11500,
    },
  });
const request = (body: unknown, signal?: AbortSignal) =>
  new Request('http://localhost/api/engines/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
describe('metadata inspection route and internal transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.role = 'owner';
    f.limited = false;
    f.inTransaction = false;
    f.query.mockResolvedValue({ rows: [{ current_revision: 2 }] });
    f.load.mockResolvedValue(selected());
    f.active.mockResolvedValue(selected());
    f.fetch.mockImplementation(async (_url, init) => {
      expect(f.inTransaction).toBe(false);
      expect(init.redirect).toBe('error');
      return Response.json(info());
    });
    vi.stubGlobal('fetch', f.fetch);
    vi.stubEnv('PROCESSOR_TOKEN', 'synthetic-processor-inspection-auth-token');
  });
  it('denies non-admin before body, database or metadata access', async () => {
    f.role = 'viewer';
    expect((await POST(request({}))).status).toBe(403);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { target: 'profile', profileId: null, revision: 0 },
    {
      target: 'active',
      profileId: null,
      revision: 0,
      endpoint: 'http://remote.invalid',
    },
    { target: 'profile', profileId: 'invalid', revision: 2 },
  ])(
    'rejects arbitrary or invalid selectors before database work',
    async (body) => {
      expect((await POST(request(body))).status).toBe(400);
      expect(f.query).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it('bounds request body before database or metadata work', async () => {
    expect((await POST(request({ extra: 'x'.repeat(65537) }))).status).toBe(
      413,
    );
    expect(f.query).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('reads the exact current profile in its tenant and releases DB before HTTP', async () => {
    const response = await POST(
      request({ target: 'profile', profileId: f.profile, revision: 2 }),
    );
    expect(response.status).toBe(200);
    expect(f.query).toHaveBeenCalledWith(
      expect.stringContaining('organization_id=$2'),
      [f.profile, f.tenant],
    );
    expect(f.load).toHaveBeenCalledWith(
      expect.anything(),
      f.tenant,
      f.profile,
      2,
    );
    expect(f.fetch.mock.calls[0][0].pathname).toBe('/v1/engine-info');
    expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual(config);
    const result = await response.json();
    expect(result).toMatchObject({
      target: 'profile',
      profileId: f.profile,
      revision: 2,
      model: config.model,
    });
    expect(JSON.stringify(result)).not.toContain(
      'synthetic-processor-inspection-auth-token',
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each([1, 3])(
    'rejects stale or invented profile revision %i before HTTP',
    async (revision) => {
      expect(
        (
          await POST(
            request({ target: 'profile', profileId: f.profile, revision }),
          )
        ).status,
      ).toBe(409);
      expect(f.load).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it('rejects absent/deleted/cross-tenant profile before HTTP', async () => {
    f.query.mockResolvedValue({ rows: [] });
    expect(
      (
        await POST(
          request({ target: 'profile', profileId: f.profile, revision: 2 }),
        )
      ).status,
    ).toBe(404);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('allows the actual selected older saved revision without substitution', async () => {
    f.active.mockResolvedValue(selected(f.profile, 1));
    const response = await POST(
      request({ target: 'active', profileId: f.profile, revision: 1 }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).revision).toBe(1);
    expect(f.active).toHaveBeenCalledWith(expect.anything(), f.tenant);
    expect(f.load).not.toHaveBeenCalled();
  });
  it('rejects an active selector changed by another administrator', async () => {
    expect(
      (
        await POST(
          request({ target: 'active', profileId: f.profile, revision: 1 }),
        )
      ).status,
    ).toBe(409);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('checks the actual deployment default, never bypassing an active saved profile', async () => {
    expect(
      (await POST(request({ target: 'active', profileId: null, revision: 0 })))
        .status,
    ).toBe(409);
    f.active.mockResolvedValue(selected(null, 0));
    expect(
      (await POST(request({ target: 'active', profileId: null, revision: 0 })))
        .status,
    ).toBe(200);
  });
  it('rate limits metadata requests before engine lookup or HTTP', async () => {
    f.limited = true;
    expect(
      (
        await POST(
          request({ target: 'profile', profileId: f.profile, revision: 2 }),
        )
      ).status,
    ).toBe(429);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('rejects a processor response for a different model', async () => {
    f.fetch.mockResolvedValue(
      Response.json({ ...info(), model: 'another-model' }),
    );
    expect(
      (
        await POST(
          request({ target: 'profile', profileId: f.profile, revision: 2 }),
        )
      ).status,
    ).toBe(502);
  });
  it('propagates browser abort to processor metadata fetch', async () => {
    const controller = new AbortController();
    f.fetch.mockImplementation(async (_url, init) => {
      expect(init.signal.aborted).toBe(false);
      controller.abort();
      expect(init.signal.aborted).toBe(true);
      throw new DOMException('Aborted', 'AbortError');
    });
    expect(
      (
        await POST(
          request(
            { target: 'profile', profileId: f.profile, revision: 2 },
            controller.signal,
          ),
        )
      ).status,
    ).toBe(502);
  });
  it('bounds processor metadata response and never exposes its body', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('private metadata ' + 'x'.repeat(131072)),
      );
    await expect(
      processorControl('/v1/engine-info', config, fetcher),
    ).rejects.toThrow('too large');
  });
});

// Admission and writer fencing are exercised in lifecycle.integration.test.ts.
vi.mock('./lifecycle', async (original) => ({
  ...(await original<typeof import('./lifecycle')>()),
  lifecycleRoute: (handler: (...args: unknown[]) => unknown) => handler,
}));
