import { z } from 'zod';
import { AccessError } from './access';
export async function readBody(
  request: Request,
  limit = 65536,
): Promise<Uint8Array> {
  const advertised = Number(request.headers.get('content-length') ?? 0);
  if (advertised > limit)
    throw new AccessError(413, 'BODY_TOO_LARGE', 'This request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new AccessError(
          413,
          'BODY_TOO_LARGE',
          'This request is too large.',
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function parseJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new AccessError(415, 'JSON_REQUIRED', 'Send a JSON request.');
  try {
    return schema.parse(
      JSON.parse(new TextDecoder().decode(await readBody(request))),
    );
  } catch (e) {
    if (e instanceof AccessError) throw e;
    throw new AccessError(
      400,
      'INVALID_REQUEST',
      'Check the submitted fields and try again.',
    );
  }
}
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
