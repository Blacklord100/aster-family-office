import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({}));
import { EngineInputSchema } from '../engine-contract';
import {
  cloudReadiness,
  processorEndpoint,
  validateEngineConfig,
  snapshotOf,
  engineDTO,
  sealJobEngine,
  openJobEngine,
} from './engine-store';
import { encrypt } from './crypto';
import { processorControl } from './engine-processor';
import { retryDecision } from './worker-retry';
const org = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const config = {
  name: 'Synthetic cloud',
  provider: 'openai' as const,
  model: 'gpt-5.3-codex',
  apiKey: 'synthetic-secret-not-a-real-key',
};
beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('PROCESSOR_TOKEN', 'synthetic-processor-key-at-least-24');
  vi.stubEnv('ALLOW_CLOUD_ENGINES', 'false');
  vi.stubEnv('PROCESSOR_URL', 'http://processor:8000');
  vi.stubEnv('PROCESSOR_CLOUD_URL', '');
});
afterEach(() => vi.unstubAllEnvs());
describe('engine isolation and secret contract', () => {
  it('keeps encrypted secrets out of snapshots and every profile DTO', () => {
    const snapshot = snapshotOf(config, id, 1);
    expect(JSON.stringify(snapshot)).not.toContain(config.apiKey);
    const payload = encrypt(JSON.stringify(config), `engine:${org}:${id}:1`);
    expect(payload.toString()).not.toContain(config.apiKey);
    const dto = engineDTO(
      {
        id,
        current_revision: 1,
        payload,
        created_at: new Date(),
        updated_at: new Date(),
        tested_at: null,
        test_ok: null,
        test_error: null,
      },
      org,
    );
    expect(dto.hasSecret).toBe(true);
    expect(dto).not.toHaveProperty('apiKey');
    expect(JSON.stringify(dto)).not.toContain(config.apiKey);
    expect(() =>
      engineDTO(
        {
          id,
          current_revision: 1,
          payload,
          created_at: new Date(),
          updated_at: new Date(),
          tested_at: null,
          test_ok: null,
          test_error: null,
        },
        id,
      ),
    ).toThrow();
  });
  it('pins independent encrypted credentials and rejects tenant, job and public metadata substitution', () => {
    const local = validateEngineConfig({
      name: 'Gemma',
      provider: 'ollama',
      model: 'gemma4:e4b-m3',
    });
    const snapshot = snapshotOf(local, id, 2),
      pin = sealJobEngine(local, snapshot, org, id);
    expect(openJobEngine(pin.payload, snapshot, org, id).config.model).toBe(
      local.model,
    );
    expect(() =>
      openJobEngine(pin.payload, { ...snapshot, model: 'other' }, org, id),
    ).toThrow();
    expect(() => openJobEngine(pin.payload, snapshot, id, org)).toThrow();
  });
  it('requires both cloud opt-in and a separate usable processor origin', () => {
    expect(cloudReadiness().cloudAllowed).toBe(false);
    vi.stubEnv('ALLOW_CLOUD_ENGINES', 'true');
    expect(cloudReadiness().cloudAllowed).toBe(false);
    vi.stubEnv('PROCESSOR_CLOUD_URL', 'http://processor:8000');
    expect(cloudReadiness().cloudAllowed).toBe(false);
    vi.stubEnv('PROCESSOR_CLOUD_URL', 'http://processor-cloud:8000');
    expect(cloudReadiness().cloudAllowed).toBe(true);
    vi.stubEnv('ALLOW_CLOUD_ENGINES', 'false');
    const snapshot = snapshotOf(config, id, 1),
      pin = sealJobEngine(config, snapshot, org, id);
    expect(() => openJobEngine(pin.payload, snapshot, org, id)).toThrow(
      'disabled',
    );
  });
  it.each([
    'http://public.example',
    'http://processor:0',
    'https://user:pass@processor',
    'https://processor/path',
    'https://processor?x=1',
  ])('rejects unsafe processor origin %s', (value) => {
    vi.stubEnv('PROCESSOR_URL', value);
    expect(() => processorEndpoint('local')).toThrow();
  });
  it('rejects arbitrary destinations, cloud aliases, unsafe model names and local API keys', () => {
    expect(
      EngineInputSchema.safeParse({ ...config, url: 'https://evil.invalid' })
        .success,
    ).toBe(false);
    expect(
      EngineInputSchema.safeParse({ ...config, model: 'bad\nmodel' }).success,
    ).toBe(false);
    expect(() =>
      validateEngineConfig({
        name: 'x',
        provider: 'ollama',
        model: 'qwen:cloud',
      }),
    ).toThrow();
    expect(() =>
      validateEngineConfig({ ...config, provider: 'ollama' }),
    ).toThrow();
  });
  it('uses a fixed route, rejects redirects and sanitizes provider check errors', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      throw new Error('private response synthetic-secret-not-a-real-key');
    });
    await expect(
      processorControl('/v1/models', undefined, fetcher),
    ).rejects.toThrow('Engine check unavailable');
    expect((fetcher.mock.calls[0][0] as URL).href).toBe(
      'http://processor:8000/v1/models',
    );
  });
  it('defers processor capacity without charging failure attempts, but caps waiting', () => {
    expect(retryDecision(false, 'PROCESSOR_HTTP_503', 3, 0)).toBe('capacity');
    expect(retryDecision(false, 'PROCESSOR_HTTP_503', 1, 30)).toBe('fail');
    expect(retryDecision(true, 'PROCESSOR_HTTP_500', 3, 30)).toBe('shutdown');
    expect(retryDecision(false, 'PROCESSOR_HTTP_500', 2, 0)).toBe('retry');
    expect(retryDecision(false, 'PROCESSOR_HTTP_500', 3, 0)).toBe('fail');
  });
});
