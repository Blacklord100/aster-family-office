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
export const ProcessingStatusSchema = z.enum([
  'queued',
  'processing',
  'awaiting_review',
  'accepted',
  'failed',
  'cancelled',
  'rejected',
]);
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>;
export type ProcessingSummary = {
  availability: 'available' | 'not_extracted' | 'size_limit' | 'unavailable';
  extractedCount: number | null;
  acceptedCount: number | null;
  deferredCount: number | null;
  rejectedCount: number | null;
  pendingCount: number | null;
  /** Older accepted jobs have no individual decision receipts. */
  legacyCount: number | null;
  /** Pending plus deferred decisions; this is not an estimate of undiscovered facts. */
  remainingCount: number | null;
  investmentNames: string[];
  factTypes: ExtractedFact['kind'][];
  documentType: string | null;
  warningCount: number | null;
  warnings: string[];
  warningsTruncated: boolean;
};
export type ProcessingTiming = {
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  /** Latest recorded attempt, not queue time or human review time. */
  processingDurationMs: number | null;
  elapsedProcessingMs: number | null;
  source: 'worker_audit';
  /** Recorded worker starts; older attempts without start receipts are unknown. */
  attemptCount: number | null;
};
export type ProcessingActivity = {
  stage: ProcessingStatus | 'waiting_for_capacity';
  availableAt: string | null;
};
export type ProcessingSource = {
  kind: 'folder' | 'mailbox' | 'upload';
  displayName: string | null;
  relativePath: string | null;
  familyNames: string[];
  /** Folder path matches are hints, never an authorization or reviewed identity. */
  familyContext: 'reviewed' | 'source_path' | 'unknown';
};
export type ProcessingPage = {
  limit: number;
  offset: number;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  maxOffset: number;
  /** jobs may also contain the selected deep link outside this page. */
  jobIds: string[];
  /** Counts across the filename search, before the status filter. */
  statusCounts: Record<ProcessingStatus, number>;
};
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
  summary?: ProcessingSummary;
  timing?: ProcessingTiming;
  activity?: ProcessingActivity;
  source?: ProcessingSource;
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
