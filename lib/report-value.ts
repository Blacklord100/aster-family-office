import type { Holding } from '../data/types';
import { sumMoney, type MetricCoverage } from './finance';
import { currentRiskHoldings } from './family-exposure';
import type { HistoryLifecycleState } from './portfolio-history-lifecycle-contract';

export type CurrentReportOwnershipBasis = {
  asOfDate: string;
  excludedCount: number;
  unknownOwnershipCount: number;
};

/** Apply only to a live register. Saved reports keep the cohort frozen when saved. */
export function currentReportHoldings(
  holdings: readonly Holding[],
  lifecycle: HistoryLifecycleState | undefined,
  asOfDate: string,
): { holdings: Holding[]; ownershipBasis: CurrentReportOwnershipBasis } {
  const selected = currentRiskHoldings(holdings, lifecycle, asOfDate);
  return {
    holdings: selected.holdings,
    ownershipBasis: {
      asOfDate,
      excludedCount: selected.excluded.length,
      unknownOwnershipCount: selected.unknownOwnership.length,
    },
  };
}

/** Recompute from the snapshot's own records, including for older saved reports. */
export function reportValue(holdings: readonly Holding[]): {
  valueEUR: number | null;
  coverage: MetricCoverage;
  label: string;
  asOfDate: string | null;
} {
  const known = holdings.filter(
    (holding) => holding.valuationStatus !== 'unknown',
  );
  const coverage = {
    knownCount: known.length,
    unknownCount: holdings.length - known.length,
    totalCount: holdings.length,
    complete: holdings.length > 0 && known.length === holdings.length,
  };
  return {
    valueEUR: known.length
      ? sumMoney(known.map((holding) => holding.valueEUR))
      : null,
    coverage,
    label: !holdings.length
      ? 'No recorded holdings'
      : !known.length
        ? 'Valuation not reported'
        : coverage.complete
          ? 'Reported portfolio value'
          : 'Known portfolio subtotal',
    asOfDate:
      known
        .map((holding) => holding.valuationDate)
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort()
        .at(-1) ?? null,
  };
}
