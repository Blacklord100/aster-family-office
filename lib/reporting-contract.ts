import { z } from 'zod';
import type { Holding, EvidenceSource } from '@/data/types';
import {
  LEDGER_CURRENCIES,
  ledgerDate,
  ledgerId,
  ledgerLabel,
  type FinanceState,
  type LedgerSource,
} from './ledger-contract';
import {
  riskScenarioSchema,
  type RiskData,
  type TotalExposure,
  type StressResult,
} from './risk-contract';
import type { PortfolioRecords } from './workspace';
const ids = z
  .array(ledgerId)
  .min(1)
  .max(200)
  .refine(
    (values) => new Set(values).size === values.length,
    'Select each scope once.',
  );
export const reportingScopeSchema = z
  .object({ familyIds: ids, entityIds: ids.optional() })
  .strict();
export type ReportingScope = z.infer<typeof reportingScopeSchema>;
export const periodQuerySchema = reportingScopeSchema
  .extend({
    from: ledgerDate,
    to: ledgerDate,
    liquidityAsOf: ledgerDate,
    liquidityThrough: ledgerDate,
    liquidityCurrencies: z
      .array(z.enum(LEDGER_CURRENCIES))
      .min(1)
      .max(4)
      .optional(),
  })
  .strict();
export type PeriodQuery = z.infer<typeof periodQuerySchema>;
export type SourcedMark = {
  holdingId: string;
  date: string;
  valueEUR: number;
  amount: number;
  currency: Holding['currency'];
  sourceId?: string;
  source: LedgerSource;
  basis: string;
};
export type PeriodHolding = {
  holdingId: string;
  name: string;
  entityId: string;
  assetClass: Holding['assetClass'];
  opening: SourcedMark | null;
  closing: SourcedMark | null;
  changeEUR: number | null;
};
export type PeriodFlow = {
  eventId: string;
  transactionId: string;
  date: string;
  kind: string;
  amountEUR: number;
  source: LedgerSource;
};
export type CashReconciliation = {
  holdingId: string;
  name: string;
  entityId: string;
  currency: Holding['currency'];
  openingNative: number | null;
  closingNative: number | null;
  recordedMovementsNative: number;
  residualNative: number | null;
  coverageId: string | null;
};
export type LiquidityGroup = {
  entityId: string;
  entityName: string;
  currency: Holding['currency'];
  recordedCashNative: number;
  restrictedCashNative: number;
  restrictionUnknownCashNative: number;
  restrictionUnknownAccountCount: number;
  liquidityUnknownHoldingCount: number;
  unavailableBalanceCount: number;
  reviewedInflowsNative: number;
  reviewedOutflowsNative: number;
  overdueOutflowsNative: number;
  blockedObligationCount: number;
  projectedAvailableNative: number | null;
  obligations: {
    transactionId: string;
    name: string;
    date: string;
    nativeChange: number;
    source: LedgerSource;
  }[];
  cashAsOfDates: string[];
};
export type PeriodReport = {
  query: PeriodQuery;
  evaluatedAt: string;
  holdings: PeriodHolding[];
  holdingCount: number;
  openingValueEUR: number | null;
  closingValueEUR: number | null;
  knownOpeningValueEUR: number;
  knownClosingValueEUR: number;
  valueChangeEUR: number | null;
  knownExternalFlowEUR: number;
  netExternalFlowEUR: number | null;
  investmentResultEUR: number | null;
  flows: PeriodFlow[];
  cashReconciliation: CashReconciliation[];
  returnEstimate: {
    method: 'Modified Dietz · end-of-day flows';
    valuePercent: number | null;
    denominatorEUR: number | null;
    reason: string;
    methodologyUrl: string;
  };
  gaps: string[];
  liquidity: LiquidityGroup[];
  assumptions: string[];
};
type SnapshotBase = {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  workspaceRevision: number;
  financeRevision: number;
  inputDigest: string;
  resultDigest: string;
};
export type PeriodSnapshot = SnapshotBase & {
  kind: 'period';
  inputs: {
    query: PeriodQuery;
    portfolio: PortfolioRecords;
    finance: FinanceState;
  };
  result: PeriodReport;
};
export type StressSnapshot = SnapshotBase & {
  kind: 'stress';
  inputs: {
    scope: ReportingScope;
    holdings: Holding[];
    evidence: EvidenceSource[];
    riskData: RiskData;
    scenario: z.infer<typeof riskScenarioSchema>;
    asOfDate: string;
  };
  result: { exposure: TotalExposure; stress: StressResult };
};
export type ReportingSnapshot = PeriodSnapshot | StressSnapshot;
export type SnapshotSummary = Omit<
  SnapshotBase,
  'inputDigest' | 'resultDigest'
> & {
  kind: ReportingSnapshot['kind'];
  familyIds: string[];
  entityIds: string[];
  integrity: 'verified' | 'changed';
};
export type ReportingState = {
  version: 1;
  snapshots: ReportingSnapshot[];
  receipts: { key: string; digest: string; resultId: string }[];
};
export const emptyReportingState = (): ReportingState => ({
  version: 1,
  snapshots: [],
  receipts: [],
});
const write = {
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.uuid(),
  name: ledgerLabel,
};
export const reportingRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('savePeriod'),
      ...write,
      query: periodQuerySchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('saveStress'),
      ...write,
      scope: reportingScopeSchema,
      scenario: riskScenarioSchema,
    })
    .strict(),
]);
export type ReportingRequest = z.infer<typeof reportingRequestSchema>;
export type ReportingResponse = {
  revision: number;
  canWrite: boolean;
  period?: PeriodReport;
  snapshots: SnapshotSummary[];
  snapshot?: ReportingSnapshot;
  resultId?: string;
  duplicate?: boolean;
};
