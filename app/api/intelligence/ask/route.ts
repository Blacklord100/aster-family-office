import { lifecycleRoute } from '@/lib/server/lifecycle';
import { z } from 'zod';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { askIntelligence } from '@/lib/server/intelligence-store';
async function handlePOST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    const input = await parseJson(
      request,
      z
        .object({
          question: z.string().trim().min(2).max(600),
          familyId: z.string().min(1).max(160).default('all'),
          mode: z.enum(['workflow', 'agentic']).optional(),
        })
        .strict(),
    );
    const answer = await askIntelligence(ctx, input, fetch, request.signal);
    // A source query may take minutes. Revocation or a narrowed membership must
    // prevent material prepared under the old permission scope from being returned.
    const current = await requireWorkspace(request, 'read');
    if (
      current.organizationId !== ctx.organizationId ||
      current.user.id !== ctx.user.id ||
      current.role !== ctx.role ||
      JSON.stringify(current.scope ?? null) !==
        JSON.stringify(ctx.scope ?? null)
    )
      throw new AccessError(
        403,
        'ACCESS_CHANGED',
        'Your access changed while answering. Reload before asking again.',
      );
    return json(answer);
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = lifecycleRoute(handlePOST);
