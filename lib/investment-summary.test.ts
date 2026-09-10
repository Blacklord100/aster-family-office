import { describe, expect, it } from 'vitest';
import { investmentSummaries, historySparkline } from './investment-summary';
import type { HoldingValuation } from '@/data/types';
const mark = (
  date: string,
  valueEUR: number,
  basis: HoldingValuation['valuationBasis'] = 'Reported mark',
): HoldingValuation => ({
  holdingId: 'one',
  date,
  valueEUR,
  valuationBasis: basis,
  netExternalFlowEUR: 0,
});
describe('observed investment summaries', () => {
  it('sorts late arrivals, replaces same-date displayed corrections and excludes carry forwards', () => {
    const result = investmentSummaries([
      mark('2026-06-30', 140),
      mark('2026-03-31', 100),
      mark('2026-04-01', 100, 'Carried forward'),
      mark('2026-06-30', 130),
    ]).get('one')!;
    expect(result.observations.map((v) => v.valueEUR)).toEqual([100, 130]);
    expect(result.changeEUR).toBe(30);
  });
  it('does not fabricate a change for a single observation or mix investments', () => {
    const result = investmentSummaries([
      mark('2026-03-31', 100),
      { ...mark('2026-06-30', 200), holdingId: 'two' },
    ]);
    expect(result.get('one')!.changeEUR).toBeNull();
    expect(result.get('two')!.changeEUR).toBeNull();
  });
  it('spaces marks by actual time and supports flat single-point series', () => {
    const points = historySparkline([
      { date: '2026-01-01', valueEUR: 100 },
      { date: '2026-01-02', valueEUR: 100 },
      { date: '2026-01-11', valueEUR: 100 },
    ]);
    expect(points.map((p) => p.x)).toEqual([4, 12.8, 92]);
    expect(points.map((p) => p.y)).toEqual([14, 14, 14]);
    expect(
      historySparkline([{ date: '2026-01-01', valueEUR: 100 }])[0],
    ).toEqual({ date: '2026-01-01', x: 48, y: 14 });
  });
});
