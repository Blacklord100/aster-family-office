import {
  AccessError,
  errorResponse,
  requireWorkspace,
} from '@/lib/server/access';
import { documentArchives } from '@/lib/server/archive-store';
import { json } from '@/lib/server/http';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireWorkspace(request);
    const { id } = await route.params;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
    return json(await documentArchives(ctx, id));
  } catch (error) {
    return errorResponse(error);
  }
}
