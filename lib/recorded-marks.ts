import type { HoldingValuation } from '@/data/types';
import { sumMoney } from './finance';
export type RecordedPoint = {
  date: string;
  value: number;
  flow: null;
  index: null;
};
/** Current-position marks carried forward only after every selected holding has a known value.
 * No interpolation, external-flow assertion or investment return is implied. */
export function aggregateRecordedMarks(
  rows: readonly HoldingValuation[],
  holdingIds: readonly string[],
  start = '0000-01-01',
): RecordedPoint[] {
  const ids = new Set(holdingIds);
  if (!ids.size) return [];
  const dates = new Map<string, HoldingValuation[]>(),
    seen = new Set<string>();
  for (const row of rows) {
    if (!ids.has(row.holdingId)) continue;
    const key = row.holdingId + ':' + row.date;
    if (seen.has(key)) throw new Error('Duplicate recorded holding/date');
    seen.add(key);
    const group = dates.get(row.date) ?? [];
    group.push(row);
    dates.set(row.date, group);
  }
  const values = new Map<string, number>(),
    points: RecordedPoint[] = [];
  for (const [date, group] of [...dates].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const row of group) values.set(row.holdingId, row.valueEUR);
    if (values.size === ids.size)
      points.push({
        date,
        value: sumMoney([...values.values()]),
        flow: null,
        index: null,
      });
  }
  const before = points.filter((p) => p.date < start).at(-1),
    visible = points.filter((p) => p.date >= start);
  if (before && visible[0]?.date !== start)
    visible.unshift({ ...before, date: start });
  return visible;
}
