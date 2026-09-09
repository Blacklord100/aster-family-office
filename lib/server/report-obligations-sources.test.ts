import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { holdings as demoHoldings } from '@/data/portfolio';
import type { Holding } from '@/data/types';
import { initialWorkspace, type WorkspaceState } from '../workspace';
import { initialReview } from '../review-contract';
import type { Extraction, ExtractedFact } from '../processing-contract';
import {
  emptyReportObligationsState,
  type ReportScheduleInput,
} from '../report-obligations-contract';
import {
  actOnReportException,
  createReportSchedule,
  evaluateReportObligations,
  matchReportReceipt,
  reviseReportSchedule,
} from '../report-obligations';

vi.mock('server-only', () => ({}));
vi.mock('./access', () => ({
  AccessError: class AccessError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('./crypto', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decrypt: vi.fn((value: Buffer) => {
    if (value.toString().startsWith('corrupt:'))
      throw new Error('Fixture authentication failure');
    return value;
  }),
}));
import { decrypt, sha256 } from './crypto';
import {
  readObligationSources,
  sourceExceptionSignals,
  sourceReceiptStatus,
  staleReportSignals,
  type ObligationSource,
  type ObligationSources,
} from './report-obligations-sources';

const now = '2026-09-09T12:00:00.000Z';
const docId = '10000000-0000-4000-8000-000000000001';
const otherDocId = '10000000-0000-4000-8000-000000000002';
const holding = (changes: Partial<Holding> = {}): Holding => ({
  ...demoHoldings[0],
  id: 'holding-1',
  name: 'Northstar Fund',
  familyId: 'family-1',
  entityId: 'entity-1',
  currency: 'EUR',
  valuationDate: '2026-01-31',
  originalValue: 100,
  ...changes,
});
function workspace(positions = [holding()]): WorkspaceState {
  return {
    ...initialWorkspace(false),
    portfolio: {
      holdings: positions,
      history: [],
      events: [],
      tasks: [],
      evidence: [],
      families: [],
      entities: [],
      accounts: [],
    },
  };
}
const fact = (changes: Partial<ExtractedFact> = {}): ExtractedFact => ({
  kind: 'valuation',
  investmentName: 'Northstar Fund',
  effectiveDate: '2026-01-31',
  amount: '100.00',
  currency: 'EUR',
  dueDate: null,
  summary: 'Manager reported the investor NAV.',
  evidence: {
    page: 1,
    quote: 'Northstar Fund investor NAV EUR 100.00 at 31 January 2026.',
  },
  ...changes,
});
const extraction = (changes: Partial<Extraction> = {}): Extraction => ({
  schemaVersion: 1,
  documentId: docId,
  mode: 'workflow',
  execution: 'local',
  documentType: 'nav_statement',
  relevant: true,
  confidence: 0.9,
  facts: [fact()],
  warnings: [],
  trace: [],
  model: 'fixture-model',
  ...changes,
});
function source(
  result = extraction(),
  changes: Partial<ObligationSource> = {},
): ObligationSource {
  return {
    id: result.documentId,
    filename: 'manager-report.pdf',
    content_hash: 'a'.repeat(64),
    created_at: new Date('2026-02-01T12:00:00.000Z'),
    job_id: 'job-1',
    status: 'awaiting_review',
    error_code: null,
    result: Buffer.from(JSON.stringify(result)),
    review_state: null,
    review_revision: 0,
    job_updated_at: new Date(now),
    extraction: result,
    review: initialReview(
      result,
      sha256(JSON.stringify(result)),
      'awaiting_review',
    ),
    corrupt: false,
    ...changes,
  };
}
const sources = (...documents: ObligationSource[]): ObligationSources => ({
  documents,
  total: documents.length,
  truncated: false,
});
const definition = (
  changes: Partial<ReportScheduleInput> = {},
): ReportScheduleInput => ({
  name: 'Northstar monthly report',
  holdingIds: ['holding-1'],
  familyIds: ['family-1'],
  managerId: null,
  reportType: 'nav_statement',
  cadence: 'monthly',
  firstPeriodStart: '2026-01-01',
  oneOffPeriodEnd: null,
  timezone: 'Europe/Helsinki',
  dueDaysAfterPeriodEnd: 15,
  dueLocalTime: '17:00',
  graceHours: 0,
  ownerUserId: 'reviewer',
  staleAfterDays: 60,
  ...changes,
});
function scheduled(changes: Partial<ReportScheduleInput> = {}) {
  const state = createReportSchedule(
    emptyReportObligationsState(),
    definition(changes),
    {
      actorUserId: 'reviewer',
      now: '2026-01-01T00:00:00.000Z',
      id: 'schedule-1',
    },
  );
  return evaluateReportObligations(state, {
    from: '2026-01-01',
    through: '2026-08-01',
    now,
  });
}

describe('obligation source projection', () => {
  it('retains one stable issue identity and fingerprint across equivalent model runs', () => {
    const first = source(
      extraction({
        facts: [
          fact({ amount: '0100.0000' }),
          fact({ kind: 'news', amount: null, summary: 'First wording' }),
        ],
      }),
    );
    const second = source(
      extraction({
        mode: 'agentic',
        model: 'another-model',
        confidence: 0.3,
        trace: [{ stage: 'tools', status: 'read', detail: 'New tool trace' }],
        facts: [
          fact({
            kind: 'news',
            amount: null,
            summary: 'Different summary',
            evidence: {
              page: 2,
              quote: 'A different source block about the same event.',
            },
          }),
          fact({ amount: '100', summary: 'Different model wording' }),
        ],
      }),
      { job_id: 'job-2', job_updated_at: new Date('2026-09-09T12:01:00.000Z') },
    );
    const a = sourceExceptionSignals(workspace(), sources(first), now),
      b = sourceExceptionSignals(workspace(), sources(second), now);
    expect(
      a.map(({ key, evidenceFingerprint, sourceActive }) => ({
        key,
        evidenceFingerprint,
        sourceActive,
      })),
    ).toEqual(
      b.map(({ key, evidenceFingerprint, sourceActive }) => ({
        key,
        evidenceFingerprint,
        sourceActive,
      })),
    );
    expect(
      b[0].evidence.some((ref) => ref.kind === 'review' && ref.id === 'job-2'),
    ).toBe(true);
  });
  it('changes the evidence fingerprint for a changed economic fact or source identity', () => {
    const base = sourceExceptionSignals(
      workspace(),
      sources(source()),
      now,
    ).find((item) => item.category === 'review_pending')!;
    const amount = sourceExceptionSignals(
      workspace(),
      sources(source(extraction({ facts: [fact({ amount: '101' })] }))),
      now,
    ).find((item) => item.category === 'review_pending')!;
    const hash = sourceExceptionSignals(
      workspace(),
      sources(source(extraction(), { content_hash: 'b'.repeat(64) })),
      now,
    ).find((item) => item.category === 'review_pending')!;
    expect(base.evidenceFingerprint).not.toBe(amount.evidenceFingerprint);
    expect(base.evidenceFingerprint).not.toBe(hash.evidenceFingerprint);
  });
  it.each([
    [1e-8, '0.00000001', false],
    [1e-8, '0.00000002', true],
    [100, '0100.00000000', false],
    [100, '100.01', true],
    [100, '-100', true],
    [100, '999999999999999999.12345678', true],
    [0, '-0.00000000', false],
  ] as const)(
    'compares %s against %s safely (conflict %s)',
    (originalValue, amount, conflict) => {
      const signals = sourceExceptionSignals(
        workspace([holding({ originalValue })]),
        sources(source(extraction({ facts: [fact({ amount })] }))),
        now,
      );
      expect(
        signals.find((item) => item.category === 'conflicting_fact')
          ?.sourceActive,
      ).toBe(conflict);
    },
  );
  it('withholds mixed or unresolved holding scope instead of leaking part of a consolidation', () => {
    const known = sourceExceptionSignals(workspace(), sources(source()), now);
    expect(
      known.find((item) => item.category === 'review_pending')?.familyIds,
    ).toEqual(['family-1']);
    const mixed = sourceExceptionSignals(
      workspace(),
      sources(
        source(
          extraction({
            facts: [
              fact(),
              fact({ investmentName: 'Unregistered investment' }),
            ],
          }),
        ),
      ),
      now,
    );
    expect(
      mixed.every((item) => !item.familyIds.length && !item.holdingIds.length),
    ).toBe(true);
    expect(
      mixed.find((item) => item.category === 'identity_unresolved')
        ?.sourceActive,
    ).toBe(true);
  });
  it('does not guess an ambiguous name or override a reviewed identity', () => {
    const duplicateName = workspace([
      holding(),
      holding({ id: 'holding-2', familyId: 'family-2' }),
    ]);
    expect(
      sourceExceptionSignals(duplicateName, sources(source()), now).find(
        (item) => item.category === 'identity_unresolved',
      )?.sourceActive,
    ).toBe(true);
    const linked = source();
    linked.review!.facts[0].holdingId = 'holding-2';
    expect(
      sourceExceptionSignals(duplicateName, sources(linked), now).find(
        (item) => item.category === 'review_pending',
      )?.familyIds,
    ).toEqual(['family-2']);
  });
  it('preserves intentionally rejected extraction facts as completed human decisions', () => {
    const rejected = source();
    rejected.review!.facts[0].status = 'rejected';
    const signals = sourceExceptionSignals(workspace(), sources(rejected), now);
    expect(
      signals.find((item) => item.category === 'review_pending')?.sourceActive,
    ).toBe(false);
    expect(
      signals.some(
        (item) => item.category === 'review_rejected' && item.sourceActive,
      ),
    ).toBe(false);
  });
  it('does not clear a prior conflict or pending issue while a new mode is processing', () => {
    const ws = workspace(),
      first = source(extraction({ facts: [fact({ amount: '200' })] }));
    let state = evaluateReportObligations(emptyReportObligationsState(), {
      from: '2026-01-01',
      through: '2026-09-01',
      now,
      issues: sourceExceptionSignals(ws, sources(first), now),
    });
    const conflictId = state.exceptions.find(
      (item) => item.category === 'conflicting_fact',
    )!.id;
    state = actOnReportException(
      state,
      conflictId,
      {
        action: 'assign',
        assigneeUserId: 'other-reviewer',
        reason: 'Assigned to the fund reviewer.',
      },
      { actorUserId: 'reviewer', now },
    );
    const processing = source(extraction(), {
      job_id: 'new-mode-job',
      status: 'processing',
      extraction: null,
      review: null,
      result: null,
    });
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-09-01',
      now,
      issues: sourceExceptionSignals(
        ws,
        { ...sources(processing), truncated: true, total: 2001 },
        now,
      ),
    });
    expect(
      state.exceptions.find((item) => item.id === conflictId),
    ).toMatchObject({
      status: 'open',
      assigneeUserId: 'other-reviewer',
      sourceActive: true,
    });
  });
});

