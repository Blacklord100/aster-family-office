import 'server-only';
import { z } from 'zod';
import { withTenant } from './db';
import { requireWorkspace, AccessError, errorResponse } from './access';
import { assertDocumentAccess } from './data-scope';
import { decrypt, sha256 } from './crypto';
import { audit, rateLimit } from './audit';
import { EmailPreviewError, parseEmailPreview } from './email-preview';

export async function serveEmailPreview(
  request: Request,
  documentId: string,
  attachmentIndex?: string,
) {
  try {
    const ctx = await requireWorkspace(request, 'read');
    if (
      !z.uuid().safeParse(documentId).success ||
      (attachmentIndex !== undefined &&
        !/^(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(attachmentIndex))
    )
      throw new AccessError(404, 'NOT_FOUND', 'Source not found.');
    return await withTenant(ctx.organizationId, async (client) => {
      await assertDocumentAccess(client, ctx, documentId);
      if (
        !(await rateLimit(
          client,
          `email-preview:${ctx.organizationId}:${ctx.user.id}`,
          60,
          60,
        ))
      )
        throw new AccessError(
          429,
          'RATE_LIMITED',
          'Too many source previews. Please wait a moment.',
        );
      const { rows } = await client.query(
        'SELECT filename,mime_type,payload FROM app_documents WHERE id=$1 AND organization_id=$2',
        [documentId, ctx.organizationId],
      );
      if (!rows[0])
        throw new AccessError(404, 'NOT_FOUND', 'Source not found.');
      const row = rows[0];
      if (
        row.mime_type !== 'message/rfc822' &&
        !(/\.eml$/i.test(row.filename) && row.mime_type === 'text/plain')
      )
        throw new AccessError(
          415,
          'EMAIL_PREVIEW_UNSUPPORTED',
          'This original is not an email.',
        );
      const parsed = await parseEmailPreview(
        decrypt(
          row.payload,
          'document:' + ctx.organizationId + ':' + documentId,
        ),
        documentId,
        row.filename,
      );
      const headers = {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'Content-Security-Policy':
          "default-src 'none'; frame-ancestors 'self'; sandbox allow-same-origin",
      };
      if (attachmentIndex !== undefined) {
        const attachment = parsed.attachments[Number(attachmentIndex)];
        if (!attachment)
          throw new AccessError(404, 'NOT_FOUND', 'Attachment not found.');
        if (!attachment.previewable)
          throw new AccessError(
            415,
            'ATTACHMENT_PREVIEW_UNSUPPORTED',
            'Download the original email to inspect this attachment.',
          );
        await audit(
          client,
          ctx.organizationId,
          ctx.user.id,
          'document.previewed',
          documentId,
          {
            surface: 'email_attachment',
            attachmentIndex: attachment.index,
            attachmentHash: sha256(attachment.content),
            byteSize: attachment.byteSize,
          },
        );
        return new Response(new Uint8Array(attachment.content), {
          headers: {
            ...headers,
            'Content-Type': 'application/pdf',
            'Content-Length': String(attachment.byteSize),
            'Content-Disposition':
              "inline; filename*=UTF-8''" +
              encodeURIComponent(attachment.filename),
          },
        });
      }
      await audit(
        client,
        ctx.organizationId,
        ctx.user.id,
        parsed.attachments.length === 0 &&
          !parsed.response.bodyTruncated &&
          parsed.response.body.trim()
          ? 'document.previewed'
          : 'document.email_previewed',
        documentId,
        {
          surface: 'decoded_email',
          attachmentCount: parsed.attachments.length,
          bodyTruncated: parsed.response.bodyTruncated,
        },
      );
      return Response.json(parsed.response, { headers });
    });
  } catch (error) {
    return errorResponse(
      error instanceof EmailPreviewError
        ? new AccessError(422, error.code, error.message)
        : error,
    );
  }
}
