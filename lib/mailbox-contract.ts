import { z } from 'zod';
export const MailProviderSchema = z.enum(['gmail', 'microsoft']);
export type MailProvider = z.infer<typeof MailProviderSchema>;
export const HistoryDaysSchema = z.union([
  z.literal(30),
  z.literal(90),
  z.literal(365),
  z.literal('all'),
]);
export const MailboxConnectSchema = z
  .object({ provider: MailProviderSchema, historyDays: HistoryDaysSchema })
  .strict();
export const MailboxActionSchema = z
  .object({ action: z.enum(['sync', 'pause', 'resume', 'disconnect']) })
  .strict();
export type ProviderInfo = {
  id: MailProvider;
  configured: boolean;
  missing: string[];
};
export type MailboxInfo = {
  id: string;
  provider: MailProvider;
  email: string;
  displayName: string;
  status: string;
  connectedBy: string;
  currentUserCanManage: boolean;
  importedCount: number;
  skippedCount: number;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  errorCode: string | null;
  historyDays: 30 | 90 | 365 | 'all';
};
export type MailboxResponse = {
  providers: ProviderInfo[];
  mailboxes: MailboxInfo[];
};
