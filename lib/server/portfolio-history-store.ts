import 'server-only';
import type { PoolClient } from 'pg';
import {
  DataScopeSchema,
  documentScopeAllows,
  scopeWorkspace,
  scopeAllows,
} from '../data-scope';
import {
  deriveWorkspace,
  type PortfolioRecords,
  type WorkspaceState,
} from '../workspace';
import {
  projectPortfolioHistory,
  HISTORY_LIMITS,
  PortfolioHistoryError,
} from '../portfolio-history';
import {
  PortfolioHistoryQuerySchema,
  type PortfolioHistoryQuery,
  type PortfolioHistoryResponse,
} from '../portfolio-history-contract';
import { AccessError, roleAllows, type WorkspaceContext } from './access';
import { withTenant } from './db';
import { decrypt } from './crypto';

export async function assertHistoryAccess(
  client: PoolClient,
  ctx: WorkspaceContext,
  write = false,
): Promise<void> {
  const row = (
    await client.query<{ role: string; data_scope: unknown }>(
      `SELECT m.role,m.data_scope FROM app_memberships m JOIN auth_session s ON s."userId"=m.user_id
     WHERE m.organization_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND s.id=$3 AND s."expiresAt">now()${write ? ' FOR SHARE OF m' : ''}`,
      [ctx.organizationId, ctx.user.id, ctx.sessionId],
    )
  ).rows[0];
  if (
    !row ||
    !roleAllows(row.role, write ? 'write' : 'read') ||
    row.role !== ctx.role ||
    JSON.stringify(
      row.data_scope == null ? null : DataScopeSchema.parse(row.data_scope),
    ) !== JSON.stringify(ctx.scope ?? null) ||
    (write && row.data_scope)
  ) {
    throw new AccessError(
      403,
      'ACCESS_CHANGED',
      'Your workspace access changed. Reload before continuing.',
    );
  }
}
/** The SQL bound prevents transferring/decrypting an oversized workspace, and
 * the same repeatable-read transaction fixes access, sources and revisions. */
export async function readHistoryWorkspace(
  client: PoolClient,
  organizationId: string,
  lock = false,
) {
  const row = (
    await client.query<{
      payload: Buffer | null;
      bytes: number;
      revision: number;
    }>(
      `SELECT CASE WHEN octet_length(payload)<=$2 THEN payload END AS payload,octet_length(payload) AS bytes,revision FROM app_workspace WHERE organization_id=$1${lock ? ' FOR UPDATE' : ''}`,
      [organizationId, HISTORY_LIMITS.maxWorkspaceBytes],
    )
  ).rows[0];
  if (!row)
    throw new AccessError(
      404,
      'WORKSPACE_NOT_FOUND',
      'This workspace has no retained history.',
    );
  if (!row.payload || row.bytes > HISTORY_LIMITS.maxWorkspaceBytes)
    throw new AccessError(
      413,
      'HISTORY_CAPACITY',
      'The encrypted workspace exceeds the safe history-query capacity. No partial results were returned.',
    );
  const state = JSON.parse(
    decrypt(row.payload, 'workspace:' + organizationId).toString(),
  ) as WorkspaceState;
  return { state, revision: row.revision };
}
/** Internal transaction-level projection: callers can compose other sourced
 * portfolio views without changing the authorization or workspace snapshot. */
