import 'server-only';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool, withTenant } from './db';
import { audit } from './audit';
import { encrypt, sha256 } from './crypto';
import { workerOrganizationScope } from './worker-scope';
import {
  openFolderConfig,
  queueFolderDocument,
  sealFolderConfig,
  type FolderConfig,
} from './folder-store';
import {
  FolderError,
  MAX_FOLDER_FILE_BYTES,
  MAX_FOLDER_SCAN_BYTES,
  readFolderFile,
  scanFolderFiles,
  type FolderFile,
  type FolderRead,
} from './folder-files';

export type FolderClaim = { id: string; organizationId: string; owner: string };
type FolderRow = { connected_by: string; config: Buffer; generation: string };
export class FolderLeaseLost extends Error {}
class FolderMembershipRevoked extends Error {}
export async function claimFolderConnection(
  organizations: string[] | null = null,
): Promise<FolderClaim | null> {
  const owner = randomUUID(),
    scope =
      organizations === null
        ? null
        : workerOrganizationScope(organizations.join(','));
  const { rows } = await pool.query<{
    id: string;
    organization_id: string;
    lease_owner: string;
  }>('SELECT * FROM claim_folder_connection($1::uuid,$2::uuid[])', [
    owner,
    scope,
  ]);
  return rows[0]
    ? {
        id: rows[0].id,
        organizationId: rows[0].organization_id,
        owner: rows[0].lease_owner,
      }
    : null;
}
async function assertClaim(
  client: PoolClient,
  claim: FolderClaim,
  generation?: string,
): Promise<FolderRow> {
  const result = await client.query<FolderRow>(
    `SELECT c.connected_by,c.config,c.generation FROM app_folder_connections c JOIN app_folder_queue q ON q.id=c.id AND q.organization_id=c.organization_id
     WHERE c.id=$1 AND c.organization_id=$2 AND c.status='active' AND q.lease_owner=$3 AND q.lease_until>clock_timestamp()
      ${generation === undefined ? '' : 'AND c.generation=$4'} FOR UPDATE OF c,q`,
    generation === undefined
      ? [claim.id, claim.organizationId, claim.owner]
      : [claim.id, claim.organizationId, claim.owner, generation],
  );
  if (!result.rows[0]) throw new FolderLeaseLost();
  const member = await client.query(
    "SELECT 1 FROM app_memberships WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL AND data_scope IS NULL AND role IN ('owner','admin') FOR SHARE",
    [claim.organizationId, result.rows[0].connected_by],
  );
  if (!member.rowCount) throw new FolderMembershipRevoked();
  return result.rows[0];
}
export async function renewFolderClaim(claim: FolderClaim): Promise<boolean> {
  return withTenant(claim.organizationId, async (client) => {
    const { rowCount } = await client.query(
      "UPDATE app_folder_queue SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND lease_until>clock_timestamp()",
      [claim.id, claim.organizationId, claim.owner],
    );
    return rowCount === 1;
  });
}
export async function importFolderFile(
  claim: FolderClaim,
  generation: string,
  file: FolderFile,
  read: FolderRead,
) {
  return withTenant(claim.organizationId, async (client) => {
    const connection = await assertClaim(client, claim, generation);
    const receiptKey = sha256(file.relativePath + '\0' + read.hash);
    const exists = await client.query(
      'SELECT 1 FROM app_folder_receipts WHERE organization_id=$1 AND connection_id=$2 AND receipt_key=$3',
      [claim.organizationId, claim.id, receiptKey],
    );
    if (exists.rowCount) return { imported: false, duplicate: true };
    const count = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM app_folder_receipts WHERE organization_id=$1 AND connection_id=$2',
      [claim.organizationId, claim.id],
    );
    if (count.rows[0].count >= 100_000) throw new FolderError('SCAN_LIMIT');
    let documentId: string | null = null,
      outcome: 'imported' | 'duplicate' | 'invalid' | 'oversize' = read.outcome;
    if (read.outcome === 'imported' && read.bytes) {
      // Same lock key as browser uploads; exact byte copies share one original.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [claim.organizationId + read.hash],
      );
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM app_documents WHERE organization_id=$1 AND content_hash=$2',
        [claim.organizationId, read.hash],
      );
      documentId = existing.rows[0]?.id ?? randomUUID();
      if (!existing.rowCount) {
        await client.query(
          'INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            documentId,
            claim.organizationId,
            connection.connected_by,
            path.posix.basename(file.relativePath).slice(0, 200),
            read.mime,
            read.hash,
            read.bytes.length,
            encrypt(
              read.bytes,
              'document:' + claim.organizationId + ':' + documentId,
            ),
          ],
        );
        await queueFolderDocument(
          client,
          claim.organizationId,
          documentId,
          connection.connected_by,
        );
      } else {
        outcome = 'duplicate';
        const job = await client.query(
          'SELECT 1 FROM app_jobs WHERE organization_id=$1 AND document_id=$2 LIMIT 1',
          [claim.organizationId, documentId],
        );
        if (!job.rowCount)
          await queueFolderDocument(
            client,
            claim.organizationId,
            documentId,
            connection.connected_by,
          );
      }
    }
    await client.query(
      'INSERT INTO app_folder_receipts(organization_id,connection_id,receipt_key,document_id,payload,outcome) VALUES($1,$2,$3,$4,$5,$6)',
      [
        claim.organizationId,
        claim.id,
        receiptKey,
        documentId,
        encrypt(
          JSON.stringify({
            relativePath: file.relativePath,
            filename: path.posix.basename(file.relativePath),
            contentHash: read.hash,
            bytes: file.size,
          }),
          'folder-receipt:' +
            claim.organizationId +
            ':' +
            claim.id +
            ':' +
            receiptKey,
        ),
        outcome,
      ],
    );
    await client.query(
      'UPDATE app_folder_connections SET imported_count=imported_count+$3,skipped_count=skipped_count+$4,updated_at=now() WHERE id=$1 AND organization_id=$2',
      [
        claim.id,
        claim.organizationId,
        ['imported', 'duplicate'].includes(outcome) ? 1 : 0,
        ['invalid', 'oversize'].includes(outcome) ? 1 : 0,
      ],
    );
    await audit(
      client,
      claim.organizationId,
      connection.connected_by,
      'folder.file.' + outcome,
      documentId ?? claim.id,
      { connectionId: claim.id, bytes: file.size },
    );
    // A statement/audit lock may have consumed the remaining lease. Roll back
    // the original, job and receipt together if ownership expired meanwhile.
    const fenced = await client.query(
      'SELECT 1 FROM app_folder_queue WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND lease_until>clock_timestamp()',
      [claim.id, claim.organizationId, claim.owner],
    );
    if (!fenced.rowCount) throw new FolderLeaseLost();
    return {
      imported: outcome === 'imported',
      duplicate: outcome === 'duplicate',
    };
  });
}
/** Bounded batches checkpoint only after every preceding file has a committed receipt. */
export async function syncFolderConnection(
  claim: FolderClaim,
  signal?: AbortSignal,
) {
  const connection = await withTenant(claim.organizationId, (client) =>
    assertClaim(client, claim),
  );
  const config = openFolderConfig(
    connection.config,
    claim.organizationId,
    claim.id,
  );
  const all = await scanFolderFiles(claim.organizationId, config.directory);
  const remaining = all.filter(
    (file) => !config.cursorAfter || file.relativePath > config.cursorAfter,
  );
  let cursorAfter = config.cursorAfter,
    bytes = 0,
    examined = 0;
  for (const file of remaining) {
    if (signal?.aborted) throw new FolderLeaseLost();
    if (
      examined >= 32 ||
      (examined > 0 &&
        bytes + (file.size <= MAX_FOLDER_FILE_BYTES ? file.size : 0) >
          MAX_FOLDER_SCAN_BYTES)
    )
      break;
    const read = await readFolderFile(
      claim.organizationId,
      config.directory,
      file,
    );
    await importFolderFile(claim, String(connection.generation), file, read);
    cursorAfter = file.relativePath;
    bytes += file.size <= MAX_FOLDER_FILE_BYTES ? file.size : 0;
    examined++;
  }
  const complete = examined === remaining.length;
  await withTenant(claim.organizationId, async (client) => {
    await assertClaim(client, claim, String(connection.generation));
    const updated: FolderConfig = {
      ...config,
      cursorAfter: complete ? null : cursorAfter,
    };
    await client.query(
      'UPDATE app_folder_connections SET config=$3,last_synced_at=CASE WHEN $4 THEN now() ELSE last_synced_at END,error_code=null,updated_at=now() WHERE id=$1 AND organization_id=$2',
      [
        claim.id,
        claim.organizationId,
        sealFolderConfig(updated, claim.organizationId, claim.id),
        complete,
      ],
    );
    const finished = await client.query(
      "UPDATE app_folder_queue SET available_at=clock_timestamp()+$4*interval '1 second',lease_owner=null,lease_until=null,attempts=0 WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND lease_until>clock_timestamp()",
      [claim.id, claim.organizationId, claim.owner, complete ? 10 : 1],
    );
    if (!finished.rowCount) throw new FolderLeaseLost();
  });
  return { complete, examined, files: all.length };
}
export async function releaseFolderClaim(claim: FolderClaim, error?: unknown) {
  return withTenant(claim.organizationId, async (client) => {
    // Match mutation/import lock ordering: connection before its queue row.
    await client.query(
      'SELECT id FROM app_folder_connections WHERE id=$1 AND organization_id=$2 FOR UPDATE',
      [claim.id, claim.organizationId],
    );
    const locked = await client.query(
      'SELECT 1 FROM app_folder_queue WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() FOR UPDATE',
      [claim.id, claim.organizationId, claim.owner],
    );
    if (!locked.rowCount) return false;
    if (error instanceof FolderMembershipRevoked) {
      await client.query(
        "UPDATE app_folder_connections SET status='paused',generation=generation+1,error_code='MEMBERSHIP_REVOKED',updated_at=now() WHERE id=$1 AND organization_id=$2",
        [claim.id, claim.organizationId],
      );
      await client.query(
        'DELETE FROM app_folder_queue WHERE id=$1 AND organization_id=$2 AND lease_owner=$3',
        [claim.id, claim.organizationId, claim.owner],
      );
      return true;
    }
    const code =
      !error || error instanceof FolderLeaseLost
        ? null
        : error instanceof FolderError
          ? error.code
          : 'SYNC_FAILED';
    if (code)
      await client.query(
        'UPDATE app_folder_connections SET error_code=$3,updated_at=now() WHERE id=$1 AND organization_id=$2',
        [claim.id, claim.organizationId, code],
      );
    await client.query(
      "UPDATE app_folder_queue SET available_at=clock_timestamp()+CASE WHEN $4 THEN LEAST(3600,10*power(2,LEAST(attempts,8))) ELSE 2 END*interval '1 second',attempts=CASE WHEN $4 THEN attempts+1 ELSE attempts END,lease_owner=null,lease_until=null WHERE id=$1 AND organization_id=$2 AND lease_owner=$3",
      [claim.id, claim.organizationId, claim.owner, code !== null],
    );
    return true;
  });
}
