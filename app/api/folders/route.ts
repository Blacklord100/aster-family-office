import { lifecycleRoute } from '@/lib/server/lifecycle';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { FolderConnectSchema } from '@/lib/folder-connection-contract';
import {
  listFolderConnections,
  connectFolder,
} from '@/lib/server/folder-store';
import { FolderError } from '@/lib/server/folder-files';
export const runtime = 'nodejs';
function folderErrorResponse(error: unknown) {
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
async function handleGET(request: Request) {
  try {
    return json(await listFolderConnections(await requireWorkspace(request)));
  } catch (error) {
    return folderErrorResponse(error);
  }
}
async function handlePOST(request: Request) {
  try {
    const context = await requireWorkspace(request, 'admin');
    return json(
      await connectFolder(
        context,
        await parseJson(request, FolderConnectSchema),
      ),
      201,
    );
  } catch (error) {
    return folderErrorResponse(error);
  }
}

export const GET = lifecycleRoute(handleGET);
export const POST = lifecycleRoute(handlePOST);
