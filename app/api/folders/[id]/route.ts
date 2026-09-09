import { z } from 'zod';
import {
  requireWorkspace,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { FolderActionSchema } from '@/lib/folder-connection-contract';
import { updateFolderConnection } from '@/lib/server/folder-store';
import { FolderError } from '@/lib/server/folder-files';
export const runtime = 'nodejs';
export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireWorkspace(request, 'admin'),
      { id } = await route.params;
    if (!z.uuid().safeParse(id).success)
      throw new AccessError(
        400,
        'INVALID_ID',
        'Choose a valid folder connection.',
      );
    return json(
      await updateFolderConnection(
        context,
        id,
        (await parseJson(request, FolderActionSchema)).action,
      ),
    );
  } catch (error) {
    return errorResponse(
      error instanceof FolderError
        ? new AccessError(
            409,
            error.code,
            'The approved intake folder is unavailable. Ask an administrator to check its configuration and permissions.',
          )
        : error,
    );
  }
}
