export type EmailAttachmentPreview = {
  index: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  previewable: boolean;
  reason: string | null;
};
export type EmailPreviewResponse = {
  documentId: string;
  filename: string;
  subject: string;
  from: string;
  to: string[];
  sentAt: string | null;
  body: string;
  bodyTruncated: boolean;
  attachments: EmailAttachmentPreview[];
  warnings: string[];
};
export function emailAttachmentPreviewPath(
  documentId: string,
  index: number,
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      documentId,
    ) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= 64
  )
    throw new Error('Invalid attachment reference.');
  return `/api/documents/${documentId}/email/attachments/${index}`;
}
