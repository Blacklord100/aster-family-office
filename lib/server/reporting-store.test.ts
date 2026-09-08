import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  initialWorkspace,
  deriveWorkspace,
  type WorkspaceState,
} from '../workspace';
import { scopeWorkspace } from '../data-scope';
import type { WorkspaceContext } from './access';
import type { ReportingRequest } from '../reporting-contract';
import { RISK_PRESETS } from '../risk-engine';
const f = vi.hoisted(() => ({
  state: {} as WorkspaceState,
  revision: 0,
  saves: vi.fn(),
  audit: vi.fn(),
  tail: Promise.resolve(),
  role: 'analyst',
  scope: null as { familyIds: string[] } | null,
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
    roleAllows: (role: string, permission: string) =>
      permission === 'read' || ['owner', 'admin', 'analyst'].includes(role),
    requireWorkspace: async (_r: Request, permission: string) => {
      if (permission === 'write' && (f.role === 'viewer' || f.scope))
        throw new AccessError(403, 'FORBIDDEN', 'Read only');
      return {
        organizationId: 'tenant',
        user: { id: 'reviewer', email: '', name: '' },
        sessionId: 'session',
        role: f.role,
        scope: f.scope,
      };
    },
    errorResponse: (e: AccessError) =>
      Response.json({ error: e.code }, { status: e.status ?? 500 }),
  };
});
vi.mock('./db', () => ({
  withTenant: async (
    org: string,
    run: (client: { organizationId: string }) => Promise<unknown>,
  ) => {
    expect(org).toBe('tenant');
    const previous = f.tail;
    let release!: () => void;
    f.tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run({ organizationId: org });
    } finally {
      release();
    }
  },
}));
vi.mock('../workspace-store', () => ({
  readWorkspace: async (ctx: WorkspaceContext) => ({
    state: scopeWorkspace(structuredClone(f.state), ctx.scope),
    revision: f.revision,
  }),
  readWorkspaceInTransaction: async (
    client: { organizationId: string },
    org: string,
    lock: boolean,
  ) => {
    expect(client.organizationId).toBe(org);
    expect(lock).toBe(true);
    return { state: structuredClone(f.state), revision: f.revision };
  },
  saveWorkspace: async (
    _client: unknown,
    org: string,
    state: WorkspaceState,
  ) => {
    expect(org).toBe('tenant');
    f.saves(state);
    f.state = structuredClone(state);
    f.revision += 1;
  },
}));
vi.mock('./audit', () => ({ audit: f.audit }));
import {
  readReporting,
  saveReporting,
  snapshotIntegrity,
} from './reporting-store';
import { GET, POST } from '../../app/api/reporting/route';
const ctx: WorkspaceContext = {
  organizationId: 'tenant',
  user: { id: 'reviewer', email: '', name: '' },
  sessionId: 'session',
  role: 'analyst',
};
const request = (
  key = '00000000-0000-4000-8000-000000000001',
): ReportingRequest => ({
  action: 'saveStress',
  expectedRevision: 0,
  idempotencyKey: key,
  name: 'Pinned hypothetical run',
  scope: { familyIds: [deriveWorkspace(f.state).families[0].id] },
  scenario: RISK_PRESETS[0],
});
describe('immutable reporting snapshots', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    f.state = initialWorkspace(true);
    f.revision = 0;
    f.saves.mockReset();
    f.audit.mockReset();
    f.role = 'analyst';
    f.scope = null;
    f.tail = Promise.resolve();
  });
  afterEach(() => vi.useRealTimers());
  it('pins selected holdings, current mapping, scenario, inputs and results independently of later workspace edits', async () => {
    const saved = await saveReporting(ctx, request()),
      snapshot = saved.snapshot!;
    expect(snapshot.kind).toBe('stress');
    expect(snapshotIntegrity(snapshot)).toBe(true);
    expect(snapshot.workspaceRevision).toBe(0);
    expect(f.audit.mock.calls[0].slice(1, 4)).toEqual([
      'tenant',
      'reviewer',
      'reporting.stress',
    ]);
    if (snapshot.kind !== 'stress') throw new Error('Wrong snapshot');
    const before = snapshot.result.stress.beforeEUR,
      original = snapshot.inputs.holdings[0].valueEUR;
    f.state.portfolio = {
      ...deriveWorkspace(f.state),
      holdings: deriveWorkspace(f.state).holdings.map((h) => ({
        ...h,
        valueEUR: h.valueEUR + 1000,
      })),
    };
    const read = await readReporting(ctx, undefined, snapshot.id);
    expect(
      read.snapshot?.kind === 'stress' &&
        read.snapshot.inputs.holdings[0].valueEUR,
    ).toBe(original);
    expect(
      read.snapshot?.kind === 'stress' && read.snapshot.result.stress.beforeEUR,
    ).toBe(before);
    expect(read.snapshot?.inputDigest).toBe(snapshot.inputDigest);
  });
  it('does not duplicate concurrent exact retries and rejects reused keys with changed scenario instructions', async () => {
    const [a, b] = await Promise.all([
      saveReporting(ctx, request()),
      saveReporting(ctx, request()),
    ]);
    expect(a.resultId).toBe(b.resultId);
    expect(b.duplicate).toBe(true);
    expect(f.saves).toHaveBeenCalledTimes(1);
    await expect(
      saveReporting(ctx, { ...request(), name: 'Changed run' }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('rejects concurrent stale revisions and verifies stored input/result integrity on read', async () => {
    const results = await Promise.allSettled([
      saveReporting(ctx, request()),
      saveReporting(ctx, request('00000000-0000-4000-8000-000000000002')),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(f.saves).toHaveBeenCalledTimes(1);
    const snapshot = f.state.reporting!.snapshots[0];
    snapshot.name = 'Display metadata may change outside API';
    if (snapshot.kind === 'stress') snapshot.result.stress.afterEUR += 1;
    expect(snapshotIntegrity(snapshot)).toBe(false);
    await expect(
      readReporting(ctx, undefined, snapshot.id),
    ).rejects.toMatchObject({ status: 409, code: 'SNAPSHOT_CHANGED' });
  });
  it('saves an incomplete period with explicit unavailable returns and includes reproducible inputs', async () => {
    const scope = request();
    if (scope.action !== 'saveStress') throw new Error('Wrong request');
    const result = await saveReporting(ctx, {
      action: 'savePeriod',
      expectedRevision: 0,
      idempotencyKey: scope.idempotencyKey,
      name: 'Source gaps to resolve',
      query: {
        ...scope.scope,
        from: '2026-01-01',
        to: '2026-06-30',
        liquidityAsOf: '2026-09-10',
        liquidityThrough: '2026-12-31',
      },
    });
    expect(result.snapshot?.kind).toBe('period');
    if (result.snapshot?.kind === 'period') {
      expect(result.snapshot.result.returnEstimate.valuePercent).toBeNull();
      expect(result.snapshot.result.netExternalFlowEUR).toBeNull();
      expect(result.snapshot.inputs.finance.receipts).toEqual([]);
      expect(snapshotIntegrity(result.snapshot)).toBe(true);
    }
  });
  it('denies viewer and scoped writes and does not expose full saved snapshots to scoped readers', async () => {
    const saved = await saveReporting(ctx, request());
    await expect(
      saveReporting({ ...ctx, role: 'viewer' }, request()),
    ).rejects.toMatchObject({ status: 403 });
    const scoped = {
      ...ctx,
      role: 'viewer' as const,
      scope: { familyIds: [deriveWorkspace(f.state).families[0].id] },
    };
    expect((await readReporting(scoped)).snapshots).toEqual([]);
    await expect(
      readReporting(scoped, undefined, saved.resultId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      saveReporting({ ...ctx, scope: scoped.scope }, request()),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('validates HTTP query syntax and delegates write permission before saving', async () => {
    expect(
      (await GET(new Request('http://localhost/api/reporting?query=invalid')))
        .status,
    ).toBe(400);
    f.role = 'viewer';
    const response = await POST(
      new Request('http://localhost/api/reporting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request()),
      }),
    );
    expect(response.status).toBe(403);
    expect(f.saves).not.toHaveBeenCalled();
  });
});
