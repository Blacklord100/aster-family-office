import {
  MAX_REPORT_RECEIPTS_PER_OCCURRENCE,
  reportExceptionActionSchema,
  reportObligationsStateSchema,
  reportReceiptInputSchema,
  reportScheduleInputSchema,
  type ReportExceptionAction,
  type ReportExceptionSignal,
  type ReportEvidenceReference,
  type ReportHistoryEntry,
  type ReportMutationContext,
  type ReportObligationsState,
  type ReportOccurrence,
  type ReportOccurrenceSummary,
  type ReportReceipt,
  type ReportReceiptInput,
  type ReportScheduleInput,
  type ReportScheduleVersion,
} from './report-obligations-contract';

const DAY = 86_400_000;
const MINUTE = 60_000;
const MAX_PERIODS = 50_000;
const MAX_EVALUATION_DAYS = 366 * 30;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function fail(message: string): never {
  throw new Error(message);
}
function instant(value: string): number {
  if (
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    fail('Use a valid timestamp with timezone.');
  return Date.parse(value);
}
function calendarTime(date: string): number {
  const value = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(value) ||
    new Date(value).toISOString().slice(0, 10) !== date
  )
    fail('Use a valid calendar date.');
  return value;
}
function utcDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}
export function addReportCalendarDays(date: string, days: number): string {
  if (!Number.isSafeInteger(days))
    fail('Calendar-day offset must be an integer.');
  return utcDate(calendarTime(date) + days * DAY);
}
function formatter(zone: string): Intl.DateTimeFormat {
  let result = formatterCache.get(zone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    if (formatterCache.size > 100) formatterCache.clear();
    formatterCache.set(zone, result);
  }
  return result;
}
function zonedParts(value: number, zone: string) {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    second: parts.second,
  };
}
export function reportLocalDate(at: string, zone: string): string {
  return zonedParts(instant(at), zone).date;
}

/**
 * Wall-clock deadlines follow Temporal's "compatible" convention: the earlier
 * instant in a repeated hour; advance by the gap for a nonexistent local time.
 * Grace is elapsed time after that instant, not another wall-clock conversion.
 */
export function reportLocalDateTimeToInstant(
  date: string,
  time: string,
  zone: string,
): string {
  calendarTime(date);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))
    fail('Use a valid local time.');
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set<number>();
  for (const delta of [-3 * DAY, -DAY, 0, DAY, 3 * DAY]) {
    const candidate = wall + delta;
    const local = zonedParts(candidate, zone);
    offsets.add(
      Date.parse(`${local.date}T${local.time}:${local.second}Z`) - candidate,
    );
  }
  const candidates = [...offsets].map((offset) => wall - offset);
  const wanted = `${date}T${time}`;
  const exact = candidates.filter((candidate) => {
    const local = zonedParts(candidate, zone);
    return `${local.date}T${local.time}` === wanted;
  });
  if (exact.length) return new Date(Math.min(...exact)).toISOString();
  const later = candidates
    .map((value) => ({ value, local: zonedParts(value, zone) }))
    .filter(
      (candidate) => `${candidate.local.date}T${candidate.local.time}` > wanted,
    )
    .sort(
      (a, b) =>
        `${a.local.date}T${a.local.time}`.localeCompare(
          `${b.local.date}T${b.local.time}`,
        ) || a.value - b.value,
    );
  if (!later.length)
    fail('The local deadline cannot be represented in the selected timezone.');
  return new Date(later[0].value).toISOString();
}

