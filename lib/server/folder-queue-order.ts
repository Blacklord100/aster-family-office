import type { DemoCatalog } from './demo-corpus';

/** Interleave verified synthetic families without consulting extraction answer keys. */
export function demoQueueOffset(
  catalog: DemoCatalog,
  contentHash: string,
): number | null {
  const matches = catalog.documents.filter(
    (document) => document.sha256 === contentHash,
  );
  const families = new Set(matches.map((document) => document.office_id));
  if (!matches.length || families.size !== 1) return null;
  const family = [...families][0],
    officeIndex = catalog.offices.findIndex((office) => office.id === family);
  if (officeIndex < 0) return null;
  const ordinal = catalog.documents
    .filter((document) => document.office_id === family)
    .findIndex((document) => document.sha256 === contentHash);
  return ordinal * catalog.offices.length + officeIndex;
}
