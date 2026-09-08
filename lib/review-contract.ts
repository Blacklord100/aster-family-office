import { z } from 'zod';
import {
  FactSchema,
  type Extraction,
  type ExtractedFact,
} from './processing-contract';
import { ledgerFxSchema } from './ledger-contract';

export const ReviewedFXSchema = ledgerFxSchema;
export const ReviewDecisionSchema = z
  .object({
    factIndex: z.number().int().min(0).max(99),
    status: z.enum(['pending', 'accepted', 'deferred', 'rejected']),
    holdingId: z.string().min(1).max(200).nullable(),
    amendedFact: FactSchema.optional(),
    rationale: z.string().trim().max(2000).default(''),
    evidenceVerified: z.boolean().default(false),
    fx: ReviewedFXSchema.optional(),
    correction: z
      .object({
        expectedValueEUR: z.number().min(0).max(1e12),
        reason: z.string().trim().min(5).max(2000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (
      decision.status === 'accepted' &&
      (!decision.holdingId || !decision.evidenceVerified)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Acceptance requires an investment link and verification against the original source.',
      });
    if (
      (decision.amendedFact ||
        ['rejected', 'deferred'].includes(decision.status)) &&
      decision.rationale.length < 5
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Explain the amendment, rejection, or deferral in at least five characters.',
      });
  });
export const ReviewRequestSchema = z
  .object({
    action: z.literal('review'),
    expectedRevision: z.number().int().min(0),
    decisions: z
      .array(ReviewDecisionSchema)
      .min(1)
      .max(100)
      .refine(
        (items) => new Set(items.map((i) => i.factIndex)).size === items.length,
      ),
  })
  .strict();
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export type ReviewedFX = z.infer<typeof ReviewedFXSchema>;
export type FactReview = Omit<ReviewDecision, 'status'> & {
  status: ReviewDecision['status'] | 'legacy';
  version: number;
  reviewedAt: string | null;
  reviewedBy: string | null;
  sourceId?: string;
};
export type ReviewVersion = {
  revision: number;
  at: string;
  actorId: string;
  decisions: FactReview[];
};
export type ReviewState = {
  revision: number;
  extractionHash: string;
  facts: FactReview[];
  history: ReviewVersion[];
};
export function initialReview(
  result: Extraction,
  extractionHash: string,
  jobStatus: string,
): ReviewState {
  return {
    revision: 0,
    extractionHash,
    history: [],
    facts: result.facts.map((_, factIndex) => ({
      factIndex,
      status:
        jobStatus === 'accepted'
          ? 'legacy'
          : jobStatus === 'rejected'
            ? 'rejected'
            : 'pending',
      holdingId: null,
      rationale: '',
      evidenceVerified: false,
      version: 0,
      reviewedAt: null,
      reviewedBy: null,
    })),
  };
}
export function reviewedFact(
  original: ExtractedFact,
  review?: Pick<FactReview, 'amendedFact'>,
): ExtractedFact {
  return review?.amendedFact ?? original;
}
export function reviewJobStatus(
  facts: Pick<FactReview, 'status'>[],
): 'awaiting_review' | 'accepted' | 'rejected' {
  if (
    facts.some(
      (fact) => fact.status === 'pending' || fact.status === 'deferred',
    )
  )
    return 'awaiting_review';
  return facts.some(
    (fact) => fact.status === 'accepted' || fact.status === 'legacy',
  )
    ? 'accepted'
    : 'rejected';
}
