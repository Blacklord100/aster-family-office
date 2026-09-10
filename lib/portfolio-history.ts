import { PortfolioHistoryError } from './portfolio-history-error';
import {
  effectiveLifecycleRecords,
  lifecycleFromRecords,
  historyPositionDetails,
} from './portfolio-history-lifecycle';
import type {
  HistoryLifecycleState,
  HistoryLifecycleRecord,
} from './portfolio-history-lifecycle-contract';
import type { Holding } from '@/data/types';
import { ledgerDate, ledgerMoney, type FinanceState } from './ledger-contract';
import type { PortfolioRecords } from './workspace';
import {
  HISTORY_PROJECTION_VERSION,
  PortfolioHistoryQuerySchema,
  type PortfolioHistoryQuery,
  type PortfolioHistoryResponse,
  type HistoryObservation,
  type HistoryPoint,
  type HistoryCoverage,
} from './portfolio-history-contract';

export const HISTORY_LIMITS = {
  maxHoldings: 200,
  maxObservations: 4000,
  maxWorkspaceBytes: 32 * 1024 * 1024,
  truncated: false as const,
};
export { PortfolioHistoryError } from './portfolio-history-error';
export type HistoryProjectionContext = {
  revision: number;
  now?: string;
  lifecycle?: HistoryLifecycleState;
  documentMetadata?: ReadonlyMap<string, { importedAt: string }>;
};
/** All arithmetic is in exact cents. Numeric values retained by the original
 * ledger are admitted only if their rounded cent representation is safe. */
export function historyCents(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value))
    throw new PortfolioHistoryError(
      'HISTORY_AMOUNT_INVALID',
      'An observation has an invalid exact amount.',
    );
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (
    (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) *
    (negative ? -1n : 1n)
  );
}
export function historyMoney(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
function retainedEUR(value: number): string | null {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isSafeInteger(Math.round(value * 100))
  )
    return null;
  return value.toFixed(2);
}
function iso(value?: string): string | null {
  if (!value || !/T/.test(value) || !Number.isFinite(Date.parse(value)))
    return null;
  return new Date(value).toISOString();
}
function compare(a: HistoryObservation, b: HistoryObservation): number {
  return (
    a.effectiveDate.localeCompare(b.effectiveDate) ||
    (a.recordedAt ?? '').localeCompare(b.recordedAt ?? '') ||
    a.id.localeCompare(b.id)
  );
}
function percent(before: string | null, after: string | null): number | null {
  if (before === null || after === null || historyCents(before) === 0n)
    return null;
  // A rounded display percentage; underlying money and differences remain exact.
  return (
    Number(
      ((historyCents(after) - historyCents(before)) * 1000000n) /
        historyCents(before),
    ) / 10000
  );
}
function delta(before: string | null, after: string | null): string | null {
  return before === null || after === null
    ? null
    : historyMoney(historyCents(after) - historyCents(before));
}
function comparable(a: HistoryObservation, b: HistoryObservation): boolean {
  return (
    a.amount !== null &&
    b.amount !== null &&
    a.currency === b.currency &&
    a.valuationBasis === b.valuationBasis
  );
}
function emptyCoverage(total: number): HistoryCoverage {
  return {
    knownCount: 0,
    unknownCount: total,
    totalCount: total,
    complete: false,
    carriedCount: 0,
    unavailableCurrencyCount: 0,
  };
}
function assertIds(
  requested: string[] | undefined,
  allowed: Set<string>,
): void {
  if (requested?.some((id) => !allowed.has(id)))
    throw new PortfolioHistoryError(
      'HISTORY_SCOPE_NOT_FOUND',
      'The selected history scope is not available.',
      404,
    );
}

/** Read-only adapter. No current balance, intake timestamp, first mark, or
 * legacy openingDate is promoted into a historical economic event. */