describe('verified latest source status and bounded source reads', () => {
  it.each(['queued', 'processing', 'failed', 'cancelled'])(
    'does not carry old acceptance into a latest %s job',
    (status) => {
      const row = source();
      row.review!.facts[0].status = 'accepted';
      row.status = status;
      expect(sourceReceiptStatus(row).reviewStatus).toBe('pending');
    },
  );
  it('treats corrupt or absent results as pending review even if a job claims acceptance', () => {
    expect(
      sourceReceiptStatus(
        source(extraction(), { status: 'accepted', corrupt: true }),
      ),
    ).toEqual({ processingStatus: 'failed', reviewStatus: 'pending' });
    expect(
      sourceReceiptStatus(
        source(extraction(), {
          status: 'accepted',
          extraction: null,
          review: null,
        }),
      ),
    ).toEqual({ processingStatus: 'blocked', reviewStatus: 'pending' });
  });
  it('does not clear pending review from an old result attached to a queued retry', () => {
    const previousResult = source(extraction(), { status: 'queued' });
    previousResult.review!.facts[0].status = 'accepted';
    const signals = sourceExceptionSignals(
      workspace(),
      sources(previousResult),
      now,
    );
    expect(signals.some((row) => row.category === 'review_pending')).toBe(
      false,
    );
  });
  it('reads the latest job for each selected document, retains historical citations and reports partial coverage', async () => {
    const state = scheduled();
    state.occurrences[0].history.push({
      at: now,
      actorUserId: 'reviewer',
      action: 'review',
      reason: 'Historical supporting source',
      evidence: [{ kind: 'document', id: otherDocId }],
      evidenceFingerprint: null,
    });
    const row = source(),
      query = vi
        .fn()
        .mockResolvedValue({
          rows: [{ ...row, total: '2500', payload_bytes: '1024' }],
        });
    const result = await readObligationSources(
      { query } as unknown as PoolClient,
      'tenant',
      state,
    );
    expect(query.mock.calls[0][0]).toContain(
      'ORDER BY created_at DESC,id DESC LIMIT 1',
    );
    expect(query.mock.calls[0][1]).toEqual([
      'tenant',
      2000,
      [otherDocId],
      64 * 1024 * 1024,
    ]);
    expect(result).toMatchObject({ total: 2500, truncated: true });
    expect(result.documents[0]).toMatchObject({ corrupt: false, id: docId });
  });
  it('isolates corrupt source/review rows while keeping unrelated documents usable', async () => {
    const valid = source();
    const mismatch = source(extraction({ documentId: otherDocId }), {
      id: docId,
    });
    const invalidReview = {
      ...initialReview(
        extraction(),
        sha256(JSON.stringify(extraction())),
        'awaiting_review',
      ),
      facts: [
        {
          ...initialReview(extraction(), 'unused', 'awaiting_review').facts[0],
          factIndex: 1,
        },
      ],
    };
    const malformed = source(extraction(), {
      review_state: Buffer.from(JSON.stringify(invalidReview)),
    });
    const query = vi.fn().mockResolvedValue({
      rows: [
        valid,
        { ...valid, result: Buffer.from('corrupt:fixture') },
        mismatch,
        malformed,
      ].map((row) => ({ ...row, total: '4', payload_bytes: '4096' })),
    });
    const result = await readObligationSources(
      { query } as unknown as PoolClient,
      'tenant',
      emptyReportObligationsState(),
    );
    expect(result.documents.map((row) => row.corrupt)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(
      result.documents
        .slice(1)
        .every((row) => row.extraction === null && row.review === null),
    ).toBe(true);
  });
  it('fails before decryption when the one-statement byte guard rejects the selected batch', async () => {
    vi.mocked(decrypt).mockClear();
    const query = vi
      .fn()
      .mockResolvedValue({
        rows: [
          {
            ...source(),
            result: null,
            review_state: null,
            total: '2000',
            payload_bytes: String(64 * 1024 * 1024 + 1),
          },
        ],
      });
    await expect(
      readObligationSources(
        { query } as unknown as PoolClient,
        'tenant',
        emptyReportObligationsState(),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'REPORT_SOURCE_BYTES_LIMIT' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain(
      'SUM(COALESCE(octet_length(result),0)::bigint + COALESCE(octet_length(review_state),0)::bigint) OVER ()',
    );
    expect(query.mock.calls[0][0]).toContain(
      'CASE WHEN payload_bytes <= $4::bigint THEN result ELSE NULL END',
    );
    expect(query.mock.calls[0][0]).toContain(
      'CASE WHEN payload_bytes <= $4::bigint THEN review_state ELSE NULL END',
    );
    expect(decrypt).not.toHaveBeenCalled();
  });
});

describe('explicit disclosure age policies', () => {
  it('never refreshes a registered NAV from a recent manager update receipt', () => {
    let state = scheduled();
    const occurrence = state.occurrences.find(
      (row) => row.periodStart === '2026-08-01',
    )!;
    state = matchReportReceipt(
      state,
      occurrence.id,
      {
        documentId: docId,
        documentHash: 'a'.repeat(64),
        holdingIds: ['holding-1'],
        reportType: 'nav_statement',
        periodStart: occurrence.periodStart,
        periodEnd: occurrence.periodEnd,
        asOfDate: '2026-08-31',
        receivedAt: now,
        processingStatus: 'completed',
        reviewStatus: 'accepted',
        matchReason: 'Verified the report period and investor.',
        matchEvidence: [{ kind: 'document', id: docId }],
        supersedesReceiptId: null,
      },
      { actorUserId: 'reviewer', now },
    );
    const stale = staleReportSignals(workspace(), state, now).find(
      (item) => item.category === 'stale_disclosure',
    )!;
    expect(stale.sourceActive).toBe(true);
    expect(stale.description).toContain('2026-01-31');
  });
  it('uses accepted disclosure dates only for the currently configured report type', () => {
    let state = scheduled({ reportType: 'manager_update' });
    const occurrence = state.occurrences.at(-1)!;
    state = matchReportReceipt(
      state,
      occurrence.id,
      {
        documentId: docId,
        documentHash: 'a'.repeat(64),
        holdingIds: ['holding-1'],
        reportType: 'manager_update',
        periodStart: occurrence.periodStart,
        periodEnd: occurrence.periodEnd,
        asOfDate: '2026-08-31',
        receivedAt: now,
        processingStatus: 'completed',
        reviewStatus: 'accepted',
        matchReason: 'Verified the report period and investor.',
        matchEvidence: [{ kind: 'document', id: docId }],
        supersedesReceiptId: null,
      },
      { actorUserId: 'reviewer', now },
    );
    expect(
      staleReportSignals(workspace(), state, now).find(
        (item) => item.category === 'stale_disclosure',
      )?.sourceActive,
    ).toBe(false);
    state = reviseReportSchedule(
      state,
      'schedule-1',
      definition({
        firstPeriodStart: '2026-09-01',
        reportType: 'financial_statements',
        dueDaysAfterPeriodEnd: 0,
      }),
      '2026-09-01',
      { actorUserId: 'reviewer', now: '2026-08-10T00:00:00.000Z' },
      { reason: 'Annual accounts need a separate disclosure policy.' },
    );
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-09-01',
      now: '2026-10-10T00:00:00.000Z',
    });
    const stale = staleReportSignals(
      workspace(),
      state,
      '2026-10-10T00:00:00.000Z',
    ).find((item) => item.category === 'stale_disclosure')!;
    expect(stale.sourceActive).toBe(true);
    expect(stale.description).toContain('No accepted receipt');
    expect(stale.evidence.some((ref) => ref.kind === 'document')).toBe(false);
  });
  it.each([{ status: 'paused' as const }, { staleAfterDays: null }])(
    'explicitly closes a disabled or paused policy without deleting history %j',
    (change) => {
      const ws = workspace();
      let state = scheduled();
      state = evaluateReportObligations(state, {
        from: '2026-01-01',
        through: '2026-08-01',
        now,
        issues: staleReportSignals(ws, state, now),
      });
      const previous = state.exceptions.find(
        (row) => row.category === 'stale_disclosure',
      )!;
      state = reviseReportSchedule(
        state,
        'schedule-1',
        definition({
          firstPeriodStart: '2026-09-01',
          ...('staleAfterDays' in change ? change : {}),
        }),
        '2026-09-01',
        { actorUserId: 'reviewer', now: '2026-08-10T00:00:00.000Z' },
        {
          status: 'status' in change ? change.status : 'active',
          reason: 'Reviewed the current reporting-age policy.',
        },
      );
      state = evaluateReportObligations(state, {
        from: '2026-01-01',
        through: '2026-09-01',
        now,
        issues: staleReportSignals(ws, state, now),
      });
      expect(
        state.exceptions.find((row) => row.id === previous.id),
      ).toMatchObject({ status: 'resolved', sourceActive: false });
    },
  );
  it('explicitly retires stale issues for holdings removed by a schedule revision', () => {
    const ws = workspace([
      holding(),
      holding({
        id: 'holding-2',
        name: 'Other fund',
        familyId: 'family-2',
        valuationDate: '2026-08-31',
      }),
    ]);
    let state = scheduled();
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-08-01',
      now,
      issues: staleReportSignals(ws, state, now),
    });
    const previous = state.exceptions.find(
      (row) => row.key === 'stale:schedule-1:holding-1',
    )!;
    state = reviseReportSchedule(
      state,
      'schedule-1',
      definition({
        firstPeriodStart: '2026-09-01',
        holdingIds: ['holding-2'],
        familyIds: ['family-2'],
      }),
      '2026-09-01',
      { actorUserId: 'reviewer', now: '2026-08-10T00:00:00.000Z' },
      { reason: 'Scope changed for the next reporting period.' },
    );
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-09-01',
      now,
      issues: staleReportSignals(ws, state, now),
    });
    expect(
      state.exceptions.find((row) => row.id === previous.id),
    ).toMatchObject({
      status: 'resolved',
      sourceActive: false,
      holdingIds: ['holding-1'],
    });
    expect(
      state.exceptions.find((row) => row.id === previous.id)?.history.at(-1)
        ?.action,
    ).toBe('source_resolved');
  });
  it('keeps a received but rejected report actionable independently of its delivery', () => {
    let state = scheduled();
    const occurrence = state.occurrences[0];
    state = matchReportReceipt(
      state,
      occurrence.id,
      {
        documentId: docId,
        documentHash: 'a'.repeat(64),
        holdingIds: ['holding-1'],
        reportType: 'nav_statement',
        periodStart: occurrence.periodStart,
        periodEnd: occurrence.periodEnd,
        asOfDate: occurrence.periodEnd,
        receivedAt: now,
        processingStatus: 'completed',
        reviewStatus: 'rejected',
        matchReason:
          'Correct period report received; financial facts were rejected.',
        matchEvidence: [{ kind: 'document', id: docId }],
        supersedesReceiptId: null,
      },
      { actorUserId: 'reviewer', now },
    );
    expect(
      staleReportSignals(workspace(), state, now).find(
        (item) => item.key === `receipt-review:${occurrence.id}`,
      )?.sourceActive,
    ).toBe(true);
  });
});
