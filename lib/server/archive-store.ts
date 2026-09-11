import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  ArchiveCommandSchema,
  ArchiveDestinationInputSchema,
  type ArchiveCommand,
  type ArchiveCommandResult,
  type ArchiveDestination,
  type ArchiveDocumentResponse,
  type ArchiveReceipt,
  type ArchiveRecord,
  type ArchiveResponse,
} from '../archive-contract';
import { AccessError, type WorkspaceContext } from './access';
import { pool, withTenant } from './db';
import { decrypt, encrypt, sha256 } from './crypto';
import { audit, rateLimit } from './audit';
import { assertDocumentAccess } from './data-scope';
import { assertHistoryAccess } from './portfolio-history-store';
import { deriveWorkspace, type WorkspaceState } from '../workspace';
import { archiveClassification } from './archive-classification';
import { archiveWorkerHealth } from './archive-health';
import {
  configuredArchiveRoot,
  testLocalArchiveDestination,
  writeLocalArchiveBundle,
  verifyLocalArchiveReceipt,
  readLocalArchiveFile,
} from './archive-provider';
import {
  ArchiveError,
  buildArchiveBundle,
  type ArchiveSource,
} from './archive-bundle';

export class ArchiveLeaseLost extends ArchiveError {
  constructor() {
    super('ARCHIVE_LEASE_LOST');
  }
}
type DestinationRow = {
  organization_id: string;
  revision: number;
  archive_revision: number;
  enabled: boolean;
  config: Buffer;
  configured_by: string;
  automatic_from: Date;
  include_existing: boolean;
  updated_at: Date;
};
type JobRow = {
  id: string;
  organization_id: string;
  document_id: string;
  source_document_id: string | null;
  destination_revision: number;
  status: ArchiveRecord['status'];
  attempts: number;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  metadata: Buffer | null;
  receipt: Buffer | null;
  filename?: string;
};
type FrozenMetadata = {
  directory: string;
  lastVerification?: { ok: boolean; checkedAt: string; issues: string[] };
  source: Omit<ArchiveSource, 'bytes'>;
};
export type ArchiveClaim = {
  id: string;
  organizationId: string;
  owner: string;
};
const envelopeContext = (kind: string, organizationId: string, id: string) =>
  `archive-${kind}:${organizationId}:${id}`;
const open = <T>(payload: Buffer, kind: string, org: string, id: string): T =>
  JSON.parse(decrypt(payload, envelopeContext(kind, org, id)).toString()) as T;
const seal = (value: unknown, kind: string, org: string, id: string) =>
  encrypt(JSON.stringify(value), envelopeContext(kind, org, id));
