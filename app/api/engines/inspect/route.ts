import { lifecycleRoute } from '@/lib/server/lifecycle';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json, parseJson } from '@/lib/server/http';
import { rateLimit } from '@/lib/server/audit';
import { activeEngine, loadEngineRevision } from '@/lib/server/engine-store';
import { inspectEngine } from '@/lib/server/engine-processor';
import { EngineInspectionRequestSchema } from '@/lib/engine-inspection';

async function handlePOST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    const input = await parseJson(request, EngineInspectionRequestSchema);
    const selected = await withTenant(ctx.organizationId, async (client) => {
      if (
        !(await rateLimit(
          client,
          'engine-inspection:' + ctx.organizationId,
          20,
          60,
        ))
      ) {
        throw new AccessError(
          429,
          'RATE_LIMITED',
          'Wait before inspecting the runtime again.',
        );
      }
      // Engine mutations take the organization lock first. Hold a shared lock
      // only while resolving the exact requested selection, never across HTTP.
      await client.query(
        'SELECT id FROM app_organizations WHERE id=$1 FOR SHARE',
        [ctx.organizationId],
      );
      if (input.target === 'active') {
        const active = await activeEngine(client, ctx.organizationId);
        if (
          active.snapshot.profileId !== input.profileId ||
          active.snapshot.revision !== input.revision
        ) {
          throw new AccessError(
            409,
            'ENGINE_CHANGED',
            'The selected engine changed. Refresh and inspect again.',
          );
        }
        return active;
      }
      const current = await client.query<{ current_revision: number }>(
        'SELECT current_revision FROM app_engine_profiles WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL',
        [input.profileId, ctx.organizationId],
      );
      if (!current.rows[0])
        throw new AccessError(
          404,
          'ENGINE_NOT_FOUND',
          'Engine profile not found.',
        );
      if (current.rows[0].current_revision !== input.revision) {
        throw new AccessError(
          409,
          'ENGINE_CHANGED',
          'Reload the current engine profile before inspection.',
        );
      }
      return loadEngineRevision(
        client,
        ctx.organizationId,
        input.profileId!,
        input.revision,
      );
    });
    // Release tenant DB resources before the bounded metadata network call.
    const info = await inspectEngine(selected.config, request.signal);
    return json({
      ...info,
      target: input.target,
      profileId: selected.snapshot.profileId,
      revision: selected.snapshot.revision,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = lifecycleRoute(handlePOST);
