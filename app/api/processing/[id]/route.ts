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
import { acceptFacts } from '@/lib/server/accept-facts';
const Body = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('accept'),
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
  z.object({ action: z.enum(['cancel', 'retry', 'reject']) }).strict(),
]);
export async function PATCH(
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
      let outcome = { applied: 0, duplicates: 0 },
        status = '';
      if (body.action === 'accept') {
        if (job.status !== 'awaiting_review' || !job.result)
          throw new AccessError(
            409,
            'INVALID_STATE',
            'This job is not waiting for review.',
          );
        const result = ExtractionSchema.parse(
          JSON.parse(
            decrypt(
              job.result,
              'result:' + ctx.organizationId + ':' + id,
            ).toString(),
          ),
        );
        outcome = await acceptFacts(c, ctx, job, result, body.selections);
        status = 'accepted';
      } else if (body.action === 'reject') {
        if (job.status !== 'awaiting_review')
          throw new AccessError(
            409,
            'INVALID_STATE',
            'This job is not waiting for review.',
          );
        status = 'rejected';
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
          'INSERT INTO app_job_queue(id,organization_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET lease_owner=NULL,lease_until=NULL,attempts=0,available_at=now()',
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
        { ...outcome, mode: job.mode },
      );
      return json({ ok: true, status, ...outcome });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
