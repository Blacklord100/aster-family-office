import { withTenant } from '@/lib/server/db';
import {
  requireWorkspace,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { decrypt } from '@/lib/server/crypto';
import { audit } from '@/lib/server/audit';
import { assertDocumentAccess } from '@/lib/server/data-scope';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireWorkspace(request, 'read'),
      { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
    return await withTenant(ctx.organizationId, async (client) => {
      await assertDocumentAccess(client, ctx, id);
      const { rows } = await client.query(
        'SELECT filename,mime_type,payload FROM app_documents WHERE organization_id=$1 AND id=$2',
        [ctx.organizationId, id],
      );
      if (!rows[0])
        throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
      const file = rows[0],
        bytes = decrypt(
          file.payload,
          'document:' + ctx.organizationId + ':' + id,
        );
      await audit(
        client,
        ctx.organizationId,
        ctx.user.id,
        'document.downloaded',
        id,
      );
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': file.mime_type,
          'Content-Length': String(bytes.length),
          'Content-Disposition':
            "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
