import { z } from 'zod';
import { ledgerDate, ledgerId } from './ledger-contract';

export const MAX_REPORT_RECEIPTS_PER_OCCURRENCE = 100;

export const REPORT_CADENCES = [
  'monthly',
  'quarterly',
  'annual',
  'one_off',
] as const;
export const REPORT_TYPES = [
  'nav_statement',
  'capital_account',
  'manager_update',
  'financial_statements',
  'tax_document',
  'consolidation',
  'other',
] as const;
export const REPORT_EXCEPTION_CATEGORIES = [
  'missing_report',
  'late_report',
  'stale_disclosure',
  'processing_failed',
  'review_pending',
  'review_rejected',
  'identity_unresolved',
  'conflicting_fact',
  'manual',
] as const;
export const REPORT_EXCEPTION_PRIORITIES = [
  'low',
  'normal',
  'high',
  'urgent',
] as const;
export const REPORT_EXCEPTION_STATUSES = [
  'open',
  'snoozed',
  'resolved',
  'waived',
] as const;

const label = z.string().trim().min(1).max(240);
const reason = z.string().trim().min(3).max(3000);
const instant = z.iso.datetime({ offset: true });
const ids = z
  .array(ledgerId)
  .min(1)
  .max(200)
  .refine(
    (values) => new Set(values).size === values.length,
    'Select each scope once.',
  );
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
      return true;
    } catch {
      return false;
    }
  }, 'Use a valid IANA timezone.');

/** Family scope is populated by the server from the selected holdings. */
export const reportScheduleInputSchema = z
  .object({
    name: label,
    holdingIds: ids,
    familyIds: ids,
    managerId: ledgerId.nullable().default(null),
    reportType: label,
    cadence: z.enum(REPORT_CADENCES),
    firstPeriodStart: ledgerDate,
    oneOffPeriodEnd: ledgerDate.nullable().default(null),
    timezone,
    dueDaysAfterPeriodEnd: z.number().int().min(0).max(366),
    dueLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    graceHours: z
      .number()
      .int()
      .min(0)
      .max(24 * 90),
    ownerUserId: ledgerId,
    staleAfterDays: z.number().int().min(1).max(3650).nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    const month = Number(value.firstPeriodStart.slice(5, 7));
    const day = Number(value.firstPeriodStart.slice(8, 10));
    if (value.cadence !== 'one_off' && day !== 1)
      context.addIssue({
        code: 'custom',
        path: ['firstPeriodStart'],
        message: 'Recurring periods start on the first day of a month.',
      });
    if (value.cadence === 'quarterly' && ![1, 4, 7, 10].includes(month))
      context.addIssue({
        code: 'custom',
        path: ['firstPeriodStart'],
        message: 'Quarterly periods start in January, April, July or October.',
      });
    if (value.cadence === 'annual' && month !== 1)
      context.addIssue({
        code: 'custom',
        path: ['firstPeriodStart'],
        message: 'Annual periods start on January 1.',
      });
    if (
      value.cadence === 'one_off' &&
      (!value.oneOffPeriodEnd || value.oneOffPeriodEnd < value.firstPeriodStart)
    )
      context.addIssue({
        code: 'custom',
        path: ['oneOffPeriodEnd'],
        message:
          'A one-off report needs an explicit end date on or after its start.',
      });
    if (value.cadence !== 'one_off' && value.oneOffPeriodEnd !== null)
      context.addIssue({
        code: 'custom',
        path: ['oneOffPeriodEnd'],
        message: 'Recurring schedules calculate their period end.',
      });
  });
export type ReportScheduleInput = z.infer<typeof reportScheduleInputSchema>;

export const reportEvidenceReferenceSchema = z
  .object({
    kind: z.enum(['document', 'fact', 'holding', 'review', 'note']),
    id: ledgerId,
    label: z.string().max(240).optional(),
  })
  .strict();
export type ReportEvidenceReference = z.infer<
  typeof reportEvidenceReferenceSchema
>;

export const reportHistoryEntrySchema = z
  .object({
    at: instant,
    actorUserId: ledgerId,
    action: label,
    reason: z.string().max(6000),
    evidence: z.array(reportEvidenceReferenceSchema).max(100),
    evidenceFingerprint: z.string().max(30_000).nullable(),
  })
  .strict();
export type ReportHistoryEntry = z.infer<typeof reportHistoryEntrySchema>;
export type ReportMutationContext = {
  actorUserId: string;
  now: string;
  id?: string;
};

export const reportScheduleVersionSchema = z
  .object({
    id: ledgerId,
    version: z.number().int().min(1),
    effectiveFrom: ledgerDate,
    status: z.enum(['active', 'paused']),
    definition: reportScheduleInputSchema,
    createdAt: instant,
    createdBy: ledgerId,
    reason,
  })
  .strict();
export type ReportScheduleVersion = z.infer<typeof reportScheduleVersionSchema>;
export const reportScheduleSchema = z
  .object({
    id: ledgerId,
    versions: z.array(reportScheduleVersionSchema).min(1).max(500),
    history: z.array(reportHistoryEntrySchema).max(5000),
  })
  .strict();
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;

export const reportReceiptInputSchema = z
  .object({
    documentId: z.uuid(),
    documentHash: z.string().regex(/^[a-f0-9]{64}$/),
    holdingIds: ids,
    reportType: label,
    periodStart: ledgerDate,
    periodEnd: ledgerDate,
    asOfDate: ledgerDate.nullable(),
    receivedAt: instant,
    processingStatus: z.enum([
      'queued',
      'processing',
      'completed',
      'failed',
      'blocked',
    ]),
    reviewStatus: z.enum(['pending', 'accepted', 'rejected']),
    matchReason: reason,
    matchEvidence: z.array(reportEvidenceReferenceSchema).min(1).max(100),
    supersedesReceiptId: ledgerId.nullable().default(null),
  })
  .strict();
