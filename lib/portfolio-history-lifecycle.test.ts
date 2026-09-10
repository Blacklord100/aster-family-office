import { describe, expect, it } from 'vitest';
import {
  appendHistoryLifecycle,
  lifecycleAt,
  historyPositionDetails,
} from './portfolio-history-lifecycle';
import { projectPortfolioHistory } from './portfolio-history';
import { emptyFinanceState } from './ledger-contract';
import type { Holding } from '@/data/types';
import type { PortfolioRecords } from './workspace';
function fixture() {
  const holding: Holding = {
    id: 'h',
    name: 'Fund',
    familyId: 'f',
    entityId: 'e',
    accountId: 'a',
    assetClass: 'Private equity',
    currency: 'EUR',
    valueEUR: 120,
    originalValue: 120,
    syntheticFXRateToEUR: 1,
    costBasisEUR: 0,
    unfundedCommitmentEUR: 0,
    liquidityBucket: '3+ years',
    valuationDate: '2026-06-30',
    sourceId: 's',
    geography: '',
    manager: 'Manager',
    description: '',
    color: '',
    valuationMethod: 'Reported fund NAV',
  };
  const portfolio: PortfolioRecords = {
    holdings: [holding],
    history: [],
    events: [],
    tasks: [],
    families: [
      {
        id: 'f',
        name: 'Family',
        initials: 'F',
        principal: '',
        location: '',
        color: '',
      },
    ],
    entities: [
      {
        id: 'e',
        familyId: 'f',
        name: 'Entity',
        type: 'Trust',
        jurisdiction: '',
        ownershipPercent: 100,
      },
    ],
    accounts: [
      {
        id: 'a',
        entityId: 'e',
        familyId: 'f',
        name: 'Account',
        institution: '',
        maskedNumber: '',
        type: 'Private investments',
      },
    ],
    evidence: [
      {
        id: 's',
        documentId: '00000000-0000-4000-8000-000000000001',
        familyId: 'f',
        holdingId: 'h',
        mailboxId: '',
        subject: '',
        sender: '',
        receivedAt: '2026-09-09T10:00:00Z',
        effectiveDate: '2026-03-31',
        filename: 'source.pdf',
        page: 1,
        excerpt: 'Subscription completed on March 31',
        status: 'Accepted',
        synthetic: false,
      },
    ],
  };
  const command = {
    holdingId: 'h',
    kind: 'opened' as const,
    effectiveDate: '2026-03-31',
    details: historyPositionDetails(holding),
    sourceId: 's',
    evidenceVerified: true as const,
    page: 1,
    quote: 'Subscription completed on March 31',
    reason: 'Reviewed subscription completion notice',
  };
  const meta = {
    id: 'open',
    at: '2026-09-09T11:00:00Z',
    actorId: 'reviewer',
    sourceSha256: 'a'.repeat(64),
  };
  return { portfolio, holding, command, meta };
}
describe('sourced economic lifecycle', () => {
  it('records acquisition, exit and classification without changing money or current identity', () => {
    const f = fixture(),
      before = structuredClone(f.portfolio);
    const opened = appendHistoryLifecycle(
      f.portfolio,
      undefined,
      f.command,
      f.meta,
    );
    const classified = appendHistoryLifecycle(
      f.portfolio,
      opened.state,
      {
        ...f.command,
        kind: 'classified',
        effectiveDate: '2026-04-30',
        details: { ...f.command.details, manager: 'New manager' },
      },
      { ...f.meta, id: 'classification' },
    );
    const closed = appendHistoryLifecycle(
      f.portfolio,
      classified.state,
      {
        ...f.command,
        kind: 'closed',
        details: undefined,
        effectiveDate: '2026-07-01',
      },
      { ...f.meta, id: 'close' },
    );
    expect(lifecycleAt(closed.state, 'h', '2026-03-01')).toMatchObject({
      ownership: 'not_yet_opened',
      details: null,
    });
    expect(lifecycleAt(closed.state, 'h', '2026-06-01')).toMatchObject({
      ownership: 'owned',
      details: { manager: 'New manager' },
    });
    expect(lifecycleAt(closed.state, 'h', '2026-07-01').ownership).toBe(
      'closed',
    );
    expect(f.portfolio).toEqual(before);
    expect(opened.state.records).toHaveLength(1);
  });
  it('keeps corrections append-only and reconstructs knowledge before acceptance', () => {
    const f = fixture();
    const first = appendHistoryLifecycle(
      f.portfolio,
      undefined,
      f.command,
      f.meta,
    );
    const revised = appendHistoryLifecycle(
      f.portfolio,
      first.state,
      { ...f.command, correctionOf: 'open', effectiveDate: '2026-04-01' },
      { ...f.meta, id: 'correct', at: '2026-09-10T10:00:00Z' },
    );
    expect(revised.state.records).toHaveLength(2);
    expect(lifecycleAt(revised.state, 'h', '2026-03-31').ownership).toBe(
      'not_yet_opened',
    );
    expect(
      lifecycleAt(revised.state, 'h', '2026-03-31', '2026-09-09T12:00:00Z')
        .ownership,
    ).toBe('owned');
    expect(
      lifecycleAt(revised.state, 'h', '2026-03-31', '2026-09-08T12:00:00Z')
        .ownership,
    ).toBe('unknown');
  });
  it('does not infer ownership from the first value or old ledger openingDate', () => {
    const f = fixture();
    const finance = emptyFinanceState();
    finance.holdings.h = {
      holdingId: 'h',
      openingDate: '2020-01-01',
      originalAmount: '100',
      pendingCapitalEUR: 0,
      source: { reference: 'Legacy', date: '2020-01-01' },
    };
    const result = projectPortfolioHistory(f.portfolio, finance, {
      cohort: 'historical',
      asOf: '2026-06-30',
    });
    expect(result.positions[0]).toMatchObject({
      economicOpenedAt: null,
      ownership: 'unknown',
      lifecycleCoverage: 'unknown',
    });
    expect(result.summary.coverage.totalCount).toBe(1);
  });
  it('includes an exited registered position in earlier projections and excludes it after its evidenced exit', () => {
    const f = fixture();
    const opened = appendHistoryLifecycle(
      f.portfolio,
      undefined,
      f.command,
      f.meta,
    );
    const closed = appendHistoryLifecycle(
      f.portfolio,
      opened.state,
      {
        ...f.command,
        kind: 'closed',
        details: undefined,
        effectiveDate: '2026-07-01',
      },
      { ...f.meta, id: 'closed' },
    );
    const finance = emptyFinanceState();
    finance.valuations.push({
      id: 'v',
      holdingId: 'h',
      amount: '100',
      valueEUR: 100,
      currency: 'EUR',
      effectiveDate: '2026-06-30',
      sourceId: 's',
      actorId: 'reviewer',
      recordedAt: f.meta.at,
      valuationMethod: 'Reported fund NAV',
    });
    expect(
      projectPortfolioHistory(
        f.portfolio,
        finance,
        { cohort: 'historical', asOf: '2026-06-30' },
        { revision: 2, lifecycle: closed.state },
      ).summary.amount,
    ).toBe('100.00');
    const after = projectPortfolioHistory(
      f.portfolio,
      finance,
      { cohort: 'historical', asOf: '2026-07-01' },
      { revision: 2, lifecycle: closed.state },
    );
    expect(after.summary.amount).toBeNull();
    expect(after.summary.coverage.totalCount).toBe(0);
    expect(after.positions[0].ownership).toBe('closed');
    expect(after.positions[0].latest).toBeNull();
    expect(after.positions[0].latestReported?.amount).toBe('100.00');
    const currentCohort = projectPortfolioHistory(
      f.portfolio,
      finance,
      { cohort: 'current', asOf: '2026-06-30' },
      { revision: 2, lifecycle: closed.state, now: '2026-09-10T00:00:00Z' },
    );
    expect(currentCohort.summary.amount).toBeNull();
    expect(currentCohort.summary.coverage.totalCount).toBe(0);
    expect(currentCohort.observations).toHaveLength(1);
  });
  it('requires a retained accepted same-position source and prevents disguised ownership transfers', () => {
    const f = fixture();
    f.portfolio.evidence[0].synthetic = true;
    expect(() =>
      appendHistoryLifecycle(f.portfolio, undefined, f.command, f.meta),
    ).toThrow('accepted retained source');
    f.portfolio.evidence[0].synthetic = false;
    expect(() =>
      appendHistoryLifecycle(
        f.portfolio,
        undefined,
        { ...f.command, details: { ...f.command.details, familyId: 'other' } },
        f.meta,
      ),
    ).toThrow('same legal owner');
  });
  it('rejects accidental duplicate openings, invalid corrections and inverted economic periods', () => {
    const f = fixture();
    const opened = appendHistoryLifecycle(
      f.portfolio,
      undefined,
      f.command,
      f.meta,
    );
    expect(() =>
      appendHistoryLifecycle(f.portfolio, opened.state, f.command, {
        ...f.meta,
        id: 'another',
      }),
    ).toThrow('already exists');
    expect(() =>
      appendHistoryLifecycle(
        f.portfolio,
        opened.state,
        { ...f.command, correctionOf: 'not-in-this-position' },
        { ...f.meta, id: 'another' },
      ),
    ).toThrow('active lifecycle record');
    expect(() =>
      appendHistoryLifecycle(
        f.portfolio,
        opened.state,
        {
          ...f.command,
          kind: 'closed',
          details: undefined,
          effectiveDate: '2026-02-01',
        },
        { ...f.meta, id: 'another' },
      ),
    ).toThrow('later than');
  });
});

