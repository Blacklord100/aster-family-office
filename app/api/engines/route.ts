import {
  requireWorkspace,
  errorResponse,
  roleAllows,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json, parseJson } from '@/lib/server/http';
import { EngineInputSchema } from '@/lib/engine-contract';
import {
  activeEngine,
  listEngines,
  saveEngine,
  cloudReadiness,
} from '@/lib/server/engine-store';
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    return await withTenant(ctx.organizationId, async (c) =>
      json({
        profiles: await listEngines(c, ctx.organizationId),
        active: (await activeEngine(c, ctx.organizationId)).snapshot,
        canManage: roleAllows(ctx.role, 'admin'),
        ...cloudReadiness(),
      }),
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
