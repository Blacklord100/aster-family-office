import { z } from 'zod';
import type { EngineSnapshot } from './engine-contract';
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      Number.isFinite(Date.parse(s + 'T00:00:00Z')) &&
      new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s,
  )
  .nullable();
export const FactSchema = z
  .object({
    kind: z.enum(['valuation', 'capital_call', 'distribution', 'news']),
    investmentName: z.string().min(1).max(300),
    effectiveDate: date,
    amount: z
      .string()
      .regex(/^-?\d{1,18}(\.\d{1,8})?$/)
      .nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    dueDate: date,
    summary: z.string().max(3000),
    evidence: z.object({
      page: z.number().int().min(1).max(100),
      quote: z.string().min(1).max(6000),
    }),
  })
  .strict();
export const ExtractionSchema = z
  .object({
    schemaVersion: z.literal(1),
    documentId: z.uuid(),
    mode: z.enum(['workflow', 'agentic']),
    execution: z.enum(['local', 'cloud']),
    documentType: z.string().max(100),
    relevant: z.boolean(),
    confidence: z.number().min(0).max(1),
    facts: z.array(FactSchema).max(100),
    warnings: z.array(z.string().max(3000)).max(100),
    trace: z
      .array(
        z.object({
          stage: z.string().max(100),
          status: z.string().max(100),
          detail: z.string().max(3000),
        }),
      )
      .max(100),
    model: z.string().max(200).nullable(),
  })
  .strict();
export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedFact = z.infer<typeof FactSchema>;
export type ProcessingMode = 'workflow' | 'agentic';
export type ProcessingJob = {
  id: string;
  documentId: string;
  filename: string;
  mode: ProcessingMode;
  status: string;
  createdAt: string;
  updatedAt: string;
  policyRevision: number;
  errorCode: string | null;
  result: Extraction | null;
  engine?: EngineSnapshot | null;
  engineLegacy?: boolean;
  review?: import('./review-contract').ReviewState | null;
};
export type ProcessingPolicy = {
  mode: ProcessingMode;
  revision: number;
  execution: 'local' | 'cloud';
  engine?: EngineSnapshot;
  externalFallback: false;
};
export type WorkspaceIdentity = {
  user: { id: string; email: string; name: string };
  organizationId: string;
  organizationName: string;
  role: 'owner' | 'admin' | 'analyst' | 'viewer';
  mfaEnabled: boolean;
  dataScope?: import('./data-scope').DataScope | null;
};
