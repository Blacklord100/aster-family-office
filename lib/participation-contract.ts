import { z } from 'zod';
import { ledgerDate, ledgerId, ledgerLabel } from './ledger-contract';
import {
  PortfolioHistoryQuerySchema,
  type PortfolioHistoryQuery,
} from './portfolio-history-contract';

export const PARTICIPATION_LIMITS = {
  maxInvestments: 200,
  maxRecords: 2000,
  truncated: false as const,
};
export const investmentIdentitySchema = z
  .object({
    name: ledgerLabel,
    manager: ledgerLabel,
    vehicle: ledgerLabel,
    shareClass: ledgerLabel,
    round: ledgerLabel,
    identifier: ledgerLabel.optional(),
  })
  .strict();
export type InvestmentIdentity = z.infer<typeof investmentIdentitySchema>;
export type SharedInvestment = { id: string; identity: InvestmentIdentity };
const evidence = {
  holdingId: ledgerId,
  effectiveDate: ledgerDate,
  sourceId: ledgerId,
  evidenceVerified: z.literal(true),
  page: z.number().int().min(1).max(10000),
  quote: z.string().trim().min(10).max(6000),
  reason: z.string().trim().min(10).max(2000),
  correctionOf: ledgerId.optional(),
};
export const participationCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...evidence,
      kind: z.literal('link'),
      investmentId: ledgerId.optional(),
      newInvestment: investmentIdentitySchema.optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (Boolean(v.investmentId) === Boolean(v.newInvestment))
        ctx.addIssue({
          code: 'custom',
          message:
            'Choose an existing investment or explicitly register a new identity.',
          path: ['investmentId'],
        });
    }),
  z.object({ ...evidence, kind: z.literal('unlink') }).strict(),
  z
    .object({
      ...evidence,
      kind: z.literal('ownership'),
      percent: z
        .string()
        .regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/)
        .refine((v) => Number(v) <= 100),
      ownershipBasis: ledgerLabel,
    })
    .strict(),
]);
export type ParticipationCommand = z.infer<typeof participationCommandSchema>;
export type ParticipationRecord = {
  id: string;
  holdingId: string;
  familyId: string;
  entityId: string;
  kind: ParticipationCommand['kind'];
  investmentId: string;
  /** Ownership declarations belong to one explicit link, never a name match. */
  linkId: string;
  effectiveDate: string;
  recordedAt: string;
  actorId: string;
  sourceId: string;
  documentId: string;
  sourceSha256: string;
  page: number;
  quote: string;
  reason: string;
  correctionOf: string | null;
  percent: string | null;
  ownershipBasis: string | null;
};
export type ParticipationState = {
  version: 1;
  revision: number;
  investments: SharedInvestment[];
  records: ParticipationRecord[];
  receipts: { key: string; digest: string; resultId: string }[];
};
export const emptyParticipation = (): ParticipationState => ({
  version: 1,
  revision: 0,
  investments: [],
  records: [],
  receipts: [],
});
export const ParticipationQuerySchema = PortfolioHistoryQuerySchema;
export type ParticipationQuery = PortfolioHistoryQuery;
export const participationRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.uuid(),
    command: participationCommandSchema,
  })
  .strict();
export type ParticipationRequest = z.infer<typeof participationRequestSchema>;
export type ParticipationWriteResponse = {
  revision: number;
  participationRevision: number;
  resultId: string;
  duplicate?: boolean;
};
export type ParticipationCoverage = {
  knownCount: number;
  totalCount: number;
  complete: boolean;
};
export type ParticipationPosition = {
  holdingId: string;
  name: string;
  familyId: string;
  familyName: string;
  entityId: string;
  entityName: string;
  accountId: string;
  accountName: string;
  nav: string | null;
  valuationDate: string | null;
  valuationSourceId: string | null;
  ownership: 'owned' | 'unknown';
  linkId: string | null;
  investmentId: string | null;
  sourceId: string | null;
  effectiveDate: string | null;
  actualOwnershipPercent: string | null;
  ownershipSourceId: string | null;
  ownershipEffectiveDate: string | null;
  ownershipBasis: string | null;
};
export type ParticipationFamily = {
  familyId: string;
  name: string;
  color: string;
  portfolioNAV: string | null;
  portfolioKnownNAV: string | null;
  coverage: ParticipationCoverage;
};
export type InvestmentFamilyParticipation = ParticipationFamily & {
  nav: string | null;
  knownNAV: string | null;
  shareOfKnownNAV: number | null;
  portfolioWeight: number | null;
  /** Coverage of this investment's positions; family denominator has its own coverage. */
  investmentCoverage: ParticipationCoverage;
  positions: ParticipationPosition[];
};
export type InvestmentParticipation = SharedInvestment & {
  nav: string | null;
  knownNAV: string | null;
  coverage: ParticipationCoverage;
  familyCount: number;
  positionCount: number;
  families: InvestmentFamilyParticipation[];
  positions: ParticipationPosition[];
};
export type ParticipationResponse = {
  query: ParticipationQuery;
  revision: number;
  participationRevision: number;
  asOf: string;
  currency: ParticipationQuery['currency'];
  canWrite: boolean;
  denominatorLabel: 'Visible selected recorded NAV';
  investments: InvestmentParticipation[];
  catalog: SharedInvestment[];
  families: ParticipationFamily[];
  unlinked: ParticipationPosition[];
  records: ParticipationRecord[];
  gaps: string[];
  limits: typeof PARTICIPATION_LIMITS;
};
