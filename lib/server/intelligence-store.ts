import 'server-only';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { AccessError, type WorkspaceContext } from './access';
import { assertDocumentAccess, releasedDocumentIds } from './data-scope';
import { scopeWorkspace } from '../data-scope';
import { deriveWorkspace } from '../workspace';
import { readWorkspaceInTransaction, saveWorkspace } from '../workspace-store';
import { withTenant } from './db';
import { decrypt, encrypt, sha256 } from './crypto';
import { audit, rateLimit } from './audit';
import { readBody } from './http';
import { verifiedDemoIndexSource } from './demo-index-policy';
import {
  activeEngine,
  assertEngineEnabled,
  processorEndpoint,
} from './engine-store';
import {
  acceptConstituent,
  constituentProposals,
  IntelligenceError,
  recordedCalculations,
  searchDocuments,
  validateAliases,
  validateCitation,
  withRecordedIssuers,
} from '../intelligence';
import {
  emptyIntelligence,
  intelligenceStateSchema,
  type IntelligenceCommand,
  type IntelligenceResponse,
  type IndexedDocument,
  type IntelligenceCoverage,
  type KnowledgeAnswer,
  type SearchHit,
} from '../intelligence-contract';

const pageSchema = z
  .object({
    number: z.number().int().min(1).max(40),
    text: z.string().max(120000),
    source: z.string().max(240),
  })
  .strict();
const decodedSchema = z
  .object({
    pages: z.array(pageSchema).min(1).max(40),
    warnings: z.array(z.string().max(3000)).max(100),
  })
  .strict()
  .refine(
    (v) =>
      v.pages.reduce((n, p) => n + p.text.length, 0) <= 120000 &&
      v.pages.every((p, i) => p.number === i + 1),
  );
const indexSchema = decodedSchema.safeExtend({
  documentId: z.uuid(),
  filename: z.string().max(200),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  indexedAt: z.string(),
});
const indexContext = (org: string, id: string) =>
  'intelligence-index:' + org + ':' + id;
