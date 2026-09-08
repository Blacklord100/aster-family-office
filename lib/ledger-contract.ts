import { z } from 'zod';
import type { Holding } from '@/data/types';
import type { PortfolioRecords } from './workspace';

export const LEDGER_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'] as const;
export const LEDGER_ENTITY_TYPES = [
  'Holding company',
  'Property SPV',
  'Trust',
  'Foundation',
  'Partnership',
  'Individual',
] as const;
export const LEDGER_KINDS = [
  'deposit',
  'withdrawal',
  'capital_call',
  'distribution',
  'purchase',
  'sale',
  'fee',
  'transfer',
] as const;
export const ledgerId = z.string().trim().min(1).max(160);
export const ledgerLabel = z.string().trim().min(1).max(240);
export const ledgerDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(value + 'T00:00:00Z');
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, 'Use a valid calendar date.');
/** Exact nonnegative currency amount, cent precision, up to one trillion. */
export const ledgerMoney = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) <= 1e12, 'Amount exceeds one trillion.');
export const ledgerFxSchema = z
  .object({
    rateToEUR: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,12})?$/)
      .refine(
        (value) => Number(value) > 0 && Number(value) <= 1e6,
        'FX rate must be positive and within bounds.',
      ),
    date: ledgerDate,
    source: ledgerLabel,
  })
  .strict();
export type LedgerFx = z.infer<typeof ledgerFxSchema>;
export const ledgerSourceSchema = z
  .object({
    reference: ledgerLabel,
    date: ledgerDate,
    sourceId: ledgerId.optional(),
  })
  .strict();
