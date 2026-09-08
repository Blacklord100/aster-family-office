import { describe, it, expect } from 'vitest';
import type { PortfolioRecords } from './workspace';
import type { Holding } from '@/data/types';
import { holdings } from '@/data/portfolio';
import {
  emptyFinanceState,
  type LedgerCommand,
  type LedgerMeta,
} from './ledger-contract';
import {
  applyLedgerAction,
  convertToEUR,
  hasReconciledCashflowCoverage,
  postReviewedValuation,
  transactionStatus,
} from './ledger';
const meta = (id: string, date = '2026-09-10'): LedgerMeta => ({
  id,
  actorId: 'reviewer',
  at: date + 'T12:00:00Z',
});
const source = { reference: 'Statement 42', date: '2026-09-10' };
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
  syntheticFXRateToEUR: 1,
  unfundedCommitmentEUR: assetClass === 'Cash' ? 0 : 400,
  valuationDate: '2026-09-01',
  sourceId: 'source-' + id,
  valuationMethod: assetClass === 'Cash' ? 'Cash balance' : 'Reported fund NAV',
});
function records(): PortfolioRecords {
  const positions = [
    h('cash', 'Cash', 500),
    h('fund', 'Private equity', 1000),
    { ...h('cash2', 'Cash', 200), accountId: 'second' },
  ];
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
      subject: 'Opening mark',
      sender: 'reviewer',
      receivedAt: '2026-09-01T12:00:00Z',
      effectiveDate: '2026-09-01',
      filename: 'opening.txt',
      page: 1,
      excerpt: 'Reviewed opening value',
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
    accounts: ['account', 'second'].map((id) => ({
      id,
      familyId: 'family',
      entityId: 'entity',
      name: id,
      institution: 'Custodian',
      maskedNumber: '',
      type: 'Custody',
    })),
  };
}
const tx = (
  overrides: Partial<
    Extract<LedgerCommand, { type: 'recordTransaction' }>
  > = {},
): Extract<LedgerCommand, { type: 'recordTransaction' }> => ({
  type: 'recordTransaction',
  kind: 'capital_call',
  holdingId: 'fund',
  cashHoldingId: 'cash',
  amount: '100',
  currency: 'EUR',
  dueDate: '2026-09-11',
  source,
  evidenceVerified: true,
  investmentEffect: 'increase',
  investmentAmount: '100',
  investmentCostBasisEUR: '100',
  commitmentEffect: 'reduce',
  commitmentAmountEUR: '100',
  memo: 'Reviewed call',
  ...overrides,
});
const settle: LedgerCommand = {
  type: 'settleTransaction',
  transactionId: 'tx',
  date: '2026-09-10',
  source,
  evidenceVerified: true,
};
const total = (p: PortfolioRecords) =>
  p.holdings.reduce((sum, row) => sum + row.valueEUR, 0);

