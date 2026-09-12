import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({
  mime: 'text/plain',
  bytes: Buffer.from('Synthetic source'),
  allowed: true,
  document: true,
  audit: vi.fn(),
}));
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
    requireWorkspace: async () => ({
      organizationId: 'synthetic-org',
      user: { id: 'synthetic-reviewer' },
    }),
    errorResponse: (error: Error & { status?: number; code?: string }) =>
      Response.json({ error: error.code }, { status: error.status ?? 500 }),
  };
});
vi.mock('./db', () => ({
  withTenant: async (
    _org: string,
    run: (c: { query: () => Promise<unknown> }) => unknown,
  ) =>
    run({
      query: async () => ({
        rows: fixtures.document
          ? [
              {
                filename: 'synthetic-source',
                mime_type: fixtures.mime,
                payload: fixtures.bytes,
              },
            ]
          : [],
      }),
    }),
}));
vi.mock('./data-scope', async () => {
  const { AccessError } = await import('./access');
  return {
    assertDocumentAccess: async () => {
      if (!fixtures.allowed)
        throw new AccessError(404, 'NOT_FOUND', 'Source not granted');
    },
  };
});
vi.mock('./crypto', () => ({ decrypt: (value: Buffer) => value }));
vi.mock('./audit', () => ({ audit: fixtures.audit }));
import { GET } from '../../app/api/documents/[id]/preview/route';
const call = () =>
  GET(
    new Request(
      'http://localhost/api/documents/00000000-0000-4000-8000-000000000010/preview',
    ),
    { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000010' }) },
  );
describe('authenticated original document preview', () => {
  beforeEach(() => {
    fixtures.allowed = true;
    fixtures.document = true;
    fixtures.mime = 'text/plain';
    fixtures.bytes = Buffer.from('Synthetic source');
    fixtures.audit.mockReset();
  });
  it('serves an email only as literal text with no executable HTML or external resources', async () => {
    fixtures.mime = 'message/rfc822';
    fixtures.bytes = Buffer.from(
      'From: synthetic@example.test\n\n<script>doNotExecute()</script><img src="https://invalid.test/pixel">',
    );
    const response = await call();
    expect(response.headers.get('Content-Type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(await response.text()).toContain('<script>doNotExecute()</script>');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('retains exact PDF bytes and permits same-origin embedding only', async () => {
    fixtures.mime = 'application/pdf';
    fixtures.bytes = Buffer.from('%PDF-synthetic-fixture');
    const response = await call();
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "frame-ancestors 'self'",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtures.bytes);
    expect(fixtures.audit).toHaveBeenCalledWith(
      expect.anything(),
      'synthetic-org',
      'synthetic-reviewer',
      'document.previewed',
      expect.any(String),
    );
  });
  it('does not release an ungranted or missing document or record it as opened', async () => {
    fixtures.allowed = false;
    expect((await call()).status).toBe(404);
    expect(fixtures.audit).not.toHaveBeenCalled();
    fixtures.allowed = true;
    fixtures.document = false;
    expect((await call()).status).toBe(404);
    expect(fixtures.audit).not.toHaveBeenCalled();
  });
  it('rejects unsupported executable formats', async () => {
    fixtures.mime = 'text/html';
    expect((await call()).status).toBe(415);
    expect(fixtures.audit).not.toHaveBeenCalled();
  });
});

// These tests isolate route behavior; the real admission barrier is exercised
// against disposable PostgreSQL in lifecycle.integration.test.ts.
vi.mock('./lifecycle', () => ({
  lifecycleRoute: (handler: (...args: unknown[]) => unknown) => handler,
}));
