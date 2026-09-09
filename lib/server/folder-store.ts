import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withTenant } from './db';
import { AccessError, type WorkspaceContext } from './access';
import { audit, rateLimit } from './audit';
import { loadDemoCatalog } from './demo-corpus';
import { demoQueueOffset } from './folder-queue-order';
import { decrypt, encrypt, sha256 } from './crypto';
import {
  activeEngine,
  assertEngineEnabled,
  sealJobEngine,
} from './engine-store';
import {
  FolderConnectSchema,
  type FolderAction,
  type FolderConnectionInfo,
  type FolderFileInfo,
  type FolderResponse,
} from '../folder-connection-contract';
import {
  configuredIntakeRoot,
  listIntakeDirectories,
  resolveFolderDirectory,
} from './folder-files';

export const FolderConfigSchema = FolderConnectSchema.extend({
  isDemo: z.boolean(),
  cursorAfter: z.string().max(240).nullable(),
}).strict();
export type FolderConfig = z.infer<typeof FolderConfigSchema>;
export const FolderReceiptPayloadSchema = z
  .object({
    filename: z.string().min(1).max(240),
    relativePath: z.string().min(1).max(240),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(0),
  })
  .strict();
export function openFolderConfig(
  payload: Buffer,
  organizationId: string,
  id: string,
): FolderConfig {
  return FolderConfigSchema.parse(
    JSON.parse(
      decrypt(payload, 'folder-config:' + organizationId + ':' + id).toString(),
    ),
  );
}
export function sealFolderConfig(
  config: FolderConfig,
  organizationId: string,
  id: string,
): Buffer {
  return encrypt(
    JSON.stringify(FolderConfigSchema.parse(config)),
    'folder-config:' + organizationId + ':' + id,
  );
}
/** Recheck active unscoped membership and session inside every write transaction. */
async function assertManager(client: PoolClient, context: WorkspaceContext) {
  if (context.scope || !['owner', 'admin'].includes(context.role))
    throw new AccessError(
      403,
      'FORBIDDEN',
      'An administrator manages local intake connections.',
    );
  const result = await client.query(
    `SELECT 1 FROM app_memberships m JOIN auth_session s ON s."userId"=m.user_id
     WHERE m.organization_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND m.data_scope IS NULL
      AND m.role IN ('owner','admin') AND s.id=$3 AND s."expiresAt">now() AND s."mfaVerifiedAt" IS NOT NULL FOR SHARE OF m`,
    [context.organizationId, context.user.id, context.sessionId],
  );
  if (!result.rowCount)
    throw new AccessError(
      403,
      'FORBIDDEN',
      'Your administrator session is no longer active.',
    );
}
export async function listFolderConnections(
  context: WorkspaceContext,
): Promise<FolderResponse> {
  if (context.scope)
    throw new AccessError(
      403,
      'SCOPED_ACCESS',
      'Local intake is available to workspace staff.',
    );
  const configured = configuredIntakeRoot() !== null;
  const canManage = ['owner', 'admin'].includes(context.role);
  const demoDirectory = await withTenant(
    context.organizationId,
    async (client) => {
      const { rows } = await client.query<{
        demo_source_directory: string | null;
      }>(
        'SELECT demo_source_directory FROM app_organizations WHERE id=$1 AND demo_owner_user_id IS NOT NULL',
        [context.organizationId],
      );
      return rows[0]?.demo_source_directory ?? null;
    },
  );
  const directories = canManage
    ? await listIntakeDirectories(context.organizationId, demoDirectory)
    : [];
  const connections = await withTenant(
    context.organizationId,
    async (client) => {
      const { rows } = await client.query<{
        id: string;
        config: Buffer;
        status: FolderConnectionInfo['status'];
        connected_by: string;
        imported_count: number;
        skipped_count: number;
        last_synced_at: Date | null;
        error_code: string | null;
        available_at: Date | null;
      }>(
        `SELECT c.*,q.available_at FROM app_folder_connections c LEFT JOIN app_folder_queue q ON q.id=c.id AND q.organization_id=c.organization_id WHERE c.organization_id=$1 ORDER BY c.created_at,c.id LIMIT 100`,
        [context.organizationId],
      );
      const results: FolderConnectionInfo[] = [];
      for (const row of rows) {
        const config = openFolderConfig(
          row.config,
          context.organizationId,
          row.id,
        );
        const receiptCounts = (
          await client.query<{
            duplicate_count: number;
            unique_document_count: number;
          }>(
            "SELECT count(*) FILTER(WHERE outcome='duplicate')::int AS duplicate_count,count(DISTINCT document_id)::int AS unique_document_count FROM app_folder_receipts WHERE organization_id=$1 AND connection_id=$2",
            [context.organizationId, row.id],
          )
        ).rows[0];
        const count = await client.query<{ status: string; count: number }>(
          `SELECT latest.status,count(*)::int AS count FROM
         (SELECT DISTINCT document_id FROM app_folder_receipts WHERE organization_id=$1 AND connection_id=$2 AND document_id IS NOT NULL) docs
         JOIN LATERAL (SELECT status FROM app_jobs j WHERE j.organization_id=$1 AND j.document_id=docs.document_id ORDER BY j.created_at DESC,j.id DESC LIMIT 1) latest ON true GROUP BY latest.status`,
          [context.organizationId, row.id],
        );
        const statusCount = Object.fromEntries(
          count.rows.map((entry) => [entry.status, entry.count]),
        );
        const files = await client.query<{
          receipt_key: string;
          payload: Buffer;
          document_id: string | null;
          outcome: FolderFileInfo['outcome'];
          created_at: Date;
          job_id: string | null;
          status: string | null;
        }>(
          `SELECT r.*,latest.id AS job_id,latest.status FROM app_folder_receipts r
         LEFT JOIN LATERAL (SELECT j.id,j.status FROM app_jobs j WHERE j.organization_id=$1 AND j.document_id=r.document_id ORDER BY j.created_at DESC,j.id DESC LIMIT 1) latest ON true
         WHERE r.organization_id=$1 AND r.connection_id=$2 ORDER BY r.created_at DESC,r.receipt_key LIMIT 20`,
          [context.organizationId, row.id],
        );
        results.push({
          id: row.id,
          directory: config.directory,
          displayName: config.displayName,
          isDemo: config.isDemo,
          status: row.status,
          connectedBy: row.connected_by,
          currentUserCanManage: canManage,
          importedCount: row.imported_count,
          skippedCount: row.skipped_count,
          duplicateCount: receiptCounts.duplicate_count,
          uniqueDocumentCount: receiptCounts.unique_document_count,
          counts: {
            queued: statusCount.queued ?? 0,
            processing: statusCount.processing ?? 0,
            awaitingReview: statusCount.awaiting_review ?? 0,
            accepted: statusCount.accepted ?? 0,
            failed: (statusCount.failed ?? 0) + (statusCount.cancelled ?? 0),
            rejected: statusCount.rejected ?? 0,
          },
          lastSyncedAt: row.last_synced_at?.toISOString() ?? null,
          nextSyncAt: row.available_at?.toISOString() ?? null,
          errorCode: row.error_code,
          recentFiles: files.rows.map((file) => {
            const payload = FolderReceiptPayloadSchema.parse(
              JSON.parse(
                decrypt(
                  file.payload,
                  'folder-receipt:' +
                    context.organizationId +
                    ':' +
                    row.id +
                    ':' +
                    file.receipt_key,
                ).toString(),
              ),
            );
            return {
              filename: payload.filename,
              relativePath: payload.relativePath,
              documentId: file.document_id,
              jobId: file.job_id,
              outcome: file.outcome,
              status: file.status ?? file.outcome,
              importedAt: file.created_at.toISOString(),
            };
          }),
        });
      }
      return results;
    },
  );
  return {
    configured,
    rootLabel: 'Local intake',
    canManage,
    directories,
    connections,
  };
}
export async function connectFolder(
  context: WorkspaceContext,
  raw: z.infer<typeof FolderConnectSchema>,
) {
  return withTenant(context.organizationId, (client) =>
    connectFolderInTransaction(client, context, raw),
  );
}
export async function connectFolderInTransaction(
  client: PoolClient,
  context: WorkspaceContext,
  raw: z.infer<typeof FolderConnectSchema>,
) {
  const input = FolderConnectSchema.parse(raw);
  if (context.scope || !['owner', 'admin'].includes(context.role))
    throw new AccessError(
      403,
      'FORBIDDEN',
      'An administrator connects a local intake directory.',
    );
  await resolveFolderDirectory(context.organizationId, input.directory);
  await assertManager(client, context);
  if (
    !(await rateLimit(
      client,
      'folder-connect:' + context.organizationId + ':' + context.user.id,
      30,
      3600,
    ))
  )
    throw new AccessError(
      429,
      'RATE_LIMIT',
      'Please wait before connecting another folder.',
    );
  const org = await client.query<{
    demo_source_directory: string | null;
    demo_owner_user_id: string | null;
  }>(
    'SELECT demo_source_directory,demo_owner_user_id FROM app_organizations WHERE id=$1 FOR UPDATE',
    [context.organizationId],
  );
  const isDemo =
    org.rows[0]?.demo_owner_user_id !== null &&
    org.rows[0]?.demo_source_directory === input.directory;
  const directoryKey = sha256(context.organizationId + ':' + input.directory);
  const existing = await client.query<{
    id: string;
    config: Buffer;
    status: string;
  }>(
    'SELECT id,config,status FROM app_folder_connections WHERE organization_id=$1 AND directory_key=$2 FOR UPDATE',
    [context.organizationId, directoryKey],
  );
  if (existing.rows[0]?.status === 'active')
    return { id: existing.rows[0].id, duplicate: true };
  const count = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM app_folder_connections WHERE organization_id=$1',
    [context.organizationId],
  );
  if (!existing.rowCount && count.rows[0].count >= 100)
    throw new AccessError(
      409,
      'FOLDER_LIMIT',
      'This workspace has reached its folder connection limit.',
    );
  const id = existing.rows[0]?.id ?? randomUUID();
  const config = sealFolderConfig(
    { ...input, isDemo, cursorAfter: null },
    context.organizationId,
    id,
  );
  // Validate engine readiness before accepting a connection that would immediately fail.
  assertEngineEnabled(
    (await activeEngine(client, context.organizationId)).config,
  );
  if (existing.rowCount)
    await client.query(
      "UPDATE app_folder_connections SET config=$3,connected_by=$4,status='active',generation=generation+1,error_code=null,updated_at=now() WHERE id=$1 AND organization_id=$2",
      [id, context.organizationId, config, context.user.id],
    );
  else
    await client.query(
      'INSERT INTO app_folder_connections(id,organization_id,directory_key,connected_by,config) VALUES($1,$2,$3,$4,$5)',
      [id, context.organizationId, directoryKey, context.user.id, config],
    );
  await client.query(
    'INSERT INTO app_folder_queue(id,organization_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET available_at=now(),attempts=0',
    [id, context.organizationId],
  );
  await audit(
    client,
    context.organizationId,
    context.user.id,
    'folder.connected',
    id,
    { demo: isDemo },
  );
  return { id, duplicate: false };
}
/** Uses the same sealed engine/job queue contract as uploads and mailbox imports. */
export async function queueFolderDocument(
  client: PoolClient,
  organizationId: string,
  documentId: string,
  actorUserId: string,
): Promise<string> {
  const policy = await client.query<{
    processing_mode: string;
    policy_revision: number;
    demo_owner_user_id: string | null;
    demo_source_directory: string | null;
    created_at: Date;
  }>(
    'SELECT processing_mode,policy_revision,demo_owner_user_id,demo_source_directory,created_at FROM app_organizations WHERE id=$1 FOR SHARE',
    [organizationId],
  );
  const engine = await activeEngine(client, organizationId);
  assertEngineEnabled(engine.config);
  const jobId = randomUUID(),
    pinned = sealJobEngine(
      engine.config,
      engine.snapshot,
      organizationId,
      jobId,
    );
  await client.query(
    'INSERT INTO app_jobs(id,organization_id,document_id,created_by,mode,policy_revision,engine_snapshot,engine_config) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      jobId,
      organizationId,
      documentId,
      actorUserId,
      policy.rows[0].processing_mode,
      policy.rows[0].policy_revision,
      JSON.stringify(pinned.snapshot),
      pinned.payload,
    ],
  );
  let availableAt: Date | null = null;
  if (
    process.env.ASTER_ENABLE_DEMO === 'true' &&
    policy.rows[0].demo_owner_user_id &&
    policy.rows[0].demo_source_directory === 'Demo mails'
  ) {
    const original = (
      await client.query<{ content_hash: string }>(
        'SELECT content_hash FROM app_documents WHERE organization_id=$1 AND id=$2',
        [organizationId, documentId],
      )
    ).rows[0];
    if (original) {
      const offset = demoQueueOffset(
        await loadDemoCatalog(),
        original.content_hash,
      );
      if (offset !== null)
        availableAt = new Date(policy.rows[0].created_at.getTime() + offset);
    }
  }
  if (availableAt)
    await client.query(
      'INSERT INTO app_job_queue(id,organization_id,available_at) VALUES($1,$2,LEAST($3::timestamptz,clock_timestamp()))',
      [jobId, organizationId, availableAt],
    );
  else
    await client.query(
      'INSERT INTO app_job_queue(id,organization_id) VALUES($1,$2)',
      [jobId, organizationId],
    );
  return jobId;
}
export async function updateFolderConnection(
  context: WorkspaceContext,
  id: string,
  action: FolderAction,
) {
  return withTenant(context.organizationId, async (client) => {
    await assertManager(client, context);
    const selected = await client.query<{ status: string; config: Buffer }>(
      'SELECT status,config FROM app_folder_connections WHERE organization_id=$1 AND id=$2 FOR UPDATE',
      [context.organizationId, id],
    );
    const row = selected.rows[0];
    if (!row)
      throw new AccessError(404, 'NOT_FOUND', 'Folder connection not found.');
    if (['sync', 'resume', 'retry'].includes(action)) {
      if (row.status === 'disconnected')
        throw new AccessError(
          409,
          'RECONNECT_REQUIRED',
          'Connect this directory again to continue.',
        );
      if (row.status === 'paused' && action !== 'resume')
        throw new AccessError(409, 'PAUSED', 'Resume this folder first.');
      if (!(await rateLimit(client, 'folder-sync:' + id, 60, 3600)))
        throw new AccessError(
          429,
          'RATE_LIMIT',
          'Please wait before requesting another scan.',
        );
      await resolveFolderDirectory(
        context.organizationId,
        openFolderConfig(row.config, context.organizationId, id).directory,
      );
      if (action === 'retry') {
        const failed = await client.query<{ document_id: string }>(
          `SELECT docs.document_id FROM (SELECT DISTINCT document_id FROM app_folder_receipts WHERE organization_id=$1 AND connection_id=$2 AND document_id IS NOT NULL) docs
           JOIN LATERAL (SELECT status FROM app_jobs j WHERE j.organization_id=$1 AND j.document_id=docs.document_id ORDER BY j.created_at DESC,j.id DESC LIMIT 1) latest ON true
           WHERE latest.status IN ('failed','cancelled') LIMIT 101`,
          [context.organizationId, id],
        );
        if (failed.rows.length > 100)
          throw new AccessError(
            409,
            'RETRY_LIMIT',
            'Retry a smaller batch from Processing; this connection has more than 100 failed documents.',
          );
        for (const document of failed.rows) {
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [context.organizationId + ':folder-retry:' + document.document_id],
          );
          // Another upload/retry may have created active work after the initial projection.
          const current = await client.query<{ status: string }>(
            'SELECT status FROM app_jobs WHERE organization_id=$1 AND document_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
            [context.organizationId, document.document_id],
          );
          if (['failed', 'cancelled'].includes(current.rows[0]?.status))
            await queueFolderDocument(
              client,
              context.organizationId,
              document.document_id,
              context.user.id,
            );
        }
      }
      await client.query(
        "UPDATE app_folder_connections SET status='active',error_code=null,updated_at=now() WHERE id=$1 AND organization_id=$2",
        [id, context.organizationId],
      );
      await client.query(
        'INSERT INTO app_folder_queue(id,organization_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET available_at=LEAST(app_folder_queue.available_at,now()),attempts=0',
        [id, context.organizationId],
      );
    } else {
      await client.query(
        'UPDATE app_folder_connections SET status=$3,generation=generation+1,error_code=null,updated_at=now() WHERE id=$1 AND organization_id=$2',
        [
          id,
          context.organizationId,
          action === 'pause' ? 'paused' : 'disconnected',
        ],
      );
      await client.query(
        'DELETE FROM app_folder_queue WHERE id=$1 AND organization_id=$2',
        [id, context.organizationId],
      );
    }
    await audit(
      client,
      context.organizationId,
      context.user.id,
      'folder.' + action,
      id,
    );
    return { updated: true };
  });
}
