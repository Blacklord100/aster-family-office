import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { deriveWorkspace, type WorkspaceState } from '../workspace';
import { readWorkspaceInTransaction, saveWorkspace } from '../workspace-store';
import { DataScopeSchema, scopeAllows } from '../data-scope';
import { scopeReportObligations } from '../report-obligations-scope';
import {
  reportObligationsRequestSchema,
  type ReportObligationsRequest,
  type ReportObligationsResponse,
} from '../report-obligations-api';
import {
  emptyReportObligationsState,
  reportObligationsStateSchema,
  type ReportEvidenceReference,
  type ReportObligationsState,
  type ReportScheduleInput,
} from '../report-obligations-contract';
import {
  actOnReportException,
  createReportSchedule,
  disposeReportOccurrence,
  evaluateReportObligations,
  matchReportReceipt,
  reinstateReportReceipt,
  reportLocalDate,
  reviseReportSchedule,
  revokeReportReceipt,
} from '../report-obligations';
import { AccessError, roleAllows, type WorkspaceContext } from './access';
import { withTenant } from './db';
import { audit } from './audit';
import { sha256 } from './crypto';
import { releasedDocumentIds } from './data-scope';
import {
  ensureReportObligations,
  scheduleReportObligations,
} from './report-obligations-queue';
import {
  readObligationSources,
  sourceExceptionSignals,
  sourceReceiptStatus,
  staleReportSignals,
  type ObligationSources,
} from './report-obligations-sources';

