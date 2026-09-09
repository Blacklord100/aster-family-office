import { z } from 'zod';
import { ledgerDate, ledgerId } from './ledger-contract';
import {
  reportScheduleInputSchema,
  reportExceptionActionSchema,
  type ReportObligationsState,
} from './report-obligations-contract';

const reason = z.string().trim().min(5).max(3000);
const base = {
  expectedRevision: z.number().int().min(0),
  idempotencyKey: z.uuid(),
};
export const reportObligationsRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...base,
      action: z.literal('createSchedule'),
      input: reportScheduleInputSchema,
      reason,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('reviseSchedule'),
      scheduleId: ledgerId,
      input: reportScheduleInputSchema,
      effectiveFrom: ledgerDate,
      status: z.enum(['active', 'paused']),
      reason,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('matchReceipt'),
      occurrenceId: ledgerId,
      documentId: z.uuid(),
      periodStart: ledgerDate,
      periodEnd: ledgerDate,
      asOfDate: ledgerDate.nullable(),
      reportType: z.string().trim().min(1).max(240),
      holdingIds: z.array(ledgerId).min(1).max(200),
      reason,
      supersedesReceiptId: ledgerId.nullable().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('revokeReceipt'),
      occurrenceId: ledgerId,
      receiptId: ledgerId,
      reason,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('reinstateReceipt'),
      occurrenceId: ledgerId,
      receiptId: ledgerId,
      reason,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('disposition'),
      occurrenceId: ledgerId,
      status: z.enum(['waived', 'cancelled', 'reopen']),
      reason,
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('exception'),
      exceptionId: ledgerId,
      operation: reportExceptionActionSchema,
    })
    .strict(),
  z.object({ ...base, action: z.literal('refresh') }).strict(),
]);
export type ReportObligationsRequest = z.infer<
  typeof reportObligationsRequestSchema
>;
export type ReportObligationsDocument = {
  id: string;
  filename: string;
  sha256: string;
  receivedAt: string;
  jobId: string | null;
  status: string;
  reviewStatus: 'pending' | 'accepted' | 'rejected';
};
export type ReportObligationsResponse = {
  revision: number;
  canWrite: boolean;
  canAdmin: boolean;
  asOf: string;
  state: ReportObligationsState;
  monitor: {
    status: 'current' | 'pending' | 'delayed' | 'error';
    nextCheckAt: string | null;
  };
  options: {
    holdings: {
      id: string;
      name: string;
      familyId: string;
      entityId: string;
      manager: string;
    }[];
    families: { id: string; name: string }[];
    members: { userId: string; name: string; role: string }[];
    documents: ReportObligationsDocument[];
  };
  coverage: {
    jobsScanned: number;
    totalJobs: number;
    truncated: boolean;
    notes: string[];
  };
  resultId?: string;
  duplicate?: boolean;
};
