import { describe, expect, it } from 'vitest';
import {
  accounts,
  AS_OF_DATE,
  evidenceSources,
  holdings,
  timelineEvents,
  valuationHistory,
} from '../data';
import {
  aggregateAllocation,
  aggregateValuationHistory,
  calculatePortfolioMetrics,
  calculateTimeWeightedReturn,
  scopeHoldings,
  sumMoney,
} from './finance';

describe('flow-aware time weighted returns', () => {
  it('does not count an external deposit or withdrawal as investment return', () => {
    expect(
      calculateTimeWeightedReturn([
        { startValueEUR: 100, endValueEUR: 150, externalFlowAtEndEUR: 50 },
      ]),
    ).toBe(0);
    expect(
      calculateTimeWeightedReturn([
        { startValueEUR: 100, endValueEUR: 60, externalFlowAtEndEUR: -40 },
      ]),
    ).toBe(0);
  });
  it('includes capital present at the beginning and geometrically links periods', () => {
    expect(
      calculateTimeWeightedReturn([
        { startValueEUR: 100, externalFlowAtStartEUR: 100, endValueEUR: 220 },
      ]),
    ).toBeCloseTo(0.1);
    expect(
      calculateTimeWeightedReturn([
        { startValueEUR: 100, endValueEUR: 110 },
        { startValueEUR: 110, endValueEUR: 99 },
      ]),
    ).toBeCloseTo(-0.01);
  });
  it('does not manufacture a return with missing, invalid or uninvested data', () => {
    expect(calculateTimeWeightedReturn([])).toBeNull();
    expect(
      calculateTimeWeightedReturn([{ startValueEUR: 0, endValueEUR: 10 }]),
    ).toBeNull();
    expect(
      calculateTimeWeightedReturn([{ startValueEUR: 100, endValueEUR: NaN }]),
    ).toBeNull();
  });
});

describe('scope and consolidation', () => {
  it('totals €128m without counting unfunded commitments or property wrappers twice', () => {
    const metrics = calculatePortfolioMetrics(holdings);
    expect(metrics.totalValueEUR).toBe(128_000_000);
    expect(metrics.unfundedCommitmentEUR).toBe(14_000_000);
    expect(metrics.cashEUR).toBe(10_100_000);
    expect(metrics.liquidValueEUR).toBe(65_200_000);
    expect(metrics.staleHoldingsCount).toBe(1);
  });
  it('family scopes recombine exactly and combined filters do not leak positions', () => {
    const laurent = scopeHoldings(holdings, { familyId: 'laurent' });
    const bergstrom = scopeHoldings(holdings, { familyId: 'bergstrom' });
    const chen = scopeHoldings(holdings, { familyId: 'chen' });
    expect(calculatePortfolioMetrics(laurent).totalValueEUR).toBe(54_600_000);
    expect(calculatePortfolioMetrics(bergstrom).totalValueEUR).toBe(41_400_000);
    expect(calculatePortfolioMetrics(chen).totalValueEUR).toBe(32_000_000);
    expect(
      scopeHoldings(holdings, { familyId: 'laurent', assetClass: 'Cash' }).map(
        (holding) => holding.id,
      ),
    ).toEqual(['ubs-cash']);
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
  });
  it('allocations use the filtered denominator and sum to 100%', () => {
    const allocation = aggregateAllocation(
      scopeHoldings(holdings, { familyId: 'chen' }),
    );
    expect(sumMoney(allocation.map((group) => group.valueEUR))).toBe(
      32_000_000,
    );
    expect(
      allocation.reduce((total, group) => total + group.percentage, 0),
    ).toBeCloseTo(100);
    expect(aggregateAllocation([])).toEqual([]);
  });
});

describe('synthetic history and provenance', () => {
  it('all ending values reconcile to accepted holdings and stay positive', () => {
    const last = valuationHistory.filter((row) => row.date === AS_OF_DATE);
    expect(last).toHaveLength(holdings.length);
    expect(sumMoney(last.map((row) => row.valueEUR))).toBe(128_000_000);
    expect(valuationHistory.every((row) => row.valueEUR > 0)).toBe(true);
    for (const holding of holdings) {
      expect(last.find((row) => row.holdingId === holding.id)?.valueEUR).toBe(
        holding.valueEUR,
      );
      expect(
        Math.abs(
          holding.originalValue * holding.syntheticFXRateToEUR -
            holding.valueEUR,
        ),
      ).toBeLessThan(0.02);
      expect(
        accounts.some(
          (account) =>
            account.id === holding.accountId &&
            account.familyId === holding.familyId,
        ),
      ).toBe(true);
      expect(
        evidenceSources.some(
          (source) =>
            source.id === holding.sourceId && source.holdingId === holding.id,
        ),
      ).toBe(true);
    }
  });
  it('never invents daily updated marks for stale private holdings', () => {
    const stale = valuationHistory.filter(
      (row) => row.holdingId === 'fjord-climate' && row.date > '2026-03-31',
    );
    expect(
      stale.every(
        (row) =>
          row.valueEUR === 3_200_000 &&
          row.valuationBasis === 'Carried forward',
      ),
    ).toBe(true);
  });
  it('monthly charts sample the same daily-linked TWR, even with midmonth external flows', () => {
    const daily = aggregateValuationHistory(
      valuationHistory,
      undefined,
      'daily',
    );
    const monthly = aggregateValuationHistory(
      valuationHistory,
      undefined,
      'monthly',
    );
    for (const point of monthly)
      expect(point.twrIndex).toBe(
        daily.find((day) => day.date === point.date)?.twrIndex,
      );
    expect(
      monthly.find((point) => point.date === '2026-02-28')?.netExternalFlowEUR,
    ).toBe(800_000);
    expect(daily.at(-1)?.valueEUR).toBe(128_000_000);
    expect(
      calculatePortfolioMetrics(holdings, valuationHistory).ytdReturn,
    ).not.toBeNull();
  });
  it('flags incomplete periods and rejects duplicates instead of double counting', () => {
    const rows = valuationHistory
      .filter((row) => row.holdingId === 'ubs-cash')
      .slice(0, 3);
    expect(() => aggregateValuationHistory([...rows, rows[0]])).toThrow(
      'Duplicate accepted observation',
    );
    const missingDate = aggregateValuationHistory(
      [rows[0], rows[2]],
      ['ubs-cash'],
      'daily',
    );
    expect(missingDate[1].twrIndex).toBeNull();
    expect(
      aggregateValuationHistory(rows, ['ubs-cash', 'absent'], 'daily').every(
        (point) => !point.isComplete && point.twrIndex === null,
      ),
    ).toBe(true);
  });
  it('expected notices do not claim settled financial effects and every event has evidence', () => {
    for (const event of timelineEvents) {
      expect(
        evidenceSources.some((source) => source.id === event.sourceId),
      ).toBe(true);
      if (
        event.type === 'Capital call' ||
        event.type === 'Distribution' ||
        event.type === 'Public news'
      )
        expect(event.financialEffect).toBe('None');
    }
  });
});
