import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  role: 'viewer',
  tenant: '00000000-0000-4000-8000-000000000001',
  writes: vi.fn(),
  query: vi.fn(),
}));
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
});
