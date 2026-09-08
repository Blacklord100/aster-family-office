/** Browser preview bounds are separate from ingestion/OCR and never relax it. */
export const PDF_PREVIEW_BYTES = 10 * 1024 * 1024;
export const PDF_PREVIEW_PAGES = 40;
export const PDF_PREVIEW_PIXELS = 4_000_000;
export const PDF_PREVIEW_EDGE = 2400;
export const PDF_PREVIEW_TIMEOUT = 20_000;
export const PDF_PREVIEW_WORKER = '/pdfjs/pdf.worker-6.3.289.min.mjs';

export function pdfPreviewPath(documentId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      documentId,
    )
  )
    throw new Error('Invalid document reference.');
  return `/api/documents/${documentId}/preview`;
}

export function pdfPreviewScale(width: number, height: number): number {
  if (
    ![width, height].every((n) => Number.isFinite(n) && n > 0 && n <= 1_000_000)
  )
    throw new Error(
      'This PDF has unsupported page dimensions. Download the original to inspect it.',
    );
  return Math.min(
    1.75,
    PDF_PREVIEW_EDGE / width,
    PDF_PREVIEW_EDGE / height,
    Math.sqrt(PDF_PREVIEW_PIXELS / (width * height)),
  );
}

export async function readPdfPreview(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.ok)
    throw new Error('The original is unavailable or access has changed.');
  if (
    response.headers.get('content-type')?.split(';')[0].trim() !==
    'application/pdf'
  )
    throw new Error(
      'The original is not a PDF. Download it to inspect its source format.',
    );
  const length = Number(response.headers.get('content-length') ?? 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > PDF_PREVIEW_BYTES)
    throw new Error(
      'PDF preview is limited to 10 MB. Download the original to inspect it.',
    );
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The original could not be read.');
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > PDF_PREVIEW_BYTES)
        throw new Error(
          'PDF preview is limited to 10 MB. Download the original to inspect it.',
        );
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
