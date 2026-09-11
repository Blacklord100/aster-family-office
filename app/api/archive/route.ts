import { ArchiveCommandSchema } from '@/lib/archive-contract';
import {
  AccessError,
  errorResponse,
  requireWorkspace,
} from '@/lib/server/access';
import { archiveCommand, listArchives } from '@/lib/server/archive-store';
import { ArchiveError } from '@/lib/server/archive-bundle';
import { json, parseJson } from '@/lib/server/http';
export const runtime = 'nodejs';
function failure(error: unknown) {
  return errorResponse(
    error instanceof ArchiveError
      ? new AccessError(
          409,
          error.code,
          'The local archive could not complete this operation. Check its approved directory and worker status.',
        )
      : error,
  );
}
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    return json(
      await listArchives(
        await requireWorkspace(request),
        Number(query.get('offset') ?? 0),
        query.get('status'),
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    return json(
      await archiveCommand(ctx, await parseJson(request, ArchiveCommandSchema)),
    );
  } catch (error) {
    return failure(error);
  }
}
