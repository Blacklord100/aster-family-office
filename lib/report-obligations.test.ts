import { describe, expect, it } from 'vitest';
import {
  emptyReportObligationsState,
  reportObligationsStateSchema,
  reportScheduleInputSchema,
  type ReportExceptionSignal,
  type ReportReceiptInput,
  type ReportScheduleInput,
} from './report-obligations-contract';
import {
  actOnReportException,
  activeReportReceipts,
  addManualReportException,
  createReportSchedule,
  disposeReportOccurrence,
  evaluateReportObligations,
  matchReportReceipt,
  reinstateReportReceipt,
  reportLocalDate,
  reportLocalDateTimeToInstant,
  reportPeriodEnd,
  revokeReportReceipt,
  reviseReportSchedule,
  summarizeReportOccurrence,
} from './report-obligations';

const now = '2026-03-10T12:00:00.000Z';
const actor = { actorUserId: 'reviewer-1', now };
const definition = (
  changes: Partial<ReportScheduleInput> = {},
): ReportScheduleInput => ({
  name: 'Northstar monthly NAV',
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
  graceHours: 24,
  ownerUserId: 'reviewer-1',
  staleAfterDays: 90,
  ...changes,
});
const configured = (changes: Partial<ReportScheduleInput> = {}) =>
  createReportSchedule(emptyReportObligationsState(), definition(changes), {
    ...actor,
    id: 'schedule-1',
  });
const evaluate = (state = configured(), at = now, through = '2026-03-01') =>
  evaluateReportObligations(state, { from: '2026-01-01', through, now: at });
const receipt = (
  changes: Partial<ReportReceiptInput> = {},
): ReportReceiptInput => ({
  documentId: '10000000-0000-4000-8000-000000000001',
  documentHash: 'a'.repeat(64),
  holdingIds: ['holding-1'],
  reportType: 'nav_statement',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  asOfDate: '2026-01-31',
  receivedAt: '2026-03-01T10:00:00.000Z',
  processingStatus: 'completed',
  reviewStatus: 'pending',
  matchReason:
    'Reviewed the manager, investor and reporting period in the original source.',
  matchEvidence: [
    { kind: 'document', id: '10000000-0000-4000-8000-000000000001' },
  ],
  supersedesReceiptId: null,
  ...changes,
});
const signal = (
  changes: Partial<ReportExceptionSignal> = {},
): ReportExceptionSignal => ({
  key: 'review:document-1',
  category: 'review_pending',
  title: 'Review reported NAV',
  description: 'The proposed valuation needs financial review.',
  familyIds: ['family-1'],
  holdingIds: ['holding-1'],
  priority: 'normal',
  evidenceFingerprint: 'document-1:fact-1:pending',
  evidence: [{ kind: 'document', id: 'document-1' }],
  assigneeUserId: 'reviewer-1',
  ...changes,
});
const note = [{ kind: 'note' as const, id: 'reviewer-attestation' }];

describe('report schedule contract', () => {
  it('keeps existing workspaces empty by default', () => {
    expect(
      reportObligationsStateSchema.parse(emptyReportObligationsState()),
    ).toEqual({ version: 1, schedules: [], occurrences: [], exceptions: [] });
  });
  it('preserves the reviewer reason when establishing a schedule', () => {
    const state = createReportSchedule(
      emptyReportObligationsState(),
      definition(),
      { ...actor, id: 'reasoned-schedule' },
      'Mandate requires monthly investor reporting.',
    );
    expect(state.schedules[0].versions[0].reason).toBe(
      'Mandate requires monthly investor reporting.',
    );
    expect(state.schedules[0].history[0].reason).toBe(
      'Mandate requires monthly investor reporting.',
    );
  });
  it.each([
    { firstPeriodStart: '2026-02-30' },
    { firstPeriodStart: '2026-01-15' },
    { cadence: 'quarterly', firstPeriodStart: '2026-02-01' },
    { cadence: 'annual', firstPeriodStart: '2026-04-01' },
    { cadence: 'one_off', oneOffPeriodEnd: null },
    { oneOffPeriodEnd: '2026-03-01' },
    { timezone: 'Definitely/Not-a-timezone' },
    { dueLocalTime: '24:30' },
    { graceHours: -1 },
    { holdingIds: ['holding-1', 'holding-1'] },
    { familyIds: [] },
    { ownerUserId: '' },
  ])('rejects an invalid schedule definition %j', (changes) => {
    expect(
      reportScheduleInputSchema.safeParse({ ...definition(), ...changes })
        .success,
    ).toBe(false);
  });
  it('allows an office-wide source exception without inventing family attribution', () => {
    const state = evaluateReportObligations(emptyReportObligationsState(), {
      from: '2026-01-01',
      through: '2026-01-01',
      now,
      issues: [signal({ familyIds: [], holdingIds: [] })],
    });
    expect(state.exceptions[0].familyIds).toEqual([]);
  });
});

