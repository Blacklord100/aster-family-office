import { z } from 'zod';
import {
  EngineModelSchema,
  EngineProviderSchema,
  type EngineSnapshot,
} from './engine-contract';

export const EngineInspectionRequestSchema = z
  .object({
    target: z.enum(['active', 'profile']),
    profileId: z.uuid().nullable(),
    revision: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) =>
    value.profileId === null
      ? value.revision === 0 && value.target === 'active'
      : value.revision > 0,
  );

const positive = z.number().int().positive();
export const EngineInfoSchema = z
  .object({
    provider: EngineProviderSchema,
    model: EngineModelSchema,
    execution: z.enum(['local', 'cloud']),
    checkedAt: z.iso.datetime({ offset: true }),
    vision: z
      .object({
        advertised: z.enum(['supported', 'unsupported', 'unknown']),
        effective: z.enum([
          'enabled',
          'model_unsupported',
          'metadata_unknown',
          'deployment_disabled',
          'provider_disabled',
        ]),
        basis: z.enum(['local_metadata', 'provider_policy']),
        imageTested: z.literal(false),
      })
      .strict(),
    observedDigest: z
      .string()
      .regex(/^(?:sha256:)?[a-f0-9]{64}$/)
      .nullable(),
    digestPinned: z.literal(false),
    limits: z
      .object({
        maxFileBytes: positive,
        maxPages: positive,
        maxTextCharacters: positive,
        ocrEnabled: z.boolean(),
        maxOcrPages: z.number().int().nonnegative(),
        maxNestedEmailDepth: z.number().int().min(0).max(5),
        maxEmailParts: z.number().int().min(1).max(64),
        maxEmailAttachments: z.number().int().min(1).max(16),
        visualPagesEnabled: z.boolean(),
        maxVisualPages: z.number().int().min(0).max(12),
        maxVisualBytes: z
          .number()
          .int()
          .min(0)
          .max(16 * 1024 * 1024),
        maxAgentSteps: z.number().int().min(1).max(64),
        maxModelCalls: z.number().int().min(1).max(96),
        maxPageExtractions: z.number().int().min(1).max(3),
        decodeTimeoutSeconds: z.number().min(1).max(120),
        documentTimeoutSeconds: positive,
        contextTokens: positive.nullable(),
        outputTokens: positive.nullable(),
        maxPromptBytes: positive.nullable(),
      })
      .strict(),
    autoDownload: z.literal(false),
    generationPerformed: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const local = value.provider === 'ollama';
    if (
      local !== (value.execution === 'local') ||
      (local &&
        (value.vision.basis !== 'local_metadata' ||
          value.vision.effective === 'provider_disabled')) ||
      (!local &&
        (value.vision.basis !== 'provider_policy' ||
          value.vision.effective !== 'provider_disabled' ||
          value.observedDigest !== null ||
          value.vision.advertised !== 'unknown'))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid inspection boundary' });
    }
    const enabled =
      value.limits.visualPagesEnabled &&
      value.limits.maxVisualPages > 0 &&
      value.limits.maxVisualBytes > 0;
    const expected = !enabled
      ? 'deployment_disabled'
      : value.vision.advertised === 'supported'
        ? 'enabled'
        : value.vision.advertised === 'unsupported'
          ? 'model_unsupported'
          : 'metadata_unknown';
    if (local && value.vision.effective !== expected) {
      ctx.addIssue({ code: 'custom', message: 'Invalid image enablement' });
    }
  });
export type EngineInfo = z.infer<typeof EngineInfoSchema>;
export const EngineInspectionSchema = EngineInfoSchema.safeExtend({
  target: z.enum(['active', 'profile']),
  profileId: z.uuid().nullable(),
  revision: z.number().int().nonnegative(),
}).refine((value) =>
  value.profileId === null
    ? value.revision === 0 && value.target === 'active'
    : value.revision > 0,
);
export type EngineInspection = z.infer<typeof EngineInspectionSchema>;

export function inspectionIdentity(
  engine: Pick<EngineSnapshot, 'profileId' | 'revision' | 'provider' | 'model'>,
) {
  return JSON.stringify([
    engine.profileId,
    engine.revision,
    engine.provider,
    engine.model,
  ]);
}

export function inspectionMatches(
  inspection: EngineInspection,
  engine: EngineSnapshot,
) {
  return (
    inspectionIdentity(inspection) === inspectionIdentity(engine) &&
    inspection.execution === engine.execution
  );
}