export type ReportReceiptInput = z.infer<typeof reportReceiptInputSchema>;
export const reportReceiptSchema = reportReceiptInputSchema
  .extend({
    id: ledgerId,
    matchedAt: instant,
    matchedBy: ledgerId,
    matchStatus: z.enum(['matched', 'revoked']),
    history: z.array(reportHistoryEntrySchema).max(5000),
  })
  .strict();
export type ReportReceipt = z.infer<typeof reportReceiptSchema>;

export const reportOccurrenceSchema = z
  .object({
    id: ledgerId,
    scheduleId: ledgerId,
    scheduleVersionId: ledgerId,
    name: label,
    holdingIds: ids,
    familyIds: ids,
    managerId: ledgerId.nullable(),
    reportType: label,
    cadence: z.enum(REPORT_CADENCES),
    periodStart: ledgerDate,
    periodEnd: ledgerDate,
    timezone,
    dueAt: instant,
    graceEndsAt: instant,
    dueLocalTime: z.string(),
    ownerUserId: ledgerId,
    staleAfterDays: z.number().int().min(1).max(3650).nullable(),
    createdAt: instant,
    receipts: z
      .array(reportReceiptSchema)
      .max(MAX_REPORT_RECEIPTS_PER_OCCURRENCE),
    disposition: z
      .object({
        status: z.enum(['waived', 'cancelled']),
        reason,
        at: instant,
        actorUserId: ledgerId,
        evidence: z.array(reportEvidenceReferenceSchema).max(100),
      })
      .strict()
      .nullable(),
    history: z.array(reportHistoryEntrySchema).max(5000),
  })
  .strict();
export type ReportOccurrence = z.infer<typeof reportOccurrenceSchema>;

export const reportExceptionSchema = z
  .object({
    id: ledgerId,
    key: z.string().min(1).max(1000),
    category: z.enum(REPORT_EXCEPTION_CATEGORIES),
    title: label,
    description: z.string().max(6000),
    familyIds: z
      .array(ledgerId)
      .max(200)
      .refine(
        (values) => new Set(values).size === values.length,
        'Select each scope once.',
      ),
    holdingIds: z.array(ledgerId).max(200),
    managerId: ledgerId.nullable(),
    occurrenceId: ledgerId.nullable(),
    priority: z.enum(REPORT_EXCEPTION_PRIORITIES),
    assigneeUserId: ledgerId.nullable(),
    dueAt: instant.nullable(),
    status: z.enum(REPORT_EXCEPTION_STATUSES),
    snoozedUntil: instant.nullable(),
    evidence: z.array(reportEvidenceReferenceSchema).max(100),
    evidenceFingerprint: z.string().max(30_000),
    resolvedFingerprint: z.string().max(30_000).nullable(),
    sourceActive: z.boolean(),
    origin: z.enum(['calendar', 'external', 'manual']),
    createdAt: instant,
    updatedAt: instant,
    history: z.array(reportHistoryEntrySchema).max(5000),
  })
  .strict();
export type ReportException = z.infer<typeof reportExceptionSchema>;
export type ReportExceptionCategory = ReportException['category'];
export type ReportExceptionSignal = Pick<
  ReportException,
  | 'key'
  | 'category'
  | 'title'
  | 'description'
  | 'familyIds'
  | 'holdingIds'
  | 'priority'
  | 'evidenceFingerprint'
  | 'evidence'
> &
  Partial<
    Pick<
      ReportException,
      | 'managerId'
      | 'occurrenceId'
      | 'assigneeUserId'
      | 'dueAt'
      | 'sourceActive'
      | 'origin'
    >
  >;

export const reportObligationsStateSchema = z
  .object({
    version: z.literal(1),
    schedules: z.array(reportScheduleSchema).max(2000),
    occurrences: z.array(reportOccurrenceSchema).max(50_000),
    exceptions: z.array(reportExceptionSchema).max(50_000),
  })
  .strict();
export type ReportObligationsState = z.infer<
  typeof reportObligationsStateSchema
>;
export const emptyReportObligationsState = (): ReportObligationsState => ({
  version: 1,
  schedules: [],
  occurrences: [],
  exceptions: [],
});

export const reportExceptionActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('assign'),
      assigneeUserId: ledgerId.nullable(),
      reason,
    })
    .strict(),
  z
    .object({
      action: z.literal('priority'),
      priority: z.enum(REPORT_EXCEPTION_PRIORITIES),
      reason,
    })
    .strict(),
  z.object({ action: z.literal('snooze'), until: instant, reason }).strict(),
  z
    .object({
      action: z.enum(['resolve', 'waive']),
      reason,
      evidence: z.array(reportEvidenceReferenceSchema).min(1).max(100),
    })
    .strict(),
  z.object({ action: z.literal('reopen'), reason }).strict(),
]);
export type ReportExceptionAction = z.infer<typeof reportExceptionActionSchema>;

export type ReportDeliveryStatus =
  | 'upcoming'
  | 'due'
  | 'overdue'
  | 'received'
  | 'received_late'
  | 'waived'
  | 'cancelled';
export type ReportOccurrenceSummary = {
  deliveryStatus: ReportDeliveryStatus;
  firstReceivedAt: string | null;
  latestReceivedAt: string | null;
  lateByHours: number;
  acceptedCount: number;
  pendingCount: number;
  rejectedCount: number;
  failedCount: number;
  activeReceiptIds: string[];
  supersededReceiptIds: string[];
};