describe('calendar dates and timezone deadlines', () => {
  it.each([
    ['2024-02-01', 'monthly', '2024-02-29'],
    ['2026-02-01', 'monthly', '2026-02-28'],
    ['2026-12-01', 'monthly', '2026-12-31'],
    ['2024-01-01', 'quarterly', '2024-03-31'],
    ['2026-10-01', 'quarterly', '2026-12-31'],
    ['2024-01-01', 'annual', '2024-12-31'],
  ] as const)('ends %s %s periods on %s', (start, cadence, end) => {
    expect(reportPeriodEnd(start, { cadence, oneOffPeriodEnd: null })).toBe(
      end,
    );
  });
  it('keeps an explicit one-off reporting period', () => {
    expect(
      reportPeriodEnd('2026-02-12', {
        cadence: 'one_off',
        oneOffPeriodEnd: '2026-03-08',
      }),
    ).toBe('2026-03-08');
  });
  it.each([
    ['2026-03-08', '02:30', 'America/New_York', '2026-03-08T07:30:00.000Z'],
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00.000Z'],
    ['2026-03-29', '03:30', 'Europe/Helsinki', '2026-03-29T01:30:00.000Z'],
    ['2026-10-25', '03:30', 'Europe/Helsinki', '2026-10-25T00:30:00.000Z'],
    ['2026-10-04', '02:15', 'Australia/Lord_Howe', '2026-10-03T15:45:00.000Z'],
    ['2026-06-01', '12:15', 'Asia/Kathmandu', '2026-06-01T06:30:00.000Z'],
    ['2011-12-30', '12:00', 'Pacific/Apia', '2011-12-30T22:00:00.000Z'],
  ])('resolves %s %s in %s deterministically', (date, time, zone, expected) => {
    expect(reportLocalDateTimeToInstant(date, time, zone)).toBe(expected);
  });
  it('adds calendar days before timezone conversion and elapsed grace afterwards', () => {
    const state = evaluateReportObligations(
      configured({
        cadence: 'one_off',
        firstPeriodStart: '2026-03-01',
        oneOffPeriodEnd: '2026-03-07',
        timezone: 'America/New_York',
        dueDaysAfterPeriodEnd: 1,
        dueLocalTime: '02:30',
        graceHours: 24,
      }),
      { from: '2026-03-01', through: '2026-03-01', now },
    );
    expect(state.occurrences[0].dueAt).toBe('2026-03-08T07:30:00.000Z');
    expect(state.occurrences[0].graceEndsAt).toBe('2026-03-09T07:30:00.000Z');
    expect(reportLocalDate('2026-03-01T23:30:00.000Z', 'Europe/Helsinki')).toBe(
      '2026-03-02',
    );
  });
});

