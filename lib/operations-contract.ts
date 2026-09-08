import { z } from 'zod';
export const OperationalPolicySchema = z
  .object({
    retentionEnabled: z.boolean(),
    unreviewedRetentionDays: z.number().int().min(30).max(3650),
    backupMaxAgeHours: z.number().int().min(1).max(168),
    jobFailureAlertThreshold: z.number().int().min(1).max(1000),
    mailboxStaleHours: z.number().int().min(1).max(168),
  })
  .strict();
export type OperationalPolicy = z.infer<typeof OperationalPolicySchema>;
export const defaultOperationalPolicy: OperationalPolicy = {
  retentionEnabled: false,
  unreviewedRetentionDays: 365,
  backupMaxAgeHours: 24,
  jobFailureAlertThreshold: 3,
  mailboxStaleHours: 24,
};
export type RetentionPreview = {
  documentIds: string[];
  documentCount: number;
  bytes: number;
  digest: string;
  limited: boolean;
  preserves: string[];
};
export type OperationsStatus = {
  policy: OperationalPolicy;
  revision: number;
  queue: {
    queued: number;
    failed: number;
    review: number;
    oldestQueuedAt: string | null;
  };
  storage: { documents: number; bytes: number };
  mailboxes: { connected: number; stale: number; errors: number };
  services: {
    documentWorker: 'healthy' | 'stale' | 'unreported';
    processor: 'healthy' | 'unavailable';
    backup: 'fresh' | 'stale' | 'unreported';
    backupAt: string | null;
  };
  deliveryConfigured: boolean;
  activeEncryptionKeyId: string;
  alerts: { code: string; message: string }[];
};
