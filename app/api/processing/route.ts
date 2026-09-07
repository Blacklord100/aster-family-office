import { z } from 'zod';
import { withTenant } from '@/lib/server/db';
import {
  requireWorkspace,
  assertSameOrigin,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { audit } from '@/lib/server/audit';
import { decrypt } from '@/lib/server/crypto';
import { ExtractionSchema } from '@/lib/processing-contract';
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    const selectedId = new URL(request.url).searchParams.get('jobId');
    if (selectedId !== null && !z.uuid().safeParse(selectedId).success)
      throw new AccessError(
        400,
        'INVALID_JOB',
        'Choose a valid processing job.',
      );
    return await withTenant(ctx.organizationId, async (client) => {
      const [{ rows: org }, { rows: jobs }] = await Promise.all([
        client.query(
          'SELECT processing_mode,policy_revision FROM app_organizations WHERE id=$1',
          [ctx.organizationId],
        ),
        client.query(
          'SELECT j.id,j.document_id,j.mode,j.status,j.created_at,j.updated_at,j.policy_revision,j.error_code,d.filename FROM app_jobs j JOIN app_documents d ON j.document_id=d.id WHERE j.organization_id=$1 ORDER BY j.created_at DESC,j.id DESC LIMIT 100',
          [ctx.organizationId],
        ),
      ]);
      // List metadata is bounded; decrypt only the selected (or newest) job.
      const selected = jobs.find((j) => j.id === selectedId) ?? jobs[0];
      const stored = selected
        ? await client.query(
            'SELECT result FROM app_jobs WHERE id=$1 AND organization_id=$2',
            [selected.id, ctx.organizationId],
          )
        : null;
      const result = stored?.rows[0]?.result
        ? ExtractionSchema.parse(
            JSON.parse(
              decrypt(
                stored.rows[0].result,
                'result:' + ctx.organizationId + ':' + selected.id,
              ).toString(),
            ),
          )
        : null;
      const list = jobs.map((j) => ({
        id: j.id,
        documentId: j.document_id,
        filename: j.filename,
        mode: j.mode,
        status: j.status,
        createdAt: j.created_at,
        updatedAt: j.updated_at,
        policyRevision: j.policy_revision,
        errorCode: j.error_code,
        result: j.id === selected?.id ? result : null,
      }));
      return json({
        policy: {
          mode: org[0].processing_mode,
          revision: org[0].policy_revision,
          execution: 'local',
          externalFallback: false,
        },
        jobs: list,
        role: ctx.role,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const ctx = await requireWorkspace(request, 'admin'),
      input = await parseJson(
        request,
        z.object({ mode: z.enum(['workflow', 'agentic']) }).strict(),
      );
    return await withTenant(ctx.organizationId, async (client) => {
      const { rows } = await client.query(
        'UPDATE app_organizations SET processing_mode=$2,policy_revision=policy_revision+1 WHERE id=$1 RETURNING policy_revision',
        [ctx.organizationId, input.mode],
      );
      if (!rows[0])
        throw new AccessError(
          404,
          'WORKSPACE_NOT_FOUND',
          'Workspace not found.',
        );
      await audit(
        client,
        ctx.organizationId,
        ctx.user.id,
        'processing.policy_changed',
        ctx.organizationId,
        { mode: input.mode, revision: rows[0].policy_revision },
      );
      return json({
        mode: input.mode,
        revision: rows[0].policy_revision,
        execution: 'local',
        externalFallback: false,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
