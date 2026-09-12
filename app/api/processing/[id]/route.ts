import { lifecycleRoute } from '@/lib/server/lifecycle';
import { z } from 'zod';
import {
  requireWorkspace,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { decrypt } from '@/lib/server/crypto';
import { audit } from '@/lib/server/audit';
import { parseJson, json } from '@/lib/server/http';
import { ExtractionSchema } from '@/lib/processing-contract';
import { applyReview, readReview } from '@/lib/server/review-store';
import { ReviewRequestSchema, type ReviewState } from '@/lib/review-contract';
import { LedgerError } from '@/lib/ledger';
const Body = z.discriminatedUnion('action', [
  ReviewRequestSchema,
  z
    .object({
      action: z.literal('accept'),
      expectedRevision: z.number().int().min(0).optional(),
      evidenceVerified: z.literal(true).optional(),
      selections: z
        .array(
          z.object({
            factIndex: z.number().int().min(0).max(99),
            holdingId: z.string().max(200).nullable(),
          }),
        )
        .min(1)
        .max(100)
        .refine((a) => new Set(a.map((i) => i.factIndex)).size === a.length),
    })
    .strict(),
  z
    .object({
      action: z.enum(['cancel', 'retry', 'reject']),
      expectedRevision: z.number().int().min(0).optional(),
    })
    .strict(),
]);
async function handlePATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireWorkspace(request, 'write'),
      body = await parseJson(request, Body),
      { id } = await params;
    if (!z.uuid().safeParse(id).success)
      throw new AccessError(404, 'NOT_FOUND', 'Job not found.');
    return await withTenant(ctx.organizationId, async (c) => {
      const { rows } = await c.query(
        'SELECT j.*,d.filename FROM app_jobs j JOIN app_documents d ON d.id=j.document_id WHERE j.id=$1 AND j.organization_id=$2 FOR UPDATE OF j',
        [id, ctx.organizationId],
      );
      const job = rows[0];
      if (!job) throw new AccessError(404, 'NOT_FOUND', 'Job not found.');
      let outcome: {
          applied: number;
          duplicates: number;
          review?: ReviewState;
        } = { applied: 0, duplicates: 0 },
        status = '';
      if (
        body.action === 'accept' ||
        body.action === 'review' ||
        body.action === 'reject'
      ) {
        if (
          !['awaiting_review', 'accepted', 'rejected'].includes(job.status) ||
          !job.result
        )
          throw new AccessError(
            409,
            'INVALID_STATE',
            'This job has no completed extraction to review.',
          );
        const result = ExtractionSchema.parse(
          JSON.parse(
            decrypt(
              job.result,
              'result:' + ctx.organizationId + ':' + id,
            ).toString(),
          ),
        );
        const current = readReview(job, ctx.organizationId, result);
        // Compatibility accepts still preserve every unselected fact. An original-source access is required by applyReview.
        const decisions =
          body.action === 'review'
            ? body.decisions
            : body.action === 'accept'
              ? body.selections.map((selection) => ({
                  ...selection,
                  status: 'accepted' as const,
                  rationale: '',
                  evidenceVerified: true,
                }))
              : current.facts
                  .filter(
                    (fact) =>
                      fact.status !== 'accepted' && fact.status !== 'legacy',
                  )
                  .map((fact) => ({
                    ...fact,
                    status: 'rejected' as const,
                    rationale: 'Reviewer rejected the remaining fact.',
                    evidenceVerified: false,
                  }));
        const reviewed = await applyReview(
          c,
          ctx,
          job,
          result,
          body.expectedRevision ?? current.revision,
          decisions,
        );
        outcome = {
          applied: reviewed.applied,
          duplicates: reviewed.duplicates,
          review: reviewed.review,
        };
        status = reviewed.status;
      } else if (body.action === 'cancel') {
        if (!['queued', 'processing'].includes(job.status))
          throw new AccessError(
            409,
            'INVALID_STATE',
            'Only pending jobs can be cancelled.',
          );
        status = 'cancelled';
        await c.query('DELETE FROM app_job_queue WHERE id=$1', [id]);
      } else {
        if (!['failed', 'cancelled'].includes(job.status))
          throw new AccessError(
            409,
            'INVALID_STATE',
            'Only failed or cancelled jobs can be retried.',
          );
        status = 'queued';
        await c.query(
          'INSERT INTO app_job_queue(id,organization_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET lease_owner=NULL,lease_until=NULL,attempts=0,capacity_deferrals=0,available_at=now()',
          [id, ctx.organizationId],
        );
      }
      await c.query(
        'UPDATE app_jobs SET status=$2,error_code=NULL,updated_at=now(),reviewed_by=$3,reviewed_at=now() WHERE id=$1',
        [id, status, ctx.user.id],
      );
      await audit(
        c,
        ctx.organizationId,
        ctx.user.id,
        'processing.' + body.action,
        id,
        {
          applied: outcome.applied,
          duplicates: outcome.duplicates,
          reviewRevision: outcome.review?.revision ?? 0,
          mode: job.mode,
        },
      );
      return json({ ok: true, status, ...outcome });
    });
  } catch (e) {
    if (
      e &&
      typeof e === 'object' &&
      'code' in e &&
      e.code === '23505' &&
      'constraint' in e &&
      e.constraint === 'app_jobs_active_document_mode_engine'
    )
      return errorResponse(
        new AccessError(
          409,
          'REVIEW_ALREADY_ACTIVE',
          'Another review for this document and engine is open. Finish that review before reopening an older decision.',
        ),
      );
    if (e instanceof LedgerError)
      return errorResponse(new AccessError(e.status, e.code, e.message));
    return errorResponse(e);
  }
}

export const PATCH = lifecycleRoute(handlePATCH);
