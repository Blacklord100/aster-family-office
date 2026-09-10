import { z } from 'zod';
import { ledgerDate } from './ledger-contract';
export const HISTORY_PROJECTION_VERSION = 'portfolio-history/1' as const;
const currency = z.enum(['EUR', 'USD', 'GBP', 'CHF']);
const ids = z
  .array(z.string().min(1).max(200))
  .min(1)
  .max(200)
  .refine((value) => new Set(value).size === value.length);
export const PortfolioHistoryQuerySchema = z
  .object({
    observationId: z.string().min(1).max(200).optional(),
    holdingIds: ids.optional(),
    familyIds: ids.optional(),
    entityIds: ids.optional(),
    from: ledgerDate.optional(),
    to: ledgerDate.optional(),
    asOf: ledgerDate.optional(),
    cohort: z.enum(['current', 'historical']).default('current'),
    knowledge: z.enum(['restated', 'as_known']).default('restated'),
    knownAt: z.iso.datetime({ offset: true }).optional(),
    currency: currency.default('EUR'),
    sourceCurrency: currency.optional(),
    includeSuperseded: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.knowledge === 'as_known' && !query.knownAt)
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a knowledge cutoff.',
        path: ['knownAt'],
      });
    if (query.knowledge === 'restated' && query.knownAt)
      ctx.addIssue({
        code: 'custom',
        message: 'A cutoff requires as-known mode.',
        path: ['knownAt'],
      });
    if (query.from && query.to && query.from > query.to)
      ctx.addIssue({
        code: 'custom',
        message: 'The end date precedes the start date.',
        path: ['to'],
      });
  });
export type PortfolioHistoryQuery = z.infer<typeof PortfolioHistoryQuerySchema>;
export type HistoryCoverage = {
  knownCount: number;
  unknownCount: number;
  totalCount: number;
  complete: boolean;
  carriedCount: number;
  unavailableCurrencyCount: number;
};
export type HistoryObservation = {
  id: string;
  holdingId: string;
  investmentName: string;
  familyId: string;
  entityId: string;
  effectiveDate: string;
  recordedAt: string | null;
  importedAt: string | null;
  reportDate: string | null;
  messageTimestamp: string | null;
  nativeAmount: string | null;
  currency: 'EUR' | 'USD' | 'GBP' | 'CHF' | null;
  valueEUR: string | null;
  amount: string | null;
  displayCurrency: PortfolioHistoryQuery['currency'];
  fx: { rateToEUR: string; date: string; source: string } | null;
  sourceId: string | null;
  documentId: string | null;
  filename: string | null;
  page: number | null;
  quote: string | null;
  provenance: 'accepted_source' | 'legacy_unverified';
  dateBasis: 'recorded_effective_date';
  status: 'current' | 'superseded' | 'conflicted' | 'legacy';
  version: number;
  correctionOf: string | null;
  correctionReason: string | null;
  supersededBy: string | null;
  valuationBasis: string;
  previousObservationId: string | null;
  changeAmount: string | null;
  changePercent: number | null;
};
export type HistoryPoint = {
  date: string;
  timestamp: number;
  amount: string | null;
  knownAmount: string | null;
  currency: PortfolioHistoryQuery['currency'];
  coverage: HistoryCoverage;
  observationIds: string[];
  basis:
    | 'Latest accepted marks of selected current holdings'
    | 'Latest accepted marks of sourced historical positions; unknown ownership retained';
};
export type HistoryPosition = {
  holdingId: string;
  investmentName: string;
  familyId: string;
  entityId: string;
  latest: HistoryObservation | null;
  /** Last accepted mark before asOf, independent of ownership; never a current balance after exit. */
  latestReported: HistoryObservation | null;
  previousComparable: HistoryObservation | null;
  changeAmount: string | null;
  changePercent: number | null;
  firstObservedDate: string | null;
  economicOpenedAt: string | null;
  economicClosedAt: string | null;
  lifecycleCoverage: 'unknown' | 'sourced';
  ownership: 'unknown' | 'owned' | 'not_yet_opened' | 'closed';
  metadata: import('./portfolio-history-lifecycle-contract').HistoryPositionDetails;
  metadataBasis: 'current_register' | 'sourced_effective_details';
};
export type HistoryComparison = {
  from: string | null;
  to: string | null;
  opening: HistoryPoint | null;
  closing: HistoryPoint | null;
  changeAmount: string | null;
  comparable: {
    holdingIds: string[];
    holdingCount: number;
    openingAmount: string | null;
    closingAmount: string | null;
    changeAmount: string | null;
    changePercent: number | null;
  };
  investmentReturn: null;
  basis: 'Change in reported value; not investment return';
};
export type PortfolioHistoryResponse = {
  query: PortfolioHistoryQuery;
  revision: number;
  financeRevision: number;
  projectionVersion: typeof HISTORY_PROJECTION_VERSION;
  asOf: string;
  summary: HistoryPoint;
  selectedObservation: HistoryObservation | null;
  selectedOffset: number | null;
  observations: HistoryObservation[];
  positions: HistoryPosition[];
  points: HistoryPoint[];
  page: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
  comparison: HistoryComparison;
  coverage: HistoryCoverage;
  gaps: string[];
  lifecycleRevision: number;
  basis:
    | 'History of selected current holdings; historical ownership is not established'
    | 'Historical positions from sourced lifecycle; unresolved ownership remains included';
  limits: {
    maxHoldings: number;
    maxObservations: number;
    maxWorkspaceBytes: number;
    truncated: false;
  };
};
