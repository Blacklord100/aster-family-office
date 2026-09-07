import { describe, it, expect } from 'vitest';
import { aggregateRecordedMarks } from './recorded-marks';
import type { HoldingValuation } from '@/data/types';
const row = (
  holdingId: string,
  date: string,
  valueEUR: number,
): HoldingValuation => ({
  holdingId,
  date,
  valueEUR,
  netExternalFlowEUR: 0,
  valuationBasis: 'Reported mark',
});
describe('recorded portfolio marks', () => {
  it('waits for all positions then carries marks forward without creating returns', () => {
    expect(
      aggregateRecordedMarks(
        [
          row('a', '2026-01-01', 100),
          row('b', '2026-02-01', 200),
          row('a', '2026-03-01', 120),
        ],
        ['a', 'b'],
      ),
    ).toEqual([
      { date: '2026-02-01', value: 300, flow: null, index: null },
      { date: '2026-03-01', value: 320, flow: null, index: null },
    ]);
  });
  it('anchors a selected period to the last known complete mark', () => {
    expect(
      aggregateRecordedMarks(
        [row('a', '2026-01-01', 100), row('a', '2026-03-01', 120)],
        ['a'],
        '2026-02-01',
      ),
    ).toEqual([
      { date: '2026-02-01', value: 100, flow: null, index: null },
      { date: '2026-03-01', value: 120, flow: null, index: null },
    ]);
  });
  it('never invents a missing position and rejects duplicate revisions', () => {
    expect(
      aggregateRecordedMarks([row('a', '2026-01-01', 100)], ['a', 'b']),
    ).toEqual([]);
    expect(() =>
      aggregateRecordedMarks(
        [row('a', '2026-01-01', 100), row('a', '2026-01-01', 120)],
        ['a'],
      ),
    ).toThrow('Duplicate');
  });
});