describe('deterministic materialization and versioning', () => {
  it('starts each office timezone independently and leaves a not-yet-started period editable', () => {
    const at = '2026-08-31T10:00:00.000Z';
    const context = { actorUserId: 'reviewer-1', now: at };
    let state = createReportSchedule(
      emptyReportObligationsState(),
      definition({
        firstPeriodStart: '2026-08-01',
        timezone: 'America/Los_Angeles',
      }),
      { ...context, id: 'los-angeles' },
    );
    state = createReportSchedule(
      state,
      definition({
        firstPeriodStart: '2026-08-01',
        timezone: 'Pacific/Kiritimati',
      }),
      { ...context, id: 'kiritimati' },
    );
    state = evaluateReportObligations(state, {
      from: '2026-08-01',
      through: '2026-09-01',
      now: at,
      startedPeriodsOnly: true,
    });
    expect(
      state.occurrences
        .filter((row) => row.scheduleId === 'los-angeles')
        .map((row) => row.periodStart),
    ).toEqual(['2026-08-01']);
    expect(
      state.occurrences
        .filter((row) => row.scheduleId === 'kiritimati')
        .map((row) => row.periodStart),
    ).toEqual(['2026-08-01', '2026-09-01']);
    state = reviseReportSchedule(
      state,
      'los-angeles',
      definition({
        firstPeriodStart: '2026-09-01',
        timezone: 'America/Los_Angeles',
        dueDaysAfterPeriodEnd: 20,
      }),
      '2026-09-01',
      context,
      { reason: 'Adjust the next period before its local start.' },
    );
    state = evaluateReportObligations(state, {
      from: '2026-08-01',
      through: '2026-09-01',
      now: '2026-09-01T07:00:00.000Z',
      startedPeriodsOnly: true,
    });
    const september = state.occurrences.find(
      (row) =>
        row.scheduleId === 'los-angeles' && row.periodStart === '2026-09-01',
    )!;
    expect(september.scheduleVersionId).toBe('los-angeles:v2');
    expect(state.occurrences).toHaveLength(4);
  });
  it('creates one obligation per configured period and catches up missed runs once', () => {
    const first = evaluate(configured());
    expect(first.occurrences.map((item) => item.periodStart)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
    expect(first.exceptions).toHaveLength(1);
    expect(first.exceptions[0]).toMatchObject({
      status: 'open',
      category: 'missing_report',
      assigneeUserId: 'reviewer-1',
    });
    expect(evaluate(first)).toEqual(first);
    const caught = evaluate(first, '2026-06-30T00:00:00.000Z', '2026-06-01');
    expect(caught.occurrences).toHaveLength(6);
    expect(new Set(caught.exceptions.map((item) => item.key)).size).toBe(
      caught.exceptions.length,
    );
  });
  it('fails all-or-nothing instead of dropping older obligations or excess catch-up', () => {
    const state = configured();
    expect(() =>
      evaluateReportObligations(state, {
        from: '2026-02-01',
        through: '2026-03-01',
        now,
      }),
    ).toThrow(/skip/);
    expect(() =>
      evaluateReportObligations(state, {
        from: '2026-01-01',
        through: '2026-03-01',
        now,
        maxNewOccurrences: 2,
      }),
    ).toThrow(/limit/);
    expect(state.occurrences).toHaveLength(0);
    expect(() =>
      evaluateReportObligations(state, {
        from: '1990-01-01',
        through: '2026-03-01',
        now,
      }),
    ).toThrow(/30 years/);
  });
  it('snapshots expectations and applies a future version at a complete period boundary', () => {
    const first = evaluate(configured(), now, '2026-03-01');
    const original = structuredClone(first.occurrences);
    const revision = definition({
      name: 'Northstar quarterly package',
      cadence: 'quarterly',
      firstPeriodStart: '2026-04-01',
      dueDaysAfterPeriodEnd: 30,
    });
    const revised = reviseReportSchedule(
      first,
      'schedule-1',
      revision,
      '2026-04-01',
      actor,
      { reason: 'Manager moved to a quarterly reporting cadence.' },
    );
    const caught = evaluate(revised, now, '2026-12-01');
    expect(caught.occurrences.slice(0, 3)).toEqual(original);
    expect(
      caught.occurrences
        .slice(3)
        .map((item) => [item.periodStart, item.periodEnd]),
    ).toEqual([
      ['2026-04-01', '2026-06-30'],
      ['2026-07-01', '2026-09-30'],
      ['2026-10-01', '2026-12-31'],
    ]);
    expect(caught.schedules[0].versions).toHaveLength(2);
  });
  it('never rewrites a materialized future occurrence or splits a previous period', () => {
    const first = evaluate(configured(), now, '2026-06-01');
    expect(() =>
      reviseReportSchedule(
        first,
        'schedule-1',
        definition({ firstPeriodStart: '2026-04-01' }),
        '2026-04-01',
        actor,
        { reason: 'Change deadline' },
      ),
    ).toThrow(/materialized/);
    const quarterly = configured({ cadence: 'quarterly' });
    expect(() =>
      reviseReportSchedule(
        quarterly,
        'schedule-1',
        definition({ firstPeriodStart: '2026-05-01' }),
        '2026-05-01',
        actor,
        { reason: 'Change cadence' },
      ),
    ).toThrow(/split/);
  });
  it('preserves missed obligations when pausing and resumes only from an explicit future boundary', () => {
    let state = evaluate(configured());
    state = reviseReportSchedule(
      state,
      'schedule-1',
      definition({ firstPeriodStart: '2026-04-01' }),
      '2026-04-01',
      actor,
      {
        status: 'paused',
        reason: 'Reporting temporarily suspended by reviewed mandate.',
      },
    );
    state = evaluate(state, now, '2026-09-01');
    expect(state.occurrences).toHaveLength(3);
    expect(state.exceptions[0].status).toBe('open');
    state = reviseReportSchedule(
      state,
      'schedule-1',
      definition({ firstPeriodStart: '2026-07-01' }),
      '2026-07-01',
      actor,
      {
        status: 'active',
        reason: 'Regular reporting resumes for the July period.',
      },
    );
    state = evaluate(state, now, '2026-09-01');
    expect(state.occurrences.map((item) => item.periodStart)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
    ]);
  });
});