type Member = { userId: string; name: string; role: string };
function domain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError(
      400,
      'REPORT_OBLIGATION_INVALID',
      error instanceof Error && error.name !== 'ZodError'
        ? error.message
        : 'Check the report schedule, period and supporting evidence.',
    );
  }
}
async function currentAccess(
  client: PoolClient,
  ctx: WorkspaceContext,
  permission: 'read' | 'write' | 'admin',
) {
  const member = (
    await client.query<{ role: string; data_scope: unknown }>(
      'SELECT m.role,m.data_scope FROM app_memberships m JOIN auth_session s ON s."userId"=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND s.id=$3 AND s."expiresAt">now() FOR SHARE OF m',
      [ctx.organizationId, ctx.user.id, ctx.sessionId],
    )
  ).rows[0];
  if (
    !member ||
    !roleAllows(member.role, permission) ||
    member.role !== ctx.role ||
    JSON.stringify(
      member.data_scope == null
        ? null
        : DataScopeSchema.parse(member.data_scope),
    ) !== JSON.stringify(ctx.scope ?? null) ||
    (permission !== 'read' && member.data_scope)
  )
    throw new AccessError(
      403,
      'ACCESS_CHANGED',
      'Your workspace access changed. Reload before continuing.',
    );
}
async function members(
  client: PoolClient,
  organizationId: string,
): Promise<Member[]> {
  return (
    await client.query<Member>(
      "SELECT u.id AS \"userId\",u.name,m.role FROM app_memberships m JOIN auth_user u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.revoked_at IS NULL AND m.data_scope IS NULL AND m.role IN ('owner','admin','analyst') ORDER BY u.name,u.id",
      [organizationId],
    )
  ).rows;
}
function validateOwner(userId: string | null, team: Member[]) {
  if (userId !== null && !team.some((row) => row.userId === userId))
    throw new AccessError(
      400,
      'ASSIGNEE_UNAVAILABLE',
      'Choose an active reviewer from this office.',
    );
}
function scheduleInput(
  input: ReportScheduleInput,
  workspace: WorkspaceState,
  team: Member[],
): ReportScheduleInput {
  const data = deriveWorkspace(workspace),
    selected = input.holdingIds.map((id) =>
      data.holdings.find((row) => row.id === id),
    );
  if (selected.some((row) => !row))
    throw new AccessError(
      400,
      'HOLDING_UNAVAILABLE',
      'Choose registered holdings from this office.',
    );
  validateOwner(input.ownerUserId, team);
  if (
    input.managerId &&
    !workspace.intelligence?.managers.some((row) => row.id === input.managerId)
  )
    throw new AccessError(
      400,
      'MANAGER_UNAVAILABLE',
      'Choose a registered manager from this office.',
    );
  return {
    ...input,
    familyIds: [...new Set(selected.map((row) => row!.familyId))],
  };
}
function bounded(state: WorkspaceState) {
  reportObligationsStateSchema.parse(state.obligations);
  if (
    Buffer.byteLength(
      JSON.stringify({
        state: state.obligations,
        receipts: state.obligationReceipts,
      }),
    ) >
    16 * 1024 * 1024
  )
    throw new AccessError(
      409,
      'REPORT_STORAGE_LIMIT',
      'The encrypted reporting store has reached its 16 MiB limit. Arrange additional storage; no history has been discarded.',
    );
}
function evaluate(
  workspace: WorkspaceState,
  state: ReportObligationsState,
  sources: ObligationSources,
  now: string,
): ReportObligationsState {
  let next = state;
  const byId = new Map(sources.documents.map((row) => [row.id, row]));
  for (const occurrence of state.occurrences)
    for (const receipt of occurrence.receipts) {
      const source = byId.get(receipt.documentId);
      if (!source || receipt.matchStatus !== 'matched') continue;
      const {
        id: _id,
        matchedAt: _at,
        matchedBy: _by,
        matchStatus: _status,
        history: _history,
        ...input
      } = receipt;
      next = matchReportReceipt(
        next,
        occurrence.id,
        { ...input, ...sourceReceiptStatus(source) },
        { actorUserId: 'system:reporting-calendar', now },
      );
    }
  // Materialize started periods only: their due dates can be in the future.
  // This preserves explicit future revision boundaries without rewriting a row.
  const starts = next.schedules.flatMap((row) =>
    row.versions.map((version) => version.definition.firstPeriodStart),
  );
  const today = now.slice(0, 10),
    from = starts.length ? starts.sort()[0] : today;
  const through = next.schedules.reduce(
    (latest, row) =>
      row.versions.reduce((date, version) => {
        const local = reportLocalDate(now, version.definition.timezone);
        return local > date ? local : date;
      }, latest),
    today,
  );
  if (from <= through)
    next = evaluateReportObligations(next, {
      from,
      through,
      now,
      maxNewOccurrences: 5000,
      startedPeriodsOnly: true,
    });
  const issues = [
    ...sourceExceptionSignals(workspace, sources, now),
    ...staleReportSignals(workspace, next, now),
  ];
  return evaluateReportObligations(next, {
    from: from <= through ? from : through,
    through,
    now,
    issues,
    externalSignalsComplete: false,
    startedPeriodsOnly: true,
  });
}
async function persistEvaluation(
  client: PoolClient,
  organizationId: string,
  workspace: WorkspaceState,
  sources: ObligationSources,
  now: string,
) {
  const previous = workspace.obligations ?? emptyReportObligationsState(),
    next = evaluate(workspace, previous, sources, now);
  if (JSON.stringify(previous) === JSON.stringify(next)) return false;
  workspace.obligations = next;
  bounded(workspace);
  await saveWorkspace(client, organizationId, workspace);
  await audit(
    client,
    organizationId,
    'system:reporting-calendar',
    'report-obligations.reconciled',
    organizationId,
    {
      schedules: next.schedules.length,
      occurrences: next.occurrences.length,
      exceptions: next.exceptions.length,
    },
  );
  return true;
}

