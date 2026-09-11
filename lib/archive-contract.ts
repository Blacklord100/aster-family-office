import { z } from 'zod';
import { FolderDirectorySchema } from './folder-connection-contract';

export const ArchiveDirectorySchema = FolderDirectorySchema.refine(
  (value) =>
    value.split('/').length <= 8 &&
    value.split('/').every((part) => part.length <= 80) &&
    !/[<>:"|?*\u202A-\u202E\u2066-\u2069]/.test(value),
  'Use up to eight portable directory segments.',
);
export const ArchiveDestinationInputSchema = z
  .object({
    provider: z.literal('local'),
    label: z.string().trim().min(1).max(100),
    directory: ArchiveDirectorySchema,
    enabled: z.boolean(),
  })
  .strict();
export type ArchiveDestinationInput = z.infer<
  typeof ArchiveDestinationInputSchema
>;
export type ArchiveDestination = ArchiveDestinationInput & {
  revision: number;
  archiveRevision: number;
  configuredAt: string;
  automaticFrom: string;
};
export type ArchiveReceipt = {
  provider: 'local';
  relativePath: string;
  manifestSha256: string;
  originalSha256: string;
  archivedAt: string;
  files: { path: string; mimeType: string; byteSize: number; sha256: string }[];
  warnings: string[];
};
export type ArchiveStatus = 'queued' | 'running' | 'archived' | 'failed';
export type ArchiveRecord = {
  id: string;
  documentId: string;
  filename: string;
  destinationDirectory: string | null;
  sourceRetained: boolean;
  canDownload: boolean;
  destinationRevision: number;
  status: ArchiveStatus;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  lastVerification?: {
    ok: boolean;
    checkedAt: string;
    issues: string[];
  } | null;
  receipt: ArchiveReceipt | null;
};
export type ArchiveResponse = {
  workerStatus: 'healthy' | 'stale' | 'unknown';
  workerCheckedAt: string;
  workerHeartbeatAt: string | null;
  configured: boolean;
  rootLabel: string;
  canManage: boolean;
  destination: ArchiveDestination | null;
  counts: Record<ArchiveStatus, number>;
  eligibleUnqueued: number;
  records: ArchiveRecord[];
  hasMore: boolean;
};
const MutationBase = {
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.uuid(),
};
export const ArchiveCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('configure'),
      ...MutationBase,
      destination: ArchiveDestinationInputSchema,
    })
    .strict(),
  z
    .object({ action: z.literal('test'), directory: ArchiveDirectorySchema })
    .strict(),
  z.object({ action: z.literal('backfill'), ...MutationBase }).strict(),
  z.object({ action: z.literal('verify'), jobId: z.uuid() }).strict(),
  z
    .object({ action: z.literal('retry'), ...MutationBase, jobId: z.uuid() })
    .strict(),
]);
export type ArchiveCommand = z.infer<typeof ArchiveCommandSchema>;
export type ArchiveCommandResult = {
  ok: true;
  revision: number;
  affected: number;
  checkedAt?: string;
  issues?: string[];
};
export type ArchiveDocumentResponse = {
  documentId: string;
  canManage: boolean;
  destinationRevision: number | null;
  configured: boolean;
  destinationEnabled: boolean;
  records: ArchiveRecord[];
};
