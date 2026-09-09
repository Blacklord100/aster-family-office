import { describe, expect, it } from 'vitest';
import {
  emptyReportObligationsState,
  type ReportScheduleInput,
} from './report-obligations-contract';
import {
  createReportSchedule,
  evaluateReportObligations,
  matchReportReceipt,
} from './report-obligations';
import { scopeReportObligations } from './report-obligations-scope';

const now = '2026-09-09T12:00:00.000Z';
const docA = '10000000-0000-4000-8000-000000000001',
  docB = '10000000-0000-4000-8000-000000000002';
const definition: ReportScheduleInput = {
  name: 'Scoped report',
  holdingIds: ['holding-a'],
  familyIds: ['family-a'],
  managerId: null,
  reportType: 'nav_statement',
  cadence: 'monthly',
  firstPeriodStart: '2026-01-01',
  oneOffPeriodEnd: null,
  timezone: 'UTC',
  dueDaysAfterPeriodEnd: 15,
  dueLocalTime: '17:00',
  graceHours: 0,
  ownerUserId: 'reviewer',
  staleAfterDays: null,
};
function state() {
  const configured = createReportSchedule(
    emptyReportObligationsState(),
    definition,
    { actorUserId: 'reviewer', now, id: 'schedule' },
  );
  return evaluateReportObligations(configured, {
    from: '2026-01-01',
    through: '2026-01-01',
    now,
  });
}
const view = (
  input = state(),
  documents = new Set<string>(),
  reviews = new Map<string, string>(),
) => scopeReportObligations(input, new Set(['holding-a']), documents, reviews);

describe('complete-record reporting scope', () => {
  it('shows a permitted expectation and hides another office or office-wide issue', () => {
    const input = state();
    expect(view(input).occurrences).toHaveLength(1);
    expect(
      scopeReportObligations(
        input,
        new Set(['holding-b']),
        new Set(),
        new Map(),
      ).schedules,
    ).toHaveLength(0);
    input.exceptions[0].holdingIds = [];
    input.exceptions[0].familyIds = [];
    expect(view(input).exceptions).toHaveLength(0);
  });
  it('withholds an entire schedule and its occurrences when a historical version covers another holding', () => {
    const input = state();
    input.schedules[0].versions.push({
      ...structuredClone(input.schedules[0].versions[0]),
      id: 'schedule:v2',
      version: 2,
      definition: {
        ...definition,
        holdingIds: ['holding-b'],
        familyIds: ['family-b'],
      },
    });
    expect(view(input)).toEqual(emptyReportObligationsState());
  });
  it('withholds a whole occurrence until every current and historical document is released', () => {
    let input = state();
    const id = input.occurrences[0].id;
    input = matchReportReceipt(
      input,
      id,
      {
        documentId: docA,
        documentHash: 'a'.repeat(64),
        holdingIds: ['holding-a'],
        reportType: 'nav_statement',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        asOfDate: '2026-01-31',
        receivedAt: now,
        processingStatus: 'completed',
        reviewStatus: 'pending',
        matchReason: 'Reviewed original reporting period and investor.',
        matchEvidence: [{ kind: 'document', id: docA }],
        supersedesReceiptId: null,
      },
      { actorUserId: 'reviewer', now },
    );
    input.occurrences[0].history.push({
      at: now,
      actorUserId: 'reviewer',
      action: 'review',
      reason: 'Prior supporting document',
      evidence: [{ kind: 'document', id: docB }],
      evidenceFingerprint: null,
    });
    expect(view(input, new Set([docA])).occurrences).toHaveLength(0);
    expect(view(input, new Set([docA, docB])).occurrences).toHaveLength(1);
  });
  it('checks explicit receipt coverage beyond the occurrence subset', () => {
    let input = state();
    input = matchReportReceipt(
      input,
      input.occurrences[0].id,
      {
        documentId: docA,
        documentHash: 'a'.repeat(64),
        holdingIds: ['holding-a', 'holding-b'],
        reportType: 'nav_statement',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        asOfDate: '2026-01-31',
        receivedAt: now,
        processingStatus: 'completed',
        reviewStatus: 'pending',
        matchReason: 'Reviewed a report explicitly covering two investors.',
        matchEvidence: [{ kind: 'document', id: docA }],
        supersedesReceiptId: null,
      },
      { actorUserId: 'reviewer', now },
    );
    expect(view(input, new Set([docA])).occurrences).toHaveLength(0);
    expect(
      scopeReportObligations(
        input,
        new Set(['holding-a', 'holding-b']),
        new Set([docA]),
        new Map(),
      ).occurrences,
    ).toHaveLength(1);
  });
  it('requires released-document binding for historical review IDs', () => {
    const input = state();
    input.exceptions[0].history[0].evidence.push({
      kind: 'review',
      id: 'old-job',
    });
    expect(view(input, new Set([docA])).exceptions).toHaveLength(0);
    expect(
      view(input, new Set([docA]), new Map([['old-job', docB]])).exceptions,
    ).toHaveLength(0);
    expect(
      view(input, new Set([docA]), new Map([['old-job', docA]])).exceptions,
    ).toHaveLength(1);
  });
  it('does not guess the document scope of opaque fact IDs or hidden historical holding references', () => {
    const input = state();
    input.exceptions[0].history[0].evidence.push({
      kind: 'fact',
      id: 'opaque-fact-id',
    });
    expect(view(input).exceptions).toHaveLength(0);
    input.exceptions[0].history[0].evidence = [
      { kind: 'holding', id: 'holding-b' },
    ];
    expect(view(input).exceptions).toHaveLength(0);
  });
});