function destination(row: DestinationRow): ArchiveDestination {
  return {
    ...ArchiveDestinationInputSchema.parse(
      open(row.config, 'config', row.organization_id, row.organization_id),
    ),
    enabled: row.enabled,
    revision: row.revision,
    archiveRevision: row.archive_revision,
    configuredAt: row.updated_at.toISOString(),
    automaticFrom: row.automatic_from.toISOString(),
  };
}
async function currentDestination(c: PoolClient, org: string, lock = false) {
  return (
    await c.query<DestinationRow>(
      `SELECT * FROM app_archive_destinations WHERE organization_id=$1${lock ? ' FOR UPDATE' : ''}`,
      [org],
    )
  ).rows[0];
}
async function assertManager(c: PoolClient, ctx: WorkspaceContext) {
  if (ctx.scope || !['owner', 'admin'].includes(ctx.role))
    throw new AccessError(
      403,
      'FORBIDDEN',
      'An administrator manages document archives.',
    );
  const row = await c.query(
    `SELECT 1 FROM app_memberships m JOIN auth_session s ON s."userId"=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND m.data_scope IS NULL AND m.role IN ('owner','admin') AND s.id=$3 AND s."expiresAt">clock_timestamp() AND s."mfaVerifiedAt" IS NOT NULL FOR SHARE OF m`,
    [ctx.organizationId, ctx.user.id, ctx.sessionId],
  );
  if (!row.rowCount)
    throw new AccessError(
      403,
      'ACCESS_CHANGED',
      'Your administrator session is no longer active.',
    );
}
function record(row: JobRow, scoped = false, canManage = false): ArchiveRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    filename:
      row.filename ??
      (row.metadata
        ? open<FrozenMetadata>(
            row.metadata,
            'metadata',
            row.organization_id,
            row.id,
          ).source.filename
        : 'Retained document'),
    destinationDirectory:
      row.metadata && !scoped
        ? open<FrozenMetadata>(
            row.metadata,
            'metadata',
            row.organization_id,
            row.id,
          ).directory
        : null,
    sourceRetained: row.source_document_id !== null,
    canDownload:
      !scoped &&
      !!row.receipt &&
      (row.source_document_id !== null || canManage),
    destinationRevision: row.destination_revision,
    status: row.status,
    attempts: row.attempts,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastVerification:
      row.metadata && !scoped
        ? (open<FrozenMetadata>(
            row.metadata,
            'metadata',
            row.organization_id,
            row.id,
          ).lastVerification ?? null)
        : null,
    receipt:
      row.receipt && !scoped
        ? open<ArchiveReceipt>(
            row.receipt,
            'receipt',
            row.organization_id,
            row.id,
          )
        : null,
  };
}
export async function listArchives(
  ctx: WorkspaceContext,
  offset = 0,
  status: string | null = null,
): Promise<ArchiveResponse> {
  if (ctx.scope)
    throw new AccessError(
      403,
      'SCOPED_ACCESS',
      'Archive settings are available to workspace staff.',
    );
  if (
    status !== null &&
    !['queued', 'running', 'archived', 'failed'].includes(status)
  )
    throw new AccessError(400, 'INVALID_REQUEST', 'Invalid archive status.');
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
    throw new AccessError(400, 'INVALID_REQUEST', 'Invalid archive page.');
  return withTenant(
    ctx.organizationId,
    async (c) => {
      await assertHistoryAccess(c, ctx);
      const d = await currentDestination(c, ctx.organizationId);
      const rows = await c.query<JobRow>(
        `SELECT j.*,d.filename FROM app_archive_jobs j LEFT JOIN app_documents d ON d.id=j.source_document_id AND d.organization_id=j.organization_id WHERE j.organization_id=$1 AND ($3::text IS NULL OR j.status=$3) ORDER BY j.created_at DESC,j.id DESC LIMIT 51 OFFSET $2`,
        [ctx.organizationId, offset, status],
      );
      const counts = { queued: 0, running: 0, archived: 0, failed: 0 };
      for (const r of (
        await c.query<{ status: ArchiveRecord['status']; count: number }>(
          'SELECT status,count(*)::int AS count FROM app_archive_jobs WHERE organization_id=$1 GROUP BY status',
          [ctx.organizationId],
        )
      ).rows)
        counts[r.status] = r.count;
      const unqueued = d
        ? (
            await c.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM app_documents d WHERE d.organization_id=$1 AND NOT EXISTS(SELECT 1 FROM app_archive_jobs j WHERE j.organization_id=d.organization_id AND j.document_id=d.id AND j.destination_revision=$2)',
              [ctx.organizationId, d.archive_revision],
            )
          ).rows[0].count
        : 0;
      return {
        configured: configuredArchiveRoot() !== null,
        rootLabel: 'Operator archive root / ' + ctx.organizationId,
        ...(await archiveWorkerHealth()),
        canManage: ['owner', 'admin'].includes(ctx.role),
        destination: d ? destination(d) : null,
        counts,
        eligibleUnqueued: unqueued,
        records: rows.rows
          .slice(0, 50)
          .map((r) => record(r, false, ['owner', 'admin'].includes(ctx.role))),
        hasMore: rows.rows.length > 50,
      };
    },
    { readOnlySnapshot: true },
  );
}
export async function documentArchives(
  ctx: WorkspaceContext,
  documentId: string,
): Promise<ArchiveDocumentResponse> {
  return withTenant(
    ctx.organizationId,
    async (c) => {
      await assertHistoryAccess(c, ctx);
      await assertDocumentAccess(c, ctx, documentId);
      if (
        !(
          await c.query(
            'SELECT 1 FROM app_documents WHERE id=$1 AND organization_id=$2',
            [documentId, ctx.organizationId],
          )
        ).rowCount
      )
        throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
      const d = await currentDestination(c, ctx.organizationId);
      const rows = await c.query<JobRow>(
        `SELECT j.*,d.filename FROM app_archive_jobs j LEFT JOIN app_documents d ON d.id=j.source_document_id AND d.organization_id=j.organization_id WHERE j.organization_id=$1 AND j.document_id=$2 ORDER BY j.created_at DESC,j.id DESC LIMIT 20`,
        [ctx.organizationId, documentId],
      );
      return {
        documentId,
        configured: configuredArchiveRoot() !== null,
        destinationEnabled: d?.enabled ?? false,
        destinationRevision: ctx.scope ? null : (d?.revision ?? null),
        canManage: !ctx.scope && ['owner', 'admin'].includes(ctx.role),
        records: rows.rows.map((r) =>
          record(r, !!ctx.scope, ['owner', 'admin'].includes(ctx.role)),
        ),
      };
    },
    { readOnlySnapshot: true },
  );
}
/** No extraction state appears here: every retained source is independently eligible. */
async function discover(
  c: PoolClient,
  org: string,
  d: DestinationRow,
): Promise<number> {
  if (!d.enabled) return 0;
  if (
    !(
      await c.query(
        "SELECT 1 FROM app_memberships WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL AND data_scope IS NULL AND role IN ('owner','admin')",
        [org, d.configured_by],
      )
    ).rowCount
  )
    return 0;
  const rows = await c.query(
    `INSERT INTO app_archive_jobs(id,organization_id,document_id,source_document_id,destination_revision)
    SELECT gen_random_uuid(),$1,doc.id,doc.id,$2 FROM app_documents doc WHERE doc.organization_id=$1 AND ($3 OR doc.created_at>=$4)
      AND NOT EXISTS(SELECT 1 FROM app_archive_jobs j WHERE j.organization_id=$1 AND j.document_id=doc.id AND j.destination_revision=$2)
    ORDER BY doc.created_at,doc.id LIMIT 100 ON CONFLICT(organization_id,document_id,destination_revision) DO NOTHING`,
    [org, d.archive_revision, d.include_existing, d.automatic_from],
  );
  return rows.rowCount ?? 0;
}
export async function archiveCommand(
  ctx: WorkspaceContext,
  input: ArchiveCommand,
): Promise<ArchiveCommandResult> {
  const command = ArchiveCommandSchema.parse(input);
  return withTenant(ctx.organizationId, async (c) => {
    await assertManager(c, ctx);
    if (
      !(await rateLimit(
        c,
        'archive:' + ctx.organizationId + ':' + ctx.user.id,
        60,
        60,
      ))
    )
      throw new AccessError(
        429,
        'RATE_LIMITED',
        'Wait a moment before changing archives again.',
      );
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,1531))', [
      ctx.organizationId,
    ]);
    const d = await currentDestination(c, ctx.organizationId, true);
    if (command.action === 'test') {
      const checked = await testLocalArchiveDestination(
        ctx.organizationId,
        command.directory,
      );
      await audit(
        c,
        ctx.organizationId,
        ctx.user.id,
        'archive.tested',
        ctx.organizationId,
      );
      return {
        ok: true,
        revision: d?.revision ?? 0,
        affected: 0,
        checkedAt: checked.checkedAt,
      };
    }
    if (command.action === 'verify') {
      const j = (
        await c.query<JobRow>(
          'SELECT * FROM app_archive_jobs WHERE id=$1 AND organization_id=$2',
          [command.jobId, ctx.organizationId],
        )
      ).rows[0];
      if (!j?.receipt || !j.metadata)
        throw new AccessError(404, 'NOT_FOUND', 'Archived record not found.');
      const metadata = open<FrozenMetadata>(
        j.metadata,
        'metadata',
        ctx.organizationId,
        j.id,
      );
      const result = await verifyLocalArchiveReceipt(
        ctx.organizationId,
        metadata.directory,
        open<ArchiveReceipt>(j.receipt, 'receipt', ctx.organizationId, j.id),
      );
      metadata.lastVerification = result;
      await c.query(
        'UPDATE app_archive_jobs SET metadata=$1 WHERE id=$2 AND organization_id=$3',
        [
          seal(metadata, 'metadata', ctx.organizationId, j.id),
          j.id,
          ctx.organizationId,
        ],
      );
      await audit(
        c,
        ctx.organizationId,
        ctx.user.id,
        'archive.verified',
        j.id,
        { intact: result.ok },
      );
      return {
        ok: true,
        revision: d?.revision ?? 0,
        affected: 0,
        checkedAt: result.checkedAt,
        issues: result.issues,
      };
    }
    const hash = sha256(JSON.stringify(command));
    const prior = (
      await c.query<{ command_hash: string; result: Buffer }>(
        'SELECT command_hash,result FROM app_archive_commands WHERE organization_id=$1 AND idempotency_key=$2',
        [ctx.organizationId, command.idempotencyKey],
      )
    ).rows[0];
    if (prior) {
      if (prior.command_hash !== hash)
        throw new AccessError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This request identifier was already used for different archive settings.',
        );
      return open<ArchiveCommandResult>(
        prior.result,
        'command',
        ctx.organizationId,
        command.idempotencyKey,
      );
    }
    if ((d?.revision ?? 0) !== command.expectedRevision)
      throw new AccessError(
        409,
        'REVISION_CONFLICT',
        'Archive settings changed. Reload and try again.',
      );
    let revision = d?.revision ?? 0,
      affected = 0;
    if (command.action === 'configure') {
      if (configuredArchiveRoot() === null)
        throw new AccessError(
          409,
          'ARCHIVE_NOT_CONFIGURED',
          'The operator must configure a local archive root first.',
        );
      const config = command.destination;
      // Test the approved tenant-relative destination before activating it.
      if (config.enabled)
        await testLocalArchiveDestination(ctx.organizationId, config.directory);
      const changed = !!d && destination(d).directory !== config.directory;
      revision += 1;
      const archiveRevision = d ? d.archive_revision + Number(changed) : 1;
      await c.query(
        `INSERT INTO app_archive_destinations(organization_id,revision,archive_revision,enabled,config,configured_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(organization_id) DO UPDATE SET revision=$2,archive_revision=$3,enabled=$4,config=$5,configured_by=$6,updated_at=clock_timestamp(),automatic_from=CASE WHEN $7 THEN clock_timestamp() ELSE app_archive_destinations.automatic_from END,include_existing=CASE WHEN $7 THEN false ELSE app_archive_destinations.include_existing END`,
        [
          ctx.organizationId,
          revision,
          archiveRevision,
          config.enabled,
          seal(config, 'config', ctx.organizationId, ctx.organizationId),
          ctx.user.id,
          changed,
        ],
      );
      if (changed)
        await c.query(
          `UPDATE app_archive_jobs SET status='failed',error_code='DESTINATION_CHANGED',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND destination_revision<>$2 AND status IN ('queued','running')`,
          [ctx.organizationId, archiveRevision],
        );
      // Disable releases claims; stale workers cannot publish even if enabled again quickly.
      if (!config.enabled)
        await c.query(
          `UPDATE app_archive_jobs SET status='queued',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE organization_id=$1 AND status='running'`,
          [ctx.organizationId],
        );
    } else {
      if (!d?.enabled)
        throw new AccessError(
          409,
          'ARCHIVE_DISABLED',
          'Enable an archive destination first.',
        );
      if (command.action === 'backfill') {
        await c.query(
          'UPDATE app_archive_destinations SET include_existing=true WHERE organization_id=$1',
          [ctx.organizationId],
        );
        affected = await discover(c, ctx.organizationId, {
          ...d,
          include_existing: true,
        });
      } else {
        const j = (
          await c.query<JobRow>(
            'SELECT * FROM app_archive_jobs WHERE organization_id=$1 AND id=$2 FOR UPDATE',
            [ctx.organizationId, command.jobId],
          )
        ).rows[0];
        if (!j)
          throw new AccessError(404, 'NOT_FOUND', 'Archive job not found.');
        if (j.destination_revision !== d.archive_revision)
          throw new AccessError(
            409,
            'DESTINATION_CHANGED',
            'Use backfill to archive this document into the current destination.',
          );
        if (j.status === 'failed')
          affected =
            (
              await c.query(
                `UPDATE app_archive_jobs SET status='queued',attempts=0,error_code=NULL,available_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND organization_id=$2`,
                [j.id, ctx.organizationId],
              )
            ).rowCount ?? 0;
      }
    }
    const result: ArchiveCommandResult = { ok: true, revision, affected };
    await c.query(
      'INSERT INTO app_archive_commands(organization_id,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4)',
      [
        ctx.organizationId,
        command.idempotencyKey,
        hash,
        seal(result, 'command', ctx.organizationId, command.idempotencyKey),
      ],
    );
    // Retain bounded replay receipts; audit is append-only and keeps the full event history.
    await c.query(
      `DELETE FROM app_archive_commands WHERE organization_id=$1 AND idempotency_key IN (SELECT idempotency_key FROM app_archive_commands WHERE organization_id=$1 ORDER BY created_at DESC,idempotency_key DESC OFFSET 1000)`,
      [ctx.organizationId],
    );
    await audit(
      c,
      ctx.organizationId,
      ctx.user.id,
      'archive.' + command.action,
      command.action === 'retry' ? command.jobId : ctx.organizationId,
      { revision, affected },
    );
    return result;
  });
}

