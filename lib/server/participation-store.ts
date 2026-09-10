import 'server-only';
import { randomUUID } from 'node:crypto';
import { deriveWorkspace, type PortfolioRecords } from '../workspace';
import { saveWorkspace } from '../workspace-store';
import { appendParticipation, projectParticipation } from '../participation';
import {
  emptyParticipation,
  ParticipationQuerySchema,
  participationRequestSchema,
  type ParticipationQuery,
  type ParticipationRequest,
  type ParticipationResponse,
  type ParticipationWriteResponse,
} from '../participation-contract';
import { HISTORY_LIMITS, PortfolioHistoryError } from '../portfolio-history';
import {
  assertHistoryAccess,
  readHistoryWorkspace,
  readPortfolioHistorySnapshot,
} from './portfolio-history-store';
import { AccessError, roleAllows, type WorkspaceContext } from './access';
import { withTenant } from './db';
import { audit } from './audit';
import { sha256 } from './crypto';

export async function readParticipation(
  ctx: WorkspaceContext,
  input: Partial<ParticipationQuery> = {},
): Promise<ParticipationResponse> {
  const query = ParticipationQuerySchema.parse(input);
  try {
    return await withTenant(
      ctx.organizationId,
      async (client) => {
        // A holding filter affects displayed rows, never the family denominator.
        const snapshot = await readPortfolioHistorySnapshot(client, ctx, {
          ...query,
          holdingIds: undefined,
        });
        const current = snapshot.state.participation ?? emptyParticipation();
        const visibleHoldings = new Set(
          snapshot.result.positions.map((h) => h.holdingId),
        );
        const sources = new Map(
          snapshot.portfolio.evidence.map((s) => [s.id, s]),
        );
        const validSource = (record: (typeof current.records)[number]) => {
          const source = sources.get(record.sourceId);
          return Boolean(
            source?.status === 'Accepted' &&
            !source.synthetic &&
            source.holdingId === record.holdingId &&
            source.familyId === record.familyId &&
            source.documentId === record.documentId &&
            snapshot.allowedDocuments.has(record.documentId) &&
            snapshot.documentHashes.get(record.documentId) ===
              record.sourceSha256,
          );
        };
        // Validate full visible chains, not just a surviving old link: withdrawn
        // sources or changed bytes must never resurrect a superseded mapping.
        const blocked = new Set(
          (snapshot.rawState.participation?.records ?? [])
            .filter((r) => visibleHoldings.has(r.holdingId) && !validSource(r))
            .map((r) => r.holdingId),
        );
        const records = current.records.filter(
          (r) =>
            visibleHoldings.has(r.holdingId) &&
            !blocked.has(r.holdingId) &&
            validSource(r),
        );
        const ids = new Set(records.map((r) => r.investmentId));
        const participation = {
          ...current,
          investments: current.investments.filter((i) => ids.has(i.id)),
          records,
          receipts: [],
        };
        const result = projectParticipation(
          snapshot.portfolio,
          participation,
          { ...snapshot.result, query },
          { canWrite: roleAllows(ctx.role, 'write') && !ctx.scope },
        );
        if (blocked.size)
          result.gaps.push(
            'Some participation mappings are unavailable because their source evidence is no longer released or its retained content does not match. These positions remain unlinked.',
          );
        if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
          throw new AccessError(
            413,
            'PARTICIPATION_RESPONSE_CAPACITY',
            'The participation projection exceeds its safe response capacity. Narrow the selected families.',
          );
        return result;
      },
      { readOnlySnapshot: true },
    );
  } catch (error) {
    if (error instanceof PortfolioHistoryError)
      throw new AccessError(error.status, error.code, error.message);
    throw error;
  }
}

export async function writeParticipation(
  ctx: WorkspaceContext,
  value: ParticipationRequest,
): Promise<ParticipationWriteResponse> {
  if (!roleAllows(ctx.role, 'write') || ctx.scope)
    throw new AccessError(
      403,
      'FORBIDDEN',
      'Your account cannot change investment participation mappings.',
    );
  const request = participationRequestSchema.parse(value);
  const digest = sha256(JSON.stringify(request.command));
  try {
    return await withTenant(ctx.organizationId, async (client) => {
      await assertHistoryAccess(client, ctx, true);
      const { state, revision } = await readHistoryWorkspace(
        client,
        ctx.organizationId,
        true,
      );
      const current = state.participation ?? emptyParticipation();
      const receipt = current.receipts.find(
        (r) => r.key === request.idempotencyKey,
      );
      if (receipt) {
        if (receipt.digest !== digest)
          throw new AccessError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This key already records a different participation instruction.',
          );
        return {
          revision,
          participationRevision: current.revision,
          resultId: receipt.resultId,
          duplicate: true,
        };
      }
      if (revision !== request.expectedRevision)
        throw new AccessError(
          409,
          'PARTICIPATION_CHANGED',
          'The workspace changed. Review current participation before submitting again.',
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
          'PARTICIPATION_SOURCE_REQUIRED',
          'Choose an accepted retained source.',
        );
      const original = (
        await client.query<{
          sha256: string;
          family_ids: string[] | null;
          entity_ids: string[] | null;
        }>(
          `SELECT d.content_hash AS sha256,a.family_ids,a.entity_ids FROM app_documents d JOIN app_document_access a ON a.organization_id=d.organization_id AND a.document_id=d.id WHERE d.organization_id=$1 AND d.id=$2 FOR SHARE OF d,a`,
          [ctx.organizationId, source.documentId],
        )
      ).rows[0];
      const holding = portfolio.holdings.find(
        (h) => h.id === request.command.holdingId,
      );
      if (
        !original ||
        !holding ||
        !original.family_ids?.includes(holding.familyId) ||
        !original.entity_ids?.includes(holding.entityId)
      )
        throw new AccessError(
          400,
          'PARTICIPATION_SOURCE_REQUIRED',
          'This source must be retained and explicitly released for the position’s family and entity.',
        );
      const result = appendParticipation(portfolio, current, request.command, {
        id: randomUUID(),
        investmentId: randomUUID(),
        actorId: ctx.user.id,
        at: new Date().toISOString(),
        sourceSha256: original.sha256,
      });
      result.state.receipts.push({
        key: request.idempotencyKey,
        digest,
        resultId: result.record.id,
      });
      const next = { ...state, participation: result.state };
      if (
        Buffer.byteLength(JSON.stringify(next)) >
        HISTORY_LIMITS.maxWorkspaceBytes - 128
      )
        throw new AccessError(
          413,
          'PARTICIPATION_CAPACITY',
          'The encrypted workspace has reached its safe history storage capacity.',
        );
      await saveWorkspace(client, ctx.organizationId, next);
      await audit(
        client,
        ctx.organizationId,
        ctx.user.id,
        'participation.' + request.command.kind,
        result.record.id,
        {
          workspaceRevision: revision + 1,
          participationRevision: result.state.revision,
          holdingId: result.record.holdingId,
          investmentId: result.record.investmentId,
          documentId: result.record.documentId,
          sourceSha256: result.record.sourceSha256,
          correctionOf: result.record.correctionOf ?? '',
        },
      );
      return {
        revision: revision + 1,
        participationRevision: result.state.revision,
        resultId: result.record.id,
      };
    });
  } catch (error) {
    if (error instanceof PortfolioHistoryError)
      throw new AccessError(error.status, error.code, error.message);
    throw error;
  }
}
