import 'server-only';
import type { Holding } from '@/data/types';
import type { PoolClient } from 'pg';
import type { WorkspaceContext } from './access';
import { AccessError } from './access';
import { audit } from './audit';
import { decrypt, sha256 } from './crypto';
import { pool, withTenant } from './db';
import { demoActorId, loadDemoCatalog, type DemoCatalog } from './demo-corpus';
import { hasDemoSourceVerification } from './demo-review-policy';
import { indexDocument, loadIndexedDocument } from './intelligence-store';
import { readWorkspaceInTransaction, saveWorkspace } from '../workspace-store';
import { deriveWorkspace } from '../workspace';
import {
  acceptConstituent,
  constituentProposals,
  IntelligenceError,
  issuerKey,
  resolveIssuer,
  validateCitation,
  withRecordedIssuers,
} from '../intelligence';
import {
  emptyIntelligence,
  intelligenceDate,
  intelligenceStateSchema,
  type ConstituentProposal,
  type IndexedDocument,
  type IssuerAlias,
} from '../intelligence-contract';

const normalize = (text: string) =>
  text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const monthNames = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
function disclosedDate(text: string): string | null {
  const match = text.match(
    /\bas (?:of|at)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\s+[a-zA-Z]+\s+\d{4})(?:\b|$)/i,
  );
  if (!match) return null;
  let value = match[1];
  if (!/^\d{4}-/.test(value)) {
    const [day, month, year] = value.toLowerCase().split(/\s+/);
    const index = monthNames.indexOf(month);
    if (index < 0) return null;
    value =
      year +
      '-' +
      String(index + 1).padStart(2, '0') +
      '-' +
      day.padStart(2, '0');
  }
  return intelligenceDate.safeParse(value).success ? value : null;
}
function pageNamesParent(text: string, name: string) {
  const key = normalize(name);
  return text.split('\n').some((line) => {
    const value = normalize(line);
    return (
      value.startsWith(key + ':') ||
      value === 'fund: ' + key ||
      value === 'investment: ' + key
    );
  });
}
/** Decoded vertical tables remain verbatim citations. No undisclosed residual is assigned. */
function verticalRows(
  doc: IndexedDocument,
  holdingId: string,
  aliases: IssuerAlias[],
  now: string,
): ConstituentProposal[] {
  const proposals: ConstituentProposal[] = [];
  for (const page of doc.pages) {
    const lines = [...page.text.matchAll(/[^\n]+/g)];
    for (let index = 0; index < lines.length; index++) {
      const heading = lines[index];
      if (
        !/^(?:current|actual|reported)\s+(?:underlying investments|underlying holdings|portfolio companies|portfolio holdings|constituents)\s+as (?:of|at)\b/i.test(
          heading[0].trim(),
        )
      )
        continue;
      const asOfDate = disclosedDate(heading[0]);
      if (!asOfDate) continue;
      let header = -1;
      for (let n = index + 1; n <= Math.min(index + 4, lines.length - 2); n++) {
        if (
          /^underlying issuer$/i.test(lines[n][0].trim()) &&
          /^share of fund nav$/i.test(lines[n + 1][0].trim())
        ) {
          header = n + 2;
          break;
        }
      }
      if (header < 0) continue;
      for (let n = header; n + 1 < lines.length; n += 2) {
        const name = lines[n][0].trim(),
          value = lines[n + 1][0].trim();
        if (
          !/^[\p{L}\p{N}][\p{L}\p{N}\s&.,'()/-]{1,199}$/u.test(name) ||
          /\b(?:not held|withdrawn|superseded|watchlist|prospective|example|hypothetical)\b/i.test(
            name,
          )
        )
          break;
        if (
          !/^(?:\d{1,3}(?:\.\d{1,4})?\s*%|unknown|undisclosed|not disclosed|n\/a|—)$/i.test(
            value,
          )
        )
          break;
        const weight = value.includes('%')
          ? Number(value.replace(/[\s%]/g, '')) / 100
          : null;
        if (weight !== null && (!Number.isFinite(weight) || weight > 1)) break;
        const quote = page.text.slice(
          heading.index,
          lines[n + 1].index + lines[n + 1][0].length,
        );
        if (quote.length > 3000) break;
        proposals.push({
          id:
            'demo-constituent-' +
            sha256(
              [doc.documentId, holdingId, page.number, name, quote].join(':'),
            ),
          holdingId,
          issuerName: name,
          issuerId: resolveIssuer(name, aliases)?.id ?? null,
          weight,
          asOfDate,
          citation: {
            documentId: doc.documentId,
            page: page.number,
            quote,
            source: page.source,
            contentHash: doc.contentHash,
          },
          status: 'pending',
          createdAt: now,
          reviewedAt: null,
        });
        if (proposals.length >= 50) return proposals;
      }
    }
  }
  return proposals;
}
/** Restrict attribution to the unique exact parent named on the same decoded page. */
export function demoConstituentProposals(
  doc: IndexedDocument,
  familyId: string,
  holdings: Pick<Holding, 'id' | 'name' | 'familyId'>[],
  aliases: IssuerAlias[],
  now = new Date().toISOString(),
): ConstituentProposal[] {
  const output: ConstituentProposal[] = [];
  for (const page of doc.pages) {
    const named = holdings.filter((holding) =>
      pageNamesParent(page.text, holding.name),
    );
    if (named.length !== 1 || named[0].familyId !== familyId) continue;
    const pageDoc = { ...doc, pages: [page] };
    const ordinary = constituentProposals(pageDoc, named[0].id, aliases, now);
    const rows = [
      ...ordinary,
      ...verticalRows(pageDoc, named[0].id, aliases, now),
    ];
    for (const row of rows) {
      if (
        output.some(
          (old) =>
            old.holdingId === row.holdingId &&
            old.issuerName === row.issuerName &&
            old.citation.page === row.citation.page &&
            old.weight === row.weight &&
            old.asOfDate === row.asOfDate,
        )
      )
        continue;
      validateCitation(row, doc);
      output.push(row);
      if (output.length >= 50) return output;
    }
  }
  return output;
}
function context(organizationId: string): WorkspaceContext {
  return {
    organizationId,
    role: 'admin',
    sessionId: 'demo-system',
    user: {
      id: demoActorId(organizationId),
      name: 'Aster demo agent',
      email: organizationId + '@demo-agent.example.invalid',
    },
  };
}
type VerifiedSource = {
  documentId: string;
  contentHash: string;
  familyId: string | null;
  indexed: boolean;
  receivedAt: string;
};
async function verifiedSource(
  c: PoolClient,
  ctx: WorkspaceContext,
  jobId: string,
  catalog: DemoCatalog,
): Promise<VerifiedSource | null> {
  const row = (
    await c.query<{
      document_id: string;
      content_hash: string;
      payload: Buffer;
      created_at: Date;
      indexed: boolean;
    }>(
      `SELECT d.id AS document_id,d.content_hash,d.payload,d.created_at,(i.document_id IS NOT NULL) AS indexed
     FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id
     LEFT JOIN app_intelligence_documents i ON i.document_id=d.id AND i.organization_id=d.organization_id
     WHERE j.organization_id=$1 AND j.id=$2`,
      [ctx.organizationId, jobId],
    )
  ).rows[0];
  if (!row || !(await hasDemoSourceVerification(c, ctx, row.document_id)))
    return null;
  const matches = catalog.documents.filter(
    (document) => document.sha256 === row.content_hash,
  );
  if (!matches.length) return null;
  const bytes = decrypt(
    row.payload,
    'document:' + ctx.organizationId + ':' + row.document_id,
  );
  if (sha256(bytes) !== row.content_hash)
    throw new Error('DEMO_SOURCE_CHANGED');
  const families = new Set(matches.map((source) => source.office_id));
  return {
    documentId: row.document_id,
    contentHash: row.content_hash,
    familyId: families.size === 1 ? [...families][0] : null,
    indexed: row.indexed,
    receivedAt: row.created_at.toISOString(),
  };
}
export async function indexDemoJobSources(
  organizationId: string,
  jobId: string,
): Promise<{ indexed: boolean; proposed: number; accepted: number }> {
  const none = { indexed: false, proposed: 0, accepted: 0 };
  if (process.env.ASTER_ENABLE_DEMO !== 'true') return none;
  const ctx = context(organizationId);
  let documentId: string | null = null;
  try {
    const catalog = await loadDemoCatalog();
    const source = await withTenant(organizationId, (c) =>
      verifiedSource(c, ctx, jobId, catalog),
    );
    if (!source) return none;
    documentId = source.documentId;
    const done = await withTenant(organizationId, (c) =>
      c.query(
        "SELECT 1 FROM app_audit WHERE organization_id=$1 AND resource_id=$2 AND action='demo.intelligence_complete' LIMIT 1",
        [organizationId, documentId],
      ),
    );
    if (done.rowCount) return { ...none, indexed: source.indexed };
    if (!source.indexed) await indexDocument(ctx, source.documentId);
    return await withTenant(organizationId, async (c) => {
      const checked = await verifiedSource(c, ctx, jobId, catalog);
      if (!checked || checked.contentHash !== source.contentHash) return none;
      const { state } = await readWorkspaceInTransaction(
        c,
        organizationId,
        true,
      );
      if (!state.demo?.autoPublish || state.demo.runId !== organizationId)
        return none;
      const doc = await loadIndexedDocument(c, ctx, source.documentId);
      if (doc.contentHash !== source.contentHash)
        throw new Error('DEMO_INDEX_CHANGED');
      const data = deriveWorkspace(state);
      let intelligence = withRecordedIssuers(
          intelligenceStateSchema.parse(
            state.intelligence ?? emptyIntelligence(),
          ),
          state.riskData,
        ),
        risk = state.riskData;
      const proposed = source.familyId
        ? demoConstituentProposals(
            doc,
            source.familyId,
            data.holdings,
            intelligence.aliases,
          )
        : [];
      const evidence = [...data.evidence];
      let added = 0,
        accepted = 0;
      for (const proposal of proposed) {
        if (
          intelligence.proposals.some(
            (old) =>
              old.holdingId === proposal.holdingId &&
              old.citation.documentId === proposal.citation.documentId &&
              old.issuerName === proposal.issuerName &&
              old.citation.quote === proposal.citation.quote,
          )
        )
          continue;
        intelligence.proposals.push(proposal);
        added++;
        const conflicting = proposed.some(
          (other) =>
            other.id !== proposal.id &&
            other.holdingId === proposal.holdingId &&
            issuerKey(other.issuerName) === issuerKey(proposal.issuerName) &&
            (other.weight !== proposal.weight ||
              other.asOfDate !== proposal.asOfDate),
        );
        if (conflicting || !proposal.asOfDate || doc.warnings.length) continue;
        try {
          const result = acceptConstituent(
            intelligence,
            risk,
            proposal.id,
            data.holdings,
          );
          intelligence = result.intelligence;
          risk = result.riskData;
          accepted++;
          const holding = data.holdings.find(
            (item) => item.id === proposal.holdingId,
          )!;
          evidence.push({
            id: 'intelligence-' + proposal.id,
            mailboxId: 'demo-folder',
            familyId: holding.familyId,
            holdingId: holding.id,
            subject:
              proposal.issuerName + ' · synthetic demo constituent disclosure',
            sender: 'Aster demo agent · source-verified synthetic report',
            receivedAt: source.receivedAt,
            reportedEffectiveDate: proposal.asOfDate,
            effectiveDate: proposal.asOfDate,
            effectiveDateBasis: 'Source reported',
            filename: doc.filename,
            page: proposal.citation.page,
            excerpt: proposal.citation.quote,
            status: 'Accepted',
            synthetic: false,
            demoSource: true,
            documentId: doc.documentId,
          });
        } catch (error) {
          if (!(error instanceof IntelligenceError))
            throw error; /* A reviewed existing mapping or conflicting weight needs a person. */
        }
      }
      if (added)
        await saveWorkspace(c, organizationId, {
          ...state,
          intelligence: intelligenceStateSchema.parse(intelligence),
          ...(risk ? { riskData: risk } : {}),
          portfolio: {
            holdings: data.holdings,
            history: data.history,
            events: data.events,
            tasks: data.tasks,
            families: data.families,
            entities: data.entities,
            accounts: data.accounts,
            evidence,
          },
        });
      const hasDisclosure = doc.pages.some((page) =>
        /(?:current|actual|reported)\s+underlying investments\b/i.test(
          page.text,
        ),
      );
      await audit(
        c,
        organizationId,
        ctx.user.id,
        hasDisclosure && !proposed.length
          ? 'demo.intelligence_deferred'
          : 'demo.intelligence_complete',
        source.documentId,
        {
          indexed: true,
          proposed: added,
          accepted,
          humanReview: false,
          ...(hasDisclosure && !proposed.length
            ? {
                reason:
                  'An exact same-page parent and family could not be matched.',
              }
            : {}),
        },
      );
      return { indexed: true, proposed: added, accepted };
    });
  } catch (error) {
    if (documentId)
      await withTenant(organizationId, (c) =>
        audit(
          c,
          organizationId,
          ctx.user.id,
          'demo.intelligence_failed',
          documentId!,
          {
            reason:
              error instanceof AccessError
                ? error.code
                : 'INDEX_REVIEW_REQUIRED',
          },
        ),
      );
    return none;
  }
}
/** Bounded crash recovery: two verified sources, with five-minute backoff after failures. */
export async function indexReadyDemoSources(scope: string[] | null) {
  if (process.env.ASTER_ENABLE_DEMO !== 'true') return;
  const organizations = await pool.query<{ id: string }>(
    `SELECT id FROM app_organizations WHERE demo_owner_user_id IS NOT NULL ${scope ? 'AND id=ANY($1::uuid[])' : ''} ORDER BY created_at DESC LIMIT 100`,
    scope ? [scope] : [],
  );
  let handled = 0;
  for (const { id } of organizations.rows) {
    const jobs = await withTenant(
      id,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT DISTINCT ON (j.document_id) j.id FROM app_jobs j
       WHERE j.organization_id=$1
        AND EXISTS(SELECT 1 FROM app_audit a WHERE a.organization_id=$1 AND a.resource_id=j.document_id::text AND a.action='demo.source_verified' AND a.actor_id=$2)
        AND NOT EXISTS(SELECT 1 FROM app_audit a WHERE a.organization_id=$1 AND a.resource_id=j.document_id::text AND a.action='demo.intelligence_complete')
        AND NOT EXISTS(SELECT 1 FROM app_audit a WHERE a.organization_id=$1 AND a.resource_id=j.document_id::text AND a.action IN ('demo.intelligence_failed','demo.intelligence_deferred') AND a.created_at>now()-interval '5 minutes')
        AND (SELECT count(*) FROM app_audit a WHERE a.organization_id=$1 AND a.resource_id=j.document_id::text AND a.action='demo.intelligence_failed')<3
       ORDER BY j.document_id,j.created_at DESC,j.id DESC LIMIT 2`,
            [id, demoActorId(id)],
          )
        ).rows,
    );
    for (const job of jobs) {
      await indexDemoJobSources(id, job.id);
      handled++;
      if (handled >= 2) return;
    }
  }
}
