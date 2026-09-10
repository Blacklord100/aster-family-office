import 'server-only';
import { randomUUID } from 'node:crypto';
import { deriveWorkspace, type PortfolioRecords } from '../workspace';
import { saveWorkspace } from '../workspace-store';
import { appendHistoryLifecycle } from '../portfolio-history-lifecycle';
import {
  emptyHistoryLifecycle,
  historyLifecycleRequestSchema,
  type HistoryLifecycleRequest,
  type HistoryLifecycleResponse,
} from '../portfolio-history-lifecycle-contract';
import { PortfolioHistoryError, HISTORY_LIMITS } from '../portfolio-history';
import {
  assertHistoryAccess,
  readHistoryWorkspace,
} from './portfolio-history-store';
import { AccessError, roleAllows, type WorkspaceContext } from './access';
import { withTenant } from './db';
import { audit } from './audit';
import { sha256 } from './crypto';
export async function writeHistoryLifecycle(
  ctx: WorkspaceContext,
  value: HistoryLifecycleRequest,
): Promise<HistoryLifecycleResponse> {
  if (!roleAllows(ctx.role, 'write') || ctx.scope)
    throw new AccessError(
      403,
      'FORBIDDEN',
      'Your account cannot change historical position records.',
    );
  const request = historyLifecycleRequestSchema.parse(value),
    digest = sha256(JSON.stringify(request.command));
  try {
    return await withTenant(ctx.organizationId, async (client) => {
      await assertHistoryAccess(client, ctx, true);
      const { state, revision } = await readHistoryWorkspace(
        client,
        ctx.organizationId,
        true,
      );
      const lifecycle = state.historyLifecycle ?? emptyHistoryLifecycle();
      const receipt = lifecycle.receipts.find(
        (r) => r.key === request.idempotencyKey,
      );
      if (receipt) {
        if (receipt.digest !== digest)
          throw new AccessError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This key already records a different lifecycle instruction.',
          );
        return {
          revision,
          historyLifecycle: lifecycle,
          canWrite: true,
          duplicate: true,
          resultId: receipt.resultId,
        };
      }
      if (revision !== request.expectedRevision)
        throw new AccessError(
          409,
          'HISTORY_CHANGED',
          'The workspace changed. Review the current history before submitting again.',
        );
      const portfolio: PortfolioRecords = deriveWorkspace({
        ...state,
        sampleData: false,
      });
      const source = portfolio.evidence.find(
        (s) => s.id === request.command.sourceId,
      );
      if (!source?.documentId)
        throw new AccessError(
          400,
          'HISTORY_SOURCE_REQUIRED',
          'Choose an accepted retained source.',
        );
      const original = (
        await client.query<{ sha256: string }>(
          'SELECT content_hash AS sha256 FROM app_documents WHERE organization_id=$1 AND id=$2 FOR SHARE',
          [ctx.organizationId, source.documentId],
        )
      ).rows[0];
      if (!original)
        throw new AccessError(
          404,
          'HISTORY_SOURCE_REQUIRED',
          'The original source is not available.',
        );
      const result = appendHistoryLifecycle(
        portfolio,
        lifecycle,
        request.command,
        {
          id: randomUUID(),
          actorId: ctx.user.id,
          at: new Date().toISOString(),
          sourceSha256: original.sha256,
        },
      );
      result.state.receipts.push({
        key: request.idempotencyKey,
        digest,
        resultId: result.record.id,
      });
      const next = { ...state, historyLifecycle: result.state };
      if (
        Buffer.byteLength(JSON.stringify(next)) >
        HISTORY_LIMITS.maxWorkspaceBytes - 128
      )
        throw new AccessError(
          413,
          'HISTORY_CAPACITY',
          'The encrypted workspace has reached its safe history storage capacity.',
        );
      await saveWorkspace(client, ctx.organizationId, next);
      await audit(
        client,
        ctx.organizationId,
        ctx.user.id,
        'history.lifecycle.' + request.command.kind,
        result.record.id,
        {
          workspaceRevision: revision + 1,
          lifecycleRevision: result.state.revision,
          documentId: result.record.documentId,
          sourceSha256: result.record.sourceSha256,
          correctionOf: result.record.correctionOf ?? '',
        },
      );
      return {
        revision: revision + 1,
        historyLifecycle: result.state,
        canWrite: true,
        resultId: result.record.id,
      };
    });
  } catch (error) {
    if (error instanceof PortfolioHistoryError)
      throw new AccessError(error.status, error.code, error.message);
    throw error;
  }
}
