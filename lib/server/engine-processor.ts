import 'server-only';
import { z } from 'zod';
import { EngineModelSchema, type EngineTestResult } from '../engine-contract';
import { EngineInfoSchema } from '../engine-inspection';
import { AccessError } from './access';
import { readBody } from './http';
import {
  assertEngineEnabled,
  processorEndpoint,
  executionFor,
  type EngineConfig,
} from './engine-store';

export async function processorControl(
  path: '/v1/models' | '/v1/engine-test' | '/v1/engine-info',
  config?: EngineConfig,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (config) assertEngineEnabled(config);
  const token = process.env.PROCESSOR_TOKEN;
  if (!token || token.length < 24)
    throw new Error('Processor authentication is not configured');
  try {
    const response = await fetcher(
      new URL(
        path,
        processorEndpoint(config ? executionFor(config.provider) : 'local'),
      ),
      {
        method: config ? 'POST' : 'GET',
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(
            path === '/v1/engine-info' ? 25000 : config ? 150000 : 15000,
          ),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          'X-Processor-Key': token,
          ...(config ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(config ? { body: JSON.stringify(config) } : {}),
      },
    );
    if (!response.ok) {
      void response.body?.cancel();
      throw new AccessError(
        response.status === 503 ? 503 : 502,
        response.status === 503 ? 'PROCESSOR_BUSY' : 'ENGINE_UNAVAILABLE',
        'Engine check unavailable. No document data was sent.',
      );
    }
    return JSON.parse(
      new TextDecoder().decode(
        await readBody(
          new Request('http://processor.invalid', {
            method: 'POST',
            body: response.body,
            duplex: 'half',
          } as RequestInit),
          131072,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError(
      502,
      'ENGINE_UNAVAILABLE',
      'Engine check unavailable. No document data was sent.',
    );
  }
}
export async function inspectEngine(
  config: EngineConfig,
  signal?: AbortSignal,
) {
  const result = EngineInfoSchema.parse(
    await processorControl('/v1/engine-info', config, fetch, signal),
  );
  if (
    result.provider !== config.provider ||
    result.model !== config.model ||
    result.execution !== executionFor(config.provider)
  ) {
    throw new AccessError(
      502,
      'ENGINE_UNAVAILABLE',
      'Engine inspection identity changed. Refresh and inspect again.',
    );
  }
  return result;
}
export async function discoverModels() {
  const parsed = z
    .object({
      models: z
        .array(
          z
            .object({
              name: EngineModelSchema,
              size: z.number().int().nonnegative(),
              digest: z.string().max(200),
            })
            .strict(),
        )
        .max(100),
    })
    .strict()
    .parse(await processorControl('/v1/models'));
  return {
    ...parsed,
    endpoint: 'deployment' as const,
    autoDownload: false as const,
  };
}
export async function testEngine(
  config: EngineConfig,
): Promise<EngineTestResult> {
  const result = z
    .object({
      ok: z.boolean(),
      errorCode: z
        .enum(['MODEL_UNAVAILABLE', 'SCHEMA_CHECK_FAILED'])
        .nullable(),
    })
    .strict()
    .parse(await processorControl('/v1/engine-test', config));
  return { ...result, testedAt: new Date().toISOString() };
}
