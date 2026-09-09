import 'server-only';
import type { PoolClient } from 'pg';
import type { Holding } from '@/data/types';
import type { RiskData } from '../risk-contract';
import type { ExtractedFact } from '../processing-contract';
import {
  constituentProposalSchema,
  intelligenceDate,
  type ConstituentProposal,
  type IndexedDocument,
} from '../intelligence-contract';
import { validateCitation } from '../intelligence';
import type { WorkspaceContext } from './access';
import type { DemoCatalog } from './demo-corpus';
import { hasDemoSourceVerification } from './demo-review-policy';
import { loadIndexedDocument } from './intelligence-store';
import { decrypt, sha256 } from './crypto';

const key = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
type ParentHolding = Pick<Holding, 'id' | 'name' | 'familyId'>;
export type DemoNewsRoute = {
  holdingId: string;
  proposalId: string;
  disclosureDocumentId: string;
  disclosureAsOfDate: string;
};

function eligibleProposals(
  fact: ExtractedFact,
  familyId: string,
  holdings: ParentHolding[],
  proposals: ConstituentProposal[],
) {
  if (
    fact.kind !== 'news' ||
    proposals.length > 500 ||
    (fact.effectiveDate !== null &&
      !intelligenceDate.safeParse(fact.effectiveDate).success)
  )
    return [];
  return proposals.filter((proposal) => {
    const parent = holdings.find(
      (holding) => holding.id === proposal.holdingId,
    );
    return (
      proposal.status === 'accepted' &&
      !!proposal.reviewedAt &&
      Number.isFinite(Date.parse(proposal.reviewedAt)) &&
      !!proposal.asOfDate &&
      intelligenceDate.safeParse(proposal.asOfDate).success &&
      (!fact.effectiveDate || proposal.asOfDate <= fact.effectiveDate) &&
      key(proposal.issuerName) === key(fact.investmentName) &&
      parent?.familyId === familyId
    );
  });
}

/** Exact accepted relationships may contextualize news without changing its subject. */
export function resolveDemoNewsHolding(
  fact: ExtractedFact,
  familyId: string,
  holdings: ParentHolding[],
  proposals: ConstituentProposal[],
  disclosures: IndexedDocument[],
  risk: RiskData | undefined,
): DemoNewsRoute | null {
  const eligible = eligibleProposals(fact, familyId, holdings, proposals);
  // An incomplete second accepted mapping must not silently select the first parent.
  if (new Set(eligible.map((proposal) => proposal.holdingId)).size !== 1)
    return null;
  for (const candidate of [...eligible].sort(
    (a, b) =>
      b.asOfDate!.localeCompare(a.asOfDate!) || a.id.localeCompare(b.id),
  )) {
    const parsed = constituentProposalSchema.safeParse(candidate);
    if (!parsed.success || !candidate.issuerId) continue;
    const disclosure = disclosures.find(
      (document) => document.documentId === candidate.citation.documentId,
    );
    if (!disclosure || disclosure.warnings.length) continue;
    try {
      validateCitation(candidate, disclosure);
    } catch {
      continue;
    }
    if (!key(candidate.citation.quote).includes(key(fact.investmentName)))
      continue;
    const position = risk?.positions.find(
      (item) => item.holdingId === candidate.holdingId,
    );
    if (
      !position ||
      !risk?.links.some((link) => {
        const issuer = risk.nodes.find((node) => node.id === link.childId);
        return (
          link.parentId === position.nodeId &&
          link.sourceId === 'intelligence-' + candidate.id &&
          link.asOfDate === candidate.asOfDate &&
          issuer?.issuerId === candidate.issuerId &&
          key(issuer.issuerName ?? issuer.name) === key(candidate.issuerName)
        );
      })
    )
      continue;
    return {
      holdingId: candidate.holdingId,
      proposalId: candidate.id,
      disclosureDocumentId: candidate.citation.documentId,
      disclosureAsOfDate: candidate.asOfDate!,
    };
  }
  return null;
}

/** Load only checksum-verified synthetic disclosures; no model/provider access. */
export async function resolveDemoNewsHoldingInTransaction(
  c: PoolClient,
  ctx: WorkspaceContext,
  fact: ExtractedFact,
  familyId: string,
  holdings: ParentHolding[],
  proposals: ConstituentProposal[],
  risk: RiskData | undefined,
  catalog: DemoCatalog,
): Promise<DemoNewsRoute | null> {
  const candidates = eligibleProposals(fact, familyId, holdings, proposals);
  if (new Set(candidates.map((proposal) => proposal.holdingId)).size !== 1)
    return null;
  const ids = [...new Set(candidates.map((item) => item.citation?.documentId))];
  if (!ids.length || ids.length > 20 || ids.some((id) => !id)) return null;
  const disclosures: IndexedDocument[] = [];
  for (const id of ids) {
    if (!(await hasDemoSourceVerification(c, ctx, id))) continue;
    const row = (
      await c.query<{ content_hash: string; payload: Buffer }>(
        'SELECT content_hash,payload FROM app_documents WHERE organization_id=$1 AND id=$2',
        [ctx.organizationId, id],
      )
    ).rows[0];
    if (!row) continue;
    const sourceFamilies = new Set(
      catalog.documents
        .filter((source) => source.sha256 === row.content_hash)
        .map((source) => source.office_id),
    );
    if (sourceFamilies.size !== 1 || !sourceFamilies.has(familyId)) continue;
    if (
      sha256(
        decrypt(row.payload, 'document:' + ctx.organizationId + ':' + id),
      ) !== row.content_hash
    )
      throw new Error('DEMO_NEWS_DISCLOSURE_CHANGED');
    const indexed = await loadIndexedDocument(c, ctx, id);
    if (indexed.contentHash !== row.content_hash)
      throw new Error('DEMO_NEWS_DISCLOSURE_INDEX_CHANGED');
    disclosures.push(indexed);
  }
  return resolveDemoNewsHolding(
    fact,
    familyId,
    holdings,
    proposals,
    disclosures,
    risk,
  );
}