export function projectPortfolioHistory(
  portfolio: PortfolioRecords,
  finance: FinanceState | undefined,
  input: Partial<PortfolioHistoryQuery> = {},
  context: HistoryProjectionContext = { revision: 0 },
): PortfolioHistoryResponse {
  const query = PortfolioHistoryQuerySchema.parse(input);
  const effectiveLifecycle = effectiveLifecycleRecords(
    context.lifecycle,
    query.knownAt,
  );
  const lifecycleByHolding = new Map<string, HistoryLifecycleRecord[]>();
  for (const record of effectiveLifecycle)
    lifecycleByHolding.set(record.holdingId, [
      ...(lifecycleByHolding.get(record.holdingId) ?? []),
      record,
    ]);
  const lifeAt = (holdingId: string, date: string) =>
    lifecycleFromRecords(lifecycleByHolding.get(holdingId) ?? [], date);
  const now = iso(context.now ?? new Date().toISOString());
  if (!now)
    throw new PortfolioHistoryError(
      'HISTORY_DATE_INVALID',
      'Choose a valid projection time.',
    );
  const asOf = query.asOf ?? query.to ?? now.slice(0, 10);
  if (query.from && query.from > asOf)
    throw new PortfolioHistoryError(
      'HISTORY_DATE_INVALID',
      'The start date is after the selected position date.',
    );
  assertIds(query.holdingIds, new Set(portfolio.holdings.map((h) => h.id)));
  assertIds(query.familyIds, new Set(portfolio.families.map((f) => f.id)));
  assertIds(query.entityIds, new Set(portfolio.entities.map((e) => e.id)));
  const holdings = portfolio.holdings.filter(
    (h) =>
      (!query.holdingIds || query.holdingIds.includes(h.id)) &&
      (!query.familyIds || query.familyIds.includes(h.familyId)) &&
      (!query.entityIds || query.entityIds.includes(h.entityId)),
  );
  if (holdings.length > HISTORY_LIMITS.maxHoldings)
    throw new PortfolioHistoryError(
      'HISTORY_CAPACITY',
      'Select at most 200 holdings for one history projection.',
      413,
    );
  const holdingMap = new Map(holdings.map((h) => [h.id, h]));
  const records = (finance?.valuations ?? []).filter((v) =>
    holdingMap.has(v.holdingId),
  );
  if (records.length > HISTORY_LIMITS.maxObservations)
    throw new PortfolioHistoryError(
      'HISTORY_CAPACITY',
      'This projection exceeds the 4,000-observation capacity. No partial totals were calculated.',
      413,
    );
  const evidence = new Map(portfolio.evidence.map((e) => [e.id, e]));
  const gaps = new Set<string>();
  const knownAt = query.knownAt ? Date.parse(query.knownAt) : null;
  const rows: HistoryObservation[] = [];
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id))
      throw new PortfolioHistoryError(
        'HISTORY_RECORD_CONFLICT',
        'Duplicate observation identities require review.',
        409,
      );
    ids.add(record.id);
    if (!ledgerDate.safeParse(record.effectiveDate).success) {
      gaps.add(
        'Some observations have invalid effective dates and are excluded.',
      );
      continue;
    }
    const recordedAt = iso(record.recordedAt);
    if (knownAt !== null && (!recordedAt || Date.parse(recordedAt) > knownAt))
      continue;
    if (record.effectiveDate > asOf) continue;
    const holding = holdingMap.get(record.holdingId)!;
    const source = evidence.get(record.sourceId);
    const trusted =
      !!source &&
      source.holdingId === holding.id &&
      source.familyId === holding.familyId &&
      source.status === 'Accepted' &&
      !source.synthetic;
    const nativeAmount = ledgerMoney.safeParse(record.amount).success
      ? historyMoney(historyCents(record.amount))
      : null;
    const retained = retainedEUR(record.valueEUR);
    const valueEUR =
      record.currency === 'EUR'
        ? nativeAmount === retained
          ? nativeAmount
          : null
        : record.fx
          ? retained
          : null;
    if (valueEUR === null)
      gaps.add(
        'Some retained observations lack valid historical currency/FX support and are unavailable in EUR.',
      );
    const amount =
      query.currency === 'EUR'
        ? valueEUR
        : record.currency === query.currency
          ? nativeAmount
          : null;
    rows.push({
      id: record.id,
      holdingId: holding.id,
      investmentName: holding.name,
      familyId: holding.familyId,
      entityId: holding.entityId,
      effectiveDate: record.effectiveDate,
      recordedAt,
      importedAt:
        trusted && source.documentId
          ? iso(context.documentMetadata?.get(source.documentId)?.importedAt)
          : null,
      reportDate: null,
      messageTimestamp: null,
      nativeAmount,
      currency: record.currency,
      valueEUR,
      amount,
      displayCurrency: query.currency,
      fx: record.fx ? { ...record.fx } : null,
      sourceId: trusted ? source.id : null,
      documentId: trusted ? (source.documentId ?? null) : null,
      filename: trusted ? source.filename : null,
      page: trusted ? source.page : null,
      quote: trusted ? source.excerpt.slice(0, 6000) : null,
      provenance:
        trusted && recordedAt ? 'accepted_source' : 'legacy_unverified',
      dateBasis: 'recorded_effective_date',
      status: trusted && recordedAt ? 'current' : 'legacy',
      version: 1,
      correctionOf: record.correctionOf ?? null,
      correctionReason: record.correctionReason ?? null,
      supersededBy: null,
      valuationBasis: record.valuationMethod,
      previousObservationId: null,
      changeAmount: null,
      changePercent: null,
    });
  }
  // Preserve unsourced legacy rows for inspection, never use them as accepted
  // totals or invent dates/source links from a current holding's latest source.
  const represented = new Set(
    records.map((r) => `${r.holdingId}\0${r.effectiveDate}`),
  );
  if (knownAt === null)
    for (const [index, row] of portfolio.history.entries()) {
      const holding = holdingMap.get(row.holdingId);
      if (
        !holding ||
        represented.has(`${row.holdingId}\0${row.date}`) ||
        row.date > asOf ||
        !ledgerDate.safeParse(row.date).success
      )
        continue;
      rows.push({
        id: `legacy:${holding.id}:${row.date}:${index}`,
        holdingId: holding.id,
        investmentName: holding.name,
        familyId: holding.familyId,
        entityId: holding.entityId,
        effectiveDate: row.date,
        recordedAt: null,
        importedAt: null,
        reportDate: null,
        messageTimestamp: null,
        nativeAmount: null,
        currency: null,
        valueEUR: retainedEUR(row.valueEUR),
        amount: query.currency === 'EUR' ? retainedEUR(row.valueEUR) : null,
        displayCurrency: query.currency,
        fx: null,
        sourceId: null,
        documentId: null,
        filename: null,
        page: null,
        quote: null,
        provenance: 'legacy_unverified',
        dateBasis: 'recorded_effective_date',
        status: 'legacy',
        version: 1,
        correctionOf: null,
        correctionReason: null,
        supersededBy: null,
        valuationBasis: row.valuationBasis,
        previousObservationId: null,
        changeAmount: null,
        changePercent: null,
      });
    }
  if (rows.length > HISTORY_LIMITS.maxObservations)
    throw new PortfolioHistoryError(
      'HISTORY_CAPACITY',
      'This projection exceeds the 4,000-observation capacity. No partial totals were calculated.',
      413,
    );
  rows.sort(compare);
  const groups = new Map<string, HistoryObservation[]>();
  for (const row of rows) {
    const key = `${row.holdingId}\0${row.effectiveDate}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const trusted = group.filter((r) => r.provenance === 'accepted_source');
    const map = new Map(trusted.map((r) => [r.id, r]));
    for (const row of trusted) {
      const previous = row.correctionOf ? map.get(row.correctionOf) : undefined;
      if (
        previous &&
        previous.id !== row.id &&
        previous.recordedAt! <= row.recordedAt!
      ) {
        previous.status = 'superseded';
        previous.supersededBy = row.id;
      }
    }
    for (const row of trusted) {
      const seen = new Set([row.id]);
      let predecessor = row.correctionOf
        ? map.get(row.correctionOf)
        : undefined;
      while (predecessor) {
        if (seen.has(predecessor.id))
          throw new PortfolioHistoryError(
            'HISTORY_RECORD_CONFLICT',
            'Circular correction lineage requires review.',
            409,
          );
        seen.add(predecessor.id);
        row.version++;
        predecessor = predecessor.correctionOf
          ? map.get(predecessor.correctionOf)
          : undefined;
      }
    }
    const active = trusted.filter((r) => r.status === 'current');
    if (active.length > 1) {
      const signatures = new Set(
        active.map(
          (r) =>
            `${r.nativeAmount}|${r.currency}|${r.valueEUR}|${r.valuationBasis}`,
        ),
      );
      if (signatures.size > 1) {
        for (const row of active) row.status = 'conflicted';
        gaps.add(
          'Conflicting accepted marks on the same date require an explicit correction; they are excluded from totals.',
        );
      } else {
        // Corroborating duplicates are inspectable versions, never counted twice.
        const current = active.at(-1)!;
        for (const row of active.slice(0, -1)) {
          row.status = 'superseded';
          row.supersededBy = current.id;
        }
      }
    }
  }
  if (rows.some((r) => r.provenance === 'legacy_unverified'))
    gaps.add(
      'Legacy observations without accepted source provenance are visible but excluded from accepted totals.',
    );
  if (query.currency !== 'EUR')
    gaps.add(
      'Non-EUR views include matching native-currency observations only; no cross-currency conversion is invented.',
    );
  const current = rows.filter((r) => r.status === 'current');
  const byHolding = new Map<string, HistoryObservation[]>();
  for (const row of current)
    byHolding.set(row.holdingId, [
      ...(byHolding.get(row.holdingId) ?? []),
      row,
    ]);
  for (const observations of byHolding.values())
    for (const [index, row] of observations.entries()) {
      const previous = observations
        .slice(0, index)
        .reverse()
        .find((p) => comparable(p, row));
      if (previous) {
        row.previousObservationId = previous.id;
        row.changeAmount = delta(previous.amount, row.amount);
        row.changePercent = percent(previous.amount, row.amount);
      }
    }
  const conflicts = new Map<string, HistoryObservation[]>();
  for (const row of rows.filter((r) => r.status === 'conflicted'))
    conflicts.set(row.holdingId, [
      ...(conflicts.get(row.holdingId) ?? []),
      row,
    ]);
  function lastAt(
    observations: HistoryObservation[],
    date: string,
  ): HistoryObservation | null {
    let low = 0,
      high = observations.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (observations[mid].effectiveDate <= date) low = mid + 1;
      else high = mid;
    }
    return low > 0 ? observations[low - 1] : null;
  }
  function markAt(holding: Holding, date: string): HistoryObservation | null {
    const mark = lastAt(byHolding.get(holding.id) ?? [], date);
    const conflict = lastAt(conflicts.get(holding.id) ?? [], date);
    // A newer unresolved conflict invalidates a carried older value.
    if (conflict && (!mark || conflict.effectiveDate >= mark.effectiveDate))
      return null;
    return mark;
  }
  function ownedAt(holding: Holding, date: string): boolean {
    const life = lifeAt(
      holding.id,
      query.cohort === 'current' ? now!.slice(0, 10) : date,
    );
    return life.ownership !== 'closed' && life.ownership !== 'not_yet_opened';
  }
  function displayMark(
    holding: Holding,
    date: string,
  ): HistoryObservation | null {
    if (!ownedAt(holding, date)) return null;
    const mark = markAt(holding, date);
    return mark &&
      (!query.sourceCurrency || mark.currency === query.sourceCurrency)
      ? mark
      : null;
  }
  function point(date: string): HistoryPoint {
    const included = holdings.filter((h) => ownedAt(h, date));
    const coverage = emptyCoverage(included.length);
    let total = 0n;
    const observationIds: string[] = [];
    for (const holding of included) {
      const mark = displayMark(holding, date);
      if (mark?.amount !== null && mark) {
        total += historyCents(mark.amount);
        coverage.knownCount++;
        if (mark.effectiveDate < date) coverage.carriedCount++;
        // Only fresh observations at this date. Carried values retain their
        // original date via the positions query, avoiding quadratic payloads.
        if (mark.effectiveDate === date) observationIds.push(mark.id);
      } else if (mark) coverage.unavailableCurrencyCount++;
    }
    coverage.unknownCount = included.length - coverage.knownCount;
    coverage.complete = included.length > 0 && coverage.unknownCount === 0;
    const knownAmount = coverage.knownCount ? historyMoney(total) : null;
    return {
      date,
      timestamp: Date.parse(date + 'T00:00:00Z'),
      amount: coverage.complete ? knownAmount : null,
      knownAmount,
      currency: query.currency,
      coverage,
      observationIds,
      basis:
        query.cohort === 'historical'
          ? 'Latest accepted marks of sourced historical positions; unknown ownership retained'
          : 'Latest accepted marks of selected current holdings',
    };
  }
  const positions = holdings.map((holding) => {
    const life = lifeAt(holding.id, asOf);
    const latest = displayMark(holding, asOf);
    const reported = markAt(holding, asOf);
    const latestReported =
      reported &&
      (!query.sourceCurrency || reported.currency === query.sourceCurrency)
        ? reported
        : null;
    const previousComparable = latest
      ? ((byHolding.get(holding.id) ?? [])
          .filter(
            (r) =>
              r.effectiveDate < latest.effectiveDate && comparable(r, latest),
          )
          .at(-1) ?? null)
      : null;
    return {
      holdingId: holding.id,
      investmentName: life.details?.name ?? holding.name,
      familyId: holding.familyId,
      entityId: holding.entityId,
      latest,
      latestReported,
      previousComparable,
      changeAmount: delta(
        previousComparable?.amount ?? null,
        latest?.amount ?? null,
      ),
      changePercent: percent(
        previousComparable?.amount ?? null,
        latest?.amount ?? null,
      ),
      firstObservedDate:
        rows.find((r) => r.holdingId === holding.id)?.effectiveDate ?? null,
      economicOpenedAt: life.openedAt,
      economicClosedAt: life.closedAt,
      lifecycleCoverage: life.coverage,
      ownership: life.ownership,
      metadata: life.details ?? historyPositionDetails(holding),
      metadataBasis: life.details
        ? ('sourced_effective_details' as const)
        : ('current_register' as const),
    };
  });
  const end = query.to && query.to < asOf ? query.to : asOf;
  const within = (r: HistoryObservation) =>
    (!query.from || r.effectiveDate >= query.from) &&
    r.effectiveDate <= end &&
    (!query.sourceCurrency || r.currency === query.sourceCurrency);
  const dates = new Set(current.filter(within).map((r) => r.effectiveDate));
  if (query.cohort === 'historical')
    for (const record of context.lifecycle?.records ?? []) {
      if (
        holdingMap.has(record.holdingId) &&
        record.effectiveDate <= end &&
        (!query.from || record.effectiveDate >= query.from) &&
        (!query.knownAt ||
          Date.parse(record.recordedAt) <= Date.parse(query.knownAt))
      )
        dates.add(record.effectiveDate);
    }
  if (query.from) dates.add(query.from);
  if (current.length) dates.add(end);
  const points = [...dates].sort().map(point);
  const from = query.from ?? points[0]?.date ?? null;
  const opening = from ? point(from) : null;
  const closing = points.length ? point(end) : null;
  const pairs = from
    ? holdings.flatMap((h) => {
        const first = displayMark(h, from),
          last = displayMark(h, end);
        return first && last && comparable(first, last)
          ? [{ holdingId: h.id, first, last }]
          : [];
      })
    : [];
  const openingAmount = pairs.length
    ? historyMoney(
        pairs.reduce((sum, p) => sum + historyCents(p.first.amount!), 0n),
      )
    : null;
  const closingAmount = pairs.length
    ? historyMoney(
        pairs.reduce((sum, p) => sum + historyCents(p.last.amount!), 0n),
      )
    : null;
  const visible = rows
    .filter(
      (r) =>
        within(r) && (query.includeSuperseded || r.status !== 'superseded'),
    )
    .sort((a, b) => -compare(a, b));
  const selectedIndex = query.observationId
    ? visible.findIndex((r) => r.id === query.observationId)
    : -1;
  const coverage = point(asOf).coverage;
  if (!coverage.complete)
    gaps.add(
      'The selected current holdings do not all have an accepted value at the selected date and currency. Unknown values are not zero.',
    );
  if (positions.some((p) => p.lifecycleCoverage === 'unknown'))
    gaps.add(
      'Acquisition and historical ownership remain unknown for positions without sourced lifecycle records. They are retained in coverage, not assumed absent.',
    );
  if (positions.some((p) => p.metadataBasis === 'current_register'))
    gaps.add(
      'Some position classifications come from the current register; their historical effective dates are not established.',
    );
  const response: PortfolioHistoryResponse = {
    query,
    revision: context.revision,
    financeRevision: finance?.revision ?? 0,
    projectionVersion: HISTORY_PROJECTION_VERSION,
    asOf,
    summary: point(asOf),
    selectedObservation: selectedIndex >= 0 ? visible[selectedIndex] : null,
    selectedOffset:
      selectedIndex >= 0
        ? Math.floor(selectedIndex / query.limit) * query.limit
        : null,
    observations: visible.slice(query.offset, query.offset + query.limit),
    positions,
    points,
    page: {
      limit: query.limit,
      offset: query.offset,
      total: visible.length,
      hasMore: query.offset + query.limit < visible.length,
      nextOffset:
        query.offset + query.limit < visible.length
          ? query.offset + query.limit
          : null,
    },
    comparison: {
      from,
      to: closing ? end : null,
      opening,
      closing,
      changeAmount: delta(opening?.amount ?? null, closing?.amount ?? null),
      comparable: {
        holdingIds: pairs.map((p) => p.holdingId),
        holdingCount: pairs.length,
        openingAmount,
        closingAmount,
        changeAmount: delta(openingAmount, closingAmount),
        changePercent: percent(openingAmount, closingAmount),
      },
      investmentReturn: null,
      basis: 'Change in reported value; not investment return',
    },
    coverage,
    gaps: [...gaps],
    lifecycleRevision: context.lifecycle?.revision ?? 0,
    basis:
      query.cohort === 'historical'
        ? 'Historical positions from sourced lifecycle; unresolved ownership remains included'
        : 'History of selected current holdings; historical ownership is not established',
    limits: HISTORY_LIMITS,
  };
  return response;
}
