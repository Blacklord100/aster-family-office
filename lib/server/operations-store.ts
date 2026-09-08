import 'server-only';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import {
  defaultOperationalPolicy,
  OperationalPolicySchema,
  type OperationalPolicy,
  type OperationsStatus,
  type RetentionPreview,
} from '../operations-contract';
import { encrypt, decrypt, sha256, activeEncryptionKeyId } from './crypto';
import { readWorkspaceInTransaction } from '../workspace-store';
import { audit } from './audit';
import { AccessError, type WorkspaceContext } from './access';
import { emailDeliveryEnabled } from './delivery';
export async function readOperationalPolicy(
  c: PoolClient,
  organizationId: string,
) {
  const row = (
    await c.query(
      'SELECT payload,revision FROM app_operational_settings WHERE organization_id=$1',
      [organizationId],
    )
  ).rows[0];
  return row
    ? {
        policy: OperationalPolicySchema.parse(
          JSON.parse(
            decrypt(row.payload, 'operations:' + organizationId).toString(),
          ),
        ),
        revision: Number(row.revision),
      }
    : { policy: defaultOperationalPolicy, revision: 0 };
}
export async function saveOperationalPolicy(
  c: PoolClient,
  ctx: WorkspaceContext,
  policy: OperationalPolicy,
  expectedRevision: number,
) {
  await c.query('SELECT id FROM app_organizations WHERE id=$1 FOR UPDATE', [
    ctx.organizationId,
  ]);
  const current = await readOperationalPolicy(c, ctx.organizationId);
  if (current.revision !== expectedRevision)
    throw new AccessError(
      409,
      'REVISION_CONFLICT',
      'Operational settings changed. Reload before saving.',
    );
  await c.query(
    'INSERT INTO app_operational_settings(organization_id,payload) VALUES($1,$2) ON CONFLICT(organization_id) DO UPDATE SET payload=EXCLUDED.payload,revision=app_operational_settings.revision+1,updated_at=now()',
    [
      ctx.organizationId,
      encrypt(JSON.stringify(policy), 'operations:' + ctx.organizationId),
    ],
  );
  await audit(
    c,
    ctx.organizationId,
    ctx.user.id,
    'operations.policy.changed',
    ctx.organizationId,
    { retentionEnabled: policy.retentionEnabled },
  );
}
export async function retentionPreview(
  c: PoolClient,
  ctx: WorkspaceContext,
  policy: OperationalPolicy,
): Promise<RetentionPreview> {
  const { state } = await readWorkspaceInTransaction(
      c,
      ctx.organizationId,
      true,
    ),
    references = [
      ...new Set(
        JSON.stringify(state).match(
          /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,
        ) ?? [],
      ),
    ];
  const candidates = await c.query<{
    id: string;
    content_hash: string;
    byte_size: number;
  }>(
    `SELECT d.id,d.content_hash,d.byte_size FROM app_documents d WHERE d.organization_id=$1 AND d.created_at<now()-$2*interval '1 day'
 AND NOT EXISTS(SELECT 1 FROM app_jobs j WHERE j.document_id=d.id AND j.status NOT IN ('failed','cancelled','rejected'))
 AND NOT EXISTS(SELECT 1 FROM app_jobs j JOIN app_accepted_facts f ON f.job_id=j.id WHERE j.document_id=d.id)
 AND NOT EXISTS(SELECT 1 FROM app_jobs j JOIN app_review_versions v ON v.job_id=j.id WHERE j.document_id=d.id)
 AND NOT EXISTS(SELECT 1 FROM app_document_access a WHERE a.document_id=d.id)
 AND NOT(d.id=ANY($3::uuid[]))
 ORDER BY d.id LIMIT 501`,
    [ctx.organizationId, policy.unreviewedRetentionDays, references],
  );
  const rows = candidates.rows.slice(0, 500);
  return {
    documentIds: rows.map((r) => r.id),
    documentCount: rows.length,
    bytes: rows.reduce((n, r) => n + Number(r.byte_size), 0),
    digest: sha256(
      JSON.stringify({ days: policy.unreviewedRetentionDays, rows }),
    ),
    limited: candidates.rows.length > 500,
    preserves: [
      'Accepted financial evidence',
      'Any reviewed document and review history',
      'Active processing/review jobs',
      'Released client originals',
      'Workspace-linked sources, constituent citations and reports',
      'Audit records',
    ],
  };
}
export async function purgeRetainedInputs(
  c: PoolClient,
  ctx: WorkspaceContext,
  digest: string,
) {
  await c.query('SELECT id FROM app_organizations WHERE id=$1 FOR UPDATE', [
    ctx.organizationId,
  ]);
  const { policy } = await readOperationalPolicy(c, ctx.organizationId);
  if (!policy.retentionEnabled)
    throw new AccessError(
      409,
      'RETENTION_DISABLED',
      'Enable and review the retention policy first.',
    );
  const preview = await retentionPreview(c, ctx, policy);
  if (preview.digest !== digest)
    throw new AccessError(
      409,
      'PREVIEW_CHANGED',
      'The eligible documents changed. Review a fresh preview.',
    );
  if (preview.documentIds.length) {
    await c.query(
      'SELECT id FROM app_documents WHERE organization_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',
      [ctx.organizationId, preview.documentIds],
    );
    await c.query(
      'SELECT id FROM app_jobs WHERE organization_id=$1 AND document_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
      [ctx.organizationId, preview.documentIds],
    );
    // Retry workers do not take the workspace lock. Recheck after both source and job locks.
    const lockedPreview = await retentionPreview(c, ctx, policy);
    if (lockedPreview.digest !== digest)
      throw new AccessError(
        409,
        'PREVIEW_CHANGED',
        'Document activity changed. Review a fresh preview.',
      );
    await c.query(
      'DELETE FROM app_intelligence_documents WHERE organization_id=$1 AND document_id=ANY($2::uuid[])',
      [ctx.organizationId, preview.documentIds],
    );
    await c.query(
      'UPDATE app_mailbox_receipts SET document_id=NULL WHERE organization_id=$1 AND document_id=ANY($2::uuid[])',
      [ctx.organizationId, preview.documentIds],
    );
    await c.query(
      'DELETE FROM app_jobs WHERE organization_id=$1 AND document_id=ANY($2::uuid[])',
      [ctx.organizationId, preview.documentIds],
    );
    await c.query(
      'DELETE FROM app_documents WHERE organization_id=$1 AND id=ANY($2::uuid[])',
      [ctx.organizationId, preview.documentIds],
    );
  }
  await audit(
    c,
    ctx.organizationId,
    ctx.user.id,
    'operations.retention.purged',
    ctx.organizationId,
    {
      documents: preview.documentCount,
      bytes: preview.bytes,
      digest: preview.digest,
    },
  );
  return { purged: preview.documentCount };
}
export async function operationsStatus(
  c: PoolClient,
  ctx: WorkspaceContext,
): Promise<OperationsStatus> {
  const { policy, revision } = await readOperationalPolicy(
    c,
    ctx.organizationId,
  );
  const jobs = (
    await c.query(
      "SELECT count(*) FILTER(WHERE status IN ('queued','processing'))::int AS queued,count(*) FILTER(WHERE status='failed')::int AS failed,count(*) FILTER(WHERE status='awaiting_review')::int AS review,min(created_at) FILTER(WHERE status='queued') AS \"oldestQueuedAt\" FROM app_jobs WHERE organization_id=$1",
      [ctx.organizationId],
    )
  ).rows[0];
  const storage = (
    await c.query(
      'SELECT count(*)::int AS documents,COALESCE(sum(byte_size),0)::bigint AS bytes FROM app_documents WHERE organization_id=$1',
      [ctx.organizationId],
    )
  ).rows[0];
  const mailbox = (
    await c.query(
      "SELECT count(*) FILTER(WHERE status<>'disconnected')::int AS connected,count(*) FILTER(WHERE status='active' AND COALESCE(last_synced_at,created_at)<now()-$2*interval '1 hour')::int AS stale,count(*) FILTER(WHERE status IN ('error','reauth_required'))::int AS errors FROM app_mailboxes WHERE organization_id=$1",
      [ctx.organizationId, policy.mailboxStaleHours],
    )
  ).rows[0];
  let documentWorker: OperationsStatus['services']['documentWorker'] =
      'unreported',
    backup: OperationsStatus['services']['backup'] = 'unreported',
    backupAt: string | null = null;
  try {
    const age =
      Date.now() -
      Number(
        await readFile(
          process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/aster-worker-heartbeat',
          'utf8',
        ),
      );
    documentWorker = age >= 0 && age < 180000 ? 'healthy' : 'stale';
  } catch {}
  if (process.env.BACKUP_STATUS_FILE)
    try {
      const report = JSON.parse(
        await readFile(process.env.BACKUP_STATUS_FILE, 'utf8'),
      );
      if (
        report.result === 'passed' &&
        typeof report.at === 'string' &&
        Number.isFinite(Date.parse(report.at))
      ) {
        backupAt = report.at;
        const age = Date.now() - Date.parse(report.at);
        backup =
          age >= 0 && age < policy.backupMaxAgeHours * 3600000
            ? 'fresh'
            : 'stale';
      }
    } catch {}
  let processor: OperationsStatus['services']['processor'] = 'unavailable';
  try {
    const r = await fetch(
      new URL('/healthz', process.env.PROCESSOR_URL ?? 'http://processor:8000'),
      { redirect: 'error', signal: AbortSignal.timeout(2000) },
    );
    if (r.ok) processor = 'healthy';
  } catch {}
  const alerts: OperationsStatus['alerts'] = [];
  if (jobs.failed >= policy.jobFailureAlertThreshold)
    alerts.push({
      code: 'FAILED_JOBS',
      message: jobs.failed + ' document jobs need attention.',
    });
  if (mailbox.stale || mailbox.errors)
    alerts.push({
      code: 'MAILBOX_ATTENTION',
      message: 'Some mailbox connections are stale or require attention.',
    });
  if (documentWorker !== 'healthy')
    alerts.push({
      code: 'WORKER_HEALTH',
      message: 'The document worker heartbeat is ' + documentWorker + '.',
    });
  if (processor !== 'healthy')
    alerts.push({
      code: 'PROCESSOR_HEALTH',
      message: 'The configured processor is unavailable.',
    });
  if (backup !== 'fresh')
    alerts.push({
      code: 'BACKUP_HEALTH',
      message: 'Production backup evidence is ' + backup + '.',
    });
  return {
    policy,
    revision,
    queue: jobs,
    storage: { documents: storage.documents, bytes: Number(storage.bytes) },
    mailboxes: mailbox,
    services: { documentWorker, processor, backup, backupAt },
    deliveryConfigured: emailDeliveryEnabled(),
    activeEncryptionKeyId: activeEncryptionKeyId(),
    alerts,
  };
}
