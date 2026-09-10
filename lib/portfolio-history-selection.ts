import type { PortfolioHistoryResponse } from './portfolio-history-contract';
/** A comparable subset is selected from a particular full-scope revision. A
 * later subset must not be labelled with the cohort derived from an older one. */
export function comparableHistoryMatches(
  full: PortfolioHistoryResponse | null,
  subset: PortfolioHistoryResponse | null,
): boolean {
  if (
    !full ||
    !subset ||
    full.revision !== subset.revision ||
    full.financeRevision !== subset.financeRevision ||
    full.lifecycleRevision !== subset.lifecycleRevision ||
    full.projectionVersion !== subset.projectionVersion ||
    full.asOf !== subset.asOf
  )
    return false;
  const common = (query: PortfolioHistoryResponse['query']) => {
    const {
      holdingIds: _holdings,
      observationId: _observation,
      limit: _limit,
      offset: _offset,
      ...selection
    } = query;
    return selection;
  };
  return (
    JSON.stringify(common(full.query)) ===
      JSON.stringify(common(subset.query)) &&
    JSON.stringify([...full.comparison.comparable.holdingIds].sort()) ===
      JSON.stringify([...(subset.query.holdingIds ?? [])].sort())
  );
}
