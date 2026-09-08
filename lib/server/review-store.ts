import type { PoolClient } from 'pg';
import { ExtractionSchema, type Extraction } from '../processing-contract';
import {
  initialReview,
  reviewedFact,
  reviewJobStatus,
  type ReviewDecision,
  type ReviewState,
  type ReviewVersion,
} from '../review-contract';
import { AccessError, type WorkspaceContext } from './access';
import { decrypt, encrypt, sha256 } from './crypto';

export function readReview(
  job: {
    id: string;
    status: string;
    review_state?: Buffer | null;
    review_revision?: number;
  },
  organizationId: string,
  result: Extraction,
): ReviewState {
  const hash = sha256(JSON.stringify(ExtractionSchema.parse(result)));
  if (!job.review_state) return initialReview(result, hash, job.status);
  const state = JSON.parse(
    decrypt(
      job.review_state,
      'review:' + organizationId + ':' + job.id,
    ).toString(),
  ) as ReviewState;
  if (
    state.extractionHash !== hash ||
    state.revision !== job.review_revision ||
    state.facts.length !== result.facts.length
  )
    throw new AccessError(
      409,
      'REVIEW_SOURCE_CHANGED',
      'The extraction no longer matches its review record. Contact an administrator.',
    );
  return state;
}

/** Pure transition planning happens before any portfolio writes; the caller holds the job row lock. */
export function planReview(
  current: ReviewState,
  result: Extraction,
  expectedRevision: number,
  decisions: ReviewDecision[],
  actorId: string,
  at: string,
): ReviewState {
  if (current.revision !== expectedRevision)
    throw new AccessError(
      409,
      'REVIEW_CONFLICT',
      'Another reviewer updated this document. Reload its decisions before saving.',
    );
  const next = structuredClone(current);
  const changed = decisions.map((decision) => {
    const previous = current.facts[decision.factIndex];
    if (!previous || !result.facts[decision.factIndex])
      throw new AccessError(
        400,
        'INVALID_FACT',
        'Choose a fact from this extraction.',
      );
    if (previous.status === 'legacy')
      throw new AccessError(
        409,
        'LEGACY_REVIEW',
        'This older review has no per-fact decision record. Use a new source review for a correction.',
      );
    if (previous.status === 'accepted') {
      const before = reviewedFact(result.facts[decision.factIndex], previous);
      const after = decision.amendedFact ?? before;
      if (
        decision.status !== 'accepted' ||
        !decision.correction ||
        decision.holdingId !== previous.holdingId ||
        before.kind !== 'valuation' ||
        after.kind !== 'valuation' ||
        before.effectiveDate !== after.effectiveDate
      )
        throw new AccessError(
          409,
          'ACCEPTED_FACT_LOCKED',
          'Accepted facts are retained. Only an explicit valuation correction for the same investment and effective date may create a new version.',
        );
    }
    const record = {
      ...previous,
      ...decision,
      fx: decision.fx,
      correction: decision.correction,
      version: previous.version + 1,
      reviewedAt: at,
      reviewedBy: actorId,
    };
    next.facts[decision.factIndex] = record;
    return record;
  });
  next.revision++;
  next.history = [
    ...next.history,
    { revision: next.revision, at, actorId, decisions: changed },
  ].slice(-30);
  return next;
}

export async function applyReview(
  c: PoolClient,
  ctx: WorkspaceContext,
  job: {
    id: string;
    document_id: string;
    filename: string;
    status: string;
    review_state?: Buffer | null;
    review_revision?: number;
  },
  result: Extraction,
  expectedRevision: number,
  decisions: ReviewDecision[],
) {
  const current = readReview(job, ctx.organizationId, result);
  const next = planReview(
    current,
    result,
    expectedRevision,
    decisions,
    ctx.user.id,
    new Date().toISOString(),
  );
  const accepted = decisions.filter(
    (decision) => decision.status === 'accepted',
  );
  if (accepted.length) {
    const opened = await c.query(
      "SELECT 1 FROM app_audit WHERE organization_id=$1 AND actor_id=$2 AND resource_id=$3 AND action IN ('document.downloaded','document.previewed') LIMIT 1",
      [ctx.organizationId, ctx.user.id, job.document_id],
    );
    if (!opened.rows.length)
      throw new AccessError(
        400,
        'ORIGINAL_REVIEW_REQUIRED',
        'Open the original source before verifying and accepting its facts.',
      );
  }
  const effectiveResult: Extraction = {
    ...result,
    facts: result.facts.map((fact, index) =>
      reviewedFact(fact, next.facts[index]),
    ),
  };
  const { acceptFacts } = await import('./accept-facts');
  const outcome = accepted.length
    ? await acceptFacts(
        c,
        ctx,
        job,
        effectiveResult,
        accepted.map((decision) => ({
          ...next.facts[decision.factIndex],
          reviewRevision: next.revision,
        })),
      )
    : { applied: 0, duplicates: 0, sources: {} as Record<number, string> };
  for (const [index, sourceId] of Object.entries(outcome.sources))
    next.facts[Number(index)].sourceId = sourceId;
  // Store a complete immutable revision; the current envelope includes the latest 30 revisions for a bounded UI.
  const version: ReviewVersion = {
    ...next.history[next.history.length - 1],
    decisions: decisions.map((decision) => next.facts[decision.factIndex]),
  };
  next.history[next.history.length - 1] = version;
  await c.query(
    'INSERT INTO app_review_versions(job_id,organization_id,revision,actor_id,payload) VALUES($1,$2,$3,$4,$5)',
    [
      job.id,
      ctx.organizationId,
      next.revision,
      ctx.user.id,
      encrypt(
        JSON.stringify(version),
        'review-version:' +
          ctx.organizationId +
          ':' +
          job.id +
          ':' +
          next.revision,
      ),
    ],
  );
  await c.query(
    'UPDATE app_jobs SET review_revision=$3,review_state=$4 WHERE id=$1 AND organization_id=$2',
    [
      job.id,
      ctx.organizationId,
      next.revision,
      encrypt(
        JSON.stringify(next),
        'review:' + ctx.organizationId + ':' + job.id,
      ),
    ],
  );
  return { ...outcome, review: next, status: reviewJobStatus(next.facts) };
}
