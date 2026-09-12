import { lifecycleRoute } from '@/lib/server/lifecycle';
import { z } from 'zod';
import { withTenant } from '@/lib/server/db';
import {
  requireWorkspace,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { assertDocumentAccess } from '@/lib/server/data-scope';
import { decrypt } from '@/lib/server/crypto';
import { audit } from '@/lib/server/audit';

/** Serve only authenticated source bytes. Email markup is never interpreted as HTML. */
async function handleGET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    const { id } = await params;
    if (!z.uuid().safeParse(id).success)
      throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
    return await withTenant(ctx.organizationId, async (c) => {
      await assertDocumentAccess(c, ctx, id);
      const { rows } = await c.query(
        'SELECT filename,mime_type,payload FROM app_documents WHERE id=$1 AND organization_id=$2',
        [id, ctx.organizationId],
      );
      if (!rows[0])
        throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
      const file = rows[0];
      const bytes = decrypt(
        file.payload,
        'document:' + ctx.organizationId + ':' + id,
      );
      const pdf = file.mime_type === 'application/pdf';
      if (!pdf && !['text/plain', 'message/rfc822'].includes(file.mime_type))
        throw new AccessError(
          415,
          'PREVIEW_UNSUPPORTED',
          'Download this original to review its format.',
        );
      const content = pdf
        ? bytes
        : Buffer.from(bytes.toString('utf8').replaceAll('\u0000', '\uFFFD'));
      await audit(c, ctx.organizationId, ctx.user.id, 'document.previewed', id);
      return new Response(new Uint8Array(content), {
        headers: {
          'Content-Type': pdf ? 'application/pdf' : 'text/plain; charset=utf-8',
          'Content-Length': String(content.length),
          'Content-Disposition':
            "inline; filename*=UTF-8''" + encodeURIComponent(file.filename),
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN',
          'Content-Security-Policy':
            "default-src 'none'; frame-ancestors 'self'; sandbox allow-same-origin",
        },
      });
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = lifecycleRoute(handleGET);
