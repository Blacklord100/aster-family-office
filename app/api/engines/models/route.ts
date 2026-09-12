import { lifecycleRoute } from '@/lib/server/lifecycle';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json } from '@/lib/server/http';
import { discoverModels } from '@/lib/server/engine-processor';
import { rateLimit } from '@/lib/server/audit';
async function handleGET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    const allowed = await withTenant(ctx.organizationId, (c) =>
      rateLimit(c, 'engine-discovery:' + ctx.organizationId, 20, 60),
    );
    if (!allowed)
      throw new AccessError(
        429,
        'RATE_LIMITED',
        'Wait before discovering models again.',
      );
    return json(await discoverModels());
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = lifecycleRoute(handleGET);