function nextPeriodStart(
  start: string,
  cadence: ReportScheduleInput['cadence'],
): string | null {
  if (cadence === 'one_off') return null;
  const date = new Date(calendarTime(start));
  date.setUTCMonth(
    date.getUTCMonth() + { monthly: 1, quarterly: 3, annual: 12 }[cadence],
  );
  return utcDate(date.getTime());
}
export function reportPeriodEnd(
  start: string,
  definition: Pick<ReportScheduleInput, 'cadence' | 'oneOffPeriodEnd'>,
): string {
  const next = nextPeriodStart(start, definition.cadence);
  if (next) return addReportCalendarDays(next, -1);
  if (!definition.oneOffPeriodEnd || definition.oneOffPeriodEnd < start)
    fail('A one-off report needs an explicit period end.');
  calendarTime(definition.oneOffPeriodEnd);
  return definition.oneOffPeriodEnd;
}
function clone(state: ReportObligationsState): ReportObligationsState {
  return structuredClone(state);
}
function history(
  context: ReportMutationContext,
  action: string,
  reason: string,
  evidence: ReportEvidenceReference[] = [],
  evidenceFingerprint: string | null = null,
): ReportHistoryEntry {
  instant(context.now);
  if (!context.actorUserId?.trim()) fail('An actor is required.');
  return {
    at: context.now,
    actorUserId: context.actorUserId,
    action,
    reason,
    evidence: structuredClone(evidence),
    evidenceFingerprint,
  };
}
function checked(state: ReportObligationsState): ReportObligationsState {
  return reportObligationsStateSchema.parse(state);
}
function requiredReason(reason: string): string {
  if (reason.trim().length < 3 || reason.trim().length > 3000)
    fail('Record a reason of 3 to 3000 characters.');
  return reason.trim();
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createReportSchedule(
  state: ReportObligationsState,
  input: ReportScheduleInput,
  context: ReportMutationContext,
  creationReason = 'Schedule created',
): ReportObligationsState {
  const definition = reportScheduleInputSchema.parse(input);
  definition.holdingIds.sort();
  definition.familyIds.sort();
  const reason = requiredReason(creationReason);
  if (!context.id) fail('A schedule ID is required.');
  if (state.schedules.some((schedule) => schedule.id === context.id))
    fail('That schedule ID already exists.');
  const next = clone(state);
  next.schedules.push({
    id: context.id,
    versions: [
      {
        id: `${context.id}:v1`,
        version: 1,
        effectiveFrom: definition.firstPeriodStart,
        status: 'active',
        definition,
        createdAt: context.now,
        createdBy: context.actorUserId,
        reason,
      },
    ],
    history: [history(context, 'created', reason)],
  });
  return checked(next);
}

/** Versions only affect future, unmaterialized periods; old occurrences are snapshots. */
export function reviseReportSchedule(
  state: ReportObligationsState,
  scheduleId: string,
  input: ReportScheduleInput,
  effectiveFrom: string,
  context: ReportMutationContext,
  options: { status?: 'active' | 'paused'; reason: string },
): ReportObligationsState {
  const definition = reportScheduleInputSchema.parse(input);
  definition.holdingIds.sort();
  definition.familyIds.sort();
  calendarTime(effectiveFrom);
  const next = clone(state);
  const schedule =
    next.schedules.find((candidate) => candidate.id === scheduleId) ??
    fail('Report schedule not found.');
  const latest = schedule.versions.at(-1)!;
  if (effectiveFrom <= reportLocalDate(context.now, definition.timezone))
    fail('Schedule changes must start in a future period.');
  if (effectiveFrom <= latest.effectiveFrom)
    fail('A new version must start after the latest version.');
  if (definition.firstPeriodStart !== effectiveFrom)
    fail('The new definition must start at the version boundary.');
  if (
    state.occurrences.some(
      (occurrence) =>
        occurrence.scheduleId === scheduleId &&
        (occurrence.periodStart >= effectiveFrom ||
          occurrence.periodEnd >= effectiveFrom),
    )
  )
    fail(
      'This change would rewrite a materialized obligation. Choose a later unmaterialized period.',
    );
  const previousBoundary =
    latest.definition.cadence === 'one_off'
      ? addReportCalendarDays(latest.definition.oneOffPeriodEnd!, 1)
      : nextPeriodStart(effectiveFrom, latest.definition.cadence);
  if (!previousBoundary) fail('Invalid version boundary.');
  // End the previous version only on one of its natural period boundaries.
  if (latest.definition.cadence !== 'one_off') {
    const month = Number(effectiveFrom.slice(5, 7));
    if (
      effectiveFrom.slice(8) !== '01' ||
      (latest.definition.cadence === 'quarterly' &&
        ![1, 4, 7, 10].includes(month)) ||
      (latest.definition.cadence === 'annual' && month !== 1)
    )
      fail('The version boundary would split an existing reporting period.');
  } else if (effectiveFrom <= latest.definition.oneOffPeriodEnd!)
    fail('The version boundary would split the one-off period.');
  const reason = requiredReason(options.reason);
  const version = latest.version + 1;
  schedule.versions.push({
    id: `${scheduleId}:v${version}`,
    version,
    effectiveFrom,
    status: options.status ?? 'active',
    definition,
    createdAt: context.now,
    createdBy: context.actorUserId,
    reason,
  });
  schedule.history.push(
    history(
      context,
      options.status === 'paused' ? 'paused' : 'revised',
      reason,
    ),
  );
  return checked(next);
}

function buildOccurrence(
  scheduleId: string,
  version: ReportScheduleVersion,
  start: string,
  now: string,
): ReportOccurrence {
  const definition = version.definition;
  const periodEnd = reportPeriodEnd(start, definition);
  const dueAt = reportLocalDateTimeToInstant(
    addReportCalendarDays(periodEnd, definition.dueDaysAfterPeriodEnd),
    definition.dueLocalTime,
    definition.timezone,
  );
  return {
    id: `occ:${scheduleId}:${start}`,
    scheduleId,
    scheduleVersionId: version.id,
    name: definition.name,
    holdingIds: [...definition.holdingIds],
    familyIds: [...definition.familyIds],
    managerId: definition.managerId,
    reportType: definition.reportType,
    cadence: definition.cadence,
    periodStart: start,
    periodEnd,
    timezone: definition.timezone,
    dueAt,
    graceEndsAt: new Date(
      instant(dueAt) + definition.graceHours * 60 * MINUTE,
    ).toISOString(),
    dueLocalTime: definition.dueLocalTime,
    ownerUserId: definition.ownerUserId,
    staleAfterDays: definition.staleAfterDays,
    createdAt: now,
    receipts: [],
    disposition: null,
    history: [],
  };
}

export function activeReportReceipts(
  occurrence: ReportOccurrence,
): ReportReceipt[] {
  const matched = occurrence.receipts.filter(
    (receipt) => receipt.matchStatus === 'matched',
  );
  const superseded = new Set<string>();
  const byId = new Map(
    occurrence.receipts.map((receipt) => [receipt.id, receipt]),
  );
  for (const receipt of matched) {
    let previous = receipt.supersedesReceiptId;
    const visited = new Set<string>([receipt.id]);
    while (previous) {
      if (visited.has(previous))
        fail('A receipt supersession cycle requires review.');
      visited.add(previous);
      superseded.add(previous);
      previous = byId.get(previous)?.supersedesReceiptId ?? null;
    }
  }
  return matched.filter((receipt) => !superseded.has(receipt.id));
}
export function summarizeReportOccurrence(
  occurrence: ReportOccurrence,
  now: string,
): ReportOccurrenceSummary {
  const at = instant(now);
  const matched = occurrence.receipts.filter(
    (receipt) => receipt.matchStatus === 'matched',
  );
  const active = activeReportReceipts(occurrence);
  const received = matched
    .map((receipt) => receipt.receivedAt)
    .sort((a, b) => instant(a) - instant(b));
  const firstReceivedAt = received[0] ?? null;
  const lateByHours = firstReceivedAt
    ? Math.max(
        0,
        (instant(firstReceivedAt) - instant(occurrence.dueAt)) / (60 * MINUTE),
      )
    : 0;
  const deliveryStatus =
    occurrence.disposition?.status ??
    (firstReceivedAt
      ? instant(firstReceivedAt) > instant(occurrence.dueAt)
        ? 'received_late'
        : 'received'
      : at > instant(occurrence.graceEndsAt)
        ? 'overdue'
        : at >= instant(occurrence.dueAt)
          ? 'due'
          : 'upcoming');
  return {
    deliveryStatus,
    firstReceivedAt,
    latestReceivedAt: received.at(-1) ?? null,
    lateByHours,
    acceptedCount: active.filter(
      (receipt) => receipt.reviewStatus === 'accepted',
    ).length,
    pendingCount: active.filter((receipt) => receipt.reviewStatus === 'pending')
      .length,
    rejectedCount: active.filter(
      (receipt) => receipt.reviewStatus === 'rejected',
    ).length,
    failedCount: active.filter((receipt) =>
      ['failed', 'blocked'].includes(receipt.processingStatus),
    ).length,
    activeReceiptIds: active.map((receipt) => receipt.id),
    supersededReceiptIds: matched
      .filter((receipt) => !active.includes(receipt))
      .map((receipt) => receipt.id),
  };
}

/** Root must verify the document hash, arrival time, scope and cited source before calling. */
export function matchReportReceipt(
  state: ReportObligationsState,
  occurrenceId: string,
  input: ReportReceiptInput,
  context: ReportMutationContext,
): ReportObligationsState {
  const receipt = reportReceiptInputSchema.parse(input);
  receipt.holdingIds.sort();
  const next = clone(state);
  const occurrence =
    next.occurrences.find((candidate) => candidate.id === occurrenceId) ??
    fail('Report occurrence not found.');
  if (
    receipt.periodStart !== occurrence.periodStart ||
    receipt.periodEnd !== occurrence.periodEnd
  )
    fail('This report covers another reporting period.');
  if (receipt.reportType !== occurrence.reportType)
    fail('This report has another report type.');
  if (!occurrence.holdingIds.every((id) => receipt.holdingIds.includes(id)))
    fail('Every holding in the expectation needs explicit receipt coverage.');
  if (instant(receipt.receivedAt) > instant(context.now))
    fail('Actual receipt time cannot be in the future.');
  if (
    receipt.asOfDate &&
    receipt.asOfDate > reportLocalDate(receipt.receivedAt, occurrence.timezone)
  )
    fail('A reported as-of date cannot be later than its actual receipt.');
  const existing = occurrence.receipts.find(
    (candidate) => candidate.documentId === receipt.documentId,
  );
  if (
    !existing &&
    occurrence.receipts.length >= MAX_REPORT_RECEIPTS_PER_OCCURRENCE
  )
    fail(
      `This reporting occurrence already has ${MAX_REPORT_RECEIPTS_PER_OCCURRENCE} retained receipt versions. Arrange a reviewed archive before linking another source; no matches or history have been removed.`,
    );
  if (existing) {
    const immutableKeys = [
      'documentHash',
      'holdingIds',
      'reportType',
      'periodStart',
      'periodEnd',
      'asOfDate',
      'receivedAt',
      'supersedesReceiptId',
    ] as const;
    if (immutableKeys.some((key) => !equal(existing[key], receipt[key])))
      fail(
        'This source is already linked with different receipt metadata. Revoke the incorrect match and explicitly review a replacement.',
      );
    if (existing.matchStatus === 'revoked')
      fail('A revoked match needs explicit reinstatement.');
    if (
      existing.processingStatus === receipt.processingStatus &&
      existing.reviewStatus === receipt.reviewStatus
    )
      return state;
    existing.processingStatus = receipt.processingStatus;
    existing.reviewStatus = receipt.reviewStatus;
    existing.history.push(
      history(
        context,
        'source_status_updated',
        'Source processing or review status changed',
        receipt.matchEvidence,
      ),
    );
  } else {
    if (
      receipt.supersedesReceiptId &&
      !occurrence.receipts.some(
        (candidate) =>
          candidate.id === receipt.supersedesReceiptId &&
          candidate.matchStatus === 'matched',
      )
    )
      fail(
        'The superseded receipt must belong to this occurrence and remain matched.',
      );
    if (
      receipt.supersedesReceiptId &&
      activeReportReceipts(occurrence).every(
        (candidate) => candidate.id !== receipt.supersedesReceiptId,
      )
    )
      fail(
        'That receipt is already superseded; link a revision to the current version.',
      );
    const event = history(
      context,
      'receipt_matched',
      receipt.matchReason,
      receipt.matchEvidence,
    );
    occurrence.receipts.push({
      ...receipt,
      id: `receipt:${receipt.documentId}`,
      matchedAt: context.now,
      matchedBy: context.actorUserId,
      matchStatus: 'matched',
      history: [event],
    });
    occurrence.history.push(event);
  }
  return checked(next);
}

export function revokeReportReceipt(
  state: ReportObligationsState,
  occurrenceId: string,
  receiptId: string,
  reason: string,
  context: ReportMutationContext,
): ReportObligationsState {
  const next = clone(state);
  const occurrence =
    next.occurrences.find((candidate) => candidate.id === occurrenceId) ??
    fail('Report occurrence not found.');
  const receipt =
    occurrence.receipts.find((candidate) => candidate.id === receiptId) ??
    fail('Report receipt not found.');
  if (receipt.matchStatus === 'revoked') return state;
  receipt.matchStatus = 'revoked';
  const entry = history(
    context,
    'receipt_revoked',
    requiredReason(reason),
    receipt.matchEvidence,
  );
  receipt.history.push(entry);
  occurrence.history.push(entry);
  return checked(next);
}

export function reinstateReportReceipt(
  state: ReportObligationsState,
  occurrenceId: string,
  receiptId: string,
  reason: string,
  context: ReportMutationContext,
): ReportObligationsState {
  const next = clone(state);
  const occurrence =
    next.occurrences.find((candidate) => candidate.id === occurrenceId) ??
    fail('Report occurrence not found.');
  const receipt =
    occurrence.receipts.find((candidate) => candidate.id === receiptId) ??
    fail('Report receipt not found.');
  if (receipt.matchStatus === 'matched') return state;
  if (
    receipt.supersedesReceiptId &&
    !occurrence.receipts.some(
      (candidate) =>
        candidate.id === receipt.supersedesReceiptId &&
        candidate.matchStatus === 'matched',
    )
  )
    fail('The superseded receipt must be reinstated first.');
  if (
    occurrence.receipts.some(
      (candidate) =>
        candidate.id !== receipt.id &&
        candidate.matchStatus === 'matched' &&
        candidate.supersedesReceiptId &&
        candidate.supersedesReceiptId === receipt.supersedesReceiptId,
    )
  )
    fail('A different current revision already supersedes that receipt.');
  receipt.matchStatus = 'matched';
  const entry = history(
    context,
    'receipt_reinstated',
    requiredReason(reason),
    receipt.matchEvidence,
  );
  receipt.history.push(entry);
  occurrence.history.push(entry);
  return checked(next);
}

export function disposeReportOccurrence(
  state: ReportObligationsState,
  occurrenceId: string,
  input: {
    status: 'waived' | 'cancelled' | 'reopen';
    reason: string;
    evidence: ReportEvidenceReference[];
  },
  context: ReportMutationContext,
): ReportObligationsState {
  const next = clone(state);
  const occurrence =
    next.occurrences.find((candidate) => candidate.id === occurrenceId) ??
    fail('Report occurrence not found.');
  const reason = requiredReason(input.reason);
  occurrence.disposition =
    input.status === 'reopen'
      ? null
      : {
          status: input.status,
          reason,
          at: context.now,
          actorUserId: context.actorUserId,
          evidence: input.evidence,
        };
  occurrence.history.push(
    history(
      context,
      input.status === 'reopen'
        ? 'obligation_reopened'
        : `obligation_${input.status}`,
      reason,
      input.evidence,
    ),
  );
  return checked(next);
}

// IDs are convenient stable handles, not security hashes. The complete issue key
// is authoritative, and a collision is rejected rather than merging two issues.
function issueId(key: string): string {
  let a = 2166136261;
  let b = 2246822519;
  for (let i = 0; i < key.length; i++) {
    a = Math.imul(a ^ key.charCodeAt(i), 16777619);
    b = Math.imul(b ^ key.charCodeAt(i), 3266489917);
  }
  return `exception:${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
function applySignal(
  state: ReportObligationsState,
  signal: ReportExceptionSignal,
  context: ReportMutationContext,
  createInactive = false,
): void {
  const active = signal.sourceActive ?? true;
  let issue = state.exceptions.find(
    (candidate) => candidate.key === signal.key,
  );
  if (!issue) {
    if (!active && !createInactive) return;
    const id = issueId(signal.key);
    if (state.exceptions.some((candidate) => candidate.id === id))
      fail('An exception identifier collision requires an explicit migration.');
    issue = {
      ...signal,
      id,
      managerId: signal.managerId ?? null,
      occurrenceId: signal.occurrenceId ?? null,
      assigneeUserId: signal.assigneeUserId ?? null,
      dueAt: signal.dueAt ?? null,
      status: active ? 'open' : 'resolved',
      snoozedUntil: null,
      resolvedFingerprint: active ? null : signal.evidenceFingerprint,
      sourceActive: active,
      origin: signal.origin ?? 'external',
      createdAt: context.now,
      updatedAt: context.now,
      history: [
        history(
          context,
          active ? 'detected' : 'delivery_recorded',
          signal.description,
          signal.evidence,
          signal.evidenceFingerprint,
        ),
      ],
    };
    state.exceptions.push(issue);
    return;
  }
  const fingerprintChanged =
    issue.evidenceFingerprint !== signal.evidenceFingerprint;
  const sourceChanged = issue.sourceActive !== active;
  const metadata = [
    'category',
    'title',
    'description',
    'familyIds',
    'holdingIds',
    'managerId',
    'occurrenceId',
    'dueAt',
    'evidence',
  ] as const;
  let changed = false;
  for (const key of metadata) {
    if (signal[key] !== undefined && !equal(issue[key], signal[key])) {
      Object.assign(issue, { [key]: structuredClone(signal[key]) });
      changed = true;
    }
  }
  // Re-evaluation never overwrites an explicit assignment or priority choice.
  issue.sourceActive = active;
  if (!active && ['open', 'snoozed'].includes(issue.status)) {
    issue.status = 'resolved';
    issue.snoozedUntil = null;
    issue.resolvedFingerprint = signal.evidenceFingerprint;
    issue.history.push(
      history(
        context,
        'source_resolved',
        signal.description,
        signal.evidence,
        signal.evidenceFingerprint,
      ),
    );
    changed = true;
  } else if (
    active &&
    ['resolved', 'waived'].includes(issue.status) &&
    (fingerprintChanged || sourceChanged)
  ) {
    issue.status = 'open';
    issue.snoozedUntil = null;
    issue.resolvedFingerprint = null;
    issue.history.push(
      history(
        context,
        'reopened_by_evidence',
        'The underlying issue or its supporting evidence changed.',
        signal.evidence,
        signal.evidenceFingerprint,
      ),
    );
    changed = true;
  } else if (fingerprintChanged) {
    issue.history.push(
      history(
        context,
        'evidence_updated',
        'Supporting evidence changed; the current assignment and snooze are preserved.',
        signal.evidence,
        signal.evidenceFingerprint,
      ),
    );
    changed = true;
  }
  issue.evidenceFingerprint = signal.evidenceFingerprint;
  if (changed || sourceChanged) issue.updatedAt = context.now;
}

function deliverySignal(
  occurrence: ReportOccurrence,
  now: string,
): ReportExceptionSignal | null {
  const summary = summarizeReportOccurrence(occurrence, now);
  if (summary.deliveryStatus === 'upcoming' || summary.deliveryStatus === 'due')
    return null;
  const isMissing = summary.deliveryStatus === 'overdue';
  const evidence = occurrence.receipts
    .filter((receipt) => receipt.matchStatus === 'matched')
    .map((receipt) => ({ kind: 'document' as const, id: receipt.documentId }));
  const description = occurrence.disposition
    ? `Obligation ${occurrence.disposition.status}: ${occurrence.disposition.reason}`
    : isMissing
      ? `No reviewed receipt match covers ${occurrence.periodStart} to ${occurrence.periodEnd}. The deadline and grace period have passed.`
      : summary.deliveryStatus === 'received_late'
        ? `The first matched report arrived ${Math.ceil(summary.lateByHours)} hours after the configured deadline. Processing and financial review remain separate.`
        : 'A source-backed receipt covers this reporting period. Processing and financial review remain separate.';
  return {
    key: `delivery:${occurrence.id}`,
    category:
      summary.deliveryStatus === 'received_late'
        ? 'late_report'
        : 'missing_report',
    title:
      `${occurrence.name} · ${isMissing ? 'missing report' : summary.deliveryStatus === 'received_late' ? 'late receipt' : 'delivery recorded'}`.slice(
        0,
        240,
      ),
    description,
    familyIds: occurrence.familyIds,
    holdingIds: occurrence.holdingIds,
    managerId: occurrence.managerId,
    occurrenceId: occurrence.id,
    assigneeUserId: occurrence.ownerUserId,
    priority: 'high',
    dueAt: occurrence.graceEndsAt,
    evidence,
    evidenceFingerprint: JSON.stringify([
      occurrence.id,
      occurrence.scheduleVersionId,
      occurrence.disposition,
      occurrence.receipts.map((receipt) => [
        receipt.documentId,
        receipt.documentHash,
        receipt.matchStatus,
        receipt.receivedAt,
      ]),
    ]),
    sourceActive: isMissing,
    origin: 'calendar',
  };
}

export type EvaluateReportObligationsOptions = {
  /** Inclusive period-start range. from cannot skip any schedule's first period. */
  from: string;
  through: string;
  now: string;
  /** Production catch-up: each version starts periods in its own timezone. */
  startedPeriodsOnly?: boolean;
  issues?: ReportExceptionSignal[];
  /** Only set for a complete, tenant-wide external issue snapshot. */
  externalSignalsComplete?: boolean;
  maxNewOccurrences?: number;
};

/** Pure, all-or-nothing catch-up. Exceeding limits fails; it never drops obligations. */
export function evaluateReportObligations(
  state: ReportObligationsState,
  options: EvaluateReportObligationsOptions,
): ReportObligationsState {
  const from = calendarTime(options.from);
  const through = calendarTime(options.through);
  instant(options.now);
  if (through < from || through - from > MAX_EVALUATION_DAYS * DAY)
    fail('Evaluate an explicit range of at most 30 years.');
  if (
    state.schedules.some(
      (schedule) =>
        calendarTime(schedule.versions[0].definition.firstPeriodStart) < from,
    )
  )
    fail(
      'The evaluation range would skip an earlier configured period. Start from the earliest schedule.',
    );
  const next = clone(state);
  const keys = new Set(next.occurrences.map((occurrence) => occurrence.id));
  let added = 0;
  let considered = 0;
  const limit = options.maxNewOccurrences ?? 5000;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PERIODS)
    fail('Use a valid explicit occurrence limit.');
  for (const schedule of next.schedules) {
    for (let index = 0; index < schedule.versions.length; index++) {
      const version = schedule.versions[index];
      const nextVersion = schedule.versions[index + 1];
      if (version.status === 'paused') continue;
      const localThrough = options.startedPeriodsOnly
        ? [
            options.through,
            reportLocalDate(options.now, version.definition.timezone),
          ].sort()[0]
        : options.through;
      let start: string | null = version.definition.firstPeriodStart;
      while (
        start &&
        start <= localThrough &&
        (!nextVersion || start < nextVersion.effectiveFrom)
      ) {
        if (++considered > 200_000)
          fail(
            'Catch-up exceeds the safe evaluation budget; partition schedules explicitly.',
          );
        if (start >= options.from) {
          const key = `occ:${schedule.id}:${start}`;
          if (!keys.has(key)) {
            if (++added > limit || next.occurrences.length >= MAX_PERIODS)
              fail(
                'Catch-up exceeds the occurrence limit. Increase the explicit limit or archive reviewed history; no partial changes were made.',
              );
            const occurrence = buildOccurrence(
              schedule.id,
              version,
              start,
              options.now,
            );
            if (
              nextVersion &&
              occurrence.periodEnd >= nextVersion.effectiveFrom
            )
              fail('A schedule version splits a reporting period.');
            next.occurrences.push(occurrence);
            keys.add(key);
          }
        }
        start = nextPeriodStart(start, version.definition.cadence);
      }
    }
  }
  const context = {
    now: options.now,
    actorUserId: 'system:reporting-calendar',
  };
  for (const occurrence of next.occurrences) {
    const signal = deliverySignal(occurrence, options.now);
    if (signal)
      applySignal(next, signal, context, signal.category === 'late_report');
  }
  const seen = new Set<string>();
  for (const signal of options.issues ?? []) {
    if (seen.has(signal.key))
      fail('Each external issue key must appear once per evaluation.');
    if (signal.key.startsWith('delivery:') || signal.origin === 'calendar')
      fail('External issues cannot impersonate calendar delivery issues.');
    seen.add(signal.key);
    applySignal(
      next,
      { ...signal, origin: signal.origin ?? 'external' },
      context,
    );
  }
  if (options.externalSignalsComplete) {
    for (const issue of next.exceptions.filter(
      (candidate) =>
        candidate.origin === 'external' &&
        candidate.sourceActive &&
        !seen.has(candidate.key),
    )) {
      applySignal(
        next,
        {
          ...issue,
          sourceActive: false,
          description: 'The authoritative source no longer reports this issue.',
        },
        context,
      );
    }
  }
  for (const issue of next.exceptions) {
    if (
      issue.status === 'snoozed' &&
      issue.snoozedUntil &&
      instant(issue.snoozedUntil) <= instant(options.now)
    ) {
      issue.status = issue.sourceActive ? 'open' : 'resolved';
      issue.snoozedUntil = null;
      issue.updatedAt = options.now;
      issue.history.push(
        history(
          context,
          'snooze_expired',
          'The configured wake time has arrived.',
          issue.evidence,
          issue.evidenceFingerprint,
        ),
      );
    }
  }
  next.occurrences.sort(
    (a, b) =>
      a.periodStart.localeCompare(b.periodStart) || a.id.localeCompare(b.id),
  );
  return checked(next);
}

export function actOnReportException(
  state: ReportObligationsState,
  exceptionId: string,
  input: ReportExceptionAction,
  context: ReportMutationContext,
): ReportObligationsState {
  const action = reportExceptionActionSchema.parse(input);
  const next = clone(state);
  const issue =
    next.exceptions.find((candidate) => candidate.id === exceptionId) ??
    fail('Report exception not found.');
  const evidence = 'evidence' in action ? action.evidence : [];
  if (action.action === 'assign') issue.assigneeUserId = action.assigneeUserId;
  else if (action.action === 'priority') issue.priority = action.priority;
  else if (action.action === 'snooze') {
    if (!issue.sourceActive || ['resolved', 'waived'].includes(issue.status))
      fail('Only an active open issue can be snoozed.');
    if (
      instant(action.until) <= instant(context.now) ||
      instant(action.until) - instant(context.now) > 366 * DAY
    )
      fail('Choose a wake time in the next 366 days.');
    issue.status = 'snoozed';
    issue.snoozedUntil = action.until;
  } else if (action.action === 'resolve' || action.action === 'waive') {
    issue.status = action.action === 'resolve' ? 'resolved' : 'waived';
    issue.snoozedUntil = null;
    issue.resolvedFingerprint = issue.evidenceFingerprint;
  } else {
    issue.status = 'open';
    issue.snoozedUntil = null;
    issue.resolvedFingerprint = null;
  }
  issue.updatedAt = context.now;
  issue.history.push(
    history(
      context,
      action.action,
      action.reason,
      evidence,
      issue.evidenceFingerprint,
    ),
  );
  return checked(next);
}

export function addManualReportException(
  state: ReportObligationsState,
  signal: ReportExceptionSignal,
  context: ReportMutationContext,
): ReportObligationsState {
  if (state.exceptions.some((candidate) => candidate.key === signal.key))
    fail('An issue with that identity already exists.');
  if (signal.key.startsWith('delivery:'))
    fail('Manual issues cannot impersonate calendar delivery issues.');
  const next = clone(state);
  applySignal(
    next,
    { ...signal, origin: 'manual', sourceActive: true },
    context,
  );
  return checked(next);
}
