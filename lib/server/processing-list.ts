import 'server-only';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { AccessError, type WorkspaceContext } from './access';
import { decrypt } from './crypto';
import { readReview } from './review-store';
import { EngineSnapshotSchema } from '../engine-contract';
import {
  ExtractionSchema,
  ProcessingStatusSchema,
  type ProcessingJob,
  type ProcessingPage,
  type ProcessingSource,
} from '../processing-contract';
import type { ReviewState } from '../review-contract';
import {
  missingProcessingSummary,
  summarizeProcessing,
  summaryPayloadIds,
  PROCESSING_SUMMARY_BYTE_BUDGET,
  processingTiming,
  processingFamilyContext,
  type ProcessingAuditEvent,
} from './processing-metadata';

const QuerySchema = z.object({
  jobId: z.uuid().nullable(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  status: z
    .union([ProcessingStatusSchema, z.enum(['working', 'closed'])])
    .optional(),
  q: z.string().trim().max(200).default(''),
});
export type ProcessingListQuery = z.infer<typeof QuerySchema>;
export function processingListQuery(url: URL): ProcessingListQuery {
  const params = url.searchParams;
  if (params.has('jobId') && !z.uuid().safeParse(params.get('jobId')).success)
    throw new AccessError(400, 'INVALID_JOB', 'Choose a valid processing job.');
  const result = QuerySchema.safeParse({
    jobId: params.get('jobId'),
    ...(params.has('limit') ? { limit: params.get('limit') } : {}),
    ...(params.has('offset') ? { offset: params.get('offset') } : {}),
    ...(params.has('status') ? { status: params.get('status') } : {}),
    ...(params.has('q') ? { q: params.get('q') } : {}),
  });
  if (!result.success)
    throw new AccessError(
      400,
      'INVALID_PROCESSING_FILTER',
      'Use a valid document status, filename search, and page.',
    );
  return result.data;
}

type JobRow = {
  id: string;
  document_id: string;
  mode: ProcessingJob['mode'];
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  policy_revision: number;
  error_code: string | null;
  engine_snapshot: unknown;
  engine_legacy: boolean;
  review_revision: number;
  filename: string;
  has_result: boolean;
  payload_bytes: number;
  available_at: Date | string | null;
};
const jobColumns = `j.id,j.document_id,j.mode,j.status,j.created_at,j.updated_at,j.policy_revision,
 j.error_code,j.engine_snapshot,j.engine_legacy,j.review_revision,d.filename,
 (j.result IS NOT NULL) AS has_result,
 (coalesce(octet_length(j.result),0)+coalesce(octet_length(j.review_state),0)) AS payload_bytes,
 q.available_at`;
const jobFrom = `FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id
 LEFT JOIN app_job_queue q ON q.id=j.id AND q.organization_id=j.organization_id`;
function timestamp(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}
function statusFilter(status?: string): string[] | null {
  return status === 'working'
    ? ['queued', 'processing']
    : status === 'closed'
      ? ['cancelled', 'rejected']
      : status
        ? [status]
        : null;
}

type SourceRow = {
  id: string;
  folder_id: string | null;
  receipt_key: string | null;
  receipt_payload: Buffer | null;
  folder_config: Buffer | null;
  mailbox_id: string | null;
  mailbox_name: string | null;
};
const FolderSummarySchema = z.object({ displayName: z.string().max(120) });
const ReceiptSummarySchema = z.object({ relativePath: z.string().max(240) });
const WorkspaceContextSchema = z.object({
  portfolio: z
    .object({
      families: z
        .array(z.object({ id: z.string(), name: z.string() }))
        .max(10000),
      holdings: z
        .array(z.object({ id: z.string(), familyId: z.string() }))
        .max(100000),
    })
    .optional(),
});

/** All list enrichment remains in this tenant transaction. Original bytes are never selected. */
export async function listProcessingJobs(
  client: PoolClient,
  ctx: WorkspaceContext,
  input: ProcessingListQuery,
): Promise<{ jobs: ProcessingJob[]; page: ProcessingPage }> {
  // Defense in depth: processing includes unreleased sources, so scoped LP viewers
  // continue to use their released Documents/Reports surfaces, never this staff queue.
  if (ctx.scope)
    throw new AccessError(
      403,
      'SCOPED_ACCESS',
      'This queue is available to workspace staff.',
    );
  const filter = statusFilter(input.status);
  const [counts, listed] = await Promise.all([
    client.query<{ status: string; count: string }>(
      `SELECT j.status,count(*) AS count FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id
       WHERE j.organization_id=$1 AND ($2='' OR strpos(lower(d.filename),lower($2))>0) GROUP BY j.status`,
      [ctx.organizationId, input.q],
    ),
    client.query<JobRow>(
      `SELECT ${jobColumns} ${jobFrom} WHERE j.organization_id=$1
       AND ($2='' OR strpos(lower(d.filename),lower($2))>0) AND ($3::text[] IS NULL OR j.status=ANY($3))
       ORDER BY j.created_at DESC,j.id DESC LIMIT $4 OFFSET $5`,
      [ctx.organizationId, input.q, filter, input.limit, input.offset],
    ),
  ]);
  const pageRows = listed.rows;
  const rows = [...pageRows];
  if (input.jobId && !rows.some((row) => row.id === input.jobId)) {
    const selected = await client.query<JobRow>(
      `SELECT ${jobColumns} ${jobFrom} WHERE j.organization_id=$1 AND j.id=$2`,
      [ctx.organizationId, input.jobId],
    );
    if (!selected.rows[0])
      throw new AccessError(
        404,
        'JOB_NOT_FOUND',
        'The selected source review is not available in this office.',
      );
    rows.push(selected.rows[0]);
  }
  const selectedId = input.jobId ?? pageRows[0]?.id ?? null;
  const statusCounts = Object.fromEntries(
    ProcessingStatusSchema.options.map((status) => [status, 0]),
  ) as ProcessingPage['statusCounts'];
  for (const row of counts.rows)
    if (ProcessingStatusSchema.safeParse(row.status).success)
      statusCounts[row.status as keyof typeof statusCounts] = Number(row.count);
  const total = Object.entries(statusCounts).reduce(
    (sum, [status, count]) =>
      sum + (!filter || filter.includes(status) ? count : 0),
    0,
  );
  const nextOffset = input.offset + input.limit;
  const page: ProcessingPage = {
    limit: input.limit,
    offset: input.offset,
    total,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total && nextOffset <= 100000 ? nextOffset : null,
    jobIds: pageRows.map((row) => row.id),
    statusCounts,
    maxOffset: 100000,
  };
  if (!rows.length) return { jobs: [], page };
  const payloadIds = summaryPayloadIds(rows, selectedId);
  const ids = rows.map((row) => row.id),
    documentIds = [...new Set(rows.map((row) => row.document_id))];
  const [payloads, auditRows, sources, workspace] = await Promise.all([
    client.query<{
      id: string;
      status: string;
      review_revision: number;
      result: Buffer | null;
      review_state: Buffer | null;
    }>(
      `WITH sized AS (
        SELECT id,status,review_revision,result,review_state,
         sum(coalesce(octet_length(result),0)+coalesce(octet_length(review_state),0)) OVER (ORDER BY array_position($2::uuid[],id)) AS running_bytes
        FROM app_jobs WHERE organization_id=$1 AND id=ANY($2::uuid[])
       ) SELECT id,status,review_revision,
        CASE WHEN running_bytes<=$3 THEN result END AS result,
        CASE WHEN running_bytes<=$3 THEN review_state END AS review_state FROM sized`,
      [ctx.organizationId, payloadIds, PROCESSING_SUMMARY_BYTE_BUDGET],
    ),
    client.query<ProcessingAuditEvent>(
      `SELECT DISTINCT ON(resource_id,action) resource_id,sequence,action,created_at,
        details->>'attemptId' AS attempt_id,details->>'durationMs' AS duration_ms,
        count(*) FILTER(WHERE action='processing.started') OVER(PARTITION BY resource_id) AS attempt_count
       FROM app_audit WHERE organization_id=$1 AND resource_id=ANY($2::text[])
        AND ((actor_id='worker' AND action IN ('processing.started','processing.completed','processing.failed','processing.requeued'))
          OR action IN ('processing.retry','processing.cancel'))
       ORDER BY resource_id,action,sequence DESC`,
      [ctx.organizationId, ids],
    ),
    client.query<SourceRow>(
      `SELECT d.id,f.connection_id AS folder_id,f.receipt_key,f.payload AS receipt_payload,c.config AS folder_config,
        m.id AS mailbox_id,m.display_name AS mailbox_name
       FROM app_documents d
       LEFT JOIN LATERAL (SELECT connection_id,receipt_key,payload FROM app_folder_receipts
         WHERE organization_id=$1 AND document_id=d.id ORDER BY created_at,receipt_key LIMIT 1) f ON true
       LEFT JOIN app_folder_connections c ON c.id=f.connection_id AND c.organization_id=$1
       LEFT JOIN LATERAL (SELECT m.id,m.display_name FROM app_mailbox_receipts r JOIN app_mailboxes m ON m.id=r.mailbox_id AND m.organization_id=r.organization_id
         WHERE r.organization_id=$1 AND r.document_id=d.id ORDER BY r.created_at,r.mailbox_id LIMIT 1) m ON true
       WHERE d.organization_id=$1 AND d.id=ANY($2::uuid[])`,
      [ctx.organizationId, documentIds],
    ),
    client.query<{ payload: Buffer | null }>(
      'SELECT CASE WHEN octet_length(payload)<=8388608 THEN payload END AS payload FROM app_workspace WHERE organization_id=$1',
      [ctx.organizationId],
    ),
  ]);
  let portfolio: z.infer<typeof WorkspaceContextSchema>['portfolio'];
  if (workspace.rows[0]?.payload) {
    try {
      portfolio = WorkspaceContextSchema.parse(
        JSON.parse(
          decrypt(
            workspace.rows[0].payload,
            'workspace:' + ctx.organizationId,
          ).toString(),
        ),
      ).portfolio;
    } catch {
      /* Context is optional; never substitute sample families. */
    }
  }
  const payloadMap = new Map(payloads.rows.map((row) => [row.id, row]));
  const sourceMap = new Map(sources.rows.map((row) => [row.id, row]));
  const jobs = rows.map((row): ProcessingJob => {
    const stored = payloadMap.get(row.id);
    let result: z.infer<typeof ExtractionSchema> | null = null,
      review: ReviewState | null = null;
    let summary = missingProcessingSummary(
      row.has_result ? 'size_limit' : 'not_extracted',
    );
    if (stored?.result) {
      try {
        result = ExtractionSchema.parse(
          JSON.parse(
            decrypt(
              stored.result,
              'result:' + ctx.organizationId + ':' + row.id,
            ).toString(),
          ),
        );
        if (result.documentId !== row.document_id || result.mode !== row.mode)
          throw new Error('RESULT_IDENTITY_MISMATCH');
        review = readReview(stored, ctx.organizationId, result);
        summary = summarizeProcessing(result, review);
      } catch (error) {
        if (row.id === selectedId) throw error;
        result = null;
        review = null;
        summary = missingProcessingSummary('unavailable');
      }
    }
    const sourceRow = sourceMap.get(row.document_id);
    const source: ProcessingSource = {
      kind: sourceRow?.folder_id
        ? 'folder'
        : sourceRow?.mailbox_id
          ? 'mailbox'
          : 'upload',
      displayName: sourceRow?.mailbox_name ?? null,
      relativePath: null,
      familyNames: [],
      familyContext: 'unknown',
    };
    if (sourceRow?.folder_id) {
      try {
        if (sourceRow.folder_config)
          source.displayName = FolderSummarySchema.parse(
            JSON.parse(
              decrypt(
                sourceRow.folder_config,
                'folder-config:' +
                  ctx.organizationId +
                  ':' +
                  sourceRow.folder_id,
              ).toString(),
            ),
          ).displayName;
        if (sourceRow.receipt_payload)
          source.relativePath = ReceiptSummarySchema.parse(
            JSON.parse(
              decrypt(
                sourceRow.receipt_payload,
                'folder-receipt:' +
                  ctx.organizationId +
                  ':' +
                  sourceRow.folder_id +
                  ':' +
                  sourceRow.receipt_key,
              ).toString(),
            ),
          ).relativePath;
      } catch {
        /* Keep unavailable source context unknown without hiding the job. */
      }
    }
    Object.assign(
      source,
      processingFamilyContext(
        review,
        source.relativePath,
        portfolio?.families ?? [],
        portfolio?.holdings ?? [],
      ),
    );
    const status = stored?.status ?? row.status;
    return {
      id: row.id,
      documentId: row.document_id,
      filename: row.filename,
      mode: row.mode,
      status,
      createdAt: timestamp(row.created_at)!,
      updatedAt: timestamp(row.updated_at)!,
      policyRevision: row.policy_revision,
      errorCode: row.error_code,
      engine: row.engine_snapshot
        ? EngineSnapshotSchema.parse(row.engine_snapshot)
        : null,
      engineLegacy: row.engine_legacy,
      result: row.id === selectedId ? result : null,
      review: row.id === selectedId ? review : null,
      summary,
      source,
      timing: processingTiming(
        status,
        auditRows.rows.filter((event) => event.resource_id === row.id),
      ),
      activity: {
        stage:
          status === 'queued' && row.error_code === 'PROCESSOR_BUSY'
            ? 'waiting_for_capacity'
            : ProcessingStatusSchema.parse(status),
        availableAt: timestamp(row.available_at),
      },
    };
  });
  return { jobs, page };
}
