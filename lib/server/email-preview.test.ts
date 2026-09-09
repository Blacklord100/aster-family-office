import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { EMAIL_PREVIEW_LIMITS, parseEmailPreview } from './email-preview';
import { emailAttachmentPreviewPath } from '../email-preview-contract';
const ID = '11111111-1111-4111-8111-111111111111';
const parse = (message: string | Buffer) =>
  parseEmailPreview(
    typeof message === 'string' ? Buffer.from(message) : message,
    ID,
    'source.eml',
  );
const pdf = Buffer.from('%PDF-1.4\n% retained synthetic PDF bytes\n%%EOF');
const multipart = (parts: string[]) =>
  'From: Manager <manager@example.invalid>\r\nTo: Office <office@example.invalid>\r\nSubject: =?UTF-8?B?UXVhcnRlcmx5IHJlcG9ydCDigJMg4oKs?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="source-boundary"\r\n\r\n' +
  parts.map((part) => '--source-boundary\r\n' + part + '\r\n').join('') +
  '--source-boundary--\r\n';
const pdfPart =
  'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="NAV.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
  pdf.toString('base64');
describe('bounded decoded email originals', () => {
  it('decodes encoded headers, quoted-printable body and PDF bytes without losing identity', async () => {
    const result = await parse(
      multipart([
        'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nNAV =E2=82=AC 100.00',
        pdfPart,
      ]),
    );
    expect(result.response.subject).toBe('Quarterly report – €');
    expect(result.response.from).toBe('Manager <manager@example.invalid>');
    expect(result.response.body).toContain('NAV € 100.00');
    expect(result.attachments[0].content).toEqual(pdf);
    expect(result.response.attachments[0]).toMatchObject({
      index: 0,
      filename: 'NAV.pdf',
      previewable: true,
    });
    expect(JSON.stringify(result.response)).not.toContain(
      pdf.toString('base64'),
    );
  });
  it('renders HTML-only emails as text and exposes no active HTML field', async () => {
    const result = await parse(
      'Content-Type: text/html; charset=utf-8\r\n\r\n<p>Fund &amp; family</p><img src="https://tracking.example.invalid/pixel"><script>window.evil=1</script><a href="javascript:alert(1)">Manager</a>',
    );
    expect(result.response.body).toContain('Fund & family');
    expect(result.response).not.toHaveProperty('html');
    expect(result.response.warnings.join(' ')).toContain('plain text');
  });
  it('does not trust a PDF content type without PDF magic bytes', async () => {
    const result = await parse(
      multipart([
        'Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="report.pdf"\r\n\r\n<script>evil()</script>',
      ]),
    );
    expect(result.response.attachments[0].previewable).toBe(false);
  });
  it('keeps nested email attachments opaque and explicitly unavailable to inline recursion', async () => {
    const result = await parse(
      multipart([
        'Content-Type: message/rfc822\r\n\r\nSubject: nested\r\nContent-Type: text/plain\r\n\r\nNested message',
      ]),
    );
    expect(result.response.attachments[0]).toMatchObject({
      previewable: false,
      mimeType: 'message/rfc822',
    });
    expect(result.response.body).not.toContain('Nested message');
  });
  it('flags body truncation rather than silently dropping it', async () => {
    const result = await parse(
      'Content-Type: text/plain\r\n\r\n' + 'a'.repeat(200_100),
    );
    expect(result.response.body.length).toBe(200_000);
    expect(result.response.bodyTruncated).toBe(true);
  });
  it('flags omitted deeply nested HTML as incomplete even below the character limit', async () => {
    const result = await parse(
      'Content-Type: text/html\r\n\r\nVisible before. ' +
        '<div>'.repeat(25) +
        'NAV hidden 2,000,000' +
        '</div>'.repeat(25),
    );
    expect(result.response.body).toContain('[Additional formatting omitted]');
    expect(result.response.bodyTruncated).toBe(true);
    expect(result.response.warnings.join(' ')).toContain('formatting limits');
  });
  it('rejects oversized original messages before parsing', async () => {
    await expect(
      parse(Buffer.alloc(EMAIL_PREVIEW_LIMITS.bytes + 1)),
    ).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_TOO_LARGE' });
  });
  it('rejects excessive multipart breadth before MIME work', async () => {
    await expect(parse('\r\n--boundary\r\n'.repeat(129))).rejects.toMatchObject(
      { code: 'EMAIL_PREVIEW_PART_LIMIT' },
    );
  });
  it('enforces cumulative header size', async () => {
    await expect(
      parse(
        'Subject: ' +
          'a'.repeat(EMAIL_PREVIEW_LIMITS.headers + 1) +
          '\r\n\r\nBody',
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_UNREADABLE' });
  });
  it('bounds MIME nesting', async () => {
    let value = 'Content-Type: text/plain\r\n\r\nBody';
    for (let index = 0; index < 25; index++)
      value = `Content-Type: multipart/mixed; boundary="b${index}"\r\n\r\n--b${index}\r\n${value}\r\n--b${index}--\r\n`;
    await expect(parse(value)).rejects.toMatchObject({
      code: 'EMAIL_PREVIEW_UNREADABLE',
    });
  });
  it('rejects over 64 decoded attachments without silently hiding any', async () => {
    await expect(
      parse(multipart(Array.from({ length: 65 }, () => pdfPart))),
    ).rejects.toMatchObject({ code: 'EMAIL_PREVIEW_PART_LIMIT' });
  });
  it('constructs attachment URLs from strict local references only', () => {
    expect(emailAttachmentPreviewPath(ID, 0)).toBe(
      `/api/documents/${ID}/email/attachments/0`,
    );
    for (const value of [-1, 64, NaN, 0.5])
      expect(() => emailAttachmentPreviewPath(ID, value)).toThrow();
    expect(() =>
      emailAttachmentPreviewPath('https://outside.example', 0),
    ).toThrow();
  });
});
