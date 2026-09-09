import type { ReportObligationsState } from './report-obligations-contract';

/** Conservative complete-record projection: a consolidation or its history is
 * hidden unless every holding and every original source has been released. */
export function scopeReportObligations(
  state: ReportObligationsState,
  holdings: Set<string>,
  documents: Set<string>,
  reviews: Map<string, string>,
): ReportObligationsState {
  const allowedHoldings = (ids: string[]) =>
    ids.length > 0 && ids.every((id) => holdings.has(id));
  function referencesAllowed(value: unknown): boolean {
    if (!value || typeof value !== 'object') return true;
    if (Array.isArray(value)) return value.every(referencesAllowed);
    const row = value as Record<string, unknown>;
    if (typeof row.holdingId === 'string' && !holdings.has(row.holdingId))
      return false;
    if (
      Array.isArray(row.holdingIds) &&
      !allowedHoldings(row.holdingIds as string[])
    )
      return false;
    if (typeof row.documentId === 'string' && !documents.has(row.documentId))
      return false;
    if (
      row.kind === 'document' &&
      (typeof row.id !== 'string' || !documents.has(row.id))
    )
      return false;
    if (
      row.kind === 'holding' &&
      (typeof row.id !== 'string' || !holdings.has(row.id))
    )
      return false;
    if (
      row.kind === 'review' &&
      (typeof row.id !== 'string' || !documents.has(reviews.get(row.id) ?? ''))
    )
      return false;
    // Fact identifiers lack a released-document contract; do not guess scope.
    if (row.kind === 'fact') return false;
    return Object.values(row).every(referencesAllowed);
  }
  const schedules = state.schedules.filter(
    (row) =>
      row.versions.every((version) =>
        allowedHoldings(version.definition.holdingIds),
      ) && referencesAllowed(row),
  );
  const scheduleIds = new Set(schedules.map((row) => row.id));
  const occurrences = state.occurrences.filter(
    (row) =>
      scheduleIds.has(row.scheduleId) &&
      allowedHoldings(row.holdingIds) &&
      referencesAllowed(row),
  );
  const occurrenceIds = new Set(occurrences.map((row) => row.id));
  return {
    version: 1,
    schedules,
    occurrences,
    exceptions: state.exceptions.filter(
      (row) =>
        allowedHoldings(row.holdingIds) &&
        (!row.occurrenceId || occurrenceIds.has(row.occurrenceId)) &&
        referencesAllowed(row),
    ),
  };
}
