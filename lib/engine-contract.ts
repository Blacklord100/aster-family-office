import { z } from 'zod';

export const EngineProviderSchema = z.enum(['ollama', 'openai', 'anthropic']);
export type EngineProvider = z.infer<typeof EngineProviderSchema>;
export const EngineModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(121)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
export const EngineInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    provider: EngineProviderSchema,
    model: EngineModelSchema,
    apiKey: z
      .string()
      .min(16)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .strict();
export const EngineSnapshotSchema = z
  .object({
    profileId: z.uuid().nullable(),
    revision: z.number().int().min(0),
    name: z.string().min(1).max(80),
    provider: EngineProviderSchema,
    model: EngineModelSchema,
    execution: z.enum(['local', 'cloud']),
  })
  .strict()
  .refine((v) => (v.provider === 'ollama') === (v.execution === 'local'));
export type EngineSnapshot = z.infer<typeof EngineSnapshotSchema>;
export type EngineTestResult = {
  testedAt: string;
  ok: boolean;
  errorCode: string | null;
};
export type EngineProfile = EngineSnapshot & {
  profileId: string;
  createdAt: string;
  updatedAt: string;
  hasSecret: boolean;
  lastTest: EngineTestResult | null;
};
export type EngineModel = { name: string; size: number; digest: string };
export type EnginesResponse = {
  profiles: EngineProfile[];
  active: EngineSnapshot;
  canManage: boolean;
  cloudAllowed: boolean;
  cloudReadinessReason: string | null;
};
export type EngineModelsResponse = {
  models: EngineModel[];
  endpoint: 'deployment';
  autoDownload: false;
};