describe('source-backed receipt lifecycle', () => {
  it('evaluates 100 retained receipt versions and rejects the next link before changing history', () => {
    let state = evaluate();
    const occurrenceId = state.occurrences[0].id;
    for (let index = 1; index <= 100; index++) {
      const documentId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      state = matchReportReceipt(
        state,
        occurrenceId,
        receipt({
          documentId,
          matchEvidence: [{ kind: 'document', id: documentId }],
        }),
        actor,
      );
    }
    state = evaluate(state);
    expect(state.occurrences[0].receipts).toHaveLength(100);
    expect(state.exceptions[0].evidence).toHaveLength(100);
    const before = structuredClone(state);
    expect(() =>
      matchReportReceipt(
        state,
        occurrenceId,
        receipt({ documentId: '10000000-0000-4000-8000-000000000101' }),
        actor,
      ),
    ).toThrow(/100 retained receipt versions/);
    expect(state).toEqual(before);
    expect(
      matchReportReceipt(
        state,
        occurrenceId,
        receipt({ reviewStatus: 'accepted' }),
        actor,
      ).occurrences[0].receipts[0].reviewStatus,
    ).toBe('accepted');
  });
  it('keeps maximum-length schedule names valid through missing and late-delivery detection', () => {
    const name = 'N'.repeat(240);
    let state = evaluate(configured({ name }));
    expect(state.occurrences[0].name).toBe(name);
    expect(state.exceptions[0].title).toHaveLength(240);
    state = matchReportReceipt(
      state,
      state.occurrences[0].id,
      receipt(),
      actor,
    );
    state = evaluate(state);
    expect(state.exceptions[0]).toMatchObject({
      category: 'late_report',
      status: 'resolved',
    });
    expect(state.exceptions[0].title).toHaveLength(240);
  });
  it('satisfies delivery with a late receipt while keeping financial review pending', () => {
    let state = evaluate();
    const occurrence = state.occurrences[0];
    const exceptionId = state.exceptions[0].id;
    state = matchReportReceipt(state, occurrence.id, receipt(), actor);
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [signal()],
    });
    expect(
      state.exceptions.find((item) => item.id === exceptionId),
    ).toMatchObject({
      status: 'resolved',
      sourceActive: false,
      category: 'late_report',
    });
    expect(
      state.exceptions.find((item) => item.key === 'review:document-1')?.status,
    ).toBe('open');
    expect(summarizeReportOccurrence(state.occurrences[0], now)).toMatchObject({
      deliveryStatus: 'received_late',
      acceptedCount: 0,
      pendingCount: 1,
    });
    expect(
      state.exceptions
        .find((item) => item.id === exceptionId)
        ?.history.map((entry) => entry.action),
    ).toEqual(['detected', 'source_resolved']);
    expect(matchReportReceipt(state, occurrence.id, receipt(), actor)).toBe(
      state,
    );
  });
  it.each([
    { periodStart: '2026-02-01', periodEnd: '2026-02-28' },
    { reportType: 'unrelated_news' },
    { holdingIds: ['holding-2'] },
    { receivedAt: '2027-01-01T00:00:00.000Z' },
    { asOfDate: '2026-12-01' },
  ])('rejects unrelated or impossible receipt metadata %j', (changes) => {
    const state = evaluate();
    expect(() =>
      matchReportReceipt(
        state,
        state.occurrences[0].id,
        receipt(changes),
        actor,
      ),
    ).toThrow();
    expect(state.occurrences[0].receipts).toHaveLength(0);
  });
  it('requires explicit coverage of every holding in a consolidation expectation', () => {
    const state = evaluate(
      configured({ holdingIds: ['holding-1', 'holding-2'] }),
    );
    expect(() =>
      matchReportReceipt(state, state.occurrences[0].id, receipt(), actor),
    ).toThrow(/Every holding/);
    expect(
      matchReportReceipt(
        state,
        state.occurrences[0].id,
        receipt({ holdingIds: ['holding-1', 'holding-2'] }),
        actor,
      ).occurrences[0].receipts,
    ).toHaveLength(1);
  });
  it('keeps unreadable but explicitly attested delivery distinct from absent delivery', () => {
    let state = evaluate();
    state = matchReportReceipt(
      state,
      state.occurrences[0].id,
      receipt({ processingStatus: 'blocked' }),
      actor,
    );
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [
        signal({ key: 'failed:document-1', category: 'processing_failed' }),
      ],
    });
    expect(summarizeReportOccurrence(state.occurrences[0], now)).toMatchObject({
      deliveryStatus: 'received_late',
      failedCount: 1,
      pendingCount: 1,
    });
    expect(
      state.exceptions
        .filter((item) => item.status === 'open')
        .map((item) => item.category),
    ).toEqual(['processing_failed']);
  });
  it('retains arrival and revision history while replacing the current review status', () => {
    let state = evaluate();
    const id = state.occurrences[0].id;
    const first = receipt({
      receivedAt: '2026-02-10T09:00:00.000Z',
      reviewStatus: 'accepted',
    });
    state = matchReportReceipt(state, id, first, actor);
    const previous = state.occurrences[0].receipts[0].id;
    state = matchReportReceipt(
      state,
      id,
      receipt({
        documentId: '10000000-0000-4000-8000-000000000002',
        supersedesReceiptId: previous,
      }),
      actor,
    );
    const summary = summarizeReportOccurrence(state.occurrences[0], now);
    expect(summary).toMatchObject({
      deliveryStatus: 'received',
      firstReceivedAt: first.receivedAt,
      acceptedCount: 0,
      pendingCount: 1,
      supersededReceiptIds: [previous],
    });
    expect(state.occurrences).toHaveLength(3);
    expect(() =>
      matchReportReceipt(
        state,
        id,
        { ...first, receivedAt: '2026-02-11T09:00:00.000Z' },
        actor,
      ),
    ).toThrow(/different receipt metadata/);
  });
  it('updates review and processing status without silently changing matched scope or source time', () => {
    let state = evaluate();
    const id = state.occurrences[0].id;
    state = matchReportReceipt(state, id, receipt(), actor);
    state = matchReportReceipt(
      state,
      id,
      receipt({ reviewStatus: 'accepted' }),
      actor,
    );
    expect(
      summarizeReportOccurrence(state.occurrences[0], now).acceptedCount,
    ).toBe(1);
    expect(
      state.occurrences[0].receipts[0].history.map((entry) => entry.action),
    ).toEqual(['receipt_matched', 'source_status_updated']);
    expect(state.occurrences[0].receipts[0].receivedAt).toBe(
      receipt().receivedAt,
    );
  });
  it('reopens the same delivery issue when the only match is revoked and retains its assignment', () => {
    let state = evaluate();
    const id = state.occurrences[0].id;
    const exceptionId = state.exceptions[0].id;
    state = actOnReportException(
      state,
      exceptionId,
      {
        action: 'assign',
        assigneeUserId: 'reviewer-2',
        reason: 'Assigned to the reporting owner.',
      },
      actor,
    );
    state = matchReportReceipt(state, id, receipt(), actor);
    state = evaluate(state);
    state = revokeReportReceipt(
      state,
      id,
      state.occurrences[0].receipts[0].id,
      'The attachment belonged to the wrong investor.',
      actor,
    );
    state = evaluate(state);
    expect(state.exceptions).toHaveLength(1);
    expect(state.exceptions[0]).toMatchObject({
      id: exceptionId,
      status: 'open',
      category: 'missing_report',
      assigneeUserId: 'reviewer-2',
    });
    expect(
      summarizeReportOccurrence(state.occurrences[0], now).firstReceivedAt,
    ).toBeNull();
    expect(() => matchReportReceipt(state, id, receipt(), actor)).toThrow(
      /reinstatement/,
    );
    state = reinstateReportReceipt(
      state,
      id,
      state.occurrences[0].receipts[0].id,
      'Reviewed investor identification and confirmed the match.',
      actor,
    );
    expect(
      summarizeReportOccurrence(state.occurrences[0], now).pendingCount,
    ).toBe(1);
  });
  it('follows supersession ancestry through a revoked intermediate revision', () => {
    let state = evaluate();
    const id = state.occurrences[0].id;
    state = matchReportReceipt(state, id, receipt(), actor);
    const a = state.occurrences[0].receipts[0].id;
    state = matchReportReceipt(
      state,
      id,
      receipt({
        documentId: '10000000-0000-4000-8000-000000000002',
        supersedesReceiptId: a,
      }),
      actor,
    );
    const b = state.occurrences[0].receipts[1].id;
    state = matchReportReceipt(
      state,
      id,
      receipt({
        documentId: '10000000-0000-4000-8000-000000000003',
        supersedesReceiptId: b,
      }),
      actor,
    );
    state = revokeReportReceipt(
      state,
      id,
      b,
      'Intermediate PDF had an incorrect attachment.',
      actor,
    );
    expect(
      activeReportReceipts(state.occurrences[0]).map((item) => item.documentId),
    ).toEqual(['10000000-0000-4000-8000-000000000003']);
  });
  it('refreshes an existing corrected receipt after its ancestor is revoked without allowing new revisions of that ancestor', () => {
    let state = evaluate();
    const id = state.occurrences[0].id;
    state = matchReportReceipt(state, id, receipt(), actor);
    const originalId = state.occurrences[0].receipts[0].id;
    const correction = receipt({
      documentId: '10000000-0000-4000-8000-000000000002',
      supersedesReceiptId: originalId,
    });
    state = matchReportReceipt(state, id, correction, actor);
    state = revokeReportReceipt(
      state,
      id,
      originalId,
      'The original was withdrawn; the corrected report remains verified.',
      actor,
    );
    expect(matchReportReceipt(state, id, correction, actor)).toBe(state);
    state = matchReportReceipt(
      state,
      id,
      { ...correction, reviewStatus: 'accepted' },
      actor,
    );
    state = evaluate(state);
    expect(summarizeReportOccurrence(state.occurrences[0], now)).toMatchObject({
      deliveryStatus: 'received_late',
      acceptedCount: 1,
    });
    expect(() =>
      matchReportReceipt(
        state,
        id,
        receipt({
          documentId: '10000000-0000-4000-8000-000000000003',
          supersedesReceiptId: originalId,
        }),
        actor,
      ),
    ).toThrow(/remain matched/);
  });
});