export async function discoverArchives(
  organizations: string[] | null,
  after: string | null = null,
): Promise<{ after: string | null; queued: number }> {
  if (configuredArchiveRoot() === null) return { after: null, queued: 0 };
  const routes = (
    await pool.query<{ organization_id: string }>(
      'SELECT * FROM archive_destinations_for_poll($1,$2::uuid[])',
      [after, organizations],
    )
  ).rows;
  let queued = 0;
  for (const row of routes)
    queued += await withTenant(row.organization_id, async (c) => {
      const d = await currentDestination(c, row.organization_id, true);
      return d ? discover(c, row.organization_id, d) : 0;
    });
  return {
    after: routes.length === 100 ? routes[99].organization_id : null,
    queued,
  };
}
export async function claimArchive(
  organizations: string[] | null = null,
): Promise<ArchiveClaim | null> {
  const owner = randomUUID();
  const row = (
    await pool.query<{ id: string; organization_id: string }>(
      'SELECT * FROM claim_archive_job($1,$2::uuid[])',
      [owner, organizations],
    )
  ).rows[0];
  return row
    ? { id: row.id, organizationId: row.organization_id, owner }
    : null;
}
export async function renewArchiveLease(claim: ArchiveClaim): Promise<boolean> {
  return withTenant(
    claim.organizationId,
    async (c) =>
      (
        await c.query(
          `UPDATE app_archive_jobs SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() AND status='running'`,
          [claim.id, claim.organizationId, claim.owner],
        )
      ).rowCount === 1,
  );
}
async function lockedClaim(
  c: PoolClient,
  claim: ArchiveClaim,
): Promise<{ d: DestinationRow; j: JobRow }> {
  const preliminary = await currentDestination(c, claim.organizationId);
  if (!preliminary) throw new ArchiveLeaseLost();
  // Membership -> destination -> job is the same order as administrative writes.
  const member = await c.query(
    `SELECT 1 FROM app_memberships WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL AND data_scope IS NULL AND role IN ('owner','admin') FOR SHARE`,
    [claim.organizationId, preliminary.configured_by],
  );
  const d = await currentDestination(c, claim.organizationId, true);
  if (!member.rowCount) throw new ArchiveError('ARCHIVE_AUTHORIZATION_CHANGED');
  if (!d?.enabled || d.configured_by !== preliminary.configured_by)
    throw new ArchiveLeaseLost();
  const j = (
    await c.query<JobRow>(
      `SELECT * FROM app_archive_jobs WHERE id=$1 AND organization_id=$2 AND status='running' AND lease_owner=$3 AND lease_until>clock_timestamp() AND destination_revision=$4 FOR UPDATE`,
      [claim.id, claim.organizationId, claim.owner, d.archive_revision],
    )
  ).rows[0];
  if (!j) throw new ArchiveLeaseLost();
  return { d, j };
}
async function loadArchiveSource(
  claim: ArchiveClaim,
): Promise<{ source: ArchiveSource; directory: string }> {
  return withTenant(claim.organizationId, async (c) => {
    const { d, j } = await lockedClaim(c, claim);
    const doc = (
      await c.query<{
        id: string;
        filename: string;
        mime_type: string;
        content_hash: string;
        payload: Buffer;
        created_at: Date;
      }>(
        `SELECT id,filename,mime_type,content_hash,payload,created_at FROM app_documents WHERE id=$1 AND organization_id=$2`,
        [j.document_id, claim.organizationId],
      )
    ).rows[0];
    if (!doc) throw new ArchiveError('SOURCE_UNAVAILABLE');
    let metadata: FrozenMetadata;
    if (j.metadata)
      metadata = open<FrozenMetadata>(
        j.metadata,
        'metadata',
        claim.organizationId,
        j.id,
      );
    else {
      // Initial classification remains explicit and immutable. No proposed model facts route originals.
      metadata = {
        directory: destination(d).directory,
        source: {
          organizationId: claim.organizationId,
          documentId: doc.id,
          filename: doc.filename,
          mimeType: doc.mime_type,
          contentHash: doc.content_hash,
          importedAt: doc.created_at.toISOString(),
          archiveRevision: j.destination_revision,
          archivedAt: j.created_at.toISOString(),
          classificationFrozenAt: (
            await c.query<{ at: Date }>('SELECT clock_timestamp() AS at')
          ).rows[0].at.toISOString(),
          classificationBasis:
            'Unassigned at archival; financial extraction does not control source preservation.',
        },
      };
      const workspace = (
        await c.query<{ payload: Buffer }>(
          'SELECT payload FROM app_workspace WHERE organization_id=$1 AND octet_length(payload)<=10485760',
          [claim.organizationId],
        )
      ).rows[0];
      if (workspace) {
        const records = deriveWorkspace(
          JSON.parse(
            decrypt(
              workspace.payload,
              'workspace:' + claim.organizationId,
            ).toString(),
          ) as WorkspaceState,
        );
        Object.assign(metadata.source, archiveClassification(doc.id, records));
      }
      await c.query(
        'UPDATE app_archive_jobs SET metadata=$1 WHERE id=$2 AND organization_id=$3',
        [
          seal(metadata, 'metadata', claim.organizationId, j.id),
          j.id,
          claim.organizationId,
        ],
      );
    }
    return {
      directory: metadata.directory,
      source: {
        ...metadata.source,
        bytes: decrypt(
          doc.payload,
          'document:' + claim.organizationId + ':' + doc.id,
        ),
      },
    };
  });
}
export async function processArchive(
  claim: ArchiveClaim,
  signal?: AbortSignal,
): Promise<ArchiveReceipt> {
  const { source, directory } = await loadArchiveSource(claim);
  const bundle = await buildArchiveBundle(source, undefined, signal);
  return writeLocalArchiveBundle(claim.organizationId, directory, bundle, {
    signal,
    publish: (commit) =>
      withTenant(claim.organizationId, async (c) => {
        const { d, j } = await lockedClaim(c, claim);
        if (signal?.aborted) throw new ArchiveLeaseLost();
        const receipt = await commit();
        // Final lease check uses wall clock after filesystem publication, not transaction start time.
        const changed = await c.query(
          `UPDATE app_archive_jobs SET status='archived',receipt=$1,error_code=NULL,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$2 AND organization_id=$3 AND lease_owner=$4 AND lease_until>clock_timestamp() AND status='running'`,
          [
            seal(receipt, 'receipt', claim.organizationId, j.id),
            j.id,
            claim.organizationId,
            claim.owner,
          ],
        );
        if (changed.rowCount !== 1) throw new ArchiveLeaseLost();
        await audit(
          c,
          claim.organizationId,
          d.configured_by,
          'archive.archived',
          j.id,
          {
            destinationRevision: j.destination_revision,
            fileCount: receipt.files.length,
          },
        );
        return receipt;
      }),
  });
}
export async function failArchive(
  claim: ArchiveClaim,
  error: unknown,
): Promise<void> {
  // Provider codes are allowlisted: never persist paths, document contents or upstream messages.
  const raw =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : error instanceof ArchiveLeaseLost
        ? 'LEASE_LOST'
        : 'ARCHIVE_FAILED';
  const code = [
    'PROCESSOR_BUSY',
    'ARCHIVE_AUTHORIZATION_CHANGED',
    'PROCESSOR_UNAVAILABLE',
    'UNSAFE_PATH',
    'ARCHIVE_NOT_CONFIGURED',
    'DESTINATION_UNAVAILABLE',
    'SOURCE_HASH_MISMATCH',
    'ARCHIVE_CONFLICT',
    'SNAPSHOT_FAILED',
    'ARCHIVE_LIMIT',
    'SOURCE_UNAVAILABLE',
    'ARCHIVE_RENDERER_NOT_LOCAL',
    'ARCHIVE_DESTINATION_UNAVAILABLE',
    'ARCHIVE_FILE_CHANGED',
    'ARCHIVE_RECEIPT_INVALID',
    'ARCHIVE_BUNDLE_LIMIT',
    'ARCHIVE_UNSAFE_PATH',
    'ARCHIVE_INTAKE_OVERLAP',
    'ARCHIVE_ROOT_UNAVAILABLE',
    'ARCHIVE_WRITE_FAILED',
    'ARCHIVE_INTEGRITY_FAILED',
    'ARCHIVE_SOURCE_INVALID',
    'SNAPSHOT_UNAVAILABLE',
    'SNAPSHOT_INPUT_LIMIT',
    'SNAPSHOT_INVALID',
    'ARCHIVE_CANCELLED',
    'ARCHIVE_LEASE_LOST',
    'LEASE_LOST',
  ].includes(raw)
    ? raw
    : 'ARCHIVE_FAILED';
  await withTenant(claim.organizationId, async (c) => {
    const changed = await c.query<{ status: string }>(
      `UPDATE app_archive_jobs SET status=CASE WHEN $6 THEN 'failed' WHEN $4 OR attempts<3 THEN 'queued' ELSE 'failed' END,attempts=CASE WHEN $4 THEN greatest(0,attempts-1) ELSE attempts END,error_code=$5,available_at=clock_timestamp()+interval '30 seconds',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() AND status='running' RETURNING status`,
      [
        claim.id,
        claim.organizationId,
        claim.owner,
        [
          'PROCESSOR_BUSY',
          'ARCHIVE_CANCELLED',
          'ARCHIVE_LEASE_LOST',
          'LEASE_LOST',
        ].includes(code),
        code,
        code === 'ARCHIVE_AUTHORIZATION_CHANGED',
      ],
    );
    if (changed.rowCount)
      await audit(
        c,
        claim.organizationId,
        'archive-worker',
        'archive.' +
          (changed.rows[0].status === 'failed' ? 'failed' : 'deferred'),
        claim.id,
        { code },
      );
  });
}