export type LedgerSource = z.infer<typeof ledgerSourceSchema>;
export type LedgerMeta = { id: string; actorId: string; at: string };
export type HoldingDetails = {
  holdingId: string;
  instrumentId?: string;
  shareClassId?: string;
  managerId?: string;
  source: LedgerSource;
  fx?: LedgerFx;
  originalAmount: string;
  pendingCapitalEUR: number;
  openingDate: string;
};
export type AccountDetails = {
  accountId: string;
  currency: (typeof LEDGER_CURRENCIES)[number];
  restricted: boolean;
  restrictionNote: string;
  reviews?: {
    currency: (typeof LEDGER_CURRENCIES)[number];
    restricted: boolean;
    restrictionNote: string;
    source: LedgerSource;
    reviewedBy: string;
    reviewedAt: string;
  }[];
};
export type LedgerTransaction = {
  id: string;
  kind: (typeof LEDGER_KINDS)[number];
  holdingId?: string;
  cashHoldingId: string;
  destinationCashHoldingId?: string;
  amount: string;
  currency: (typeof LEDGER_CURRENCIES)[number];
  amountEUR: number;
  fx?: LedgerFx;
  dueDate: string;
  source: LedgerSource;
  investmentEffect: 'none' | 'increase' | 'reduce';
  investmentAmount?: string;
  investmentCostBasisEUR: number;
  commitmentEffect: 'none' | 'reduce' | 'increase';
  commitmentAmountEUR: number;
  reviewedBy: string;
  reviewedAt: string;
  memo: string;
};
export type LedgerEvent = {
  id: string;
  transactionId: string;
  type: 'settled' | 'reversed' | 'voided';
  date: string;
  at: string;
  actorId: string;
  source: LedgerSource;
  reason: string;
  reversesEventId?: string;
  postings: {
    holdingId: string;
    nativeDelta: number;
    valueEURDelta: number;
    commitmentEURDelta: number;
    costBasisEURDelta: number;
  }[];
  externalFlowEUR: number;
};
export type ValuationRecord = {
  id: string;
  holdingId: string;
  amount: string;
  currency: (typeof LEDGER_CURRENCIES)[number];
  valueEUR: number;
  effectiveDate: string;
  sourceId: string;
  fx?: LedgerFx;
  actorId: string;
  recordedAt: string;
  valuationMethod: Holding['valuationMethod'];
  correctionOf?: string;
  correctionReason?: string;
  supersededValueEUR?: number;
};
export type CashflowCoverage = {
  id: string;
  familyId: string;
  entityId: string;
  from: string;
  to: string;
  cashHoldingIds: string[];
  source: LedgerSource;
  reviewedBy: string;
  reviewedAt: string;
  ledgerRevision: number;
  eventCount: number;
  valuationCount: number;
  closingBalances: { holdingId: string; amount: string; valueEUR: string }[];
  status: 'reconciled';
};
export type FinanceState = {
  version: 1;
  revision: number;
  entities: Record<
    string,
    { source: LedgerSource; reviewedBy: string; reviewedAt: string }
  >;
  holdings: Record<string, HoldingDetails>;
  accounts: Record<string, AccountDetails>;
  transactions: LedgerTransaction[];
  events: LedgerEvent[];
  valuations: ValuationRecord[];
  coverage: CashflowCoverage[];
  receipts: { key: string; digest: string; resultId: string; at: string }[];
};
export const emptyFinanceState = (): FinanceState => ({
  version: 1,
  revision: 0,
  entities: {},
  holdings: {},
  accounts: {},
  transactions: [],
  events: [],
  valuations: [],
  coverage: [],
  receipts: [],
});
const sourceFields = {
  source: ledgerSourceSchema,
  evidenceVerified: z.literal(true),
};
const financialAmount = {
  amount: ledgerMoney,
  currency: z.enum(LEDGER_CURRENCIES),
  fx: ledgerFxSchema.optional(),
};
const classSchema = z.enum([
  'Public equities',
  'Private equity',
  'Venture capital',
  'Real estate',
  'Fixed income',
  'Cash',
]);
export const ledgerCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('reviewAccount'),
      accountId: ledgerId,
      currency: z.enum(LEDGER_CURRENCIES),
      restricted: z.boolean(),
      restrictionNote: z.string().max(1000),
      ...sourceFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('createFamily'),
      name: ledgerLabel,
      principal: z.string().max(240).default(''),
      location: z.string().max(240).default(''),
    })
    .strict(),
  z
    .object({
      type: z.literal('createEntity'),
      familyId: ledgerId,
      name: ledgerLabel,
      entityType: z.enum(LEDGER_ENTITY_TYPES),
      jurisdiction: ledgerLabel,
      ownershipPercent: z.number().min(0).max(100),
      ...sourceFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('createAccount'),
      entityId: ledgerId,
      name: ledgerLabel,
      institution: ledgerLabel,
      accountType: z.enum(['Custody', 'Private investments', 'Property']),
      currency: z.enum(LEDGER_CURRENCIES),
      restricted: z.boolean(),
      restrictionNote: z.string().max(1000).default(''),
    })
    .strict(),
  z
    .object({
      type: z.literal('createHolding'),
      accountId: ledgerId,
      name: ledgerLabel,
      assetClass: classSchema,
      ...financialAmount,
      costBasisEUR: ledgerMoney,
      unfundedCommitmentEUR: ledgerMoney,
      valuationDate: ledgerDate,
      liquidityBucket: z.enum([
        'Daily',
        'Within 30 days',
        '1–3 years',
        '3+ years',
      ]),
      manager: ledgerLabel,
      managerId: ledgerId.optional(),
      instrumentId: ledgerId.optional(),
      shareClassId: ledgerId.optional(),
      geography: ledgerLabel,
      ...sourceFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('recordTransaction'),
      kind: z.enum(LEDGER_KINDS),
      holdingId: ledgerId.optional(),
      cashHoldingId: ledgerId,
      destinationCashHoldingId: ledgerId.optional(),
      ...financialAmount,
      dueDate: ledgerDate,
      investmentEffect: z.enum(['none', 'increase', 'reduce']),
      investmentAmount: ledgerMoney.optional(),
      investmentCostBasisEUR: ledgerMoney,
      commitmentEffect: z.enum(['none', 'reduce', 'increase']),
      commitmentAmountEUR: ledgerMoney,
      memo: z.string().max(1000).default(''),
      ...sourceFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('settleTransaction'),
      transactionId: ledgerId,
      date: ledgerDate,
      ...sourceFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('reverseTransaction'),
      transactionId: ledgerId,
      date: ledgerDate,
      reason: ledgerLabel,
      ...sourceFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('voidTransaction'),
      transactionId: ledgerId,
      reason: ledgerLabel,
      ...sourceFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('recordValuation'),
      holdingId: ledgerId,
      ...financialAmount,
      effectiveDate: ledgerDate,
      correction: z
        .object({
          expectedValueEUR: z.number().nonnegative().max(1e12),
          reason: ledgerLabel,
        })
        .strict()
        .optional(),
      ...sourceFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('reconcilePeriod'),
      entityId: ledgerId,
      from: ledgerDate,
      to: ledgerDate,
      cashHoldingIds: z.array(ledgerId).min(1).max(200),
      closingBalances: z
        .array(
          z
            .object({
              holdingId: ledgerId,
              amount: ledgerMoney,
              valueEUR: ledgerMoney,
            })
            .strict(),
        )
        .min(1)
        .max(200),
      ...sourceFields,
    })
    .strict(),
]);
export type LedgerCommand = z.infer<typeof ledgerCommandSchema>;
export const ledgerRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.uuid(),
    command: ledgerCommandSchema,
  })
  .strict();
export type LedgerRequest = z.infer<typeof ledgerRequestSchema>;
export type LedgerResponse = {
  finance: FinanceState;
  portfolio: PortfolioRecords;
  revision: number;
  canWrite: boolean;
  resultId?: string;
  duplicate?: boolean;
};
export type ReviewedValuationInput = {
  holdingId: string;
  amount: string;
  currency: (typeof LEDGER_CURRENCIES)[number];
  effectiveDate: string;
  sourceId: string;
  valuationMethod?: Holding['valuationMethod'];
  fx?: LedgerFx;
  correction?: { expectedValueEUR: number; reason: string };
};