export async function readPortfolioHistorySnapshot(
  client: PoolClient,
  ctx: WorkspaceContext,
  query: PortfolioHistoryQuery,
) {
  await assertHistoryAccess(client, ctx);
  const { state, revision } = await readHistoryWorkspace(
    client,
    ctx.organizationId,
  );
  const relevantHoldings = new Set(
    (state.portfolio?.holdings ?? [])
      .filter(
        (h) =>
          scopeAllows(ctx.scope, h.familyId, h.entityId) &&
          (!query.holdingIds || query.holdingIds.includes(h.id)) &&
          (!query.familyIds || query.familyIds.includes(h.familyId)) &&
          (!query.entityIds || query.entityIds.includes(h.entityId)),
      )
      .map((h) => h.id),
  );
  const originals = new Set(
    (state.portfolio?.evidence ?? []).flatMap((e) =>
      e.documentId && relevantHoldings.has(e.holdingId) ? [e.documentId] : [],
    ),
  );
  if (originals.size > HISTORY_LIMITS.maxObservations)
    throw new AccessError(
      413,
      'HISTORY_CAPACITY',
      'This history library exceeds the bounded source lookup capacity.',
    );
  const documents = originals.size
    ? (
        await client.query<{
          id: string;
          created_at: Date;
          content_hash: string;
          family_ids: string[] | null;
          entity_ids: string[] | null;
        }>(
          `SELECT d.id,d.created_at,d.content_hash,a.family_ids,a.entity_ids FROM app_documents d LEFT JOIN app_document_access a ON a.organization_id=d.organization_id AND a.document_id=d.id WHERE d.organization_id=$1 AND d.id=ANY($2::uuid[])`,
          [ctx.organizationId, [...originals]],
        )
      ).rows
    : [];
  const allowed = new Set(
    documents
      .filter(
        (d) =>
          !ctx.scope ||
          (!!d.family_ids &&
            !!d.entity_ids &&
            documentScopeAllows(ctx.scope, {
              family_ids: d.family_ids,
              entity_ids: d.entity_ids,
            })),
      )
      .map((d) => d.id),
  );
  // Legacy/sample-only fallback is deliberately empty. This API never
  // substitutes the static illustration dataset for a retained portfolio.
  const scoped = scopeWorkspace(
    { ...state, sampleData: false },
    ctx.scope,
    allowed,
  );
  const portfolio: PortfolioRecords = deriveWorkspace(scoped);
  const evidence = portfolio.evidence.filter(
    (source) => !source.documentId || allowed.has(source.documentId),
  );
  const sourceIds = new Set(evidence.map((e) => e.id));
  const finance = scoped.finance
    ? {
        ...scoped.finance,
        valuations: scoped.finance.valuations.filter((r) =>
          sourceIds.has(r.sourceId),
        ),
      }
    : undefined;
  const safePortfolio = {
    ...portfolio,
    evidence,
    history: ctx.scope ? [] : portfolio.history,
  };
  const metadata = new Map(
    documents
      .filter((d) => allowed.has(d.id))
      .map((d) => [d.id, { importedAt: d.created_at.toISOString() }]),
  );
  const hashes = new Map(documents.map((d) => [d.id, d.content_hash]));
  const lifecycle = scoped.historyLifecycle
    ? {
        ...scoped.historyLifecycle,
        records: scoped.historyLifecycle.records.filter(
          (r) =>
            allowed.has(r.documentId) &&
            sourceIds.has(r.sourceId) &&
            hashes.get(r.documentId) === r.sourceSha256,
        ),
        receipts: [],
      }
    : undefined;
  const result = projectPortfolioHistory(safePortfolio, finance, query, {
    revision,
    documentMetadata: metadata,
    lifecycle,
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
    throw new AccessError(
      413,
      'HISTORY_RESPONSE_CAPACITY',
      'This history projection exceeds the safe response capacity. Narrow the selected holdings or date range.',
    );
  return {
    result,
    portfolio: safePortfolio,
    state: scoped,
    rawState: state,
    documentHashes: hashes,
    allowedDocuments: allowed,
  };
}
export async function readPortfolioHistory(
  ctx: WorkspaceContext,
  input: Partial<PortfolioHistoryQuery> = {},
): Promise<PortfolioHistoryResponse> {
  const query = PortfolioHistoryQuerySchema.parse(input);
  try {
    return await withTenant(
      ctx.organizationId,
      async (client) =>
        (await readPortfolioHistorySnapshot(client, ctx, query)).result,
      { readOnlySnapshot: true },
    );
  } catch (error) {
    if (error instanceof PortfolioHistoryError)
      throw new AccessError(error.status, error.code, error.message);
    throw error;
  }
}
