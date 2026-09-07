import { ExtractionSchema, type ProcessingMode } from '../processing-contract';

/** Bound bytes before decoding/parsing, including chunked responses with no length. */
export async function readProcessingResult(
  response: Response,
  expected: { documentId: string; mode: ProcessingMode },
  maxBytes = 2_000_000,
) {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error('PROCESSOR_HTTP_' + response.status);
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('RESULT_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_PROCESSOR_RESULT');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error('RESULT_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const result = ExtractionSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  if (
    result.documentId !== expected.documentId ||
    result.mode !== expected.mode
  ) {
    throw new Error('RESULT_IDENTITY_MISMATCH');
  }
  return result;
}
