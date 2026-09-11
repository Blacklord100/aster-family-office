import 'server-only';
import PostalMime, { type Address } from 'postal-mime';
import { compile } from 'html-to-text';
import type { EmailPreviewResponse } from '../email-preview-contract';
export const EMAIL_PREVIEW_LIMITS = {
  bytes: 10 * 1024 * 1024,
  headers: 256 * 1024,
  depth: 20,
  boundaryLines: 128,
  attachments: 64,
  attachmentBytes: 8 * 1024 * 1024,
  bodyCharacters: 200_000,
} as const;
const FORMATTING_OMITTED = '[Additional formatting omitted]';
const htmlAsText = compile({
  wordwrap: false,
  limits: {
    maxInputLength: 200_000,
    maxDepth: 20,
    maxChildNodes: 10_000,
    maxBaseElements: 100,
    ellipsis: FORMATTING_OMITTED,
  },
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'iframe', format: 'skip' },
  ],
});
export class EmailPreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const text = (value: string | undefined, limit: number) =>
  (value ?? '').replaceAll('\u0000', '\uFFFD').slice(0, limit);
function address(value?: Address): string {
  if (!value) return '';
  return value.group
    ? text(value.name, 200) +
        ': ' +
        value.group
          .slice(0, 25)
          .map((item) => address(item))
          .join(', ')
    : [text(value.name, 200), text(value.address, 320)]
        .filter(Boolean)
        .join(' <')
        .replace(/ <([^<>]+)$/, ' <$1>');
}
/** A work budget, not a MIME parser: every MIME delimiter is a line beginning --. */
function checkBudget(bytes: Uint8Array) {
  if (!bytes.byteLength || bytes.byteLength > EMAIL_PREVIEW_LIMITS.bytes)
    throw new EmailPreviewError(
      'EMAIL_PREVIEW_TOO_LARGE',
      'Email preview supports originals up to 10 MB. Download the original to inspect this message.',
    );
  let boundaries = 0;
  for (let index = 0; index + 1 < bytes.byteLength; index++) {
    if (
      (index === 0 || bytes[index - 1] === 10) &&
      bytes[index] === 45 &&
      bytes[index + 1] === 45 &&
      ++boundaries > EMAIL_PREVIEW_LIMITS.boundaryLines
    )
      throw new EmailPreviewError(
        'EMAIL_PREVIEW_PART_LIMIT',
        'This email contains too many parts for inline preview. Download its original.',
      );
  }
}
export async function parseEmailPreview(
  bytes: Uint8Array,
  documentId: string,
  filename: string,
) {
  checkBudget(bytes);
  let email;
  try {
    email = await PostalMime.parse(bytes, {
      attachmentEncoding: 'arraybuffer',
      maxNestingDepth: EMAIL_PREVIEW_LIMITS.depth,
      maxHeadersSize: EMAIL_PREVIEW_LIMITS.headers,
      maxRfc822NestingDepth: 0,
      forceRfc822Attachments: true,
    });
  } catch {
    throw new EmailPreviewError(
      'EMAIL_PREVIEW_UNREADABLE',
      'This email could not be decoded within the preview limits. Download its original to inspect it.',
    );
  }
  if (email.attachments.length > EMAIL_PREVIEW_LIMITS.attachments)
    throw new EmailPreviewError(
      'EMAIL_PREVIEW_PART_LIMIT',
      'This email contains too many attachments for inline preview. Download its original.',
    );
  const attachments = email.attachments.map((attachment, index) => {
    const content =
      typeof attachment.content === 'string'
        ? Buffer.from(
            attachment.content,
            attachment.encoding === 'base64' ? 'base64' : 'utf8',
          )
        : Buffer.from(
            attachment.content instanceof ArrayBuffer
              ? new Uint8Array(attachment.content)
              : attachment.content,
          );
    const pdf = content.subarray(0, 5).equals(Buffer.from('%PDF-'));
    const previewable =
      pdf && content.byteLength <= EMAIL_PREVIEW_LIMITS.attachmentBytes;
    return {
      index,
      filename: text(attachment.filename ?? `Attachment ${index + 1}`, 240),
      mimeType: text(attachment.mimeType, 100),
      byteSize: content.byteLength,
      previewable,
      reason: previewable
        ? null
        : pdf
          ? 'PDF exceeds the 8 MB attachment preview limit.'
          : attachment.mimeType === 'message/rfc822'
            ? 'Nested email retained in the original; inline recursion is disabled.'
            : 'This attachment format is retained in the original email.',
      content,
    };
  });
  const htmlTruncated =
    !email.text &&
    (email.html?.length ?? 0) > EMAIL_PREVIEW_LIMITS.bodyCharacters;
  const body =
    email.text ||
    (email.html
      ? htmlAsText(email.html.slice(0, EMAIL_PREVIEW_LIMITS.bodyCharacters))
      : '');
  const formattingTruncated = !email.text && body.includes(FORMATTING_OMITTED);
  const response: EmailPreviewResponse = {
    documentId,
    filename,
    subject: text(email.subject, 1000) || filename,
    from: address(email.from),
    to: (email.to ?? []).slice(0, 50).map((item) => address(item)),
    sentAt: email.date ? text(email.date, 200) : null,
    body: text(body, EMAIL_PREVIEW_LIMITS.bodyCharacters),
    bodyTruncated:
      htmlTruncated ||
      formattingTruncated ||
      body.length > EMAIL_PREVIEW_LIMITS.bodyCharacters,
    attachments: attachments.map(
      ({ content: _content, ...metadata }) => metadata,
    ),
    warnings: [
      ...(htmlTruncated || body.length > EMAIL_PREVIEW_LIMITS.bodyCharacters
        ? ['Email body is limited to the first 200,000 characters.']
        : []),
      ...(formattingTruncated
        ? [
            'Some body content was omitted by the formatting limits. Download the original to inspect the complete source.',
          ]
        : []),
      ...(attachments.some((item) => !item.previewable)
        ? [
            'Some attachments cannot be previewed. Their bytes remain in the original email.',
          ]
        : []),
      ...(email.html
        ? [
            'Email formatting is presented as plain text. Images, links and scripts are not loaded.',
          ]
        : []),
    ],
  };
  const archiveHeaders = [
    { name: 'From', value: response.from },
    { name: 'To', value: response.to.join(', ') },
    {
      name: 'Cc',
      value: (email.cc ?? []).slice(0, 50).map(address).join(', '),
    },
    {
      name: 'Bcc',
      value: (email.bcc ?? []).slice(0, 50).map(address).join(', '),
    },
    {
      name: 'Reply-To',
      value: (email.replyTo ?? []).slice(0, 50).map(address).join(', '),
    },
    { name: 'Date', value: response.sentAt ?? '' },
    { name: 'Subject', value: response.subject },
    { name: 'Message-ID', value: text(email.messageId, 1000) },
  ].filter((header) => header.value);
  return { response, attachments, archiveHeaders };
}
