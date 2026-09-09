import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EngineInspectionDetails } from '../components/aster/engine-inspection';
import {
  EngineInfoSchema,
  EngineInspectionRequestSchema,
  EngineInspectionSchema,
  inspectionIdentity,
  inspectionMatches,
  type EngineInspection,
} from './engine-inspection';

const fixture = (): EngineInspection => ({
  target: 'active',
  profileId: null,
  revision: 0,
  provider: 'ollama',
  model: 'gemma4:fixture',
  execution: 'local',
  checkedAt: '2026-09-09T12:00:00+00:00',
  vision: {
    advertised: 'supported',
    effective: 'enabled',
    basis: 'local_metadata',
    imageTested: false,
  },
  observedDigest: 'a'.repeat(64),
  digestPinned: false,
  autoDownload: false,
  generationPerformed: false,
  limits: {
    maxFileBytes: 10485760,
    maxPages: 40,
    maxTextCharacters: 120000,
    ocrEnabled: true,
    maxOcrPages: 4,
    maxNestedEmailDepth: 3,
    maxEmailParts: 32,
    maxEmailAttachments: 8,
    visualPagesEnabled: true,
    maxVisualPages: 6,
    maxVisualBytes: 8388608,
    maxAgentSteps: 32,
    maxModelCalls: 64,
    maxPageExtractions: 2,
    decodeTimeoutSeconds: 75,
    documentTimeoutSeconds: 590,
    contextTokens: 16384,
    outputTokens: 3200,
    maxPromptBytes: 11500,
  },
});
describe('engine inspection contract and presentation', () => {
  it('accepts exact observed metadata with an inspection timestamp', () => {
    expect(EngineInspectionSchema.parse(fixture())).toEqual(fixture());
    const { target, profileId, revision, ...info } = fixture();
    expect(EngineInfoSchema.parse(info).observedDigest).toBe('a'.repeat(64));
    expect(
      EngineInspectionRequestSchema.parse({ target, profileId, revision }),
    ).toEqual({ target, profileId, revision });
  });
  it.each([
    { generationPerformed: true },
    { autoDownload: true },
    { digestPinned: true },
    { observedDigest: 'not-a-digest' },
    { checkedAt: 'yesterday' },
    { endpoint: 'http://arbitrary.invalid' },
    {
      vision: {
        advertised: 'unsupported',
        effective: 'enabled',
        basis: 'local_metadata',
        imageTested: false,
      },
    },
    {
      vision: {
        advertised: 'supported',
        effective: 'enabled',
        basis: 'local_metadata',
        imageTested: true,
      },
    },
    { execution: 'cloud' },
  ])('rejects false claims and unknown fields: %j', (patch) => {
    expect(
      EngineInspectionSchema.safeParse({ ...fixture(), ...patch }).success,
    ).toBe(false);
  });
  it('rejects unsupported identity selectors and caller model/endpoint input', () => {
    for (const value of [
      { target: 'active', profileId: null, revision: 1 },
      { target: 'profile', profileId: null, revision: 0 },
      { target: 'active', profileId: null, revision: 0, model: 'other' },
      { target: 'active', profileId: null, revision: 0, apiKey: 'secret' },
    ])
      expect(EngineInspectionRequestSchema.safeParse(value).success).toBe(
        false,
      );
  });
  it('does not display observations for another profile, revision, model or execution', () => {
    const inspection = fixture();
    const engine = { ...inspection, name: 'Current' };
    expect(inspectionMatches(inspection, engine)).toBe(true);
    for (const patch of [
      { profileId: '00000000-0000-4000-8000-000000000001' },
      { revision: 1 },
      { model: 'qwen3:fixture' },
      { provider: 'openai' as const },
      { execution: 'cloud' as const },
    ]) {
      expect(inspectionMatches(inspection, { ...engine, ...patch })).toBe(
        false,
      );
    }
    expect(inspectionIdentity(engine)).toContain('gemma4:fixture');
  });
  it('renders actual limits and distinguishes observation from testing and pinning', () => {
    const html = renderToStaticMarkup(
      createElement(EngineInspectionDetails, { inspection: fixture() }),
    );
    for (const text of [
      'image support supported',
      'No image or generation request was made',
      'not pinned to jobs',
      '16,384 tokens requested',
      '11,500 bytes',
      '64 per document',
      '32 planner steps',
    ])
      expect(html).toContain(text);
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('10 MiB');
    expect(html).toContain('Processor limits');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });
  it.each([
    [
      'unsupported',
      'model_unsupported',
      'model does not advertise image support',
    ],
    ['unknown', 'metadata_unknown', 'image capability could not be verified'],
    [
      'supported',
      'deployment_disabled',
      'Images disabled by deployment settings',
    ],
  ] as const)('renders %s/%s honestly', (advertised, effective, expected) => {
    const inspection = fixture();
    inspection.vision = { ...inspection.vision, advertised, effective };
    if (effective === 'deployment_disabled')
      inspection.limits.visualPagesEnabled = false;
    expect(EngineInspectionSchema.safeParse(inspection).success).toBe(true);
    expect(
      renderToStaticMarkup(
        createElement(EngineInspectionDetails, { inspection }),
      ),
    ).toContain(expected);
  });
  it('does not infer provider image capability or show a local digest for cloud adapters', () => {
    const inspection = fixture();
    Object.assign(inspection, {
      provider: 'anthropic',
      execution: 'cloud',
      observedDigest: null,
    });
    inspection.vision = {
      advertised: 'unknown',
      effective: 'provider_disabled',
      basis: 'provider_policy',
      imageTested: false,
    };
    inspection.limits.contextTokens = null;
    inspection.limits.maxPromptBytes = null;
    expect(EngineInspectionSchema.safeParse(inspection).success).toBe(true);
    const html = renderToStaticMarkup(
      createElement(EngineInspectionDetails, { inspection }),
    );
    expect(html).toContain('Images disabled in this cloud adapter');
    expect(html).toContain('Provider capabilities were not queried');
    expect(html).toContain('3,200 tokens requested');
    expect(html).not.toContain('Observed model digest');
  });
});