/** Source and file identifiers are looked up under office RLS; the client supplies no paths. */
export async function downloadArchiveFile(
  ctx: WorkspaceContext,
  jobId: string,
  index: number,
): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
  if (ctx.scope)
    throw new AccessError(
      403,
      'SCOPED_ACCESS',
      'Archived files are available to workspace staff.',
    );
  if (!Number.isInteger(index) || index < 0 || index >= 80)
    throw new AccessError(404, 'NOT_FOUND', 'Archived file not found.');
  return withTenant(ctx.organizationId, async (c) => {
    async function freshAccess() {
      const access = (
        await c.query<{ role: string }>(
          `SELECT m.role FROM app_memberships m JOIN auth_session s ON s."userId"=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.revoked_at IS NULL AND m.data_scope IS NULL AND s.id=$3 AND s."expiresAt">clock_timestamp() AND s."mfaVerifiedAt" IS NOT NULL`,
          [ctx.organizationId, ctx.user.id, ctx.sessionId],
        )
      ).rows[0];
      if (!access || access.role !== ctx.role)
        throw new AccessError(
          403,
          'ACCESS_CHANGED',
          'Your workspace access changed. Reload before continuing.',
        );
      return ['owner', 'admin'].includes(access.role);
    }
    const canManage = await freshAccess();
    const row = (
      await c.query<JobRow>(
        'SELECT * FROM app_archive_jobs WHERE organization_id=$1 AND id=$2',
        [ctx.organizationId, jobId],
      )
    ).rows[0];
    if (!row?.receipt || !row.metadata)
      throw new AccessError(404, 'NOT_FOUND', 'Archived file not found.');
    if (row.source_document_id === null && !canManage)
      throw new AccessError(
        403,
        'FORBIDDEN',
        'An administrator can retrieve archived copies after input retention purges.',
      );
    if (
      !(await rateLimit(
        c,
        'archive-download:' + ctx.organizationId + ':' + ctx.user.id,
        120,
        60,
      ))
    )
      throw new AccessError(
        429,
        'RATE_LIMITED',
        'Wait a moment before downloading more archive files.',
      );
    const receipt = open<ArchiveReceipt>(
        row.receipt,
        'receipt',
        ctx.organizationId,
        row.id,
      ),
      metadata = open<FrozenMetadata>(
        row.metadata,
        'metadata',
        ctx.organizationId,
        row.id,
      );
    const file = receipt.files[index];
    if (!file)
      throw new AccessError(404, 'NOT_FOUND', 'Archived file not found.');
    const bytes = await readLocalArchiveFile(
      ctx.organizationId,
      metadata.directory,
      receipt,
      index,
    );
    const freshManager = await freshAccess();
    if (
      !freshManager &&
      !(
        await c.query(
          'SELECT 1 FROM app_archive_jobs WHERE organization_id=$1 AND id=$2 AND source_document_id IS NOT NULL',
          [ctx.organizationId, row.id],
        )
      ).rowCount
    )
      throw new AccessError(
        403,
        'FORBIDDEN',
        'The source retention policy changed. An administrator can retrieve this archived copy.',
      );
    await audit(
      c,
      ctx.organizationId,
      ctx.user.id,
      'archive.file_downloaded',
      row.id,
      { fileIndex: index },
    );
    return {
      bytes,
      filename: file.path.split('/').at(-1)!,
      mimeType: file.mimeType,
    };
  });
}
