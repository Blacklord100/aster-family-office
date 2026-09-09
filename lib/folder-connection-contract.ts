import { z } from 'zod';

/** A relative, tenant-owned directory name. Absolute paths never cross this API. */
export const FolderDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !Array.from(value).some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) &&
      !value.startsWith('/') &&
      value
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            part !== '.' &&
            part !== '..' &&
            !part.startsWith('.'),
        ),
    'Choose a visible directory inside this workspace’s local intake.',
  );
export const FolderConnectSchema = z
  .object({
    directory: FolderDirectorySchema,
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();
export const FolderActionSchema = z
  .object({
    action: z.enum(['sync', 'pause', 'resume', 'disconnect', 'retry']),
  })
  .strict();
export type FolderAction = z.infer<typeof FolderActionSchema>['action'];
export type FolderDirectory = {
  directory: string;
  displayName: string;
  isDemo: boolean;
};
export type FolderFileInfo = {
  filename: string;
  relativePath: string;
  documentId: string | null;
  jobId: string | null;
  outcome: 'imported' | 'duplicate' | 'invalid' | 'oversize';
  status: string;
  importedAt: string;
};
export type FolderConnectionInfo = {
  id: string;
  directory: string;
  displayName: string;
  isDemo: boolean;
  status: 'active' | 'paused' | 'disconnected';
  connectedBy: string;
  currentUserCanManage: boolean;
  importedCount: number;
  skippedCount: number;
  duplicateCount: number;
  uniqueDocumentCount: number;
  counts: {
    queued: number;
    processing: number;
    awaitingReview: number;
    accepted: number;
    failed: number;
    rejected: number;
  };
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  errorCode: string | null;
  recentFiles: FolderFileInfo[];
};
export type FolderResponse = {
  configured: boolean;
  rootLabel: string;
  canManage: boolean;
  directories: FolderDirectory[];
  connections: FolderConnectionInfo[];
};
