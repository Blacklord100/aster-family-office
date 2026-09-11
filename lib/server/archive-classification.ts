import type { PortfolioRecords } from '../workspace';
import type { ArchiveSource } from './archive-bundle';
/** Access grants release visibility; only accepted source associations classify an archive. */
export function archiveClassification(
  documentId: string,
  portfolio: Pick<PortfolioRecords, 'holdings' | 'families' | 'evidence'>,
): Pick<ArchiveSource, 'family' | 'investment' | 'classificationBasis'> {
  const ids = new Set(
    portfolio.evidence
      .filter((e) => e.documentId === documentId && e.status === 'Accepted')
      .filter((e) =>
        portfolio.holdings.some(
          (h) => h.id === e.holdingId && h.familyId === e.familyId,
        ),
      )
      .map((e) => e.holdingId),
  );
  const holdings = portfolio.holdings.filter((h) => ids.has(h.id));
  const families = new Set(holdings.map((h) => h.familyId));
  const family =
    families.size === 1
      ? portfolio.families.find((f) => families.has(f.id))
      : undefined;
  const holding = holdings.length === 1 ? holdings[0] : undefined;
  return {
    ...(family ? { family: { id: family.id, name: family.name } } : {}),
    ...(holding ? { investment: { id: holding.id, name: holding.name } } : {}),
    classificationBasis: holdings.length
      ? 'Accepted source associations at archival; ambiguous family or investment remains unassigned.'
      : 'Unassigned at archival; no accepted source association.',
  };
}