describe('source currency and reviewed marks', () => {
  it('converts exact decimals, requires actual FX source and rejects impossible dates/rates', () => {
    expect(
      convertToEUR(
        '0.05',
        'USD',
        { rateToEUR: '0.9', date: '2026-09-01', source: 'FX fixing' },
        '2026-09-01',
      ),
    ).toBe(0.05);
    expect(
      convertToEUR(
        '123.45',
        'USD',
        {
          rateToEUR: '0.923456789012',
          date: '2026-09-01',
          source: 'FX fixing',
        },
        '2026-09-01',
      ),
    ).toBe(114);
    expect(() => convertToEUR('1', 'USD')).toThrow(/dated EUR/);
    expect(() =>
      convertToEUR('1', 'EUR', {
        rateToEUR: '2',
        date: '2026-09-01',
        source: 'bad',
      }),
    ).toThrow(/exactly 1/);
    expect(() =>
      convertToEUR('1', 'USD', {
        rateToEUR: '0',
        date: '2026-09-01',
        source: 'bad',
      }),
    ).toThrow();
    expect(() =>
      convertToEUR('1', 'USD', {
        rateToEUR: '1',
        date: '2026-02-30',
        source: 'bad',
      }),
    ).toThrow();
    expect(() =>
      convertToEUR(
        '1',
        'USD',
        { rateToEUR: '1', date: '2026-09-02', source: 'bad' },
        '2026-09-01',
      ),
    ).toThrow(/after/);
    expect(() =>
      convertToEUR('1000000000000', 'USD', {
        rateToEUR: '2',
        date: '2026-09-01',
        source: 'fix',
      }),
    ).toThrow(/trillion/);
  });
  it('preserves non-EUR source amount and adds an append-only evidenced correction', () => {
    const initial = records();
    const first = postReviewedValuation(
      initial,
      undefined,
      {
        holdingId: 'fund',
        amount: '1200',
        currency: 'USD',
        fx: { rateToEUR: '0.9', date: '2026-09-09', source: 'FX report' },
        effectiveDate: '2026-09-10',
        sourceId: 'source-fund',
      },
      meta('mark'),
    );
    expect(first.portfolio.holdings[1]).toMatchObject({
      originalValue: 1200,
      currency: 'USD',
      valueEUR: 1080,
      valuationMethod: 'Reported fund NAV',
    });
    expect(initial.holdings[1].valueEUR).toBe(1000);
    expect(() =>
      postReviewedValuation(
        first.portfolio,
        first.finance,
        {
          holdingId: 'fund',
          amount: '1300',
          currency: 'USD',
          fx: { rateToEUR: '0.9', date: '2026-09-09', source: 'FX report' },
          effectiveDate: '2026-09-10',
          sourceId: 'source-fund',
        },
        meta('bad'),
      ),
    ).toThrow(/correction/);
    const corrected = postReviewedValuation(
      first.portfolio,
      first.finance,
      {
        holdingId: 'fund',
        amount: '1300',
        currency: 'USD',
        fx: { rateToEUR: '0.9', date: '2026-09-09', source: 'FX report' },
        effectiveDate: '2026-09-10',
        sourceId: 'source-fund',
        correction: { expectedValueEUR: 1080, reason: 'Corrected statement' },
      },
      meta('correction'),
    );
    expect(corrected.finance.valuations).toHaveLength(2);
    expect(corrected.valuation).toMatchObject({
      correctionOf: 'mark',
      supersededValueEUR: 1080,
      valueEUR: 1170,
    });
    expect(corrected.portfolio.history.at(-1)?.flowCoverage).toBe('unknown');
  });
  it('refuses foreign evidence and stale correction preconditions', () => {
    expect(() =>
      postReviewedValuation(
        records(),
        undefined,
        {
          holdingId: 'fund',
          amount: '100',
          currency: 'EUR',
          effectiveDate: '2026-09-10',
          sourceId: 'source-cash',
        },
        meta('x'),
      ),
    ).toThrow(/evidence/);
    expect(() =>
      postReviewedValuation(
        records(),
        undefined,
        {
          holdingId: 'fund',
          amount: '100',
          currency: 'EUR',
          effectiveDate: '2026-09-01',
          sourceId: 'source-fund',
          correction: { expectedValueEUR: 999, reason: 'Wrong base' },
        },
        meta('x'),
      ),
    ).toThrow();
  });
  it('protects legacy same-date holdings without history and native basis changes with identical EUR value', () => {
    const initial = records();
    initial.history = [];
    const input = {
      holdingId: 'fund',
      amount: '1100',
      currency: 'EUR' as const,
      effectiveDate: '2026-09-01',
      sourceId: 'source-fund',
    };
    expect(() =>
      postReviewedValuation(initial, undefined, input, meta('bad')),
    ).toThrow(/correction/);
    const changed = {
      ...input,
      amount: '2000',
      currency: 'USD' as const,
      fx: { rateToEUR: '0.5', date: '2026-09-01', source: 'Reviewed FX' },
    };
    expect(() =>
      postReviewedValuation(initial, undefined, changed, meta('bad')),
    ).toThrow(/correction/);
    const corrected = postReviewedValuation(
      initial,
      undefined,
      {
        ...changed,
        correction: {
          expectedValueEUR: 1000,
          reason: 'Corrected source currency',
        },
      },
      meta('correct'),
    );
    expect(corrected.valuation).toMatchObject({
      valueEUR: 1000,
      amount: '2000',
      currency: 'USD',
      correctionOf: 'legacy:fund:2026-09-01',
    });
    expect(() =>
      postReviewedValuation(
        corrected.portfolio,
        corrected.finance,
        { ...changed, fx: { ...changed.fx, source: 'Different FX evidence' } },
        meta('provenance'),
      ),
    ).toThrow(/correction/);
  });
});
describe('reviewed cash movements and commitments', () => {
  it('records a notice without posting, then conserves value/cost on a paid capital call', () => {
    const initial = records(),
      reviewed = applyLedgerAction(initial, undefined, tx(), meta('tx'));
    expect(reviewed.portfolio).toEqual(initial);
    expect(transactionStatus(reviewed.finance, 'tx')).toBe('reviewed');
    const paid = applyLedgerAction(
      reviewed.portfolio,
      reviewed.finance,
      settle,
      meta('settled'),
    );
    expect(total(paid.portfolio)).toBe(total(initial));
    expect(paid.portfolio.holdings[0]).toMatchObject({
      valueEUR: 400,
      costBasisEUR: 400,
    });
    expect(paid.portfolio.holdings[1]).toMatchObject({
      valueEUR: 1100,
      costBasisEUR: 1100,
      unfundedCommitmentEUR: 300,
      valuationMethod: 'Reported mark plus settled capital',
    });
    expect(paid.finance.events[0].externalFlowEUR).toBe(0);
    expect(paid.finance.transactions[0]).toEqual(
      reviewed.finance.transactions[0],
    );
    expect(() =>
      applyLedgerAction(
        paid.portfolio,
        paid.finance,
        settle,
        meta('duplicate'),
      ),
    ).toThrow(/Only a reviewed/);
  });
  it('reverses by appending exact opposite postings and rejects double reversals', () => {
    const reviewed = applyLedgerAction(records(), undefined, tx(), meta('tx'));
    const paid = applyLedgerAction(
      reviewed.portfolio,
      reviewed.finance,
      settle,
      meta('settled'),
    );
    const reverse: LedgerCommand = {
      type: 'reverseTransaction',
      transactionId: 'tx',
      date: '2026-09-10',
      source,
      evidenceVerified: true,
      reason: 'Bank posting reversed',
    };
    const reversed = applyLedgerAction(
      paid.portfolio,
      paid.finance,
      reverse,
      meta('reversed'),
    );
    expect(reversed.finance.events).toHaveLength(2);
    expect(reversed.finance.events[1].reversesEventId).toBe('settled');
    expect(
      reversed.portfolio.holdings.map((row) => [
        row.valueEUR,
        row.costBasisEUR,
        row.unfundedCommitmentEUR,
      ]),
    ).toEqual(
      records().holdings.map((row) => [
        row.valueEUR,
        row.costBasisEUR,
        row.unfundedCommitmentEUR,
      ]),
    );
    expect(() =>
      applyLedgerAction(
        reversed.portfolio,
        reversed.finance,
        reverse,
        meta('twice'),
      ),
    ).toThrow(/once/);
  });
  it('distinguishes external deposits, income distributions, transfers and investment losses', () => {
    const cases: [
      Partial<Extract<LedgerCommand, { type: 'recordTransaction' }>>,
      number,
      number,
    ][] = [
      [
        {
          kind: 'deposit',
          holdingId: undefined,
          investmentEffect: 'none',
          investmentAmount: undefined,
          investmentCostBasisEUR: '0',
          commitmentEffect: 'none',
          commitmentAmountEUR: '0',
        },
        100,
        100,
      ],
      [
        {
          kind: 'distribution',
          investmentEffect: 'none',
          investmentAmount: undefined,
          investmentCostBasisEUR: '0',
          commitmentEffect: 'none',
          commitmentAmountEUR: '0',
        },
        100,
        0,
      ],
      [
        {
          kind: 'transfer',
          holdingId: undefined,
          destinationCashHoldingId: 'cash2',
          investmentEffect: 'none',
          investmentAmount: undefined,
          investmentCostBasisEUR: '0',
          commitmentEffect: 'none',
          commitmentAmountEUR: '0',
        },
        0,
        0,
      ],
      [
        {
          kind: 'fee',
          holdingId: undefined,
          investmentEffect: 'none',
          investmentAmount: undefined,
          investmentCostBasisEUR: '0',
          commitmentEffect: 'none',
          commitmentAmountEUR: '0',
        },
        -100,
        0,
      ],
    ];
    for (const [override, valueChange, externalFlow] of cases) {
      const initial = records(),
        r = applyLedgerAction(initial, undefined, tx(override), meta('tx')),
        p = applyLedgerAction(r.portfolio, r.finance, settle, meta('s'));
      expect(total(p.portfolio) - total(initial)).toBe(valueChange);
      expect(p.finance.events[0].externalFlowEUR).toBe(externalFlow);
    }
  });
  it('blocks cross-entity transfers, mismatched currencies, restricted cash and overdraws', () => {
    const foreign = records();
    foreign.holdings[2].entityId = 'different';
    expect(() =>
      applyLedgerAction(
        foreign,
        undefined,
        tx({
          kind: 'transfer',
          holdingId: undefined,
          destinationCashHoldingId: 'cash2',
          investmentEffect: 'none',
          investmentAmount: undefined,
          investmentCostBasisEUR: '0',
          commitmentEffect: 'none',
          commitmentAmountEUR: '0',
        }),
        meta('tx'),
      ),
    ).toThrow(/same legal entity/);
    const currency = records();
    currency.holdings[0].currency = 'USD';
    expect(() =>
      applyLedgerAction(currency, undefined, tx(), meta('tx')),
    ).toThrow(/currenc/);
    const restricted = emptyFinanceState();
    restricted.accounts.account = {
      accountId: 'account',
      currency: 'EUR',
      restricted: true,
      restrictionNote: 'Blocked',
    };
    expect(() =>
      applyLedgerAction(records(), restricted, tx(), meta('tx')),
    ).toThrow(/restricted/);
    const r = applyLedgerAction(
      records(),
      undefined,
      tx({
        amount: '600',
        investmentAmount: '600',
        investmentCostBasisEUR: '600',
        commitmentEffect: 'none',
        commitmentAmountEUR: '0',
      }),
      meta('tx'),
    );
    expect(() =>
      applyLedgerAction(r.portfolio, r.finance, settle, meta('s')),
    ).toThrow(/overdraw/);
  });
  it('requires a cash revaluation before settlement with a changed FX basis', () => {
    const initial = records();
    for (const holding of initial.holdings) holding.currency = 'USD';
    const r = applyLedgerAction(
      initial,
      undefined,
      tx({
        currency: 'USD',
        fx: { rateToEUR: '0.9', date: '2026-09-10', source: 'FX report' },
        investmentCostBasisEUR: '90',
        commitmentAmountEUR: '90',
      }),
      meta('tx'),
    );
    expect(() =>
      applyLedgerAction(r.portfolio, r.finance, settle, meta('s')),
    ).toThrow(/full cash balance/);
  });
  it('requires explicit movement direction and rejects accidental negative amounts or commitment restoration', () => {
    expect(() =>
      applyLedgerAction(
        records(),
        undefined,
        tx({ amount: '-100' }),
        meta('tx'),
      ),
    ).toThrow();
    expect(() =>
      applyLedgerAction(
        records(),
        undefined,
        tx({ investmentEffect: 'none' }),
        meta('tx'),
      ),
    ).toThrow(/effect/);
    expect(() =>
      applyLedgerAction(
        records(),
        undefined,
        tx({ commitmentEffect: 'increase' }),
        meta('tx'),
      ),
    ).toThrow(/Calls/);
  });
  it('voids only unsettled obligations without changing financial balances', () => {
    const r = applyLedgerAction(records(), undefined, tx(), meta('tx'));
    const v = applyLedgerAction(
      r.portfolio,
      r.finance,
      {
        type: 'voidTransaction',
        transactionId: 'tx',
        reason: 'Notice cancelled',
        source,
        evidenceVerified: true,
      },
      meta('void'),
    );
    expect(v.portfolio).toEqual(r.portfolio);
    expect(transactionStatus(v.finance, 'tx')).toBe('voided');
    expect(() =>
      applyLedgerAction(v.portfolio, v.finance, settle, meta('s')),
    ).toThrow();
  });
  it('allows historical bank settlement reviewed today but refuses posting before an existing mark', () => {
    const r = applyLedgerAction(records(), undefined, tx(), meta('tx'));
    expect(
      applyLedgerAction(
        r.portfolio,
        r.finance,
        { ...settle, date: '2026-09-07' },
        meta('s'),
      ).finance.events[0].date,
    ).toBe('2026-09-07');
    expect(() =>
      applyLedgerAction(
        r.portfolio,
        r.finance,
        { ...settle, date: '2026-08-31' },
        meta('bad'),
      ),
    ).toThrow(/later valuation/);
  });
  it('separates sale proceeds from explicit released carrying value and cost, then reverses all three', () => {
    const r = applyLedgerAction(
      records(),
      undefined,
      tx({
        kind: 'sale',
        amount: '150',
        investmentEffect: 'reduce',
        investmentAmount: '100',
        investmentCostBasisEUR: '80',
        commitmentEffect: 'none',
        commitmentAmountEUR: '0',
      }),
      meta('tx'),
    );
    const paid = applyLedgerAction(r.portfolio, r.finance, settle, meta('s'));
    expect(total(paid.portfolio)).toBe(total(records()) + 50);
    expect(paid.portfolio.holdings[1]).toMatchObject({
      valueEUR: 900,
      costBasisEUR: 920,
      unfundedCommitmentEUR: 400,
    });
    expect(paid.finance.events[0].externalFlowEUR).toBe(0);
    const undo = applyLedgerAction(
      paid.portfolio,
      paid.finance,
      {
        type: 'reverseTransaction',
        transactionId: 'tx',
        date: '2026-09-10',
        source,
        evidenceVerified: true,
        reason: 'Trade cancelled',
      },
      meta('undo'),
    );
    expect(
      undo.portfolio.holdings.map((row) => [row.valueEUR, row.costBasisEUR]),
    ).toEqual(
      records().holdings.map((row) => [row.valueEUR, row.costBasisEUR]),
    );
  });
});
describe('register and cashflow coverage', () => {
  it('reviews existing account restrictions with source history and blocks currency relabeling', () => {
    const command: LedgerCommand = {
      type: 'reviewAccount',
      accountId: 'account',
      currency: 'EUR',
      restricted: false,
      restrictionNote: 'Checked bank mandate',
      source,
      evidenceVerified: true,
    };
    const initial = applyLedgerAction(
      records(),
      undefined,
      command,
      meta('review'),
    );
    expect(initial.portfolio).toEqual(records());
    expect(initial.finance.accounts.account.reviews).toHaveLength(1);
    const updated = applyLedgerAction(
      initial.portfolio,
      initial.finance,
      { ...command, restricted: true, restrictionNote: 'Bank freeze' },
      meta('restriction'),
    );
    expect(updated.finance.accounts.account.reviews).toHaveLength(2);
    expect(updated.finance.accounts.account.reviews?.[0].restricted).toBe(
      false,
    );
    expect(() =>
      applyLedgerAction(
        records(),
        undefined,
        { ...command, currency: 'USD' },
        meta('bad'),
      ),
    ).toThrow(/existing cash balance/);
  });
  it('reuses existing entities/accounts and records native opening value with source identifiers', () => {
    const result = applyLedgerAction(
      records(),
      undefined,
      {
        type: 'createHolding',
        accountId: 'account',
        name: 'New fund',
        assetClass: 'Private equity',
        amount: '100',
        currency: 'USD',
        fx: { rateToEUR: '0.9', date: '2026-09-10', source: 'FX fixing' },
        costBasisEUR: '90',
        unfundedCommitmentEUR: '20',
        valuationDate: '2026-09-10',
        liquidityBucket: '3+ years',
        manager: 'Manager',
        managerId: 'manager-id',
        instrumentId: 'ISIN-example',
        shareClassId: 'class-a',
        geography: 'Europe',
        source,
        evidenceVerified: true,
      },
      meta('new'),
    );
    expect(result.portfolio.entities).toHaveLength(1);
    expect(result.portfolio.accounts).toHaveLength(2);
    expect(result.portfolio.holdings.at(-1)).toMatchObject({
      originalValue: 100,
      valueEUR: 90,
      currency: 'USD',
      entityId: 'entity',
      accountId: 'account',
    });
    expect(result.finance.holdings.new.shareClassId).toBe('class-a');
  });
  it('will not call unknown zero flows reconciled, and requires all entity cash statement balances', () => {
    const p = records();
    expect(
      hasReconciledCashflowCoverage(
        undefined,
        p,
        ['fund'],
        '2026-09-01',
        '2026-09-10',
      ),
    ).toBe(false);
    const action: LedgerCommand = {
      type: 'reconcilePeriod',
      entityId: 'entity',
      from: '2026-09-01',
      to: '2026-09-10',
      cashHoldingIds: ['cash', 'cash2'],
      closingBalances: [
        { holdingId: 'cash', amount: '500', valueEUR: '500' },
        { holdingId: 'cash2', amount: '200', valueEUR: '200' },
      ],
      source,
      evidenceVerified: true,
    };
    expect(() =>
      applyLedgerAction(
        p,
        undefined,
        { ...action, cashHoldingIds: ['cash'] },
        meta('r'),
      ),
    ).toThrow(/every cash/);
    expect(() =>
      applyLedgerAction(
        p,
        undefined,
        {
          ...action,
          closingBalances: [
            { holdingId: 'cash', amount: '499', valueEUR: '499' },
            { holdingId: 'cash2', amount: '200', valueEUR: '200' },
          ],
        },
        meta('r'),
      ),
    ).toThrow(/does not match/);
    const reconciled = applyLedgerAction(p, undefined, action, meta('r'));
    expect(
      hasReconciledCashflowCoverage(
        reconciled.finance,
        p,
        ['fund'],
        '2026-09-01',
        '2026-09-10',
      ),
    ).toBe(true);
    const changed = applyLedgerAction(
      reconciled.portfolio,
      reconciled.finance,
      tx(),
      meta('tx'),
    );
    expect(
      hasReconciledCashflowCoverage(
        changed.finance,
        p,
        ['fund'],
        '2026-09-01',
        '2026-09-10',
      ),
    ).toBe(true);
    const settled = applyLedgerAction(
      changed.portfolio,
      changed.finance,
      settle,
      meta('paid'),
    );
    expect(
      hasReconciledCashflowCoverage(
        settled.finance,
        settled.portfolio,
        ['fund'],
        '2026-09-01',
        '2026-09-10',
      ),
    ).toBe(false);
  });
});
