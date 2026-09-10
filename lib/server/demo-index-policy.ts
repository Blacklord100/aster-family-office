import 'server-only';
import type { PoolClient } from 'pg';
import type { WorkspaceContext } from './access';
import { readWorkspaceInTransaction } from '../workspace-store';
import { hasDemoSourceVerification } from './demo-review-policy';
import { loadDemoCatalog } from './demo-corpus';

/** The automation quota belongs only to retained originals of the dataset
 * pinned in this verified synthetic workspace. Never consult answer keys. */
export async function verifiedDemoIndexSource(
  client: PoolClient,
  context: WorkspaceContext,
  documentId: string,
  contentHash: string,
): Promise<boolean> {
  if (!(await hasDemoSourceVerification(client, context, documentId)))
    return false;
  const { state } = await readWorkspaceInTransaction(
    client,
    context.organizationId,
  );
  if (!state.demo?.autoPublish || state.demo.runId !== context.organizationId)
    return false;
  return (await loadDemoCatalog(state.demo.dataset)).documents.some(
    (source) => source.sha256 === contentHash,
  );
}
