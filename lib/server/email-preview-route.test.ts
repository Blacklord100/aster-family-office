import { beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  ctx: { organizationId: 'tenant', user: { id: 'reviewer' }, scope: null },
  access: vi.fn(),
  documentAccess: vi.fn(),
  query: vi.fn(),
  decrypt: vi.fn(),
  audit: vi.fn(),
  rate: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./access', () => {
  class AccessError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessError,
    requireWorkspace: f.access,
    errorResponse: (error: unknown) =>
      error instanceof AccessError
        ? Response.json(
            { error: error.code, message: error.message },
            { status: error.status },
          )
        : Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 }),
  };
});
vi.mock('./db', () => ({
  withTenant: async (org: string, run: (client: unknown) => unknown) => {
    expect(org).toBe('tenant');
    return run({ query: f.query });
  },
}));
vi.mock('./data-scope', () => ({ assertDocumentAccess: f.documentAccess }));
vi.mock('./crypto', () => ({ decrypt: f.decrypt, sha256: () => 'part-sha256' }));
vi.mock('./audit', () => ({ audit: f.audit, rateLimit: f.rate }));
import { serveEmailPreview } from './email-preview-route';
import { AccessError } from './access';
const ID = '11111111-1111-4111-8111-111111111111';
const request = () =>
  new Request(`https://aster.example/api/documents/${ID}/email`);
