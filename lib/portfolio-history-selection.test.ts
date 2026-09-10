import { describe, expect, it } from 'vitest';
import { comparableHistoryMatches } from './portfolio-history-selection';
import {
  PortfolioHistoryQuerySchema,
  type PortfolioHistoryResponse,
} from './portfolio-history-contract';
function selections() {
  const full = {
    revision: 4,
    financeRevision: 2,
    lifecycleRevision: 1,
    projectionVersion: 'portfolio-history/1',
    asOf: '2026-06-30',
    query: PortfolioHistoryQuerySchema.parse({
      from: '2026-03-31',
      familyIds: ['family'],
      cohort: 'historical',
    }),
    comparison: { comparable: { holdingIds: ['one', 'two'] } },
  } as PortfolioHistoryResponse;
  const subset = {
    ...full,
    query: { ...full.query, holdingIds: ['two', 'one'], limit: 20, offset: 0 },
  };
  return { full, subset };
}
describe('comparable portfolio selection', () => {
  it('accepts the same scoped, dated revision independent of page or holding order', () => {
    const { full, subset } = selections();
    expect(comparableHistoryMatches(full, subset)).toBe(true);
  });
  it('never mixes a cohort derived before a newer financial or lifecycle revision', () => {
    const { full, subset } = selections();
    for (const field of [
      'revision',
      'financeRevision',
      'lifecycleRevision',
    ] as const)
      expect(
        comparableHistoryMatches(full, {
          ...subset,
          [field]: subset[field] + 1,
        }),
      ).toBe(false);
  });
  it('rejects another period, family, currency, knowledge cutoff or holding cohort', () => {
    const { full, subset } = selections();
    for (const change of [
      { from: '2026-02-28' },
      { familyIds: ['other'] },
      { currency: 'USD' as const },
      { knowledge: 'as_known' as const, knownAt: '2026-09-09T00:00:00Z' },
      { holdingIds: ['one'] },
    ])
      expect(
        comparableHistoryMatches(full, {
          ...subset,
          query: { ...subset.query, ...change },
        }),
      ).toBe(false);
    expect(comparableHistoryMatches(full, null)).toBe(false);
  });
});
