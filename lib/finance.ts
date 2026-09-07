import type {
  AssetClass,
  FamilyId,
  Holding,
  HoldingValuation,
} from '../data/types';

export interface ScopeFilters {
  familyId?: FamilyId | 'all';
  assetClass?: AssetClass | 'all';
  entityId?: string;
  query?: string;
}
export interface ReturnPeriod {
  startValueEUR: number;
  endValueEUR: number;
  externalFlowAtStartEUR?: number;
  externalFlowAtEndEUR?: number;
}
export interface AllocationGroup {
  id: string;
  label: string;
  valueEUR: number;
  percentage: number;
  count: number;
  color: string;
}
export interface PortfolioHistoryPoint {
  date: string;
  valueEUR: number;
  netExternalFlowEUR: number;
  twrIndex: number | null;
  isComplete: boolean;
}
export interface PortfolioMetrics {
  totalValueEUR: number;
  costBasisEUR: number;
  unrealizedGainEUR: number;
  unrealizedGainPercent: number | null;
  cashEUR: number;
  liquidValueEUR: number;
  unfundedCommitmentEUR: number;
  holdingsCount: number;
  familyCount: number;
  staleHoldingsCount: number;
  dayChangeEUR: number | null;
  dayInvestmentGainEUR: number | null;
  dayReturn: number | null;
  thirtyDayReturn: number | null;
  ytdReturn: number | null;
  oneYearReturn: number | null;
}

/** Monetary aggregation uses integer cents; this demo does not model tax-lot precision. */
export const sumMoney = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;

export function scopeHoldings(
  positions: readonly Holding[],
  filters: ScopeFilters = {},
): Holding[] {
  const query = filters.query?.trim().toLocaleLowerCase();
  return positions.filter(
    (holding) =>
      (!filters.familyId ||
        filters.familyId === 'all' ||
        holding.familyId === filters.familyId) &&
      (!filters.assetClass ||
        filters.assetClass === 'all' ||
        holding.assetClass === filters.assetClass) &&
      (!filters.entityId ||
        filters.entityId === 'all' ||
        holding.entityId === filters.entityId) &&
      (!query ||
        `${holding.name} ${holding.ticker ?? ''} ${holding.manager} ${holding.geography}`
          .toLocaleLowerCase()
          .includes(query)),
  );
}

/** Returns a decimal return, not percentage points. Each period must have valuations
 * at its flow boundaries; intraperiod flows require additional subperiods.
 * r = (end - endFlow) / (start + startFlow) - 1; geometrically link (1+r).
 * Empty/undefined invested bases return null, never a fabricated zero return.
 * Method reference: https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/
 * This method documentation is not a claim of GIPS compliance. */
export function calculateTimeWeightedReturn(
  periods: readonly ReturnPeriod[],
): number | null {
  if (periods.length === 0) return null;
  let linked = 1;
  for (const period of periods) {
    const startFlow = period.externalFlowAtStartEUR ?? 0;
    const endFlow = period.externalFlowAtEndEUR ?? 0;
    if (
      ![period.startValueEUR, period.endValueEUR, startFlow, endFlow].every(
        Number.isFinite,
      )
    )
      return null;
    const base = period.startValueEUR + startFlow;
    const final = period.endValueEUR - endFlow;
    if (base <= 0 || final < 0) return null;
    linked *= final / base;
  }
  return linked - 1;
}

const familyNames: Record<FamilyId, string> = {
  laurent: 'Laurent',
  bergstrom: 'Bergström',
  chen: 'Chen',
};
export function aggregateAllocation(
  positions: readonly Holding[],
  key:
    | 'assetClass'
    | 'familyId'
    | 'currency'
    | 'liquidityBucket'
    | 'geography' = 'assetClass',
): AllocationGroup[] {
  const total = sumMoney(positions.map((holding) => holding.valueEUR));
  const groups = new Map<
    string,
    { values: number[]; count: number; color: string }
  >();
  for (const holding of positions) {
    const id = holding[key];
    const group = groups.get(id) ?? {
      values: [],
      count: 0,
      color: holding.color,
    };
    group.values.push(holding.valueEUR);
    group.count += 1;
    groups.set(id, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      const valueEUR = sumMoney(group.values);
      return {
        id,
        label: key === 'familyId' ? familyNames[id as FamilyId] : id,
        valueEUR,
        percentage: total > 0 ? (valueEUR / total) * 100 : 0,
        count: group.count,
        color: group.color,
      };
    })
    .sort((a, b) => b.valueEUR - a.valueEUR);
}

/** Link DAILY returns before sampling. The monthly point's external flow is the sum
 * of that month's flows for display; it is NOT an assumption that all flows occurred
 * at month end. Duplicate date/holding observations fail loudly rather than double count. */