const pdf = '%PDF-1.4\n%%EOF';
const email = Buffer.from(
  'From: Manager <manager@example.invalid>\r\nSubject: Monthly NAV\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nSource body\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=nav.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    Buffer.from(pdf).toString('base64') +
    '\r\n--x--\r\n',
);
beforeEach(() => {
  vi.resetAllMocks();
  f.access.mockResolvedValue(f.ctx);
  f.documentAccess.mockResolvedValue(undefined);
  f.rate.mockResolvedValue(true);
  f.query.mockResolvedValue({
    rows: [
      {
        filename: 'report.eml',
        mime_type: 'message/rfc822',
        payload: 'encrypted',
      },
    ],
  });
  f.decrypt.mockReturnValue(email);
});
describe('authenticated email and attachment routes', () => {
  it('uses tenant document scope and encrypted AAD, audits the retained original', async () => {
    const response = await serveEmailPreview(request(), ID);
    expect(response.status).toBe(200);
    expect((await response.json()).body).toContain('Source body');
    expect(f.documentAccess).toHaveBeenCalledWith(expect.anything(), f.ctx, ID);
    expect(f.query).toHaveBeenCalledWith(
      expect.stringContaining('organization_id=$2'),
      [ID, 'tenant'],
    );
    expect(f.decrypt).toHaveBeenCalledWith(
      'encrypted',
      'document:tenant:' + ID,
    );
    expect(f.audit).toHaveBeenCalledWith(
      expect.anything(),
      'tenant',
      'reviewer',
      'document.email_previewed',
      ID,
      expect.objectContaining({ surface: 'decoded_email' }),
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('qualifies a complete body-only email, but never an empty or truncated body, as reviewed source', async () => {
    for (const [body, action] of [
      ['NAV EUR 1,000,000 as of 31 August 2026.', 'document.previewed'],
      ['', 'document.email_previewed'],
      ['x'.repeat(200_001), 'document.email_previewed'],
    ]) {
      f.audit.mockClear();
      f.decrypt.mockReturnValue(
        Buffer.from('Content-Type: text/plain\r\n\r\n' + body),
      );
      expect((await serveEmailPreview(request(), ID)).status).toBe(200);
      expect(f.audit.mock.calls[0][3]).toBe(action);
    }
  });
  it('returns exact PDF bytes with safe headers and a separate attachment audit', async () => {
    const response = await serveEmailPreview(request(), ID, '0');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(pdf);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );
    expect(f.audit).toHaveBeenCalledWith(
      expect.anything(),
      'tenant',
      'reviewer',
      'document.previewed',
      ID,
      {
        surface: 'email_attachment',
        attachmentIndex: 0,
        attachmentHash: 'part-sha256',
        byteSize: Buffer.byteLength(pdf),
      },
    );
  });
  it('does not qualify structurally truncated HTML as an opened complete source', async () => {
    f.decrypt.mockReturnValue(
      Buffer.from(
        'Content-Type: text/html\r\n\r\nVisible before. ' +
          '<div>'.repeat(25) +
          'NAV hidden 2,000,000' +
          '</div>'.repeat(25),
      ),
    );
    const response = await serveEmailPreview(request(), ID);
    expect((await response.json()).bodyTruncated).toBe(true);
    expect(f.audit.mock.calls[0][3]).toBe('document.email_previewed');
  });
  it('returns and identifies only the requested second PDF in a multipart source', async () => {
    const second = '%PDF-1.7\nsecond retained document\n%%EOF';
    f.decrypt.mockReturnValue(
      Buffer.from(
        email.toString().replace(
          '--x--\r\n',
          '--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=second.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
            Buffer.from(second).toString('base64') +
            '\r\n--x--\r\n',
        ),
      ),
    );
    const response = await serveEmailPreview(request(), ID, '1');
    expect(await response.text()).toBe(second);
    expect(f.audit.mock.calls[0][5]).toEqual({
      surface: 'email_attachment',
      attachmentIndex: 1,
      attachmentHash: 'part-sha256',
      byteSize: Buffer.byteLength(second),
    });
  });
  it('blocks unauthenticated requests before reading bytes', async () => {
    f.access.mockRejectedValue(
      new AccessError(401, 'UNAUTHENTICATED', 'Sign in.'),
    );
    expect((await serveEmailPreview(request(), ID)).status).toBe(401);
    expect(f.query).not.toHaveBeenCalled();
  });
  it('honors released-document denial on both metadata and attachments', async () => {
    f.documentAccess.mockRejectedValue(
      new AccessError(404, 'NOT_FOUND', 'Not found.'),
    );
    expect((await serveEmailPreview(request(), ID)).status).toBe(404);
    expect((await serveEmailPreview(request(), ID, '0')).status).toBe(404);
    expect(f.decrypt).not.toHaveBeenCalled();
  });
  it('does not reveal other-tenant or missing originals', async () => {
    f.query.mockResolvedValue({ rows: [] });
    expect((await serveEmailPreview(request(), ID)).status).toBe(404);
    expect(f.decrypt).not.toHaveBeenCalled();
  });
  it('rejects invalid references and indexes before querying sources', async () => {
    for (const index of ['-1', '64', '../0', '00', '1.5'])
      expect((await serveEmailPreview(request(), ID, index)).status).toBe(404);
    expect((await serveEmailPreview(request(), 'outside')).status).toBe(404);
    expect(f.query).not.toHaveBeenCalled();
  });
  it('rejects unsupported attachment content and missing attachment IDs', async () => {
    f.decrypt.mockReturnValue(
      Buffer.from(
        email
          .toString()
          .replace(
            Buffer.from(pdf).toString('base64'),
            Buffer.from('<script>bad</script>').toString('base64'),
          ),
      ),
    );
    expect((await serveEmailPreview(request(), ID, '0')).status).toBe(415);
    expect((await serveEmailPreview(request(), ID, '1')).status).toBe(404);
    expect(f.audit).not.toHaveBeenCalled();
  });
  it('bounds preview traffic before decrypting', async () => {
    f.rate.mockResolvedValue(false);
    expect((await serveEmailPreview(request(), ID)).status).toBe(429);
    expect(f.decrypt).not.toHaveBeenCalled();
  });
  it('does not reinterpret non-email originals', async () => {
    f.query.mockResolvedValue({
      rows: [
        {
          filename: 'report.pdf',
          mime_type: 'application/pdf',
          payload: 'encrypted',
        },
      ],
    });
    expect((await serveEmailPreview(request(), ID)).status).toBe(415);
    expect(f.decrypt).not.toHaveBeenCalled();
  });
});
