import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  role: 'viewer',
  tenant: '00000000-0000-4000-8000-000000000001',
  writes: vi.fn(),
  query: vi.fn(),
  documentDecrypt: vi.fn(),
  listDocuments: vi.fn(),
  scoped: false,
}));
vi.mock('./crypto', () => ({ decrypt: f.documentDecrypt }));
vi.mock('./processing-list', () => ({ listProcessingJobs: f.listDocuments }));
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
    roleAllows: (role: string) => role === 'owner',
    requireWorkspace: async (_r: Request, permission: string) => {
      if (f.scoped)
        throw new AccessError(
          403,
          'SCOPED_ACCESS',
          'Selected family records only.',
        );
      if (permission === 'admin' && f.role !== 'owner')
        throw new AccessError(403, 'FORBIDDEN', 'Denied');
      return {
        organizationId: f.tenant,
        role: f.role,
        user: { id: 'fixture' },
      };
    },
    errorResponse: (e: AccessError) =>
      Response.json({ error: e.code }, { status: e.status ?? 500 }),
  };
});
vi.mock('./db', () => ({
  withTenant: async (tenant: string, fn: (c: unknown) => unknown) => {
    expect(tenant).toBe(f.tenant);
    return fn({ query: f.query });
  },
}));
vi.mock('./engine-store', () => ({
  listEngines: async () => [],
  activeEngine: async () => ({
    config: { apiKey: 'private-engine-secret' },
    snapshot: {
      provider: 'ollama',
      model: 'fixture',
      execution: 'local',
      profileId: null,
      revision: 0,
      name: 'Default',
    },
  }),
  cloudReadiness: () => ({
    cloudAllowed: false,
    cloudReadinessReason: 'disabled',
  }),
  saveEngine: f.writes,
  activateEngine: f.writes,
  deleteEngine: f.writes,
  loadEngineRevision: f.writes,
}));
vi.mock('./engine-processor', () => ({
  discoverModels: f.writes,
  testEngine: f.writes,
}));
vi.mock('./audit', () => ({ audit: f.writes, rateLimit: async () => true }));
import { GET, POST } from '../../app/api/engines/route';
import { PATCH, DELETE } from '../../app/api/engines/[id]/route';
import { POST as activate } from '../../app/api/engines/[id]/activate/route';
import { POST as test } from '../../app/api/engines/[id]/test/route';
import { POST as reset } from '../../app/api/engines/default/activate/route';
import { GET as discover } from '../../app/api/engines/models/route';
describe('engine HTTP permissions', () => {
  beforeEach(() => {
    f.role = 'viewer';
    f.writes.mockReset();
    f.query.mockReset();
    f.documentDecrypt.mockReset();
    f.listDocuments.mockReset();
    f.scoped = false;
    f.query.mockImplementation(async (sql: string, values: unknown[]) => {
      expect(sql).toBe(
        'SELECT processing_mode,policy_revision FROM app_organizations WHERE id=$1',
      );
      expect(values).toEqual([f.tenant]);
      return { rows: [{ processing_mode: 'agentic', policy_revision: 7 }] };
    });
    f.documentDecrypt.mockImplementation(() => {
      throw new Error('CORRUPT_DOCUMENT');
    });
    f.listDocuments.mockImplementation(() => {
      throw new Error('SOURCE_LIST_UNAVAILABLE');
    });
  });
  it('allows viewer metadata and denies every management, discovery or test endpoint before provider/SQL work', async () => {
    const response = await GET(new Request('http://localhost/api/engines'));
    expect(response.status).toBe(200);
    expect((await response.json()).canManage).toBe(false);
    const request = new Request('http://localhost/api/engines', {
        method: 'POST',
      }),
      context = { params: Promise.resolve({ id: f.tenant }) };
    for (const action of [
      () => POST(request),
      () => PATCH(request, context),
      () => DELETE(request, context),
      () => activate(request, context),
      () => test(request, context),
      () => reset(request),
      () => discover(request),
    ])
      expect((await action()).status).toBe(403);
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('returns the mode and active engine without loading or decrypting document results', async () => {
    f.role = 'owner';
    const response = await GET(new Request('http://localhost/api/engines'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.policy).toEqual({
      mode: 'agentic',
      revision: 7,
      execution: 'local',
      engine: body.active,
      externalFallback: false,
    });
    expect(body.canManage).toBe(true);
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.documentDecrypt).not.toHaveBeenCalled();
    expect(f.listDocuments).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(
      /private-engine-secret|apiKey|"jobs"|"result"/,
    );
  });
  it('keeps engine policy unavailable to scoped accounts before tenant SQL', async () => {
    f.scoped = true;
    const response = await GET(new Request('http://localhost/api/engines'));
    expect(response.status).toBe(403);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.documentDecrypt).not.toHaveBeenCalled();
  });
});

// These tests isolate route behavior; the real admission barrier is exercised
// against disposable PostgreSQL in lifecycle.integration.test.ts.
vi.mock('./lifecycle', () => ({
  lifecycleRoute: (handler: (...args: unknown[]) => unknown) => handler,
}));
