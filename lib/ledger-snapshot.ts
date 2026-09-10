import type { LedgerResponse } from './ledger-contract';
export type LedgerSnapshot = { contextKey: string; response: LedgerResponse };
/** A late GET/POST must not replace a newer revision or another authenticated scope. */
export function mergeLedgerSnapshot(
  current: LedgerSnapshot | null,
  response: LedgerResponse,
  requestContext: string,
  activeContext: string,
): LedgerSnapshot | null {
  if (requestContext !== activeContext) return current;
  if (
    current?.contextKey === activeContext &&
    current.response.revision > response.revision
  )
    return current;
  return { contextKey: requestContext, response };
}
/** A form keeps its entries, but permission to submit belongs to its reviewed revision. */
export function ledgerDraftNeedsReview(
  draft: { revision: number; contextKey: string },
  snapshot: LedgerSnapshot | null,
  loading: boolean,
  observedRevision = -1,
): boolean {
  return (
    loading ||
    !snapshot ||
    snapshot.response.revision < observedRevision ||
    draft.contextKey !== snapshot.contextKey ||
    draft.revision !== snapshot.response.revision
  );
}
