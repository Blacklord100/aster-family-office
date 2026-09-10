import {
  requireWorkspace,
  errorResponse,
  roleAllows,
  AccessError,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json, parseJson } from '@/lib/server/http';
import { EngineInputSchema, type EnginesResponse } from '@/lib/engine-contract';
import type { ProcessingMode } from '@/lib/processing-contract';
import {
  activeEngine,
  listEngines,
  saveEngine,
  cloudReadiness,
} from '@/lib/server/engine-store';
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    return await withTenant(
      ctx.organizationId,
      async (c) => {
        const [profiles, engine, { rows }] = await Promise.all([
          listEngines(c, ctx.organizationId),
          activeEngine(c, ctx.organizationId),
          c.query<{ processing_mode: ProcessingMode; policy_revision: number }>(
            'SELECT processing_mode,policy_revision FROM app_organizations WHERE id=$1',
            [ctx.organizationId],
          ),
        ]);
        if (!rows[0])
          throw new AccessError(
            404,
            'WORKSPACE_NOT_FOUND',
            'Workspace not found.',
          );
        return json({
          profiles,
          active: engine.snapshot,
          policy: {
            mode: rows[0].processing_mode,
            revision: rows[0].policy_revision,
            execution: engine.snapshot.execution,
            engine: engine.snapshot,
            externalFallback: false,
          },
          canManage: roleAllows(ctx.role, 'admin'),
          ...cloudReadiness(),
        } satisfies EnginesResponse);
      },
      { readOnlySnapshot: true },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    const input = await parseJson(request, EngineInputSchema);
    return await withTenant(ctx.organizationId, async (c) =>
      json(await saveEngine(c, ctx, input), 201),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
