import { z } from 'zod';
import type { EngineSnapshot } from './engine-contract';
import type { ProcessingMode } from './processing-contract';
const id = z.string().min(1).max(160);
const text = z.string().trim().min(1).max(240);
export const intelligenceDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
      new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v,
  );
export const citationSchema = z
  .object({
    documentId: z.uuid(),
    page: z.number().int().min(1).max(40),
    quote: z.string().min(1).max(3000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.string().max(240),
  })
  .strict();
export type SourceCitation = z.infer<typeof citationSchema>;
export const issuerAliasSchema = z
  .object({ id, name: text, aliases: z.array(text).max(30) })
  .strict();
export type IssuerAlias = z.infer<typeof issuerAliasSchema>;
export const constituentProposalSchema = z
  .object({
    id,
    holdingId: id,
    issuerName: text,
    issuerId: id.nullable(),
    weight: z.number().min(0).max(1).nullable(),
    asOfDate: intelligenceDate.nullable(),
    citation: citationSchema,
    status: z.enum(['pending', 'accepted', 'rejected']),
    createdAt: z.string(),
    reviewedAt: z.string().nullable(),
  })
  .strict();
export type ConstituentProposal = z.infer<typeof constituentProposalSchema>;
export const relationshipSchema = z
  .object({
    id,
    name: text,
    familyId: id.nullable(),
    holdingId: id.nullable(),
    managerId: id.nullable(),
    email: z.email().max(240).or(z.literal('')),
    notes: z.string().max(3000),
    updatedAt: z.string(),
  })
  .strict();
export type RelationshipRecord = z.infer<typeof relationshipSchema>;
export type Manager = RelationshipRecord;
export type Contact = RelationshipRecord;
export type Mandate = RelationshipRecord;
export const dealSchema = relationshipSchema
  .extend({
    stage: z.enum(['Watching', 'Diligence', 'Decision', 'Passed']),
    issuerIds: z.array(id).max(30),
    targetEUR: z.number().min(0).max(1e12).nullable(),
  })
  .strict();
export type ProspectiveDeal = z.infer<typeof dealSchema>;
export const draftSchema = z
  .object({
    id,
    contactId: id.nullable(),
    familyId: id.nullable(),
    holdingId: id.nullable(),
    subject: text,
    body: z.string().min(1).max(6000),
    status: z.literal('draft'),
    updatedAt: z.string(),
  })
  .strict();
export type FollowupDraft = z.infer<typeof draftSchema>;
export const intelligenceStateSchema = z
  .object({
    version: z.literal(1),
    aliases: z.array(issuerAliasSchema).max(300),
    proposals: z.array(constituentProposalSchema).max(500),
    managers: z.array(relationshipSchema).max(200),
    contacts: z.array(relationshipSchema).max(300),
    mandates: z.array(relationshipSchema).max(200),
    deals: z.array(dealSchema).max(200),
    drafts: z.array(draftSchema).max(300),
  })
  .strict();
export type IntelligenceState = z.infer<typeof intelligenceStateSchema>;
export const emptyIntelligence = (): IntelligenceState => ({
  version: 1,
  aliases: [],
  proposals: [],
  managers: [],
  contacts: [],
  mandates: [],
  deals: [],
  drafts: [],
});
export type SourcePage = { number: number; text: string; source: string };
export type IndexedDocument = {
  documentId: string;
  filename: string;
  contentHash: string;
  indexedAt: string;
  pages: SourcePage[];
  warnings: string[];
};
export type SearchHit = {
  id: string;
  documentId: string;
  filename: string;
  page: number;
  source: string;
  quote: string;
  contentHash: string;
  score: number;
};
export type IntelligenceCoverage = {
  indexedDocuments: number;
  searchedDocuments: number;
  indexedPages: number;
  searchedPages: number;
  documentLimit: number;
  characterLimit: number;
  scannedCharacters: number;
  encryptedByteLimit?: number;
  scannedEncryptedBytes?: number;
  truncated: boolean;
  warnings: string[];
};
export type IntelligenceResponse = {
  state: IntelligenceState;
  canWrite: boolean;
  canReview: boolean;
  documents: {
    id: string;
    filename: string;
    indexed: boolean;
    indexedAt: string | null;
    pageCount: number | null;
  }[];
  documentListTruncated: boolean;
  engine: EngineSnapshot;
  mode: ProcessingMode;
};
export type SearchResponse = {
  hits: SearchHit[];
  coverage: IntelligenceCoverage;
};
export type Calculation = {
  liquidityCoverage?: {
    knownHoldingCount: number;
    totalHoldingCount: number;
    complete: boolean;
    unknownHoldingIds: string[];
  };
  coverage?: {
    knownHoldingCount: number;
    totalHoldingCount: number;
    complete: boolean;
    unknownHoldingIds: string[];
  };
  id: string;
  label: string;
  valueEUR: number;
  holdingIds: string[];
  basis: string;
  asOfDate: string | null;
};
export type KnowledgeAnswer = {
  mode: ProcessingMode;
  engine: EngineSnapshot;
  modelCalls: number;
  status: 'answered' | 'insufficient_evidence' | 'model_unavailable';
  citations: SearchHit[];
  calculations: Calculation[];
  coverage: IntelligenceCoverage;
  warnings: string[];
  trace: { stage: string; detail: string }[];
};
export const intelligenceCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('alias'), value: issuerAliasSchema }).strict(),
  z
    .object({
      action: z.literal('record'),
      collection: z.enum(['managers', 'contacts', 'mandates']),
      value: relationshipSchema,
    })
    .strict(),
  z.object({ action: z.literal('deal'), value: dealSchema }).strict(),
  z.object({ action: z.literal('draft'), value: draftSchema }).strict(),
  z
    .object({
      action: z.literal('delete'),
      collection: z.enum([
        'managers',
        'contacts',
        'mandates',
        'deals',
        'drafts',
      ]),
      id,
    })
    .strict(),
  z
    .object({
      action: z.literal('propose'),
      documentId: z.uuid(),
      holdingId: id,
    })
    .strict(),
  z
    .object({
      action: z.literal('review'),
      proposalId: id,
      decision: z.enum(['accept', 'reject']),
      issuerId: id.optional(),
    })
    .strict(),
]);
export type IntelligenceCommand = z.infer<typeof intelligenceCommandSchema>;
