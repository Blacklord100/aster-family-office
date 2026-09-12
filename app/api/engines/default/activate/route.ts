import { lifecycleRoute } from '@/lib/server/lifecycle';
import { z } from 'zod';
import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json, parseJson } from '@/lib/server/http';
import { activateEngine } from '@/lib/server/engine-store';
async function handlePOST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    await parseJson(request, z.object({}).strict());
    return await withTenant(ctx.organizationId, async (c) =>
      json(await activateEngine(c, ctx, null)),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = lifecycleRoute(handlePOST);