describe('exception review, snooze, disposition and evidence history', () => {
  it('preserves a complete 3000-character disposition reason in generated history', () => {
    let state = evaluate();
    const reason = 'R'.repeat(3000);
    state = disposeReportOccurrence(
      state,
      state.occurrences[0].id,
      { status: 'waived', reason, evidence: note },
      actor,
    );
    state = evaluate(state);
    expect(state.occurrences[0].disposition?.reason).toBe(reason);
    expect(state.exceptions[0].history.at(-1)?.reason).toContain(reason);
  });
  it('preserves assignment, manual priority and snooze on unchanged worker evaluations', () => {
    let state = evaluate();
    const id = state.exceptions[0].id;
    state = actOnReportException(
      state,
      id,
      {
        action: 'assign',
        assigneeUserId: 'reviewer-2',
        reason: 'Assigned by the office operations lead.',
      },
      actor,
    );
    state = actOnReportException(
      state,
      id,
      {
        action: 'priority',
        priority: 'urgent',
        reason: 'Required for the quarterly close.',
      },
      actor,
    );
    state = actOnReportException(
      state,
      id,
      {
        action: 'snooze',
        until: '2026-03-12T12:00:00.000Z',
        reason: 'Manager committed to delivery on Thursday.',
      },
      actor,
    );
    expect(evaluate(state)).toEqual(state);
    expect(state.exceptions[0]).toMatchObject({
      status: 'snoozed',
      assigneeUserId: 'reviewer-2',
      priority: 'urgent',
    });
    const woke = evaluate(state, '2026-03-12T12:00:00.000Z');
    expect(woke.exceptions[0]).toMatchObject({
      status: 'open',
      snoozedUntil: null,
      assigneeUserId: 'reviewer-2',
      priority: 'urgent',
    });
    expect(woke.exceptions[0].history.at(-1)?.action).toBe('snooze_expired');
  });
  it('does not erase the underlying calendar gap when an exception is waived', () => {
    let state = evaluate();
    state = actOnReportException(
      state,
      state.exceptions[0].id,
      {
        action: 'waive',
        reason: 'Reviewed waiver for this reporting period.',
        evidence: note,
      },
      actor,
    );
    const repeated = evaluate(state);
    expect(repeated.exceptions[0]).toMatchObject({
      status: 'waived',
      sourceActive: true,
    });
    expect(
      summarizeReportOccurrence(repeated.occurrences[0], now).deliveryStatus,
    ).toBe('overdue');
    expect(repeated.exceptions[0].history).toHaveLength(2);
  });
  it('reopens a resolved source issue on relevant new evidence without creating another issue', () => {
    let state = evaluateReportObligations(emptyReportObligationsState(), {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [signal()],
    });
    const id = state.exceptions[0].id;
    state = actOnReportException(
      state,
      id,
      {
        action: 'resolve',
        reason: 'The reported figure was independently reconciled.',
        evidence: note,
      },
      actor,
    );
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [signal()],
    });
    expect(state.exceptions[0].status).toBe('resolved');
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [signal({ evidenceFingerprint: 'document-1:fact-2:corrected' })],
    });
    expect(state.exceptions).toHaveLength(1);
    expect(state.exceptions[0]).toMatchObject({ id, status: 'open' });
    expect(state.exceptions[0].history.at(-1)?.action).toBe(
      'reopened_by_evidence',
    );
  });
  it('retains out-of-window sources unless an explicit inactive signal or complete snapshot closes them', () => {
    let state = evaluateReportObligations(emptyReportObligationsState(), {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [signal()],
    });
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [],
    });
    expect(state.exceptions[0].status).toBe('open');
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [signal({ sourceActive: false })],
    });
    expect(state.exceptions[0].status).toBe('resolved');
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [signal()],
    });
    expect(state.exceptions[0].status).toBe('open');
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [],
      externalSignalsComplete: true,
    });
    expect(state.exceptions[0].status).toBe('resolved');
  });
  it('protects calendar issue identities and refuses conflicting duplicate issue signals', () => {
    expect(() =>
      evaluateReportObligations(emptyReportObligationsState(), {
        from: '2026-01-01',
        through: '2026-03-01',
        now,
        issues: [signal(), signal()],
      }),
    ).toThrow(/once/);
    expect(() =>
      evaluateReportObligations(emptyReportObligationsState(), {
        from: '2026-01-01',
        through: '2026-03-01',
        now,
        issues: [signal({ key: 'delivery:occ:schedule:date' })],
      }),
    ).toThrow(/impersonate/);
  });
  it('keeps reviewed cancellations in the occurrence and delivery issue history', () => {
    let state = evaluate();
    const id = state.occurrences[0].id;
    state = disposeReportOccurrence(
      state,
      id,
      {
        status: 'cancelled',
        reason:
          'Manager confirmed the fund was closed before this reporting period.',
        evidence: note,
      },
      actor,
    );
    state = evaluate(state);
    expect(
      summarizeReportOccurrence(state.occurrences[0], now).deliveryStatus,
    ).toBe('cancelled');
    expect(state.exceptions[0]).toMatchObject({
      status: 'resolved',
      sourceActive: false,
    });
    expect(state.occurrences[0].receipts).toHaveLength(0);
    state = disposeReportOccurrence(
      state,
      id,
      {
        status: 'reopen',
        reason: 'The fund remained active through this period.',
        evidence: note,
      },
      actor,
    );
    state = evaluate(state);
    expect(state.exceptions[0].status).toBe('open');
    expect(state.occurrences[0].history.map((entry) => entry.action)).toEqual([
      'obligation_cancelled',
      'obligation_reopened',
    ]);
  });
  it('requires evidence for explicit dispositions and a future bounded snooze time', () => {
    const state = evaluate();
    const id = state.exceptions[0].id;
    expect(() =>
      actOnReportException(
        state,
        id,
        { action: 'resolve', reason: 'Reviewed', evidence: [] },
        actor,
      ),
    ).toThrow();
    expect(() =>
      actOnReportException(
        state,
        id,
        { action: 'snooze', until: now, reason: 'Wait for manager' },
        actor,
      ),
    ).toThrow(/wake time/);
    expect(() =>
      actOnReportException(
        state,
        id,
        {
          action: 'snooze',
          until: '2030-01-01T00:00:00.000Z',
          reason: 'Wait for manager',
        },
        actor,
      ),
    ).toThrow(/wake time/);
  });
  it('preserves manually raised conflicts when the external source snapshot is complete', () => {
    let state = addManualReportException(
      emptyReportObligationsState(),
      signal({ key: 'manual:conflict-1', category: 'conflicting_fact' }),
      actor,
    );
    state = evaluateReportObligations(state, {
      from: '2026-01-01',
      through: '2026-03-01',
      now,
      issues: [],
      externalSignalsComplete: true,
    });
    expect(state.exceptions[0]).toMatchObject({
      origin: 'manual',
      status: 'open',
    });
  });
});