export function requireUnscoped(ctx: WorkspaceContext) {
  if (ctx.scope)
    throw new AccessError(
      403,
      'SCOPED_INTELLIGENCE_UNAVAILABLE',
      'Relationship management and full-library search are available to office-wide members. Ask Aster can query your released sources and permitted holdings.',
    );
}
export async function getIntelligence(
  ctx: WorkspaceContext,
): Promise<IntelligenceResponse> {
  requireUnscoped(ctx);
  return withTenant(ctx.organizationId, async (c) => {
    const { state } = await readWorkspaceInTransaction(c, ctx.organizationId);
    const docs = await c.query<{
      id: string;
      filename: string;
      indexed_at: Date | null;
      page_count: number | null;
    }>(
      'SELECT d.id,d.filename,i.indexed_at,i.page_count FROM app_documents d LEFT JOIN app_intelligence_documents i ON i.document_id=d.id AND i.organization_id=d.organization_id WHERE d.organization_id=$1 ORDER BY d.created_at DESC,d.id DESC LIMIT 101',
      [ctx.organizationId],
    );
    const engine = await activeEngine(c, ctx.organizationId);
    const org = await c.query<{ processing_mode: 'workflow' | 'agentic' }>(
      'SELECT processing_mode FROM app_organizations WHERE id=$1',
      [ctx.organizationId],
    );
    return {
      state: withRecordedIssuers(
        intelligenceStateSchema.parse(
          state.intelligence ?? emptyIntelligence(),
        ),
        state.riskData,
      ),
      canWrite: ctx.role !== 'viewer',
      canReview: ['owner', 'admin'].includes(ctx.role),
      documents: docs.rows.slice(0, 100).map((d) => ({
        id: d.id,
        filename: d.filename,
        indexed: !!d.indexed_at,
        indexedAt: d.indexed_at?.toISOString() ?? null,
        pageCount: d.page_count,
      })),
      documentListTruncated: docs.rows.length > 100,
      engine: engine.snapshot,
      mode: org.rows[0].processing_mode,
    };
  });
}
async function processorRequest(
  path: '/v1/knowledge' | '/v1/knowledge/decode',
  body: BodyInit,
  execution: 'local' | 'cloud',
  isJson: boolean,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const token = process.env.PROCESSOR_TOKEN;
  if (!token || token.length < 24)
    throw new AccessError(
      503,
      'PROCESSOR_UNAVAILABLE',
      'The processor is not configured.',
    );
  try {
    const response = await fetcher(
      new URL(path, processorEndpoint(execution)),
      {
        method: 'POST',
        body,
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(595000)])
          : AbortSignal.timeout(595000),
        headers: {
          'X-Processor-Key': token,
          ...(isJson ? { 'Content-Type': 'application/json' } : {}),
        },
      },
    );
    if (!response.ok) {
      void response.body?.cancel();
      throw new AccessError(
        response.status === 503 ? 503 : 502,
        response.status === 503 ? 'PROCESSOR_BUSY' : 'KNOWLEDGE_UNAVAILABLE',
        response.status === 503
          ? 'The processor is busy. Try again after document processing finishes.'
          : 'The processor could not complete this request. No fallback engine was used.',
      );
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readBody(
          new Request('http://processor.invalid', {
            method: 'POST',
            body: response.body,
            duplex: 'half',
          } as RequestInit),
          2_000_000,
        ),
      ),
    );
  } catch (e) {
    if (e instanceof AccessError) throw e;
    throw new AccessError(
      502,
      'KNOWLEDGE_UNAVAILABLE',
      'The selected processor could not complete this request. No fallback engine was used.',
    );
  }
}
export async function indexDocument(ctx: WorkspaceContext, documentId: string) {
  requireUnscoped(ctx);
  const original = await withTenant(ctx.organizationId, async (c) => {
    await assertDocumentAccess(c, ctx, documentId);
    const row = (
      await c.query<{
        payload: Buffer;
        filename: string;
        mime_type: string;
        content_hash: string;
      }>(
        'SELECT payload,filename,mime_type,content_hash FROM app_documents WHERE organization_id=$1 AND id=$2',
        [ctx.organizationId, documentId],
      )
    ).rows[0];
    if (!row) throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
    const verifiedDemo = await verifiedDemoIndexSource(
      c,
      ctx,
      documentId,
      row.content_hash,
    );
    if (
      !(await rateLimit(
        c,
        'intelligence-index:' + ctx.organizationId + ':' + ctx.user.id,
        verifiedDemo ? 120 : 30,
        3600,
      ))
    )
      throw new AccessError(
        429,
        'RATE_LIMITED',
        'Decoding limit reached. Try later.',
      );
    return {
      ...row,
      bytes: decrypt(
        row.payload,
        'document:' + ctx.organizationId + ':' + documentId,
      ),
    };
  });
  if (sha256(original.bytes) !== original.content_hash)
    throw new AccessError(
      409,
      'SOURCE_CHANGED',
      'The original checksum could not be verified.',
    );
  const form = new FormData();
  form.set(
    'file',
    new Blob([new Uint8Array(original.bytes)], { type: original.mime_type }),
    original.filename,
  );
  const decoded = decodedSchema.parse(
    await processorRequest('/v1/knowledge/decode', form, 'local', false),
  );
  const indexed: IndexedDocument = {
    ...decoded,
    documentId,
    filename: original.filename,
    contentHash: original.content_hash,
    indexedAt: new Date().toISOString(),
  };
  await withTenant(ctx.organizationId, async (c) => {
    await assertDocumentAccess(c, ctx, documentId);
    await c.query(
      'INSERT INTO app_intelligence_documents(document_id,organization_id,payload,page_count) VALUES($1,$2,$3,$4) ON CONFLICT(document_id) DO UPDATE SET payload=$3,page_count=$4,indexed_at=now()',
      [
        documentId,
        ctx.organizationId,
        encrypt(
          JSON.stringify(indexed),
          indexContext(ctx.organizationId, documentId),
        ),
        decoded.pages.length,
      ],
    );
    await audit(
      c,
      ctx.organizationId,
      ctx.user.id,
      'intelligence.indexed',
      documentId,
      { pages: decoded.pages.length },
    );
  });
  return {
    documentId,
    pages: decoded.pages.length,
    warnings: decoded.warnings,
    indexedAt: indexed.indexedAt,
  };
}
export async function loadIndexedDocument(
  c: PoolClient,
  ctx: WorkspaceContext,
  id: string,
) {
  await assertDocumentAccess(c, ctx, id);
  const row = (
    await c.query<{ payload: Buffer }>(
      'SELECT payload FROM app_intelligence_documents WHERE organization_id=$1 AND document_id=$2',
      [ctx.organizationId, id],
    )
  ).rows[0];
  if (!row)
    throw new AccessError(
      409,
      'SOURCE_NOT_INDEXED',
      'Index this original in Intelligence before extracting constituents.',
    );
  return indexSchema.parse(
    JSON.parse(
      decrypt(row.payload, indexContext(ctx.organizationId, id)).toString(),
    ),
  );
}
export async function changeIntelligence(
  ctx: WorkspaceContext,
  command: IntelligenceCommand,
) {
  requireUnscoped(ctx);
  if (ctx.role === 'viewer')
    throw new AccessError(
      403,
      'FORBIDDEN',
      'This action requires editing access.',
    );
  if (
    ['review', 'alias'].includes(command.action) &&
    !['owner', 'admin'].includes(ctx.role)
  )
    throw new AccessError(
      403,
      'ADMIN_REQUIRED',
      'An administrator must review issuer identities and risk mappings.',
    );
  try {
    return await withTenant(ctx.organizationId, async (c) => {
      const { state } = await readWorkspaceInTransaction(
        c,
        ctx.organizationId,
        true,
      );
      const current = withRecordedIssuers(
        intelligenceStateSchema.parse(
          state.intelligence ?? emptyIntelligence(),
        ),
        state.riskData,
      );
      const data = deriveWorkspace(state);
      let risk = state.riskData;
      let portfolio = state.portfolio;
      let next = current;
      const checkLinks = (v: {
        familyId: string | null;
        holdingId: string | null;
        managerId?: string | null;
      }) => {
        if (v.familyId && !data.families.some((f) => f.id === v.familyId))
          throw new IntelligenceError('Choose an existing family.');
        const holding = v.holdingId
          ? data.holdings.find((h) => h.id === v.holdingId)
          : null;
        if (
          v.holdingId &&
          (!holding || (v.familyId && holding.familyId !== v.familyId))
        )
          throw new IntelligenceError('The holding and family do not match.');
        if (v.managerId && !current.managers.some((m) => m.id === v.managerId))
          throw new IntelligenceError('Choose an existing manager.');
      };
      if (command.action === 'propose') {
        if (!data.holdings.some((h) => h.id === command.holdingId))
          throw new IntelligenceError('Choose an existing holding.');
        const document = await loadIndexedDocument(c, ctx, command.documentId);
        const proposals = constituentProposals(
          document,
          command.holdingId,
          current.aliases,
        );
        for (const proposal of proposals)
          if (
            !current.proposals.some(
              (p) =>
                p.holdingId === proposal.holdingId &&
                p.citation.documentId === proposal.citation.documentId &&
                p.citation.quote === proposal.citation.quote &&
                p.issuerName === proposal.issuerName,
            )
          )
            current.proposals.push(proposal);
      } else if (command.action === 'review') {
        const proposal = current.proposals.find(
          (p) => p.id === command.proposalId,
        );
        if (!proposal || proposal.status !== 'pending')
          throw new IntelligenceError('This proposal is no longer pending.');
        const document = await loadIndexedDocument(
          c,
          ctx,
          proposal.citation.documentId,
        );
        validateCitation(proposal, document);
        if (command.decision === 'reject') {
          proposal.status = 'rejected';
          proposal.reviewedAt = new Date().toISOString();
        } else {
          const accepted = acceptConstituent(
            current,
            risk,
            proposal.id,
            data.holdings,
            command.issuerId,
          );
          next = accepted.intelligence;
          risk = accepted.riskData;
          const holding = data.holdings.find(
            (h) => h.id === proposal.holdingId,
          )!;
          const original = (
            await c.query<{ created_at: Date }>(
              'SELECT created_at FROM app_documents WHERE organization_id=$1 AND id=$2',
              [ctx.organizationId, document.documentId],
            )
          ).rows[0];
          if (!original)
            throw new AccessError(
              404,
              'NOT_FOUND',
              'Original document not found.',
            );
          const receivedAt = original.created_at.toISOString();
          portfolio = {
            holdings: data.holdings,
            history: data.history,
            events: data.events,
            tasks: data.tasks,
            families: data.families,
            entities: data.entities,
            accounts: data.accounts,
            evidence: [
              ...data.evidence,
              {
                id: 'intelligence-' + proposal.id,
                mailboxId: 'upload',
                familyId: holding.familyId,
                holdingId: holding.id,
                subject:
                  proposal.issuerName + ' · reviewed constituent disclosure',
                sender: 'Uploaded document',
                receivedAt,
                reportedEffectiveDate: proposal.asOfDate,
                effectiveDate: proposal.asOfDate ?? receivedAt.slice(0, 10),
                effectiveDateBasis: proposal.asOfDate
                  ? 'Source reported'
                  : 'Receipt date fallback',
                filename: document.filename,
                page: proposal.citation.page,
                excerpt: proposal.citation.quote,
                status: 'Accepted',
                synthetic: false,
                documentId: document.documentId,
              },
            ],
          };
        }
      } else if (command.action === 'alias') {
        current.aliases = [
          ...current.aliases.filter((a) => a.id !== command.value.id),
          command.value,
        ];
        validateAliases(current.aliases);
      } else if (command.action === 'delete') {
        if (
          command.collection === 'managers' &&
          [...current.contacts, ...current.mandates, ...current.deals].some(
            (r) => r.managerId === command.id,
          )
        )
          throw new IntelligenceError(
            'Remove the linked manager references first.',
          );
        if (
          command.collection === 'contacts' &&
          current.drafts.some((d) => d.contactId === command.id)
        )
          throw new IntelligenceError('Remove linked drafts first.');
        next = {
          ...current,
          [command.collection]: current[command.collection].filter(
            (r) => r.id !== command.id,
          ),
        };
      } else {
        const value = { ...command.value, updatedAt: new Date().toISOString() };
        checkLinks(value);
        if (command.action === 'record')
          current[command.collection] = [
            ...current[command.collection].filter((r) => r.id !== value.id),
            value as typeof command.value,
          ];
        else if (command.action === 'deal') {
          for (const issuer of command.value.issuerIds)
            if (!current.aliases.some((a) => a.id === issuer))
              throw new IntelligenceError('Choose existing canonical issuers.');
          current.deals = [
            ...current.deals.filter((r) => r.id !== value.id),
            { ...command.value, updatedAt: value.updatedAt },
          ];
        } else {
          if (
            command.value.contactId &&
            !current.contacts.some((r) => r.id === command.value.contactId)
          )
            throw new IntelligenceError('Choose an existing contact.');
          current.drafts = [
            ...current.drafts.filter((r) => r.id !== value.id),
            { ...command.value, updatedAt: value.updatedAt },
          ];
        }
      }
      next = intelligenceStateSchema.parse(next);
      await saveWorkspace(c, ctx.organizationId, {
        ...state,
        ...(portfolio ? { portfolio } : {}),
        intelligence: next,
        ...(risk ? { riskData: risk } : {}),
      });
      await audit(
        c,
        ctx.organizationId,
        ctx.user.id,
        'intelligence.' + command.action,
        ctx.organizationId,
      );
      return { state: next };
    });
  } catch (e) {
    if (e instanceof IntelligenceError || e instanceof z.ZodError)
      throw new AccessError(
        400,
        'INTELLIGENCE_REVIEW_REQUIRED',
        e instanceof IntelligenceError
          ? e.message
          : 'The intelligence record limit or schema was exceeded.',
      );
    throw e;
  }
}
export const INTELLIGENCE_DOCUMENT_LIMIT = 500;
export const INTELLIGENCE_ENCRYPTED_BYTE_LIMIT = 32 * 1024 * 1024;
export const INTELLIGENCE_CHARACTER_LIMIT = 8_000_000;
async function sourceSet(c: PoolClient, ctx: WorkspaceContext) {
  const released = await releasedDocumentIds(c, ctx);
  // The SQL byte window prevents a large library from transferring unbounded
  // ciphertext. The extra metadata row detects a real document-limit overflow.
  const rows = (
    await c.query<{
      document_id: string;
      payload: Buffer | null;
      page_count: number;
    }>(
      `WITH candidates AS (
       SELECT document_id,indexed_at,page_count,octet_length(payload) AS encrypted_bytes
       FROM app_intelligence_documents
       WHERE organization_id=$1 AND ($2::uuid[] IS NULL OR document_id=ANY($2::uuid[]))
       ORDER BY indexed_at DESC,document_id DESC LIMIT $3
     ), bounded AS (
       SELECT *,row_number() OVER(ORDER BY indexed_at DESC,document_id DESC) AS ordinal,
        sum(encrypted_bytes) OVER(ORDER BY indexed_at DESC,document_id DESC) AS running_bytes
       FROM candidates
     )
     SELECT b.document_id,b.page_count,
      CASE WHEN b.ordinal<=$4 AND b.running_bytes<=$5 THEN i.payload ELSE NULL END AS payload
     FROM bounded b JOIN app_intelligence_documents i ON i.document_id=b.document_id AND i.organization_id=$1
     ORDER BY b.ordinal`,
      [
        ctx.organizationId,
        ctx.scope ? [...released] : null,
        INTELLIGENCE_DOCUMENT_LIMIT + 1,
        INTELLIGENCE_DOCUMENT_LIMIT,
        INTELLIGENCE_ENCRYPTED_BYTE_LIMIT,
      ],
    )
  ).rows;
  const documents: IndexedDocument[] = [];
  let chars = 0,
    pages = 0,
    indexedPages = 0,
    encryptedBytes = 0;
  let truncated = rows.length > INTELLIGENCE_DOCUMENT_LIMIT;
  const warnings: string[] = [];
  for (const row of rows.slice(0, INTELLIGENCE_DOCUMENT_LIMIT)) {
    // Even an omitted payload contributes coverage metadata, so its grant must
    // still be current before returning either a source or an aggregate count.
    await assertDocumentAccess(c, ctx, row.document_id);
    if (
      !row.payload ||
      encryptedBytes + row.payload.length > INTELLIGENCE_ENCRYPTED_BYTE_LIMIT
    ) {
      truncated = true;
      indexedPages += row.page_count ?? 0;
      continue;
    }
    const doc = indexSchema.parse(
      JSON.parse(
        decrypt(
          row.payload,
          indexContext(ctx.organizationId, row.document_id),
        ).toString(),
      ),
    );
    encryptedBytes += row.payload.length;
    indexedPages += doc.pages.length;
    const selected = [];
    for (const page of doc.pages) {
      const remaining = INTELLIGENCE_CHARACTER_LIMIT - chars;
      if (remaining <= 0 && page.text.length) {
        truncated = true;
        break;
      }
      const text = page.text.slice(0, Math.max(0, remaining));
      if (text.length < page.text.length) truncated = true;
      chars += text.length;
      pages++;
      selected.push({ ...page, text });
    }
    if (selected.length) documents.push({ ...doc, pages: selected });
    warnings.push(
      ...doc.warnings.map((warning) => doc.filename + ': ' + warning),
    );
  }
  for (const sentinel of rows.slice(INTELLIGENCE_DOCUMENT_LIMIT))
    await assertDocumentAccess(c, ctx, sentinel.document_id);
  const coverage: IntelligenceCoverage = {
    indexedDocuments: Math.min(rows.length, INTELLIGENCE_DOCUMENT_LIMIT),
    searchedDocuments: documents.length,
    indexedPages,
    searchedPages: pages,
    documentLimit: INTELLIGENCE_DOCUMENT_LIMIT,
    characterLimit: INTELLIGENCE_CHARACTER_LIMIT,
    encryptedByteLimit: INTELLIGENCE_ENCRYPTED_BYTE_LIMIT,
    scannedEncryptedBytes: encryptedBytes,
    scannedCharacters: chars,
    truncated,
    warnings: warnings.slice(0, 30),
  };
  if (truncated)
    coverage.warnings.push(
      'Coverage reached its bound: at most the newest 500 accessible indexed documents, 32 MiB of encrypted index records and 8,000,000 decoded characters. Unindexed or omitted originals are not searched.',
    );
  return {
    documents,
    coverage,
    released,
    checkedDocumentIds: rows.map((row) => row.document_id),
  };
}
export async function searchIntelligence(
  ctx: WorkspaceContext,
  question: string,
) {
  requireUnscoped(ctx);
  return withTenant(ctx.organizationId, async (c) => {
    const { documents, coverage } = await sourceSet(c, ctx);
    return { hits: searchDocuments(documents, question), coverage };
  });
}
const answerSchema = z
  .object({
    status: z.enum(['answered', 'insufficient_evidence', 'model_unavailable']),
    quotes: z
      .array(
        z
          .object({
            sourceId: z.string().max(160),
            quote: z.string().min(1).max(1800),
          })
          .strict(),
      )
      .max(6),
    calculationIds: z.array(z.enum(['nav', 'cash', 'unfunded'])).max(3),
    model: z.string().max(121),
    execution: z.enum(['local', 'cloud']),
    mode: z.enum(['workflow', 'agentic']),
    modelCalls: z.number().int().min(0).max(4),
    warnings: z.array(z.string().max(1000)).max(20),
    trace: z
      .array(
        z
          .object({ stage: z.string().max(80), detail: z.string().max(500) })
          .strict(),
      )
      .max(10),
  })
  .strict();
