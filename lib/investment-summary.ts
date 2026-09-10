import type { HoldingValuation } from '@/data/types';

/** A compact display of observed values, never interpolated daily prices or returns. */
export function investmentSummaries(rows: HoldingValuation[]) {
  const grouped = new Map<string, Map<string, HoldingValuation>>();
  for (const row of rows) {
    if (
      row.valuationBasis === 'Carried forward' ||
      !Number.isFinite(row.valueEUR)
    )
      continue;
    let dates = grouped.get(row.holdingId);
    if (!dates) {
      dates = new Map();
      grouped.set(row.holdingId, dates);
    }
    dates.set(row.date, row);
  }
  return new Map(
    [...grouped].map(([id, dates]) => {
      const observations = [...dates.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      const latest = observations.at(-1),
        previous = observations.at(-2);
      return [
        id,
        {
          observations,
          latest,
          previous,
          changeEUR:
            latest && previous
              ? Math.round((latest.valueEUR - previous.valueEUR) * 100) / 100
              : null,
        },
      ];
    }),
  );
}

export function historySparkline(
  observations: { date: string; valueEUR: number }[],
) {
  if (!observations.length) return [];
  const first = Date.parse(observations[0].date),
    last = Date.parse(observations.at(-1)!.date);
  const values = observations.map((row) => row.valueEUR);
  const low = Math.min(...values),
    high = Math.max(...values);
  return observations.map((row) => ({
    date: row.date,
    x:
      last === first
        ? 48
        : 4 + ((Date.parse(row.date) - first) / (last - first)) * 88,
    y: high === low ? 14 : 24 - ((row.valueEUR - low) / (high - low)) * 20,
  }));
}
