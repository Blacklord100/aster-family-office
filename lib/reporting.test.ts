import { describe, it, expect } from 'vitest';
import { holdings } from '@/data/portfolio';
import type { Holding } from '@/data/types';
import type { PortfolioRecords } from './workspace';
import {
  emptyFinanceState,
  type LedgerCommand,
  type LedgerMeta,
} from './ledger-contract';
import {
  applyLedgerAction,
  cashflowCoverageCurrent,
  postReviewedValuation,
} from './ledger';
import {
  evaluatePeriod,
  modifiedDietz,
  scopedReportingInputs,
  scopedRiskData,
  currentStressInputs,
} from './reporting';
import { currentRiskHoldings } from './family-exposure';
import {
  buildTotalExposure,
  RISK_PRESETS,
  runStressScenario,
} from './risk-engine';
import {
  emptyHistoryLifecycle,
  type HistoryLifecycleRecord,
} from './portfolio-history-lifecycle-contract';
import { historyPositionDetails } from './portfolio-history-lifecycle';
import type { PeriodQuery } from './reporting-contract';
const at = '2026-09-10T12:00:00Z';
const meta = (id: string): LedgerMeta => ({ id, actorId: 'reviewer', at });
const source = { reference: 'Synthetic bank statement', date: '2026-09-10' };
const query: PeriodQuery = {
  familyIds: ['family'],
  from: '2026-09-01',
  to: '2026-09-10',
  liquidityAsOf: '2026-09-10',
  liquidityThrough: '2026-09-30',
};
const h = (
  id: string,
  assetClass: Holding['assetClass'],
  value: number,
): Holding => ({
  ...holdings[0],
  id,
  name: id,
  familyId: 'family',
  entityId: 'entity',
  accountId: 'account',
  assetClass,
  currency: 'EUR',
  valueEUR: value,
  originalValue: value,
  costBasisEUR: value,
  unfundedCommitmentEUR: 0,
  valuationDate: '2026-09-01',
  sourceId: 'source-' + id,
  valuationMethod: assetClass === 'Cash' ? 'Cash balance' : 'Reported fund NAV',
});
function records(): PortfolioRecords {
  const positions = [h('cash', 'Cash', 500), h('fund', 'Private equity', 1000)];
  return {
    holdings: positions,
    history: positions.map((row) => ({
      holdingId: row.id,
      date: '2026-09-01',
      valueEUR: row.valueEUR,
      netExternalFlowEUR: 0,
      valuationBasis: 'Reported mark',
      flowCoverage: 'unknown',
    })),
    events: [],
    tasks: [],
    evidence: positions.map((row) => ({
      id: row.sourceId,
      holdingId: row.id,
      familyId: 'family',
      mailboxId: 'manual',
      subject: 'Source mark',
      sender: 'reviewer',
      receivedAt: at,
      effectiveDate: '2026-09-01',
      filename: 'source.pdf',
      page: 1,
      excerpt: 'Synthetic test evidence',
      status: 'Accepted',
      synthetic: false,
    })),
    families: [
      {
        id: 'family',
        name: 'Family',
        initials: 'F',
        principal: '',
        location: '',
        color: '#000',
      },
    ],
    entities: [
      {
        id: 'entity',
        familyId: 'family',
        name: 'Entity',
        type: 'Holding company',
        jurisdiction: 'Finland',
        ownershipPercent: 100,
      },
    ],
    accounts: [
      {
        id: 'account',
        entityId: 'entity',
        familyId: 'family',
        name: 'Cash account',
        institution: 'Bank',
        maskedNumber: '',
        type: 'Custody',
      },
    ],
  };
}
function fixture(recordDeposit = true) {
  let state = { portfolio: records(), finance: emptyFinanceState() };
  state.finance.accounts.account = {
    accountId: 'account',
    currency: 'EUR',
    restricted: false,
    restrictionNote: '',
  };
  for (const holding of state.portfolio.holdings)
    state = postReviewedValuation(
      state.portfolio,
      state.finance,
      {
        holdingId: holding.id,
        amount: holding.valueEUR.toFixed(2),
        currency: 'EUR',
        effectiveDate: query.from,
        sourceId: holding.sourceId,
      },
      meta('opening-' + holding.id),
    );
  if (recordDeposit) {
    const deposit: LedgerCommand = {
      type: 'recordTransaction',
      kind: 'deposit',
      cashHoldingId: 'cash',
      amount: '100',
      currency: 'EUR',
      dueDate: '2026-09-05',
      source,
      evidenceVerified: true,
      investmentEffect: 'none',
      investmentCostBasisEUR: '0',
      commitmentEffect: 'none',
      commitmentAmountEUR: '0',
      memo: '',
    };
    state = applyLedgerAction(
      state.portfolio,
      state.finance,
      deposit,
      meta('deposit'),
    );
    state = applyLedgerAction(
      state.portfolio,
      state.finance,
      {
        type: 'settleTransaction',
        transactionId: 'deposit',
        date: '2026-09-05',
        source,
        evidenceVerified: true,
      },
      meta('settled'),
    );
  }
  for (const [holdingId, amount] of [
    ['cash', '600'],
    ['fund', '1100'],
  ])
    state = postReviewedValuation(
      state.portfolio,
      state.finance,
      {
        holdingId,
        amount,
        currency: 'EUR',
        effectiveDate: query.to,
        sourceId: 'source-' + holdingId,
      },
      meta('closing-' + holdingId),
    );
  state = applyLedgerAction(
    state.portfolio,
    state.finance,
    {
      type: 'reconcilePeriod',
      entityId: 'entity',
      from: query.from,
      to: query.to,
      cashHoldingIds: ['cash'],
      closingBalances: [{ holdingId: 'cash', amount: '600', valueEUR: '600' }],
      source,
      evidenceVerified: true,
    },
    meta('coverage'),
  );
  return state;
}
describe('custom-period financial truth', () => {
  it('calculates only with exact sourced marks, reconciled native cash and complete external flows', () => {
    const state = fixture(),
      result = evaluatePeriod(state.portfolio, state.finance, query, at);
    expect(result.gaps).toEqual([]);
    expect(result.openingValueEUR).toBe(1500);
    expect(result.closingValueEUR).toBe(1700);
    expect(result.netExternalFlowEUR).toBe(100);
    expect(result.investmentResultEUR).toBe(100);
    expect(result.cashReconciliation[0].residualNative).toBe(0);
    expect(result.returnEstimate.valuePercent).toBeCloseTo(
      (100 / (1500 + (100 * 5) / 9)) * 100,
      10,
    );
  });
  it('does not substitute zero flows or interpolate missing dates', () => {
    const state = fixture();
    state.finance.coverage = [];
    const unknown = evaluatePeriod(state.portfolio, state.finance, query, at);
    expect(unknown.knownExternalFlowEUR).toBe(100);
    expect(unknown.netExternalFlowEUR).toBeNull();
    expect(unknown.returnEstimate.valuePercent).toBeNull();
    const missing = evaluatePeriod(
      state.portfolio,
      state.finance,
      { ...query, from: '2026-09-02' },
      at,
    );
    expect(missing.openingValueEUR).toBeNull();
    expect(missing.knownOpeningValueEUR).toBe(0);
    expect(
      missing.gaps.some((g) => g.includes('no accepted source mark')),
    ).toBe(true);
  });
  it('detects balance corrections masquerading as an unrecorded deposit despite a statement attestation', () => {
    const state = fixture(false),
      result = evaluatePeriod(state.portfolio, state.finance, query, at);
    expect(result.cashReconciliation[0]).toMatchObject({
      recordedMovementsNative: 0,
      residualNative: 100,
      coverageId: 'coverage',
    });
    expect(result.returnEstimate.valuePercent).toBeNull();
    expect(result.investmentResultEUR).toBeNull();
  });
  it('rejects synthetic evidence, future periods and out-of-scope entity references', () => {
    const state = fixture();
    state.portfolio.evidence.forEach((e) => {
      e.synthetic = true;
    });
    expect(
      evaluatePeriod(state.portfolio, state.finance, query, at).returnEstimate
        .valuePercent,
    ).toBeNull();
    expect(() =>
      evaluatePeriod(records(), undefined, { ...query, to: '2026-09-11' }, at),
    ).toThrow(/today/);
    expect(() =>
      evaluatePeriod(
        records(),
        undefined,
        { ...query, entityIds: ['foreign'] },
        at,
      ),
    ).toThrow(/selected families/);
  });
  it('makes end-of-day weighting, nonpositive capital, withdrawals and zero/extreme bounds explicit', () => {
    expect(
      modifiedDietz(
        100,
        220,
        [{ date: query.to, amountEUR: 100 }],
        query.from,
        query.to,
      ).valuePercent,
    ).toBe(20);
    expect(
      modifiedDietz(
        100,
        60,
        [{ date: query.to, amountEUR: -50 }],
        query.from,
        query.to,
      ).valuePercent,
    ).toBe(10);
    expect(
      modifiedDietz(0, 0, [], query.from, query.to).valuePercent,
    ).toBeNull();
    expect(
      modifiedDietz(1e12, 1e12, [], query.from, query.to).valuePercent,
    ).toBe(0);
    expect(
      modifiedDietz(
        100,
        100,
        [{ date: query.from, amountEUR: 10 }],
        query.from,
        query.to,
      ).valuePercent,
    ).toBeNull();
  });
  it('preserves coverage freshness when snapshot scope removes unrelated ledger entries', () => {
    const state = fixture(),
      original = state.finance.events[0];
    state.finance.events.unshift({
      ...original,
      id: 'foreign-event',
      transactionId: 'foreign-tx',
      postings: [{ ...original.postings[0], holdingId: 'foreign-cash' }],
    });
    state.finance.coverage[0].eventCount += 1;
    const scoped = scopedReportingInputs(state.portfolio, state.finance, query);
    expect(scoped.finance.events).toHaveLength(1);
    expect(scoped.finance.coverage[0].eventCount).toBe(1);
    expect(
      cashflowCoverageCurrent(
        scoped.finance,
        scoped.portfolio,
        scoped.finance.coverage[0],
      ),
    ).toBe(true);
    state.finance.events.push({
      ...original,
      id: 'later-post',
      date: '2026-09-08',
    });
    const stale = scopedReportingInputs(state.portfolio, state.finance, query);
    expect(
      cashflowCoverageCurrent(
        stale.finance,
        stale.portfolio,
        stale.finance.coverage[0],
      ),
    ).toBe(false);
  });
});
describe('dated liquidity and snapshot scoping', () => {
  it('uses the risk view’s exact current cohort and known NAV, with scoped lifecycle evidence', () => {
    const state = fixture(),
      future = {
        ...h('future', 'Private equity', 400),
        sourceId: 'future-source',
      },
      unknown = {
        ...h('unknown', 'Private equity', 999_900),
        valuationStatus: 'unknown' as const,
      },
      hidden = {
        ...h('hidden', 'Private equity', 8000),
        familyId: 'hidden-family',
      };
    state.portfolio.holdings.push(future, unknown, hidden);
    const lifecycle = emptyHistoryLifecycle();
    const record = (
      holding: Holding,
      kind: 'opened' | 'closed',
      effectiveDate: string,
    ): HistoryLifecycleRecord => ({
      id: kind + holding.id,
      holdingId: holding.id,
      kind,
      effectiveDate,
      recordedAt: at,
      actorId: 'reviewer',
      registeredDetails: historyPositionDetails(holding),
      details: null,
      sourceId: holding.sourceId,
      documentId: 'doc-' + holding.id,
      sourceSha256: 'a'.repeat(64),
      page: 1,
      quote: 'Sourced ownership declaration.',
      reason: 'Synthetic financial consistency regression.',
      correctionOf: null,
    });
    lifecycle.records = [
      record(state.portfolio.holdings[1], 'closed', '2026-09-09'),
      record(future, 'opened', '2026-10-01'),
      record(hidden, 'closed', '2026-09-09'),
    ];
    const inputs = currentStressInputs(
      state.portfolio,
      query,
      undefined,
      lifecycle,
      query.to,
    );
    expect(inputs.holdings.map((holding) => holding.id)).toEqual([
      'cash',
      'unknown',
    ]);
    expect(inputs.ownershipBasis).toEqual({
      asOfDate: query.to,
      excludedCount: 2,
      unknownOwnershipCount: 2,
    });
    expect(JSON.stringify(inputs)).not.toContain('hidden');
    expect(inputs.lifecycle?.records).toHaveLength(2);
    const riskView = runStressScenario(
      buildTotalExposure(
        currentRiskHoldings(
          state.portfolio.holdings.filter(
            (holding) => holding.familyId === 'family',
          ),
          lifecycle,
          query.to,
        ).holdings,
        inputs.riskData,
        query.to,
      ),
      RISK_PRESETS[0],
    );
    const preview = runStressScenario(
      buildTotalExposure(inputs.holdings, inputs.riskData, inputs.asOfDate),
      RISK_PRESETS[0],
    );
    expect(preview).toEqual(riskView);
    expect(preview.beforeEUR).toBe(600);
    expect(
      preview.warnings.some(
        (warning) => warning.code === 'VALUATION_COVERAGE_INCOMPLETE',
      ),
    ).toBe(true);
    lifecycle.records[0].effectiveDate = '2027-01-01';
    expect(inputs.lifecycle?.records[0].effectiveDate).toBe('2026-09-09');
  });
  it('excludes future inflows into restricted accounts and exposes newly blocked obligations', () => {
    const state = fixture();
    state.finance.accounts.account.restricted = true;
    state.finance.transactions.push({
      ...state.finance.transactions[0],
      id: 'future-deposit',
      dueDate: '2026-09-15',
    });
    const incoming = evaluatePeriod(state.portfolio, state.finance, query, at)
      .liquidity[0];
    expect(incoming.reviewedInflowsNative).toBe(100);
    expect(incoming.projectedAvailableNative).toBe(0);
    state.finance.transactions.push({
      ...state.finance.transactions[0],
      id: 'future-withdrawal',
      kind: 'withdrawal',
      dueDate: '2026-09-15',
    });
    const blocked = evaluatePeriod(state.portfolio, state.finance, query, at)
      .liquidity[0];
    expect(blocked.blockedObligationCount).toBe(1);
    expect(blocked.projectedAvailableNative).toBeNull();
  });
  it('includes overdue reviewed calls without changing investment performance or pooling entities/currencies', () => {
    const state = fixture();
    state.finance.transactions.push({
      id: 'pending',
      kind: 'capital_call',
      holdingId: 'fund',
      cashHoldingId: 'cash',
      amount: '200',
      currency: 'EUR',
      amountEUR: 200,
      dueDate: '2026-09-09',
      source,
      investmentEffect: 'increase',
      investmentAmount: '200',
      investmentCostBasisEUR: 200,
      commitmentEffect: 'none',
      commitmentAmountEUR: 0,
      reviewedBy: 'reviewer',
      reviewedAt: at,
      memo: '',
    });
    const other = {
      ...h('other-cash', 'Cash', 900),
      entityId: 'other',
      accountId: 'other-account',
      currency: 'GBP' as const,
    };
    state.portfolio.holdings.push(other);
    state.portfolio.entities.push({
      ...state.portfolio.entities[0],
      id: 'other',
      name: 'Other entity',
    });
    const result = evaluatePeriod(state.portfolio, state.finance, query, at);
    expect(result.liquidity.find((g) => g.currency === 'EUR')).toMatchObject({
      recordedCashNative: 600,
      reviewedOutflowsNative: 200,
      overdueOutflowsNative: 200,
      projectedAvailableNative: 400,
    });
    expect(result.liquidity.find((g) => g.currency === 'GBP')).toMatchObject({
      recordedCashNative: 900,
      restrictionUnknownAccountCount: 1,
      projectedAvailableNative: null,
    });
    expect(
      evaluatePeriod(
        state.portfolio,
        state.finance,
        { ...query, liquidityCurrencies: ['EUR'] },
        at,
      ).liquidity,
    ).toHaveLength(1);
  });
  it('does not project availability for a zero-balance account with unknown restrictions or unavailable historical cash', () => {
    const state = fixture();
    delete state.finance.accounts.account;
    state.portfolio.holdings[0].originalValue = 0;
    expect(
      evaluatePeriod(state.portfolio, state.finance, query, at).liquidity[0]
        .projectedAvailableNative,
    ).toBeNull();
    state.finance.valuations = [];
    const past = evaluatePeriod(
      state.portfolio,
      state.finance,
      { ...query, liquidityAsOf: '2026-09-02' },
      at,
    );
    expect(past.liquidity[0].unavailableBalanceCount).toBe(1);
  });
  it('retains only reachable risk mapping inputs and copies them independently', () => {
    const data = {
      version: 1 as const,
      positions: [
        { holdingId: 'fund', nodeId: 'root' },
        { holdingId: 'other', nodeId: 'hidden' },
      ],
      nodes: [
        { id: 'root', name: 'Root', kind: 'fund' as const, synthetic: false },
        {
          id: 'child',
          name: 'Child',
          kind: 'asset' as const,
          synthetic: false,
        },
        {
          id: 'hidden',
          name: 'Hidden',
          kind: 'asset' as const,
          synthetic: false,
        },
      ],
      links: [{ id: 'link', parentId: 'root', childId: 'child', weight: 1 }],
    };
    const output = scopedRiskData(data, records().holdings);
    expect(output.nodes.map((node) => node.id)).toEqual(['root', 'child']);
    expect(output.positions).toHaveLength(1);
    output.nodes[0].name = 'Edited copy';
    expect(data.nodes[0].name).toBe('Root');
  });
});

it('suppresses funding projections for unknown holding liquidity even in an unrestricted account', () => {
  const state = fixture();
  state.portfolio.holdings[0].liquidityStatus = 'unknown';
  const report = evaluatePeriod(state.portfolio, state.finance, query, at);
  expect(report.liquidity[0]).toMatchObject({
    recordedCashNative: 600,
    restrictionUnknownAccountCount: 0,
    liquidityUnknownHoldingCount: 1,
    projectedAvailableNative: null,
  });
});

it('does not turn an unknown cash placeholder into zero available liquidity', () => {
  const portfolio = records();
  portfolio.holdings[0] = {
    ...portfolio.holdings[0],
    valuationStatus: 'unknown',
    valueEUR: 999,
    originalValue: 999,
    valuationDate: '',
  };
  const result = evaluatePeriod(portfolio, emptyFinanceState(), query, at);
  expect(result.liquidity[0]).toMatchObject({
    recordedCashNative: 0,
    unavailableBalanceCount: 1,
    projectedAvailableNative: null,
  });
  expect(
    result.holdings.find((row) => row.holdingId === 'cash')?.opening,
  ).toBeNull();
});