export async function askIntelligence(
  ctx: WorkspaceContext,
  input: { question: string; familyId: string; mode?: 'workflow' | 'agentic' },
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<KnowledgeAnswer> {
  const prepared = await withTenant(ctx.organizationId, async (c) => {
    if (
      !(await rateLimit(
        c,
        'intelligence-ask:' + ctx.organizationId + ':' + ctx.user.id,
        20,
        3600,
      ))
    )
      throw new AccessError(
        429,
        'RATE_LIMITED',
        'Question limit reached. Try again later.',
      );
    const engine = await activeEngine(c, ctx.organizationId);
    assertEngineEnabled(engine.config);
    if (ctx.scope && engine.snapshot.execution === 'cloud')
      throw new AccessError(
        403,
        'SCOPED_CLOUD_UNAVAILABLE',
        'Scoped source queries currently require an active local engine.',
      );
    const { documents, coverage, released, checkedDocumentIds } =
      await sourceSet(c, ctx);
    const { state } = await readWorkspaceInTransaction(c, ctx.organizationId);
    const data = deriveWorkspace(scopeWorkspace(state, ctx.scope, released));
    if (
      input.familyId !== 'all' &&
      !data.families.some((f) => f.id === input.familyId)
    )
      throw new AccessError(404, 'FAMILY_NOT_FOUND', 'Family not found.');
    const holdings = data.holdings.filter(
      (h) => input.familyId === 'all' || h.familyId === input.familyId,
    );
    const mode =
      input.mode ??
      (
        await c.query<{ processing_mode: 'workflow' | 'agentic' }>(
          'SELECT processing_mode FROM app_organizations WHERE id=$1',
          [ctx.organizationId],
        )
      ).rows[0].processing_mode;
    return {
      engine,
      mode,
      hits: searchDocuments(documents, input.question),
      coverage,
      checkedDocumentIds,
      calculations: recordedCalculations(holdings),
    };
  });
  const raw = answerSchema.parse(
    await processorRequest(
      '/v1/knowledge',
      JSON.stringify({
        question: input.question,
        mode: prepared.mode,
        engine: prepared.engine.config,
        passages: prepared.hits.map((h) => ({
          id: h.id,
          text: h.quote,
          label: h.filename + ' · ' + h.source + ' · page ' + h.page,
        })),
        calculations: prepared.calculations.map(
          ({ id, label, valueEUR, basis }) => ({ id, label, valueEUR, basis }),
        ),
      }),
      prepared.engine.snapshot.execution,
      true,
      fetcher,
      signal,
    ),
  );
  if (
    raw.model !== prepared.engine.snapshot.model ||
    raw.mode !== prepared.mode ||
    raw.execution !== prepared.engine.snapshot.execution
  )
    throw new AccessError(
      502,
      'ENGINE_IDENTITY_MISMATCH',
      'The answer did not match the selected engine and mode.',
    );
  const citations: SearchHit[] = [];
  for (const quote of raw.quotes) {
    const hit = prepared.hits.find((h) => h.id === quote.sourceId);
    if (!hit || !hit.quote.includes(quote.quote))
      throw new AccessError(
        502,
        'UNSUPPORTED_ANSWER',
        'The answer included an unsupported source quotation.',
      );
    citations.push({ ...hit, quote: quote.quote });
  }
  // Recheck grants before returning decoded material after a potentially long inference.
  await withTenant(ctx.organizationId, async (c) => {
    for (const documentId of prepared.checkedDocumentIds)
      await assertDocumentAccess(c, ctx, documentId);
  });
  return {
    mode: prepared.mode,
    engine: prepared.engine.snapshot,
    status: raw.status,
    modelCalls: raw.modelCalls,
    citations,
    calculations: prepared.calculations.filter((c) =>
      raw.calculationIds.includes(c.id as 'nav' | 'cash' | 'unfunded'),
    ),
    coverage: prepared.coverage,
    warnings: raw.warnings,
    trace: raw.trace,
  };
}