async function response(
  client: PoolClient,
  ctx: WorkspaceContext,
  workspace: WorkspaceState,
  revision: number,
  sources: ObligationSources,
  team: Member[],
  now: string,
): Promise<ReportObligationsResponse> {
  const data = deriveWorkspace(workspace),
    scoped = !!ctx.scope;
  const holdings = data.holdings.filter((row) =>
    scopeAllows(ctx.scope, row.familyId, row.entityId),
  );
  const allowed = await releasedDocumentIds(client, ctx);
  let state = workspace.obligations ?? emptyReportObligationsState();
  if (scoped) {
    // Includes historical review IDs, not just the latest mode's job.
    const reviews = await client.query<{ id: string; document_id: string }>(
      'SELECT id,document_id FROM app_jobs WHERE organization_id=$1 AND document_id=ANY($2::uuid[])',
      [ctx.organizationId, [...allowed]],
    );
    state = scopeReportObligations(
      state,
      new Set(holdings.map((row) => row.id)),
      allowed,
      new Map(reviews.rows.map((row) => [row.id, row.document_id])),
    );
  }
  const documents = sources.documents.filter(
    (row) => !scoped || allowed.has(row.id),
  );
  const familyIds = new Set(holdings.map((row) => row.familyId));
  const monitorRow = (
    await client.query<{ run_after: Date; error_code: string | null }>(
      'SELECT run_after,error_code FROM app_report_obligations_queue WHERE organization_id=$1',
      [ctx.organizationId],
    )
  ).rows[0];
  const delay = monitorRow
    ? Date.parse(now) - monitorRow.run_after.getTime()
    : 0;
  const monitor: ReportObligationsResponse['monitor'] = {
    status: monitorRow?.error_code
      ? 'error'
      : delay > 180_000
        ? 'delayed'
        : monitorRow && delay < 0
          ? 'current'
          : 'pending',
    nextCheckAt: monitorRow?.run_after.toISOString() ?? null,
  };
  return {
    revision,
    canWrite: roleAllows(ctx.role, 'write') && !scoped,
    canAdmin: roleAllows(ctx.role, 'admin') && !scoped,
    asOf: now,
    state,
    monitor,
    options: {
      holdings: holdings.map(({ id, name, familyId, entityId, manager }) => ({
        id,
        name,
        familyId,
        entityId,
        manager,
      })),
      families: data.families
        .filter((row) => familyIds.has(row.id))
        .map(({ id, name }) => ({ id, name })),
      members: scoped ? [] : team,
      documents: documents.map((row) => ({
        id: row.id,
        filename: row.filename,
        sha256: row.content_hash,
        receivedAt: row.created_at.toISOString(),
        jobId: scoped ? null : row.job_id,
        status: sourceReceiptStatus(row).processingStatus,
        reviewStatus: sourceReceiptStatus(row).reviewStatus,
      })),
    },
    coverage: {
      jobsScanned: documents.length,
      totalJobs: scoped ? documents.length : sources.total,
      truncated: scoped ? false : sources.truncated,
      notes: [
        'Arrival is the time the original was imported into Aster, not a sender-supplied email date.',
        'Started reporting periods are materialized automatically. Future schedule changes preserve existing obligations.',
        ...(sources.truncated && !scoped
          ? [
              'The current scan covers 2,000 recent documents plus retained references. Older unlinked sources are not covered; omitted issues remain open.',
            ]
          : []),
        ...(scoped
          ? [
              'Only complete permitted records and explicitly released originals are shown.',
            ]
          : []),
      ],
    },
  };
}

export async function readReportObligations(
  ctx: WorkspaceContext,
): Promise<ReportObligationsResponse> {
  return withTenant(ctx.organizationId, async (client) => {
    await currentAccess(client, ctx, 'read');
    const { state, revision } = await readWorkspaceInTransaction(
        client,
        ctx.organizationId,
        true,
      ),
      now = new Date().toISOString();
    const sources = await readObligationSources(
      client,
      ctx.organizationId,
      state.obligations ?? emptyReportObligationsState(),
    );
    const changed = await persistEvaluation(
      client,
      ctx.organizationId,
      state,
      sources,
      now,
    );
    await ensureReportObligations(client, ctx.organizationId);
    return response(
      client,
      ctx,
      state,
      revision + Number(changed),
      sources,
      ctx.scope ? [] : await members(client, ctx.organizationId),
      now,
    );
  });
}

