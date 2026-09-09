import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveWorkspace,
  initialWorkspace,
  type WorkspaceState,
} from '../workspace';
import type { WorkspaceContext } from './access';
import type { ReportObligationsRequest } from '../report-obligations-api';
import type { ObligationSources } from './report-obligations-sources';
const f = vi.hoisted(() => ({
  state: {} as WorkspaceState,
  revision: 0,
  role: 'owner',
  scope: null as unknown,
  session: true,
  opened: false,
  saves: vi.fn(),
  audit: vi.fn(),
  wake: vi.fn(),
  ensure: vi.fn(),
  tail: Promise.resolve(),
  sources: { documents: [], total: 0, truncated: false } as ObligationSources,
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
      permission === 'read'
        ? ['owner', 'admin', 'analyst', 'viewer'].includes(role)
        : permission === 'admin'
          ? ['owner', 'admin'].includes(role)
          : ['owner', 'admin', 'analyst'].includes(role),
  };
});
vi.mock('./db', () => ({
  withTenant: async (
    org: string,
    run: (client: unknown) => Promise<unknown>,
  ) => {
    expect(org).toBe('tenant');
    const prior = f.tail;
    let release!: () => void;
    f.tail = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await run({
        query: async (sql: string) => {
          if (sql.includes('JOIN auth_session'))
            return {
              rows: f.session ? [{ role: f.role, data_scope: f.scope }] : [],
            };
          if (sql.includes('JOIN auth_user'))
            return {
              rows: [
                { userId: 'owner', name: 'Owner', role: 'owner' },
                { userId: 'analyst', name: 'Analyst', role: 'analyst' },
              ],
            };
          if (sql.includes('FROM app_audit'))
            return { rows: f.opened ? [{}] : [] };
          if (sql.includes('FROM app_report_obligations_queue'))
            return { rows: [] };
          if (sql.includes('SELECT id,document_id FROM app_jobs'))
            return { rows: [] };
          throw new Error('Unexpected test SQL: ' + sql);
        },
      });
    } finally {
      release();
    }
  },
}));
vi.mock('../workspace-store', () => ({
  readWorkspaceInTransaction: async (
    _client: unknown,
    _org: string,
    lock: boolean,
  ) => {
    expect(lock).toBe(true);
    return { state: structuredClone(f.state), revision: f.revision };
  },
  saveWorkspace: async (
    _client: unknown,
    _org: string,
    state: WorkspaceState,
  ) => {
    f.state = structuredClone(state);
    f.revision++;
    f.saves();
  },
}));
vi.mock('./audit', () => ({ audit: f.audit }));
vi.mock('./data-scope', () => ({ releasedDocumentIds: async () => new Set() }));
vi.mock('./report-obligations-queue', () => ({
  ensureReportObligations: f.ensure,
  scheduleReportObligations: f.wake,
}));
vi.mock('./report-obligations-sources', async (original) => ({
  ...(await original<typeof import('./report-obligations-sources')>()),
  readObligationSources: async () => f.sources,
  sourceExceptionSignals: () => [],
  staleReportSignals: () => [],
}));
import {
  readReportObligations,
  reconcileReportObligations,
  saveReportObligations,
} from './report-obligations-store';
const ctx: WorkspaceContext = {
  organizationId: 'tenant',
  user: { id: 'owner', name: 'Owner', email: '' },
  sessionId: 'session',
  role: 'owner',
};
function create(): Extract<
  ReportObligationsRequest,
  { action: 'createSchedule' }