describe('lifecycle scope', () => {
  it('requires both permitted legal ownership and released original bytes, with no idempotency receipts', async () => {
    const { scopeWorkspace } = await import('./data-scope');
    const { initialWorkspace } = await import('./workspace');
    const f = fixture();
    const opened = appendHistoryLifecycle(
      f.portfolio,
      undefined,
      f.command,
      f.meta,
    );
    opened.state.receipts.push({
      key: 'private-key',
      digest: 'private-digest',
      resultId: 'open',
    });
    const state = {
      ...initialWorkspace(false),
      portfolio: f.portfolio,
      historyLifecycle: opened.state,
    };
    expect(
      scopeWorkspace(state, { familyIds: ['f'] }).historyLifecycle?.records,
    ).toHaveLength(0);
    const allowed = scopeWorkspace(
      state,
      { familyIds: ['f'] },
      new Set([f.portfolio.evidence[0].documentId!]),
    );
    expect(allowed.historyLifecycle?.records).toHaveLength(1);
    expect(allowed.historyLifecycle?.receipts).toEqual([]);
    expect(
      scopeWorkspace(
        state,
        { familyIds: ['other'] },
        new Set([f.portfolio.evidence[0].documentId!]),
      ).historyLifecycle?.records,
    ).toHaveLength(0);
    state.historyLifecycle.records[0].details!.entityId = 'other-entity';
    expect(
      scopeWorkspace(
        state,
        { familyIds: ['f'], entityIds: ['e'] },
        new Set([f.portfolio.evidence[0].documentId!]),
      ).historyLifecycle?.records,
    ).toHaveLength(0);
  });
});
