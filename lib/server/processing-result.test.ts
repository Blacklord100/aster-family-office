import { describe, expect, it } from 'vitest';
import { readProcessingResult } from './processing-result';

const expected = {
  documentId: '00000000-0000-4000-8000-000000000001',
  mode: 'workflow' as const,
};
const extraction = {
  schemaVersion: 1,
  ...expected,
  execution: 'local',
  documentType: 'statement',
  relevant: false,
  confidence: 0.5,
  facts: [],
  warnings: [],
  trace: [],
  model: null,
};
describe('bounded processor responses', () => {
  it('requires the pinned execution and model for cloud results', async () => {
    const pinned = {
      ...expected,
      execution: 'cloud' as const,
      model: 'gpt-5.3-codex',
    };
    const cloud = { ...extraction, execution: 'cloud', model: pinned.model };
    await expect(
      readProcessingResult(Response.json(cloud), pinned),
    ).resolves.toEqual(cloud);
    await expect(
      readProcessingResult(Response.json({ ...cloud, model: 'other' }), pinned),
    ).rejects.toThrow('RESULT_IDENTITY_MISMATCH');
    await expect(
      readProcessingResult(Response.json(extraction), pinned),
    ).rejects.toThrow('RESULT_IDENTITY_MISMATCH');
  });
  it('accepts validated results and verifies document identity and mode', async () => {
    await expect(
      readProcessingResult(Response.json(extraction), expected),
    ).resolves.toEqual(extraction);
    await expect(
      readProcessingResult(
        Response.json({
          ...extraction,
          documentId: '00000000-0000-4000-8000-000000000002',
        }),
        expected,
      ),
    ).rejects.toThrow('RESULT_IDENTITY_MISMATCH');
    await expect(
      readProcessingResult(
        Response.json({ ...extraction, mode: 'agentic' }),
        expected,
      ),
    ).rejects.toThrow('RESULT_IDENTITY_MISMATCH');
  });
  it('cancels an oversized chunked stream before decoding it', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readProcessingResult(new Response(stream), expected, 64),
    ).rejects.toThrow('RESULT_TOO_LARGE');
    expect(cancelled).toBe(true);
  });
  it('rejects oversized declared responses and invalid or cloud execution', async () => {
    await expect(
      readProcessingResult(
        new Response('{}', { headers: { 'content-length': '2000001' } }),
        expected,
      ),
    ).rejects.toThrow('RESULT_TOO_LARGE');
    await expect(
      readProcessingResult(
        Response.json({ ...extraction, execution: 'cloud' }),
        expected,
      ),
    ).rejects.toThrow();
    await expect(
      readProcessingResult(new Response('invalid JSON'), expected),
    ).rejects.toThrow();
    await expect(
      readProcessingResult(new Response('', { status: 503 }), expected),
    ).rejects.toThrow('PROCESSOR_HTTP_503');
  });
});