> {
  const holding = deriveWorkspace(f.state).holdings[0];
  return {
    action: 'createSchedule',
    expectedRevision: f.revision,
    idempotencyKey: randomUUID(),
    reason: 'Agreed quarterly reporting coverage',
    input: {
      name: 'Quarterly NAV',
      holdingIds: [holding.id],
      familyIds: ['forged-family'],
      managerId: null,
      reportType: 'nav_statement',
      cadence: 'quarterly',
      firstPeriodStart: '2026-04-01',
      oneOffPeriodEnd: null,
      timezone: 'Europe/Helsinki',
      dueDaysAfterPeriodEnd: 10,
      dueLocalTime: '17:00',
      graceHours: 24,
      ownerUserId: 'owner',
      staleAfterDays: null,
    },
  };
}
describe('reporting storage authorization and atomic commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
    f.state = initialWorkspace(true);
    f.revision = 0;
    f.role = 'owner';
    f.scope = null;
    f.session = true;
    f.opened = false;
    f.tail = Promise.resolve();
    f.sources = { documents: [], total: 0, truncated: false };
    for (const fn of [f.saves, f.audit, f.ensure, f.wake]) fn.mockReset();
  });
  afterEach(() => vi.useRealTimers());
  it('derives family scope from registered holdings and records creation reason', async () => {
    const input = create(),
      saved = await saveReportObligations(ctx, input);
    expect(saved.state.schedules[0].versions[0].definition.familyIds).toEqual([
      deriveWorkspace(f.state).holdings[0].familyId,
    ]);
    expect(saved.state.schedules[0].history[0].reason).toBe(input.reason);
    expect(saved.state.occurrences).toHaveLength(2);
    expect(
      saved.state.exceptions.filter((row) => row.sourceActive),
    ).toHaveLength(1);
    expect(saved.state.exceptions[0].assigneeUserId).toBe('owner');
  });
  it('serializes exact retries and checks idempotency before stale revision', async () => {
    const input = create(),
      [first, second] = await Promise.all([
        saveReportObligations(ctx, input),
        saveReportObligations(ctx, input),
      ]);
    expect(second.resultId).toBe(first.resultId);
    expect(second.duplicate).toBe(true);
    expect(f.saves).toHaveBeenCalledTimes(1);
    await expect(
      saveReportObligations(ctx, {
        ...input,
        reason: 'Different action under this key',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('rejects distinct concurrent stale edits without silent overwrite', async () => {
    const input = create(),
      other = {
        ...create(),
        input: { ...input.input, name: 'Conflicting editor' },
      };
    const results = await Promise.allSettled([
      saveReportObligations(ctx, input),
      saveReportObligations(ctx, other),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((row) => row.status === 'rejected')).toMatchObject({
      reason: { code: 'REPORT_OBLIGATIONS_CHANGED' },
    });
    expect(f.state.obligations?.schedules).toHaveLength(1);
  });
  it('does not write on repeated reads or unchanged background evaluation', async () => {
    await saveReportObligations(ctx, create());
    f.saves.mockClear();
    await readReportObligations(ctx);
    await readReportObligations(ctx);
    expect(await reconcileReportObligations('tenant')).toEqual({
      changed: false,
    });
    expect(f.saves).not.toHaveBeenCalled();
    expect(f.ensure).toHaveBeenCalledTimes(2);
  });
  it('catches up missed periods after restart and preserves assignment and waiver history', async () => {
    const saved = await saveReportObligations(ctx, create()),
      issue = saved.state.exceptions[0];
    await saveReportObligations(ctx, {
      action: 'exception',
      expectedRevision: f.revision,
      idempotencyKey: randomUUID(),
      exceptionId: issue.id,
      operation: {
        action: 'assign',
        assigneeUserId: 'analyst',
        reason: 'Analyst owns the follow-up',
      },
    });
    await saveReportObligations(ctx, {
      action: 'exception',
      expectedRevision: f.revision,
      idempotencyKey: randomUUID(),
      exceptionId: issue.id,
      operation: {
        action: 'waive',
        reason: 'Reviewed temporary reporting waiver',
        evidence: [{ kind: 'holding', id: issue.holdingIds[0] }],
      },
    });
    vi.setSystemTime(new Date('2027-02-01T12:00:00Z'));
    expect(await reconcileReportObligations('tenant')).toEqual({
      changed: true,
    });
    const retained = f.state.obligations!.exceptions.find(
      (row) => row.id === issue.id,
    )!;
    expect(retained.status).toBe('waived');
    expect(retained.assigneeUserId).toBe('analyst');
    expect(retained.history.some((row) => row.action === 'waive')).toBe(true);
    expect(f.state.obligations!.occurrences).toHaveLength(4);
  });
  it('rechecks revoked sessions, changed roles and scopes inside the transaction', async () => {
    f.session = false;
    await expect(saveReportObligations(ctx, create())).rejects.toMatchObject({
      code: 'ACCESS_CHANGED',
    });
    f.session = true;
    f.role = 'analyst';
    await expect(saveReportObligations(ctx, create())).rejects.toMatchObject({
      code: 'ACCESS_CHANGED',
    });
    f.role = 'owner';
    f.scope = { familyIds: ['new-scope'] };
    await expect(readReportObligations(ctx)).rejects.toMatchObject({
      code: 'ACCESS_CHANGED',
    });
    expect(f.saves).not.toHaveBeenCalled();
  });
  it('accepts equivalent family/entity scopes despite PostgreSQL JSON key ordering', async () => {
    const holding = deriveWorkspace(f.state).holdings[0];
    f.role = 'viewer';
    f.scope = { entityIds: [holding.entityId], familyIds: [holding.familyId] };
    const scoped = await readReportObligations({
      ...ctx,
      role: 'viewer',
      scope: { familyIds: [holding.familyId], entityIds: [holding.entityId] },
    });
    expect(scoped.canWrite).toBe(false);
    expect(
      scoped.options.holdings.every((row) => row.entityId === holding.entityId),
    ).toBe(true);
  });
  it('permits schedule administration only for owner/admin and validates assignees', async () => {
    await expect(
      saveReportObligations({ ...ctx, role: 'analyst' }, create()),
    ).rejects.toMatchObject({ status: 403 });
    const input = create();
    input.input.ownerUserId = 'another-office';
    await expect(saveReportObligations(ctx, input)).rejects.toMatchObject({
      code: 'ASSIGNEE_UNAVAILABLE',
    });
    expect(f.saves).not.toHaveBeenCalled();
  });
  it('requires original inspection, rejects wrong period and leaves financial records untouched on receipt', async () => {
    const saved = await saveReportObligations(ctx, create()),
      occurrence = saved.state.occurrences[0],
      documentId = randomUUID();
    f.sources = {
      total: 1,
      truncated: false,
      documents: [
        {
          id: documentId,
          filename: 'nav.txt',
          content_hash: 'a'.repeat(64),
          created_at: new Date('2026-09-08T12:00:00Z'),
          job_id: randomUUID(),
          status: 'awaiting_review',
          error_code: null,
          result: null,
          review_state: null,
          review_revision: 0,
          job_updated_at: new Date(),
          extraction: {
            schemaVersion: 1,
            documentId,
            mode: 'workflow',
            execution: 'local',
            documentType: 'report',
            relevant: true,
            confidence: 1,
            facts: [],
            warnings: [],
            trace: [],
            model: null,
          },
          review: null,
          corrupt: false,
        },
      ],
    };
    const input: Extract<ReportObligationsRequest, { action: 'matchReceipt' }> =
      {
        action: 'matchReceipt',
        expectedRevision: f.revision,
        idempotencyKey: randomUUID(),
        occurrenceId: occurrence.id,
        documentId,
        holdingIds: occurrence.holdingIds,
        reportType: occurrence.reportType,
        periodStart: occurrence.periodStart,
        periodEnd: occurrence.periodEnd,
        asOfDate: occurrence.periodEnd,
        reason: 'Verified period and coverage in original',
      };
    await expect(saveReportObligations(ctx, input)).rejects.toMatchObject({
      code: 'ORIGINAL_REVIEW_REQUIRED',
    });
    f.opened = true;
    await expect(
      saveReportObligations(ctx, { ...input, periodStart: '2026-01-01' }),
    ).rejects.toMatchObject({ code: 'REPORT_OBLIGATION_INVALID' });
    const financeBefore = JSON.stringify({
      engine: f.state.engine,
      finance: f.state.finance,
      portfolio: f.state.portfolio,
    });
    const matched = await saveReportObligations(ctx, input);
    expect(matched.state.occurrences[0].receipts[0].reviewStatus).toBe(
      'pending',
    );
    expect(
      matched.state.exceptions.find((row) => row.occurrenceId === occurrence.id)
        ?.sourceActive,
    ).toBe(false);
    expect(
      JSON.stringify({
        engine: f.state.engine,
        finance: f.state.finance,
        portfolio: f.state.portfolio,
      }),
    ).toBe(financeBefore);
    await expect(readReportObligations(ctx)).resolves.toMatchObject({
      revision: matched.revision,
    });
    expect(f.state.obligations!.occurrences[0].receipts).toHaveLength(1);
  });
});
