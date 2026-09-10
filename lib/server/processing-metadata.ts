import type {
  Extraction,
  ProcessingSummary,
  ProcessingTiming,
  ProcessingSource,
} from '../processing-contract';
import type { ReviewState } from '../review-contract';
import { reviewedFact } from '../review-contract';

export const PROCESSING_SUMMARY_BYTE_BUDGET = 32 * 1024 * 1024;

export function missingProcessingSummary(
  availability: Exclude<ProcessingSummary['availability'], 'available'>,
): ProcessingSummary {
  return {
    availability,
    extractedCount: null,
    acceptedCount: null,
    deferredCount: null,
    rejectedCount: null,
    pendingCount: null,
    legacyCount: null,
    remainingCount: null,
    investmentNames: [],
    factTypes: [],
    documentType: null,
    warningCount: null,
    warnings: [],
    warningsTruncated: false,
  };
}

/** No quotes, amounts, model trace, rationale, or review history enter a list row. */
export function summarizeProcessing(
  result: Extraction,
  review: ReviewState,
): ProcessingSummary {
  const counts = {
    accepted: 0,
    deferred: 0,
    rejected: 0,
    pending: 0,
    legacy: 0,
  };
  const seen = new Set<number>();
  if (review.facts.length !== result.facts.length)
    throw new Error('INVALID_REVIEW_SUMMARY');
  for (const fact of review.facts) {
    if (
      !Number.isInteger(fact.factIndex) ||
      !result.facts[fact.factIndex] ||
      seen.has(fact.factIndex) ||
      !Object.hasOwn(counts, fact.status)
    )
      throw new Error('INVALID_REVIEW_SUMMARY');
    seen.add(fact.factIndex);
    counts[fact.status]++;
  }
  const warnings = result.warnings
    .slice(0, 3)
    .map((warning) => warning.slice(0, 240));
  const decisions = new Map(review.facts.map((fact) => [fact.factIndex, fact]));
  const effectiveFacts = result.facts.map((fact, index) =>
    reviewedFact(fact, decisions.get(index)),
  );
  return {
    availability: 'available',
    extractedCount: result.facts.length,
    acceptedCount: counts.accepted,
    deferredCount: counts.deferred,
    rejectedCount: counts.rejected,
    pendingCount: counts.pending,
    legacyCount: counts.legacy,
    remainingCount: counts.pending + counts.deferred,
    investmentNames: [
      ...new Set(effectiveFacts.map((fact) => fact.investmentName)),
    ],
    factTypes: [...new Set(effectiveFacts.map((fact) => fact.kind))],
    documentType: result.documentType,
    warningCount: result.warnings.length,
    warnings,
    warningsTruncated:
      result.warnings.length > warnings.length ||
      result.warnings.some((warning) => warning.length > 240),
  };
}

/** Choose ciphertexts before fetching them. Prioritize the explicitly selected record. */
export function summaryPayloadIds(
  rows: { id: string; payload_bytes: number; has_result: boolean }[],
  selectedId: string | null,
  budget = PROCESSING_SUMMARY_BYTE_BUDGET,
): string[] {
  let remaining = budget;
  return [...rows]
    .sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId))
    .filter((row) => {
      if (
        !row.has_result ||
        !Number.isSafeInteger(row.payload_bytes) ||
        row.payload_bytes < 1 ||
        row.payload_bytes > remaining
      )
        return false;
      remaining -= row.payload_bytes;
      return true;
    })
    .map((row) => row.id);
}

export type ProcessingAuditEvent = {
  resource_id: string;
  sequence: string | number;
  action: string;
  created_at: string | Date;
  attempt_id: string | null;
  duration_ms: number | string | null;
  attempt_count?: number | string;
};

function iso(value: string | Date): string | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function processingTiming(
  status: string,
  events: ProcessingAuditEvent[],
  now = Date.now(),
): ProcessingTiming {
  const latest = [...events].sort((a, b) => {
    const left = BigInt(a.sequence),
      right = BigInt(b.sequence);
    return left === right ? 0 : left > right ? -1 : 1;
  });
  const reset = latest.find((event) => event.action === 'processing.retry');
  const current = latest.filter(
    (event) => !reset || BigInt(event.sequence) > BigInt(reset.sequence),
  );
  const start = current.find((event) => event.action === 'processing.started');
  const end = current.find((event) =>
    [
      'processing.completed',
      'processing.failed',
      'processing.requeued',
      'processing.cancel',
    ].includes(event.action),
  );
  // A previous failed/requeued attempt cannot finish a newer attempt. Requiring
  // the signed attempt identity prevents pairing unrelated events after retries.
  const matchingEnd = start
    ? end &&
      BigInt(end.sequence) > BigInt(start.sequence) &&
      start.attempt_id &&
      end.attempt_id === start.attempt_id
      ? end
      : undefined
    : end;
  const startedAt = start ? iso(start.created_at) : null;
  const completedAt =
    matchingEnd?.action === 'processing.completed'
      ? iso(matchingEnd.created_at)
      : null;
  const failedAt =
    matchingEnd?.action === 'processing.failed'
      ? iso(matchingEnd.created_at)
      : null;
  const measured =
    matchingEnd?.duration_ms == null ? NaN : Number(matchingEnd.duration_ms);
  const processingDurationMs =
    startedAt && matchingEnd && Number.isSafeInteger(measured) && measured >= 0
      ? measured
      : null;
  const attempts = Number(
    latest.find((event) => event.attempt_count != null)?.attempt_count ?? 0,
  );
  return {
    startedAt,
    completedAt,
    failedAt,
    processingDurationMs,
    elapsedProcessingMs:
      status === 'processing' &&
      startedAt &&
      !matchingEnd &&
      now >= Date.parse(startedAt)
        ? now - Date.parse(startedAt)
        : null,
    source: 'worker_audit',
    attemptCount:
      Number.isSafeInteger(attempts) && attempts > 0 ? attempts : null,
  };
}

export function processingFamilyContext(
  review: ReviewState | null,
  relativePath: string | null,
  families: { id: string; name: string }[],
  holdings: { id: string; familyId: string }[],
): Pick<ProcessingSource, 'familyNames' | 'familyContext'> {
  const holdingIds = new Set(
    review?.facts
      .filter((fact) => fact.status === 'accepted')
      .map((fact) => fact.holdingId),
  );
  const familyIds = new Set(
    holdings
      .filter((holding) => holdingIds.has(holding.id))
      .map((holding) => holding.familyId),
  );
  const reviewed = families
    .filter((family) => familyIds.has(family.id))
    .map((family) => family.name);
  if (reviewed.length)
    return { familyNames: reviewed, familyContext: 'reviewed' };
  // Exact directory components only: no fuzzy matching or filename-derived claims.
  const components = new Set(
    relativePath
      ?.split('/')
      .slice(0, -1)
      .map((part) => part.toLowerCase()) ?? [],
  );
  const hints = families
    .filter(
      (family) =>
        components.has(family.id.toLowerCase()) ||
        components.has(family.name.toLowerCase()),
    )
    .map((family) => family.name);
  return {
    familyNames: hints,
    familyContext: hints.length ? 'source_path' : 'unknown',
  };
}
