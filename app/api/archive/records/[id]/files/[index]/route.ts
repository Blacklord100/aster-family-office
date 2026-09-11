import {
  AccessError,
  errorResponse,
  requireWorkspace,
} from '@/lib/server/access';
import { downloadArchiveFile } from '@/lib/server/archive-store';
import { ArchiveError } from '@/lib/server/archive-bundle';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string; index: string }> },
) {
  try {
    const ctx = await requireWorkspace(request);
    const { id, index } = await route.params;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      ) ||
      !/^\d{1,2}$/.test(index)
    )
      throw new AccessError(404, 'NOT_FOUND', 'Archived file not found.');
    const file = await downloadArchiveFile(ctx, id, Number(index));
    const filename = encodeURIComponent(file.filename).replace(
      /['()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.mimeType,
        'Content-Length': String(file.bytes.length),
        'Content-Disposition': "attachment; filename*=UTF-8''" + filename,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "sandbox; default-src 'none'; frame-ancestors 'none'",
        'X-Frame-Options': 'DENY',
      },
    });
  } catch (error) {
    return errorResponse(
      error instanceof ArchiveError
        ? new AccessError(
            409,
            error.code,
            'The archive file could not be verified. Ask an administrator to check its integrity.',
          )
        : error,
    );
  }
}
