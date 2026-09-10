import type { Holding } from '@/data/types';
import type { PortfolioRecords } from './workspace';
import { PortfolioHistoryError } from './portfolio-history-error';
import {
  emptyHistoryLifecycle,
  historyLifecycleCommandSchema,
  type HistoryLifecycleState,
  type HistoryLifecycleRecord,
  type HistoryLifecycleCommand,
  type HistoryPositionDetails,
} from './portfolio-history-lifecycle-contract';
export const HISTORY_LIFECYCLE_LIMIT = 2000;
export function historyPositionDetails(
  holding: Holding,
): HistoryPositionDetails {
  const { familyId, entityId, accountId, name, manager, assetClass, currency } =
    holding;
  return { familyId, entityId, accountId, name, manager, assetClass, currency };
}
export function effectiveLifecycleRecords(
  state: HistoryLifecycleState | undefined,
  knownAt?: string,
): HistoryLifecycleRecord[] {
  const cutoff = knownAt ? Date.parse(knownAt) : null;
  const records = (state?.records ?? []).filter(
    (r) => cutoff === null || Date.parse(r.recordedAt) <= cutoff,
  );
  const superseded = new Set(
    records.flatMap((r) => (r.correctionOf ? [r.correctionOf] : [])),
  );
  return records
    .filter((r) => !superseded.has(r.id))
    .sort(
      (a, b) =>
        a.effectiveDate.localeCompare(b.effectiveDate) ||
        Number(a.kind !== 'opened') - Number(b.kind !== 'opened') ||
        a.recordedAt.localeCompare(b.recordedAt) ||
        a.id.localeCompare(b.id),
    );
}
export function lifecycleAt(
  state: HistoryLifecycleState | undefined,
  holdingId: string,
  date: string,
  knownAt?: string,
) {
  const records = effectiveLifecycleRecords(state, knownAt).filter(
    (r) => r.holdingId === holdingId,
  );
  return lifecycleFromRecords(records, date);
}
/** Accepts already version-selected, effective-date ordered records for one position. */
export function lifecycleFromRecords(
  records: readonly HistoryLifecycleRecord[],
  date: string,
) {
  const opening = records.find((r) => r.kind === 'opened') ?? null;
  const closing = records.find((r) => r.kind === 'closed') ?? null;
  const details =
    records.filter((r) => r.details && r.effectiveDate <= date).at(-1) ?? null;
  return {
    openedAt: opening?.effectiveDate ?? null,
    closedAt: closing?.effectiveDate ?? null,
    ownership:
      opening && date < opening.effectiveDate
        ? ('not_yet_opened' as const)
        : closing && date >= closing.effectiveDate
          ? ('closed' as const)
          : opening
            ? ('owned' as const)
            : ('unknown' as const),
    details: details?.details ?? null,
    sourceRecordId: details?.id ?? null,
    coverage: opening ? ('sourced' as const) : ('unknown' as const),
  };
}
/** Append-only economic declarations. A source-linked attestation is required;
 * legacy ledger openingDate and first observation are deliberately ignored. */
