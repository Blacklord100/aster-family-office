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
import { projectPortfolioHistory } from '../portfolio-history';
import { emptyFinanceState } from '../ledger-contract';
const f = vi.hoisted(() => ({
  state: {} as WorkspaceState,
  revision: 0,
  saves: vi.fn(),
  audit: vi.fn(),
  tail: Promise.resolve(),
  role: 'analyst',
  scope: null as { familyIds: string[] } | null,
  historyRead: vi.fn(),
  historyAccess: vi.fn(),
  historyWorkspace: vi.fn(),
}));
vi.mock('./portfolio-history-store', () => ({
  readPortfolioHistory: f.historyRead,
  assertHistoryAccess: f.historyAccess,
  readHistoryWorkspace: f.historyWorkspace,
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
    f.historyRead.mockReset();
    f.historyAccess.mockReset();
    f.historyWorkspace
      .mockReset()
      .mockImplementation(async (_client, _org, locked) => {
        expect(locked).toBe(true);
        return { state: structuredClone(f.state), revision: f.revision };
      });
  });
  afterEach(() => vi.useRealTimers());
  it('preserves every source observation across pagination and later corrections', async () => {
    const portfolio = deriveWorkspace(f.state),
      holding = portfolio.holdings[0];
    f.state.sampleData = false;
    f.state.portfolio = {
      ...portfolio,
      holdings: [holding],
      evidence: [],
      history: [],
      events: [],
      tasks: [],
    };
    f.state.finance = emptyFinanceState();
    for (let index = 0; index < 155; index++) {
      const date = new Date(Date.UTC(2025, 0, index + 1))
          .toISOString()
          .slice(0, 10),
        sourceId = 'history-source-' + index;
      f.state.portfolio.evidence.push({
        id: sourceId,
        holdingId: holding.id,
        familyId: holding.familyId,
        mailboxId: 'manual',
        subject: 'Reviewed NAV',
        sender: 'Test manager',
        receivedAt: date + 'T12:00:00Z',
        effectiveDate: date,
        filename: 'nav-' + index + '.txt',
        page: 1,
        excerpt: 'NAV ' + (1000 + index),
        status: 'Accepted',
        synthetic: false,
      });
      f.state.finance.valuations.push({
        id: 'valuation-' + index,
        holdingId: holding.id,
        amount: String(1000 + index) + '.00',
        currency: 'EUR',
        valueEUR: 1000 + index,
        effectiveDate: date,
        sourceId,
        actorId: 'reviewer',
        recordedAt: date + 'T12:00:00Z',
        valuationMethod: 'Reported fund NAV',
      });
    }
    f.historyRead.mockImplementation(async (_ctx, query) =>
      projectPortfolioHistory(f.state.portfolio!, f.state.finance, query, {
        revision: f.revision,
        now: '2026-09-10T12:00:00Z',
      }),
    );
    const historyRequest: ReportingRequest = {
      action: 'saveHistory',
      expectedRevision: 0,
      idempotencyKey: '00000000-0000-4000-8000-000000000010',
      name: 'History preserved',
      query: {
        currency: 'EUR',
        knowledge: 'restated',
        cohort: 'current',
        includeSuperseded: false,
        limit: 20,
        offset: 0,
      },
    };
    const result = await saveReporting(ctx, historyRequest);
    const snapshot = result.snapshot!;
    if (snapshot.kind !== 'history') throw new Error('Wrong snapshot kind');
    expect(snapshot.inputs.observations).toHaveLength(155);
    expect(snapshot.result.observations).toHaveLength(20);
    expect(snapshot.result.summary.knownAmount).toBe('1154.00');
    expect(f.historyAccess).toHaveBeenCalledWith(expect.anything(), ctx, true);
    f.state.finance!.valuations.at(-1)!.valueEUR = 99999;
    f.state.finance!.valuations.at(-1)!.amount = '99999.00';
    const reopened = await readReporting(ctx, undefined, snapshot.id);
    expect(reopened.snapshot?.kind).toBe('history');
    expect(snapshotIntegrity(reopened.snapshot!)).toBe(true);
    expect(
      (reopened.snapshot as typeof snapshot).result.summary.knownAmount,
    ).toBe('1154.00');
    f.historyRead.mockRejectedValue(
      new Error('Live projection unavailable after save'),
    );
    const retried = await saveReporting(ctx, historyRequest);
    expect(retried.duplicate).toBe(true);
    expect(retried.resultId).toBe(snapshot.id);
    expect(f.saves).toHaveBeenCalledTimes(1);
    await expect(
      saveReporting(ctx, { ...historyRequest, name: 'Different intent' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
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
