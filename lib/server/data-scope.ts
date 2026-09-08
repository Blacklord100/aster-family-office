import 'server-only';
import type { PoolClient } from 'pg';
import { AccessError, type WorkspaceContext } from './access';
import { documentScopeAllows } from '../data-scope';
export async function releasedDocumentIds(
  client: PoolClient,
  ctx: WorkspaceContext,
): Promise<Set<string>> {
  if (!ctx.scope) return new Set();
  const rows = await client.query<{
    document_id: string;
    family_ids: string[];
    entity_ids: string[];
  }>(
    'SELECT document_id,family_ids,entity_ids FROM app_document_access WHERE organization_id=$1',
    [ctx.organizationId],
  );
  return new Set(
    rows.rows
      .filter((row) => documentScopeAllows(ctx.scope!, row))
      .map((row) => row.document_id),
  );
}
export async function assertDocumentAccess(
  client: PoolClient,
  ctx: WorkspaceContext,
  documentId: string,
): Promise<void> {
  if (!ctx.scope) return;
  const row = (
    await client.query<{ family_ids: string[]; entity_ids: string[] }>(
      'SELECT family_ids,entity_ids FROM app_document_access WHERE organization_id=$1 AND document_id=$2',
      [ctx.organizationId, documentId],
    )
  ).rows[0];
  if (!row || !documentScopeAllows(ctx.scope, row))
    throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
}
