import { describe, expect, it } from 'vitest';
import {
  PDF_PREVIEW_BYTES,
  PDF_PREVIEW_EDGE,
  PDF_PREVIEW_PIXELS,
  pdfPreviewPath,
  pdfPreviewScale,
  readPdfPreview,
} from './pdf-preview';

describe('bounded original PDF preview', () => {
  it('allows only a fixed UUID document path, never a user URL or traversal', () => {
    expect(pdfPreviewPath('4ee4b1af-cba6-4253-9f70-a6ddbc94964c')).toBe(
      '/api/documents/4ee4b1af-cba6-4253-9f70-a6ddbc94964c/preview',
    );
    for (const id of [
      'https://example.invalid/file.pdf',
      '../private',
      'id/../../secret',
      'data:application/pdf,abc',
      '%2e%2e',
      '',
    ])
      expect(() => pdfPreviewPath(id)).toThrow();
  });
  it('caps page canvas area and edges including extreme page aspect ratios', () => {
    for (const [width, height] of [
      [612, 792],
      [100_000, 100_000],
      [20, 800_000],
      [1_000_000, 1],
    ]) {
      const scale = pdfPreviewScale(width, height);
      expect(width * scale).toBeLessThanOrEqual(PDF_PREVIEW_EDGE);
      expect(height * scale).toBeLessThanOrEqual(PDF_PREVIEW_EDGE);
      expect(width * scale * height * scale).toBeLessThanOrEqual(
        PDF_PREVIEW_PIXELS + 0.001,
      );
    }
    for (const value of [NaN, Infinity, -1, 0, 1_000_001])
      expect(() => pdfPreviewScale(value, 100)).toThrow();
  });
  it('rejects changed access, mislabeled content and oversized declared bodies', async () => {
    const signal = new AbortController().signal;
    await expect(
      readPdfPreview(new Response('denied', { status: 404 }), signal),
    ).rejects.toThrow('access has changed');
    await expect(
      readPdfPreview(
        new Response('<script>bad()</script>', {
          headers: { 'content-type': 'text/html' },
        }),
        signal,
      ),
    ).rejects.toThrow('not a PDF');
    await expect(
      readPdfPreview(
        new Response('pdf', {
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(PDF_PREVIEW_BYTES + 1),
          },
        }),
        signal,
      ),
    ).rejects.toThrow('10 MB');
  });
  it('enforces actual streamed bytes even when content length is missing and cancels the stream', async () => {
    let cancelled = false,
      sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        sent++;
        c.enqueue(new Uint8Array(sent === 1 ? PDF_PREVIEW_BYTES : 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readPdfPreview(
        new Response(stream, {
          headers: { 'content-type': 'application/pdf' },
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow('10 MB');
    expect(cancelled).toBe(true);
  });
  it('preserves authorized source bytes and propagates cancellation without returning a partial PDF', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 0, 255]);
    expect(
      await readPdfPreview(
        new Response(bytes, { headers: { 'content-type': 'application/pdf' } }),
        new AbortController().signal,
      ),
    ).toEqual(bytes);
    const controller = new AbortController();
    controller.abort();
    await expect(
      readPdfPreview(
        new Response(bytes, { headers: { 'content-type': 'application/pdf' } }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('cancels an in-flight stream read immediately when its signal is aborted', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const pending = readPdfPreview(
      new Response(body, { headers: { 'content-type': 'application/pdf' } }),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });
});
