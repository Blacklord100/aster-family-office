import { describe, expect, it } from 'vitest';
import {
  projectPortfolioHistory,
  historyCents,
  historyMoney,
} from './portfolio-history';
import { emptyFinanceState, type ValuationRecord } from './ledger-contract';
import type { Holding } from '@/data/types';
import type { PortfolioRecords } from './workspace';
export function historyFixture() {
  const holding = (id: string, familyId = 'f1'): Holding => ({
    id,
    familyId,
    name: id,
    entityId: `e-${familyId}`,
    accountId: 'a',
    assetClass: 'Private equity',
    currency: 'EUR',
    valueEUR: 900,
    originalValue: 900,
    syntheticFXRateToEUR: 1,
    costBasisEUR: 0,
    unfundedCommitmentEUR: 0,
    liquidityBucket: '3+ years',
    valuationDate: '2026-06-30',
    sourceId: '',
    geography: '',
    manager: 'Manager',
    description: '',
    color: '',
    valuationMethod: 'Reported fund NAV',
  });
  const portfolio: PortfolioRecords = {
    holdings: [holding('h1'), holding('h2'), holding('h3', 'f2')],
    evidence: [],
    history: [],
    events: [],
    tasks: [],
    families: [
      {
        id: 'f1',
        name: 'One',
        initials: 'O',
        principal: '',
        location: '',
        color: '',
      },
      {
        id: 'f2',
        name: 'Two',
        initials: 'T',
        principal: '',
        location: '',
        color: '',
      },
    ],
    entities: [
      {
        id: 'e-f1',
        familyId: 'f1',
        name: 'E1',
        type: 'Trust',
        jurisdiction: '',
        ownershipPercent: 100,
      },
      {
        id: 'e-f2',
        familyId: 'f2',
        name: 'E2',
        type: 'Trust',
        jurisdiction: '',
        ownershipPercent: 100,
      },
    ],
    accounts: [],
  };
  const finance = emptyFinanceState();
  function mark(
    id: string,
    holdingId: string,
    effectiveDate: string,
    amount: string,
    options: Partial<ValuationRecord> = {},
  ) {
    const sourceId = `s-${id}`,
      documentId =
        '00000000-0000-4000-8000-' +
        String(portfolio.evidence.length + 1).padStart(12, '0');
    portfolio.evidence.push({
      id: sourceId,
      documentId,
      familyId: portfolio.holdings.find((h) => h.id === holdingId)!.familyId,
      holdingId,
      mailboxId: '',
      subject: 'Report',
      sender: '',
      receivedAt: '2026-09-09T12:00:00Z',
      effectiveDate,
      filename: `${id}.pdf`,
      page: 2,
      excerpt: 'Retained report value',
      status: 'Accepted',
      synthetic: false,
    });
    finance.valuations.push({
      id,
      sourceId,
      holdingId,
      effectiveDate,
      amount,
      valueEUR: Number(amount),
      currency: 'EUR',
      actorId: 'reviewer',
      recordedAt: '2026-09-09T12:00:00Z',
      valuationMethod: 'Reported fund NAV',
      ...options,
    });
    return documentId;
  }
  return { portfolio, finance, mark };
}
describe('shared accepted portfolio history', () => {
  it('shows a late mark at its effective date while keeping import and acceptance distinct', () => {
    const f = historyFixture();
    f.mark('june', 'h1', '2026-06-30', '110');
    const documentId = f.mark('march', 'h1', '2026-03-31', '100', {
      recordedAt: '2026-09-10T10:00:00Z',
    });
    const before = structuredClone({
      portfolio: f.portfolio,
      finance: f.finance,
    });
    const result = projectPortfolioHistory(
      f.portfolio,
      f.finance,
      { holdingIds: ['h1'] },
      {
        revision: 4,
        now: '2026-09-10T11:00:00Z',
        documentMetadata: new Map([
          [documentId, { importedAt: '2026-09-10T09:00:00Z' }],
        ]),
      },
    );
    expect(result.positions[0].latest?.id).toBe('june');
    expect(result.observations.find((r) => r.id === 'march')).toMatchObject({
      effectiveDate: '2026-03-31',
      importedAt: '2026-09-10T09:00:00.000Z',
      recordedAt: '2026-09-10T10:00:00.000Z',
      reportDate: null,
      messageTimestamp: null,
    });
    expect(result.positions[0]).toMatchObject({
      firstObservedDate: '2026-03-31',
      economicOpenedAt: null,
      changeAmount: '10.00',
      changePercent: 10,
    });
    expect(f.portfolio).toEqual(before.portfolio);
    expect(f.finance).toEqual(before.finance);
  });
  it('restates a correction but reproduces the earlier accepted version at a knowledge cutoff', () => {
    const f = historyFixture();
    f.mark('v1', 'h1', '2026-03-31', '100');
    f.mark('v2', 'h1', '2026-03-31', '105', {
      correctionOf: 'v1',
      correctionReason: 'Manager corrected NAV',
      recordedAt: '2026-09-10T10:00:00Z',
    });
    const now = projectPortfolioHistory(f.portfolio, f.finance, {
      holdingIds: ['h1'],
      includeSuperseded: true,
    });
    expect(now.summary.amount).toBe('105.00');
    expect(now.observations.find((r) => r.id === 'v1')).toMatchObject({
      status: 'superseded',
      supersededBy: 'v2',
    });
    expect(now.observations.find((r) => r.id === 'v2')?.version).toBe(2);
    const past = projectPortfolioHistory(f.portfolio, f.finance, {
      holdingIds: ['h1'],
      knowledge: 'as_known',
      knownAt: '2026-09-09T13:00:00Z',
    });
    expect(past.summary.amount).toBe('100.00');
    expect(past.observations.map((r) => r.id)).toEqual(['v1']);
  });
  it('uses current-cohort coverage and a separately identified comparable cohort', () => {
    const f = historyFixture();
    f.mark('a', 'h1', '2026-03-31', '100');
    f.mark('b', 'h1', '2026-06-30', '110');
    f.mark('c', 'h2', '2026-06-30', '50');
    f.mark('d', 'h3', '2026-06-30', '25');
    const result = projectPortfolioHistory(f.portfolio, f.finance, {
      from: '2026-03-31',
      to: '2026-06-30',
    });
    expect(result.points[0]).toMatchObject({
      amount: null,
      knownAmount: '100.00',
      coverage: { knownCount: 1, totalCount: 3 },
    });
    expect(result.summary.amount).toBe('185.00');
    expect(result.comparison.changeAmount).toBeNull();
    expect(result.comparison.comparable).toMatchObject({
      holdingIds: ['h1'],
      holdingCount: 1,
      changeAmount: '10.00',
    });
    expect(result.comparison.investmentReturn).toBeNull();
  });
  it('retains native amounts and historical FX without inventing a second conversion', () => {
    const f = historyFixture();
    f.mark('usd', 'h1', '2026-06-30', '100.01', {
      currency: 'USD',
      valueEUR: 90.01,
      fx: { rateToEUR: '0.9', date: '2026-06-30', source: 'Retained FX' },
    });
    f.mark('eur', 'h2', '2026-06-30', '20');
    const result = projectPortfolioHistory(f.portfolio, f.finance, {
      holdingIds: ['h1', 'h2'],
      currency: 'USD',
    });
    expect(result.summary).toMatchObject({
      amount: null,
      knownAmount: '100.01',
      coverage: { unavailableCurrencyCount: 1 },
    });
    expect(result.observations.find((r) => r.id === 'usd')).toMatchObject({
      valueEUR: '90.01',
      nativeAmount: '100.01',
      fx: { source: 'Retained FX' },
    });
  });
  it('sums exact cents and does not count duplicates twice', () => {
    const f = historyFixture();
    f.mark('a', 'h1', '2026-06-30', '0.10');
    f.mark('b', 'h2', '2026-06-30', '0.20');
    f.mark('z', 'h2', '2026-06-30', '0.20');
    const result = projectPortfolioHistory(f.portfolio, f.finance, {
      holdingIds: ['h1', 'h2'],
    });
    expect(result.summary.amount).toBe('0.30');
    expect(result.page.total).toBe(2);
    expect(
      historyMoney(historyCents('1000000000000.01') + historyCents('0.02')),
    ).toBe('1000000000000.03');
  });
  it('blocks conflicting same-date marks from becoming a plausible carried balance', () => {
    const f = historyFixture();
    f.mark('old', 'h1', '2026-03-31', '90');
    f.mark('a', 'h1', '2026-06-30', '100');
    f.mark('b', 'h1', '2026-06-30', '200');
    const result = projectPortfolioHistory(f.portfolio, f.finance, {
      holdingIds: ['h1'],
    });
    expect(result.summary.amount).toBeNull();
    expect(result.positions[0].latest).toBeNull();
    expect(
      result.observations.filter((r) => r.status === 'conflicted'),
    ).toHaveLength(2);
  });
  it('pages full observations without shortening the chart, and finds a selected older row', () => {
    const f = historyFixture();
    for (let i = 1; i <= 30; i++)
      f.mark(
        `day-${i}`,
        'h1',
        `2026-06-${String(i).padStart(2, '0')}`,
        String(i),
      );
    const result = projectPortfolioHistory(f.portfolio, f.finance, {
      holdingIds: ['h1'],
      asOf: '2026-06-30',
      limit: 10,
      observationId: 'day-1',
    });
    expect(result.observations).toHaveLength(10);
    expect(result.points).toHaveLength(30);
    expect(result.page).toMatchObject({
      total: 30,
      hasMore: true,
      nextOffset: 10,
    });
    expect(result.selectedObservation?.id).toBe('day-1');
    expect(result.selectedOffset).toBe(20);
  });
  it('keeps unsourced legacy marks visible without inventing accepted totals or knowledge', () => {
    const f = historyFixture();
    f.portfolio.history.push({
      holdingId: 'h1',
      date: '2026-03-31',
      valueEUR: 100,
      netExternalFlowEUR: 0,
      valuationBasis: 'Reported mark',
    });
    const result = projectPortfolioHistory(f.portfolio, f.finance, {
      holdingIds: ['h1'],
    });
    expect(result.observations[0]).toMatchObject({
      status: 'legacy',
      sourceId: null,
      recordedAt: null,
    });
    expect(result.summary.amount).toBeNull();
    expect(
      projectPortfolioHistory(f.portfolio, f.finance, {
        holdingIds: ['h1'],
        knowledge: 'as_known',
        knownAt: '2026-09-09T00:00:00Z',
      }).observations,
    ).toHaveLength(0);
  });
  it('rejects invalid scope and date combinations', () => {
    const f = historyFixture();
    expect(() =>
      projectPortfolioHistory(f.portfolio, f.finance, {
        holdingIds: ['secret'],
      }),
    ).toThrow('not available');
    expect(() =>
      projectPortfolioHistory(f.portfolio, f.finance, {
        knowledge: 'as_known',
      }),
    ).toThrow();
    expect(() =>
      projectPortfolioHistory(f.portfolio, f.finance, { from: '2026-06-31' }),
    ).toThrow();
  });
});