export function appendHistoryLifecycle(
  portfolio: PortfolioRecords,
  current: HistoryLifecycleState | undefined,
  value: HistoryLifecycleCommand,
  meta: { id: string; actorId: string; at: string; sourceSha256: string },
): { state: HistoryLifecycleState; record: HistoryLifecycleRecord } {
  const command = historyLifecycleCommandSchema.parse(value);
  const holding = portfolio.holdings.find((h) => h.id === command.holdingId);
  if (!holding)
    throw new PortfolioHistoryError(
      'HISTORY_HOLDING_NOT_FOUND',
      'Choose a registered position from this office.',
      404,
    );
  const source = portfolio.evidence.find(
    (e) =>
      e.id === command.sourceId &&
      e.holdingId === holding.id &&
      e.familyId === holding.familyId &&
      e.status === 'Accepted' &&
      !e.synthetic &&
      e.documentId,
  );
  if (!source || !/^[a-f0-9]{64}$/.test(meta.sourceSha256))
    throw new PortfolioHistoryError(
      'HISTORY_SOURCE_REQUIRED',
      'Select an accepted retained source for this position.',
    );
  if (!meta.actorId || !meta.id || !Number.isFinite(Date.parse(meta.at)))
    throw new PortfolioHistoryError(
      'HISTORY_ACTOR_INVALID',
      'A recorded reviewer and time are required.',
    );
  const state = structuredClone(current ?? emptyHistoryLifecycle());
  if (state.records.length >= HISTORY_LIFECYCLE_LIMIT)
    throw new PortfolioHistoryError(
      'HISTORY_LIFECYCLE_CAPACITY',
      'The bounded lifecycle history is full.',
      413,
    );
  if (state.records.some((r) => r.id === meta.id))
    throw new PortfolioHistoryError(
      'HISTORY_ID_CONFLICT',
      'This lifecycle record already exists.',
      409,
    );
  if (command.details) {
    const details = command.details;
    const entity = portfolio.entities.find(
      (e) => e.id === details.entityId && e.familyId === details.familyId,
    );
    const account = portfolio.accounts.find(
      (a) =>
        a.id === details.accountId &&
        a.entityId === details.entityId &&
        a.familyId === details.familyId,
    );
    // A position remains within one legal owner. A real transfer between owners
    // needs two positions and transfer evidence, not silently changing access.
    if (
      !entity ||
      !account ||
      details.familyId !== holding.familyId ||
      details.entityId !== holding.entityId
    )
      throw new PortfolioHistoryError(
        'HISTORY_IDENTITY_INVALID',
        'Position details must use a registered account of the same legal owner. Record ownership transfers as separate positions.',
      );
  }
  const active = effectiveLifecycleRecords(state).filter(
    (r) => r.holdingId === holding.id,
  );
  const previous = command.correctionOf
    ? active.find(
        (r) => r.id === command.correctionOf && r.kind === command.kind,
      )
    : null;
  if (command.correctionOf && !previous)
    throw new PortfolioHistoryError(
      'HISTORY_CORRECTION_INVALID',
      'Correct an active lifecycle record of the same position and event kind.',
      409,
    );
  if (previous && Date.parse(meta.at) < Date.parse(previous.recordedAt))
    throw new PortfolioHistoryError(
      'HISTORY_CORRECTION_INVALID',
      'A correction cannot precede the record it replaces.',
    );
  if (
    command.kind !== 'classified' &&
    active.some((r) => r.kind === command.kind && r.id !== previous?.id)
  )
    throw new PortfolioHistoryError(
      'HISTORY_LIFECYCLE_EXISTS',
      'This event already exists. Use an explicit correction; a reacquisition is a separate position.',
      409,
    );
  if (
    command.kind === 'classified' &&
    active.some(
      (r) =>
        r.kind === 'classified' &&
        r.effectiveDate === command.effectiveDate &&
        r.id !== previous?.id,
    )
  )
    throw new PortfolioHistoryError(
      'HISTORY_LIFECYCLE_EXISTS',
      'Correct the classification already recorded on this date.',
      409,
    );
  const record: HistoryLifecycleRecord = {
    id: meta.id,
    holdingId: holding.id,
    kind: command.kind,
    effectiveDate: command.effectiveDate,
    recordedAt: new Date(meta.at).toISOString(),
    actorId: meta.actorId,
    registeredDetails: historyPositionDetails(holding),
    details: command.details ?? null,
    sourceId: source.id,
    documentId: source.documentId!,
    sourceSha256: meta.sourceSha256,
    page: command.page,
    quote: command.quote,
    reason: command.reason,
    correctionOf: previous?.id ?? null,
  };
  state.records.push(record);
  const next = effectiveLifecycleRecords(state).filter(
    (r) => r.holdingId === holding.id,
  );
  const opened = next.find((r) => r.kind === 'opened'),
    closed = next.find((r) => r.kind === 'closed');
  if (opened && closed && closed.effectiveDate <= opened.effectiveDate)
    throw new PortfolioHistoryError(
      'HISTORY_LIFECYCLE_ORDER',
      'The exit must be later than the acquisition date.',
    );
  if (
    next.some(
      (r) =>
        r.kind === 'classified' &&
        ((opened && r.effectiveDate < opened.effectiveDate) ||
          (closed && r.effectiveDate >= closed.effectiveDate)),
    )
  )
    throw new PortfolioHistoryError(
      'HISTORY_LIFECYCLE_ORDER',
      'Classification changes must fall inside the sourced ownership period.',
    );
  state.revision++;
  return { state, record };
}
