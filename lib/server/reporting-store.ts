import 'server-only';
import { randomUUID } from 'node:crypto';
import { deriveWorkspace, type WorkspaceState } from '../workspace';
import {
  readWorkspace,
  readWorkspaceInTransaction,
  saveWorkspace,
} from '../workspace-store';
import {
  emptyReportingState,
  reportingRequestSchema,
  type PeriodQuery,
  type ReportingRequest,
  type ReportingResponse,
  type ReportingSnapshot,
  type SnapshotSummary,
} from '../reporting-contract';
import {
  evaluatePeriod,
  reportingHoldings,
  scopedReportingInputs,
  scopedRiskData,
} from '../reporting';
import { buildTotalExposure, runStressScenario } from '../risk-engine';
import { LedgerError } from '../ledger';
import { AccessError, roleAllows, type WorkspaceContext } from './access';
import { withTenant } from './db';
import { audit } from './audit';
import { sha256 } from './crypto';
import {
  readPortfolioHistory,
  assertHistoryAccess,
  readHistoryWorkspace,
} from './portfolio-history-store';

export function snapshotIntegrity(snapshot: ReportingSnapshot): boolean {
  return (
    snapshot.inputDigest === sha256(JSON.stringify(snapshot.inputs)) &&
    snapshot.resultDigest === sha256(JSON.stringify(snapshot.result))
  );
}
function summaries(state: WorkspaceState): SnapshotSummary[] {
  return (state.reporting?.snapshots ?? []).map((snapshot) => {
    const holdings =
      snapshot.kind === 'history'
        ? snapshot.result.positions
        : snapshot.kind === 'period'
          ? snapshot.inputs.portfolio.holdings
          : snapshot.inputs.holdings;
    return {
      id: snapshot.id,
      kind: snapshot.kind,
      name: snapshot.name,
      createdAt: snapshot.createdAt,
      createdBy: snapshot.createdBy,
      workspaceRevision: snapshot.workspaceRevision,
      financeRevision: snapshot.financeRevision,
      familyIds: [...new Set(holdings.map((h) => h.familyId))],
      entityIds: [...new Set(holdings.map((h) => h.entityId))],
      integrity: snapshotIntegrity(snapshot) ? 'verified' : 'changed',
    };
  });
}
function translate(error: unknown): never {
  if (error instanceof LedgerError)
    throw new AccessError(error.status, error.code, error.message);
  throw error;
}
export async function readReporting(
  ctx: WorkspaceContext,
  query?: PeriodQuery,
  id?: string,
): Promise<ReportingResponse> {
  try {
    const { state, revision } = await readWorkspace(ctx);
    const snapshot = id
      ? state.reporting?.snapshots.find((row) => row.id === id)
      : undefined;
    if (id && !snapshot)
      throw new AccessError(
        404,
        'SNAPSHOT_NOT_FOUND',
        'This snapshot is not available in the selected workspace and access scope.',
      );
    if (snapshot && !snapshotIntegrity(snapshot))
      throw new AccessError(
        409,
        'SNAPSHOT_CHANGED',
        'The saved inputs or results failed their integrity check.',
      );
    return {
      revision,
      canWrite: roleAllows(ctx.role, 'write') && !ctx.scope,
      snapshots: summaries(state),
      ...(query
        ? {
            period: evaluatePeriod(
              deriveWorkspace(state),
              state.finance,
              query,
              new Date().toISOString(),
            ),
          }
        : {}),
      ...(snapshot ? { snapshot } : {}),
    };
  } catch (error) {
    translate(error);
  }
}
export async function saveReporting(
  ctx: WorkspaceContext,
  value: ReportingRequest,
): Promise<ReportingResponse> {
  if (!roleAllows(ctx.role, 'write') || ctx.scope)
    throw new AccessError(
      403,
      'FORBIDDEN',
      'You do not have permission to save reports.',
    );
  const input = reportingRequestSchema.parse(value),
    { expectedRevision: _revision, idempotencyKey: _key, ...intent } = input,
    digest = sha256(JSON.stringify(intent));
  // Exact retries must remain available even if the live history has since
  // lost source coverage or can no longer be recalculated within observation limits.
  if (input.action === 'saveHistory') {
    const prior = await withTenant(ctx.organizationId, async (client) => {
      await assertHistoryAccess(client, ctx, true);
      const { state, revision } = await readHistoryWorkspace(
        client,
        ctx.organizationId,
        true,
      );
      const reporting = state.reporting ?? emptyReportingState();
      const receipt = reporting.receipts.find(
        (row) => row.key === input.idempotencyKey,
      );
      if (!receipt) return null;
      if (receipt.digest !== digest)
        throw new AccessError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'The snapshot request key was already used for different inputs.',
        );
      const snapshot = reporting.snapshots.find(
        (row) => row.id === receipt.resultId,
      );
      if (!snapshot || !snapshotIntegrity(snapshot))
        throw new AccessError(
          409,
          'SNAPSHOT_CHANGED',
          'The original saved snapshot could not be verified.',
        );
      return {
        revision,
        canWrite: true,
        snapshots: summaries(state),
        snapshot,
        resultId: receipt.resultId,
        duplicate: true,
      };
    });
    if (prior) return prior;
  }
  const history =
    input.action === 'saveHistory'
      ? await readPortfolioHistory(ctx, input.query)
      : null;
  const historyObservations = history
    ? ([] as typeof history.observations)
    : null;
  if (history && historyObservations) {
    // Pin the economic date and revision across bounded pages. A concurrent
    // acceptance fails the save rather than mixing versions in a report.
    for (let offset = 0; offset < history.page.total; offset += 100) {
      const page = await readPortfolioHistory(ctx, {
        ...history.query,
        asOf: history.asOf,
        observationId: undefined,
        offset,
        limit: 100,
      });
      if (
        page.revision !== history.revision ||
        page.page.total !== history.page.total
      )
        throw new AccessError(
          409,
          'REPORTING_CHANGED',
          'The history changed while preparing the snapshot. Refresh and save again.',
        );
      historyObservations.push(...page.observations);
    }
  }
  try {
    return await withTenant(ctx.organizationId, async (client) => {
      if (input.action === 'saveHistory')
        await assertHistoryAccess(client, ctx, true);
      const { state, revision } = await (
          input.action === 'saveHistory'
            ? readHistoryWorkspace
            : readWorkspaceInTransaction
        )(client, ctx.organizationId, true),
        reporting = state.reporting ?? emptyReportingState();
      const receipt = reporting.receipts.find(
        (row) => row.key === input.idempotencyKey,
      );
      if (receipt) {
        if (receipt.digest !== digest)
          throw new AccessError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'The snapshot request key was already used for different inputs.',
          );
        const snapshot = reporting.snapshots.find(
          (row) => row.id === receipt.resultId,
        );
        if (!snapshot || !snapshotIntegrity(snapshot))
          throw new AccessError(
            409,
            'SNAPSHOT_CHANGED',
            'The original saved snapshot could not be verified.',
          );
        return {
          revision,
          canWrite: true,
          snapshots: summaries(state),
          snapshot,
          resultId: receipt.resultId,
          duplicate: true,
        };
      }
      if (revision !== input.expectedRevision)
        throw new AccessError(
          409,
          'REPORTING_CHANGED',
          'The workspace changed. Recalculate the report before saving its inputs.',
        );
      if (reporting.snapshots.length >= 20)
        throw new AccessError(
          409,
          'SNAPSHOT_LIMIT',
          'This workspace supports at most 20 immutable report snapshots. Export existing snapshots before expanding storage.',
        );
      const data = deriveWorkspace(state),
        at = new Date().toISOString(),
        id = randomUUID();
      const base = {
        id,
        name: input.name,
        createdAt: at,
        createdBy: ctx.user.id,
        workspaceRevision: revision,
        financeRevision: state.finance?.revision ?? 0,
      };
      let snapshot: ReportingSnapshot;
      if (input.action === 'saveHistory') {
        if (!history || history.revision !== revision)
          throw new AccessError(
            409,
            'REPORTING_CHANGED',
            'The history changed. Refresh the view before saving.',
          );
        if (!history.positions.length)
          throw new AccessError(
            400,
            'NO_HOLDINGS',
            'Select investments with retained history before saving.',
          );
        const inputs = {
          query: { ...history.query, asOf: history.asOf },
          observations: historyObservations!,
          positions: history.positions,
          points: history.points,
          basis: history.basis,
          projectionVersion: history.projectionVersion,
          lifecycle: state.historyLifecycle
            ? {
                ...state.historyLifecycle,
                records: state.historyLifecycle.records.filter((record) =>
                  history.positions.some(
                    (position) => position.holdingId === record.holdingId,
                  ),
                ),
                receipts: [],
              }
            : null,
        };
        snapshot = {
          ...base,
          kind: 'history',
          inputs,
          result: history,
          inputDigest: sha256(JSON.stringify(inputs)),
          resultDigest: sha256(JSON.stringify(history)),
        };
      } else if (input.action === 'savePeriod') {
        const scoped = scopedReportingInputs(data, state.finance, input.query),
          inputs = { query: input.query, ...scoped },
          result = evaluatePeriod(
            scoped.portfolio,
            scoped.finance,
            input.query,
            at,
          );
        snapshot = {
          ...base,
          kind: 'period',
          inputs,
          result,
          inputDigest: sha256(JSON.stringify(inputs)),
          resultDigest: sha256(JSON.stringify(result)),
        };
      } else {
        const holdings = reportingHoldings(data, input.scope);
        if (!holdings.length)
          throw new AccessError(
            400,
            'NO_HOLDINGS',
            'Select registered holdings before saving a stress run.',
          );
        const holdingIds = new Set(holdings.map((h) => h.id)),
          inputs = {
            scope: input.scope,
            holdings: structuredClone(holdings),
            evidence: structuredClone(
              data.evidence.filter((source) =>
                holdingIds.has(source.holdingId),
              ),
            ),
            riskData: scopedRiskData(state.riskData, holdings),
            scenario: input.scenario,
            asOfDate: at.slice(0, 10),
          };
        const exposure = buildTotalExposure(
            inputs.holdings,
            inputs.riskData,
            inputs.asOfDate,
          ),
          result = {
            exposure,
            stress: runStressScenario(exposure, input.scenario),
          };
        snapshot = {
          ...base,
          kind: 'stress',
          inputs,
          result,
          inputDigest: sha256(JSON.stringify(inputs)),
          resultDigest: sha256(JSON.stringify(result)),
        };
      }
      const next = {
        ...state,
        reporting: {
          ...reporting,
          snapshots: [...reporting.snapshots, snapshot],
          receipts: [
            ...reporting.receipts,
            { key: input.idempotencyKey, digest, resultId: id },
          ],
        },
      };
      if (Buffer.byteLength(JSON.stringify(next.reporting)) > 8 * 1024 * 1024)
        throw new AccessError(
          409,
          'SNAPSHOT_STORAGE_LIMIT',
          'The bounded encrypted snapshot store is full. Export the report and arrange additional storage.',
        );
      await saveWorkspace(client, ctx.organizationId, next);
      await audit(
        client,
        ctx.organizationId,
        ctx.user.id,
        'reporting.' + snapshot.kind,
        id,
        {
          workspaceRevision: revision,
          inputDigest: snapshot.inputDigest,
          resultDigest: snapshot.resultDigest,
        },
      );
      return {
        revision: revision + 1,
        canWrite: true,
        snapshots: summaries(next),
        snapshot,
        resultId: id,
      };
    });
  } catch (error) {
    translate(error);
  }
}
