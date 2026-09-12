import { lifecycleRoute } from '@/lib/server/lifecycle';
import {
  AccessError,
  errorResponse,
  requireWorkspace,
} from '@/lib/server/access';
import {
  ParticipationQuerySchema,
  participationRequestSchema,
} from '@/lib/participation-contract';
import {
  readParticipation,
  writeParticipation,
} from '@/lib/server/participation-store';
import { json, parseJson } from '@/lib/server/http';
async function handleGET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    const raw = new URL(request.url).searchParams.get('query');
    let query;
    try {
      if (raw && raw.length > 8192) throw new Error('Bounded query');
      query = ParticipationQuerySchema.parse(raw ? JSON.parse(raw) : {});
    } catch {
      throw new AccessError(
        400,
        'PARTICIPATION_QUERY_INVALID',
        'Check the selected families, dates and currency.',
      );
    }
    return json(await readParticipation(ctx, query));
  } catch (error) {
    return errorResponse(error);
  }
}
async function handlePOST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'write');
    return json(
      await writeParticipation(
        ctx,
        await parseJson(request, participationRequestSchema),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = lifecycleRoute(handleGET);
export const POST = lifecycleRoute(handlePOST);
