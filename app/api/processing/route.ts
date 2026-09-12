import { lifecycleRoute } from '@/lib/server/lifecycle';
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
import { activeEngine } from '@/lib/server/engine-store';
import {
  listProcessingJobs,
  processingListQuery,
} from '@/lib/server/processing-list';
async function handleGET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    const input = processingListQuery(new URL(request.url));
    return await withTenant(
      ctx.organizationId,
      async (client) => {
        const [{ rows: org }, listing] = await Promise.all([
          client.query(
            'SELECT processing_mode,policy_revision FROM app_organizations WHERE id=$1',
            [ctx.organizationId],
          ),
          listProcessingJobs(client, ctx, input),
        ]);
        const engine = (await activeEngine(client, ctx.organizationId))
          .snapshot;
        return json({
          policy: {
            mode: org[0].processing_mode,
            revision: org[0].policy_revision,
            execution: engine.execution,
            engine,
            externalFallback: false,
          },
          ...listing,
          role: ctx.role,
        });
      },
      { readOnlySnapshot: true },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
async function handlePATCH(request: Request) {
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
      const engine = (await activeEngine(client, ctx.organizationId)).snapshot;
      return json({
        mode: input.mode,
        revision: rows[0].policy_revision,
        execution: engine.execution,
        engine,
        externalFallback: false,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = lifecycleRoute(handleGET);
export const PATCH = lifecycleRoute(handlePATCH);