export function aggregateValuationHistory(
  history: readonly HoldingValuation[],
  holdingIds?: readonly string[],
  frequency: 'daily' | 'monthly' = 'monthly',
): PortfolioHistoryPoint[] {
  const ids = new Set(holdingIds ?? history.map((row) => row.holdingId));
  if (ids.size === 0) return [];
  const dates = new Map<string, Map<string, HoldingValuation>>();
  for (const row of history) {
    if (!ids.has(row.holdingId)) continue;
    const positions =
      dates.get(row.date) ?? new Map<string, HoldingValuation>();
    if (positions.has(row.holdingId))
      throw new Error(
        `Duplicate accepted observation: ${row.holdingId} on ${row.date}`,
      );
    positions.set(row.holdingId, row);
    dates.set(row.date, positions);
  }
  let index: number | null = 100;
  const points: PortfolioHistoryPoint[] = [];
  for (const [date, positions] of [...dates.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const rows = [...positions.values()];
    const valueEUR = sumMoney(rows.map((row) => row.valueEUR));
    const netExternalFlowEUR = sumMoney(
      rows.map((row) => row.netExternalFlowEUR),
    );
    const isComplete =
      positions.size === ids.size &&
      rows.every(
        (row) =>
          Number.isFinite(row.valueEUR) &&
          row.valueEUR >= 0 &&
          Number.isFinite(row.netExternalFlowEUR),
      );
    const previous = points.at(-1);
    if (!isComplete) index = null;
    else if (previous && index !== null) {
      // Never bridge a missing daily valuation and silently assume a cash-flow timing.
      const contiguous =
        Date.parse(date) - Date.parse(previous.date) === 86_400_000;
      const result =
        contiguous && previous.isComplete
          ? calculateTimeWeightedReturn([
              {
                startValueEUR: previous.valueEUR,
                endValueEUR: valueEUR,
                externalFlowAtEndEUR: netExternalFlowEUR,
              },
            ])
          : null;
      index = result === null ? null : index * (1 + result);
    }
    points.push({
      date,
      valueEUR,
      netExternalFlowEUR,
      twrIndex: index,
      isComplete,
    });
  }
  if (frequency === 'daily') return points;
  const months = new Map<string, PortfolioHistoryPoint>();
  for (const point of points) {
    const month = point.date.slice(0, 7);
    const prior = months.get(month);
    months.set(month, {
      ...point,
      netExternalFlowEUR: sumMoney([
        prior?.netExternalFlowEUR ?? 0,
        point.netExternalFlowEUR,
      ]),
    });
  }
  return [...months.values()];
}

function indexReturn(
  points: readonly PortfolioHistoryPoint[],
  from: string,
  to: string,
): number | null {
  const first = points.find((point) => point.date === from);
  const last = points.find((point) => point.date === to);
  if (
    !first ||
    !last ||
    first.twrIndex === null ||
    last.twrIndex === null ||
    first.twrIndex <= 0
  )
    return null;
  return last.twrIndex / first.twrIndex - 1;
}
export function calculatePortfolioMetrics(
  positions: readonly Holding[],
  history: readonly HoldingValuation[] = [],
  asOfDate = '2026-09-07',
): PortfolioMetrics {
  const totalValueEUR = sumMoney(positions.map((holding) => holding.valueEUR));
  const costBasisEUR = sumMoney(
    positions.map((holding) => holding.costBasisEUR),
  );
  const daily = aggregateValuationHistory(
    history,
    positions.map((holding) => holding.id),
    'daily',
  );
  const today = daily.find((point) => point.date === asOfDate);
  const asOf = Date.parse(`${asOfDate}T00:00:00Z`);
  const dateAgo = (days: number) =>
    new Date(asOf - days * 86_400_000).toISOString().slice(0, 10);
  const yesterday = daily.find((point) => point.date === dateAgo(1));
  const unrealizedGainEUR = sumMoney([totalValueEUR, -costBasisEUR]);
  return {
    totalValueEUR,
    costBasisEUR,
    unrealizedGainEUR,
    unrealizedGainPercent:
      costBasisEUR > 0 ? (unrealizedGainEUR / costBasisEUR) * 100 : null,
    cashEUR: sumMoney(
      positions
        .filter((holding) => holding.assetClass === 'Cash')
        .map((holding) => holding.valueEUR),
    ),
    liquidValueEUR: sumMoney(
      positions
        .filter((holding) =>
          ['Daily', 'Within 30 days'].includes(holding.liquidityBucket),
        )
        .map((holding) => holding.valueEUR),
    ),
    unfundedCommitmentEUR: sumMoney(
      positions.map((holding) => holding.unfundedCommitmentEUR),
    ),
    holdingsCount: positions.length,
    familyCount: new Set(positions.map((holding) => holding.familyId)).size,
    staleHoldingsCount: positions.filter(
      (holding) =>
        asOf - Date.parse(`${holding.valuationDate}T00:00:00Z`) >
        90 * 86_400_000,
    ).length,
    dayChangeEUR:
      today && yesterday
        ? sumMoney([today.valueEUR, -yesterday.valueEUR])
        : null,
    dayInvestmentGainEUR:
      today && yesterday
        ? sumMoney([
            today.valueEUR,
            -yesterday.valueEUR,
            -today.netExternalFlowEUR,
          ])
        : null,
    dayReturn: indexReturn(daily, dateAgo(1), asOfDate),
    thirtyDayReturn: indexReturn(daily, dateAgo(30), asOfDate),
    ytdReturn: indexReturn(
      daily,
      `${Number(asOfDate.slice(0, 4)) - 1}-12-31`,
      asOfDate,
    ),
    oneYearReturn: indexReturn(
      daily,
      `${Number(asOfDate.slice(0, 4)) - 1}${asOfDate.slice(4)}`,
      asOfDate,
    ),
  };
}

export const formatEUR = (value: number, compact = false): string =>
  new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 0,
  }).format(value);
/** Input is decimal return, e.g. 0.083 -> +8.3%. */
export const formatReturn = (value: number | null, digits = 1): string =>
  value === null
    ? '—'
    : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
