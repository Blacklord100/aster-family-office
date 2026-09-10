import { z } from 'zod';
import {
  ledgerDate,
  ledgerId,
  ledgerLabel,
  LEDGER_CURRENCIES,
} from './ledger-contract';
export const historyPositionDetailsSchema = z
  .object({
    familyId: ledgerId,
    entityId: ledgerId,
    accountId: ledgerId,
    name: ledgerLabel,
    manager: ledgerLabel,
    assetClass: z.enum([
      'Public equities',
      'Private equity',
      'Venture capital',
      'Real estate',
      'Fixed income',
      'Cash',
    ]),
    currency: z.enum(LEDGER_CURRENCIES),
  })
  .strict();
export type HistoryPositionDetails = z.infer<
  typeof historyPositionDetailsSchema
>;
const evidenceFields = {
  sourceId: ledgerId,
  evidenceVerified: z.literal(true),
  page: z.number().int().min(1).max(10000),
  quote: z.string().trim().min(10).max(6000),
};
export const historyLifecycleCommandSchema = z
  .object({
    holdingId: ledgerId,
    kind: z.enum(['opened', 'closed', 'classified']),
    effectiveDate: ledgerDate,
    details: historyPositionDetailsSchema.optional(),
    correctionOf: ledgerId.optional(),
    reason: z.string().trim().min(10).max(2000),
    ...evidenceFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind !== 'closed' && !v.details)
      ctx.addIssue({
        code: 'custom',
        path: ['details'],
        message:
          'Acquisition and classification records require explicit position details.',
      });
    if (v.kind === 'closed' && v.details)
      ctx.addIssue({
        code: 'custom',
        path: ['details'],
        message: 'An exit does not amend position classifications.',
      });
  });
export type HistoryLifecycleCommand = z.infer<
  typeof historyLifecycleCommandSchema
>;
export type HistoryLifecycleRecord = {
  id: string;
  holdingId: string;
  kind: HistoryLifecycleCommand['kind'];
  effectiveDate: string;
  recordedAt: string;
  actorId: string;
  /** Snapshot of the registered identity, preserved if later archived. */
  registeredDetails: HistoryPositionDetails;
  details: HistoryPositionDetails | null;
  sourceId: string;
  documentId: string;
  sourceSha256: string;
  page: number;
  quote: string;
  reason: string;
  correctionOf: string | null;
};
export type HistoryLifecycleState = {
  version: 1;
  revision: number;
  records: HistoryLifecycleRecord[];
  receipts: { key: string; digest: string; resultId: string }[];
};
export const emptyHistoryLifecycle = (): HistoryLifecycleState => ({
  version: 1,
  revision: 0,
  records: [],
  receipts: [],
});
export const historyLifecycleRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.uuid(),
    command: historyLifecycleCommandSchema,
  })
  .strict();
export type HistoryLifecycleRequest = z.infer<
  typeof historyLifecycleRequestSchema
>;
export type HistoryLifecycleResponse = {
  revision: number;
  historyLifecycle: HistoryLifecycleState;
  canWrite: boolean;
  resultId?: string;
  duplicate?: boolean;
};