async function validateEvidence(
  client: PoolClient,
  ctx: WorkspaceContext,
  evidence: ReportEvidenceReference[],
  workspace: WorkspaceState,
  sources: ObligationSources,
  issueId: string,
) {
  const holdings = new Set(
    deriveWorkspace(workspace).holdings.map((row) => row.id),
  );
  for (const ref of evidence) {
    if (ref.kind === 'holding' && holdings.has(ref.id)) continue;
    if (
      ref.kind === 'note' &&
      (ref.id === issueId ||
        workspace.intelligence?.proposals.some((row) => row.id === ref.id))
    )
      continue;
    if (
      ref.kind === 'review' &&
      z.uuid().safeParse(ref.id).success &&
      (
        await client.query(
          'SELECT 1 FROM app_jobs WHERE organization_id=$1 AND id=$2::uuid',
          [ctx.organizationId, ref.id],
        )
      ).rows.length
    )
      continue;
    if (
      ref.kind === 'document' &&
      sources.documents.some((row) => row.id === ref.id)
    )
      continue;
    throw new AccessError(
      400,
      'EVIDENCE_UNAVAILABLE',
      'Choose supporting evidence available in this office.',
    );
  }
}

export async function saveReportObligations(
  ctx: WorkspaceContext,
  value: ReportObligationsRequest,
): Promise<ReportObligationsResponse> {
  const input = reportObligationsRequestSchema.parse(value),
    permission = ['createSchedule', 'reviseSchedule'].includes(input.action)
      ? 'admin'
      : 'write';
  if (ctx.scope || !roleAllows(ctx.role, permission))
    throw new AccessError(
      403,
      'FORBIDDEN',
      'You do not have permission for this reporting action.',
    );
  const {
      expectedRevision: _revision,
      idempotencyKey: _key,
      ...intent
    } = input,
    digest = sha256(JSON.stringify(intent));
  return withTenant(ctx.organizationId, async (client) => {
    await currentAccess(client, ctx, permission);
    const { state, revision } = await readWorkspaceInTransaction(
        client,
        ctx.organizationId,
        true,
      ),
      now = new Date().toISOString();
    const receipts = state.obligationReceipts ?? [],
      previous = receipts.find((row) => row.key === input.idempotencyKey);
    if (previous && previous.digest !== digest)
      throw new AccessError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This request key was already used for another action.',
      );
    if (!previous && revision !== input.expectedRevision)
      throw new AccessError(
        409,
        'REPORT_OBLIGATIONS_CHANGED',
        'Another update changed this workspace. Reload and review the current record before submitting again.',
      );
    const sources = await readObligationSources(
        client,
        ctx.organizationId,
        state.obligations ?? emptyReportObligationsState(),
      ),
      team = await members(client, ctx.organizationId);
    if (previous)
      return {
        ...(await response(client, ctx, state, revision, sources, team, now)),
        resultId: previous.resultId,
        duplicate: true,
      };
    if (receipts.length >= 25_000)
      throw new AccessError(
        409,
        'REPORT_REQUEST_LIMIT',
        'The retained request ledger is full. Arrange additional storage; no history has been removed.',
      );
    let obligations = state.obligations ?? emptyReportObligationsState(),
      resultId = randomUUID() as string;
    const context = { actorUserId: ctx.user.id, now, id: resultId };
    if (input.action === 'createSchedule')
      obligations = domain(() =>
        createReportSchedule(
          obligations,
          scheduleInput(input.input, state, team),
          context,
          input.reason,
        ),
      );
    else if (input.action === 'reviseSchedule') {
      resultId = input.scheduleId;
      obligations = domain(() =>
        reviseReportSchedule(
          obligations,
          input.scheduleId,
          scheduleInput(input.input, state, team),
          input.effectiveFrom,
          context,
          { status: input.status, reason: input.reason },
        ),
      );
    } else if (input.action === 'matchReceipt') {
      const source = sources.documents.find(
        (row) => row.id === input.documentId,
      );
      if (!source)
        throw new AccessError(
          404,
          'SOURCE_UNAVAILABLE',
          'Choose a retained original from this office.',
        );
      if (
        !input.holdingIds.every((id) =>
          deriveWorkspace(state).holdings.some((row) => row.id === id),
        )
      )
        throw new AccessError(
          400,
          'HOLDING_UNAVAILABLE',
          'Choose registered holdings from this office.',
        );
      const opened = await client.query(
        "SELECT 1 FROM app_audit WHERE organization_id=$1 AND actor_id=$2 AND resource_id=$3 AND action IN ('document.downloaded','document.previewed') LIMIT 1",
        [ctx.organizationId, ctx.user.id, source.id],
      );
      if (!opened.rows.length)
        throw new AccessError(
          400,
          'ORIGINAL_REVIEW_REQUIRED',
          'Open the original source before confirming its report type, period and holding coverage.',
        );
      resultId = input.occurrenceId;
      obligations = domain(() =>
        matchReportReceipt(
          obligations,
          input.occurrenceId,
          {
            documentId: source.id,
            documentHash: source.content_hash,
            holdingIds: input.holdingIds,
            reportType: input.reportType,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            asOfDate: input.asOfDate,
            receivedAt: source.created_at.toISOString(),
            ...sourceReceiptStatus(source),
            matchReason: input.reason,
            matchEvidence: [
              {
                kind: 'document',
                id: source.id,
                label: source.filename.slice(0, 240),
              },
            ],
            supersedesReceiptId: input.supersedesReceiptId ?? null,
          },
          context,
        ),
      );
    } else if (
      input.action === 'revokeReceipt' ||
      input.action === 'reinstateReceipt'
    ) {
      resultId = input.occurrenceId;
      obligations = domain(() =>
        (input.action === 'revokeReceipt'
          ? revokeReportReceipt
          : reinstateReportReceipt)(
          obligations,
          input.occurrenceId,
          input.receiptId,
          input.reason,
          context,
        ),
      );
    } else if (input.action === 'disposition') {
      resultId = input.occurrenceId;
      obligations = domain(() =>
        disposeReportOccurrence(
          obligations,
          input.occurrenceId,
          {
            status: input.status,
            reason: input.reason,
            evidence: [
              {
                kind: 'note',
                id: input.occurrenceId,
                label: 'Reviewed reporting disposition',
              },
            ],
          },
          context,
        ),
      );
    } else if (input.action === 'exception') {
      resultId = input.exceptionId;
      if (input.operation.action === 'assign')
        validateOwner(input.operation.assigneeUserId, team);
      if ('evidence' in input.operation)
        await validateEvidence(
          client,
          ctx,
          input.operation.evidence,
          state,
          sources,
          input.exceptionId,
        );
      obligations = domain(() =>
        actOnReportException(
          obligations,
          input.exceptionId,
          input.operation,
          context,
        ),
      );
    }
    state.obligations = domain(() =>
      evaluate(state, obligations, sources, now),
    );
    state.obligationReceipts = [
      ...receipts,
      { key: input.idempotencyKey, digest, resultId },
    ];
    bounded(state);
    await saveWorkspace(client, ctx.organizationId, state);
    await scheduleReportObligations(client, ctx.organizationId);
    await audit(
      client,
      ctx.organizationId,
      ctx.user.id,
      `report-obligations.${input.action}`,
      resultId,
      { revision, intentDigest: digest },
    );
    return {
      ...(await response(client, ctx, state, revision + 1, sources, team, now)),
      resultId,
    };
  });
}

export async function reconcileReportObligations(
  organizationId: string,
): Promise<{ changed: boolean }> {
  return withTenant(organizationId, async (client) => {
    const { state } = await readWorkspaceInTransaction(
      client,
      organizationId,
      true,
    );
    const sources = await readObligationSources(
      client,
      organizationId,
      state.obligations ?? emptyReportObligationsState(),
    );
    return {
      changed: await persistEvaluation(
        client,
        organizationId,
        state,
        sources,
        new Date().toISOString(),
      ),
    };
  });
}
