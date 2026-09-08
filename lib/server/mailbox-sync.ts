import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, withTenant } from './db';
import { decrypt, encrypt, sha256 } from './crypto';
import { audit } from './audit';
import {
  CredentialsSchema,
  exchangeTokens,
  MailboxError,
  MAX_MAIL_BYTES,
  providerConfiguration,
} from './mailbox-provider';
import {
  nextMailPage,
  fetchMailOriginal,
  type MailCursor,
} from './mailbox-pages';
import type { MailProvider } from '../mailbox-contract';
export type MailboxClaim = {
  id: string;
  organization_id: string;
  lease_owner: string;
};
type MailboxRow = {
  id: string;
  provider: MailProvider;
  connected_by: string;
  credentials: Buffer;
  cursor: Buffer | null;
  history_days: number | null;
  generation: number;
};
export class MailboxLeaseLost extends Error {}
export async function claimMailbox(
  workerId: string,
): Promise<MailboxClaim | undefined> {
  const result = await pool.query<MailboxClaim>(
    `WITH candidate AS (SELECT id FROM app_mailbox_queue WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE app_mailbox_queue q SET lease_owner=$1,lease_until=now()+interval '90 seconds' FROM candidate c WHERE q.id=c.id RETURNING q.id,q.organization_id,q.lease_owner`,
    [workerId],
  );
  return result.rows[0];
}
async function assertClaim(
  client: PoolClient,
  claim: MailboxClaim,
  generation?: number,
): Promise<MailboxRow> {
  const result = await client.query<MailboxRow>(
    `SELECT m.* FROM app_mailboxes m JOIN app_mailbox_queue q ON q.id=m.id JOIN app_memberships member ON member.organization_id=m.organization_id AND member.user_id=m.connected_by WHERE m.id=$1 AND m.organization_id=$2 AND m.status='active' AND m.credentials IS NOT NULL AND q.lease_owner=$3 AND q.lease_until>now() AND member.revoked_at IS NULL AND member.role IN ('owner','admin','analyst') ${generation === undefined ? '' : 'AND m.generation=$4'} FOR UPDATE OF m,q`,
    generation === undefined
      ? [claim.id, claim.organization_id, claim.lease_owner]
      : [claim.id, claim.organization_id, claim.lease_owner, generation],
  );
  if (!result.rows[0]) throw new MailboxLeaseLost();
  return result.rows[0];
}
export async function importMailboxMessage(
  claim: MailboxClaim,
  generation: number,
  messageId: string,
  bytes: Buffer | null,
  outcome: 'imported' | 'oversize' | 'missing' | 'invalid' = 'imported',
) {
  return withTenant(claim.organization_id, async (client) => {
    const mailbox = await assertClaim(client, claim, generation);
    const receipt = await client.query(
      'SELECT 1 FROM app_mailbox_receipts WHERE mailbox_id=$1 AND message_id=$2',
      [claim.id, messageId],
    );
    if (receipt.rowCount) return;
    let documentId: string | null = null;
    if (outcome === 'imported' && bytes) {
      if (
        !bytes.length ||
        bytes.length > MAX_MAIL_BYTES ||
        !/^(?:[A-Za-z][A-Za-z0-9-]*:[^\r\n]*\r?\n)/.test(
          bytes.subarray(0, 4096).toString(),
        )
      )
        outcome = 'invalid';
      else {
        const hash = sha256(bytes);
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [claim.organization_id + ':' + hash],
        );
        const existing = await client.query<{ id: string }>(
          'SELECT id FROM app_documents WHERE organization_id=$1 AND content_hash=$2',
          [claim.organization_id, hash],
        );
        documentId = existing.rows[0]?.id ?? randomUUID();
        if (!existing.rowCount) {
          await client.query(
            "INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload) VALUES($1,$2,$3,$4,'message/rfc822',$5,$6,$7)",
            [
              documentId,
              claim.organization_id,
              mailbox.connected_by,
              mailbox.provider + '-' + sha256(messageId).slice(0, 16) + '.eml',
              hash,
              bytes.length,
              encrypt(
                bytes,
                'document:' + claim.organization_id + ':' + documentId,
              ),
            ],
          );
          const policy = await client.query<{
            processing_mode: string;
            policy_revision: number;
          }>(
            'SELECT processing_mode,policy_revision FROM app_organizations WHERE id=$1',
            [claim.organization_id],
          );
          const jobId = randomUUID();
          await client.query(
            'INSERT INTO app_jobs(id,organization_id,document_id,created_by,mode,policy_revision) VALUES($1,$2,$3,$4,$5,$6)',
            [
              jobId,
              claim.organization_id,
              documentId,
              mailbox.connected_by,
              policy.rows[0].processing_mode,
              policy.rows[0].policy_revision,
            ],
          );
          await client.query(
            'INSERT INTO app_job_queue(id,organization_id) VALUES($1,$2)',
            [jobId, claim.organization_id],
          );
        }
      }
    }
    await client.query(
      'INSERT INTO app_mailbox_receipts(organization_id,mailbox_id,message_id,document_id,outcome) VALUES($1,$2,$3,$4,$5)',
      [claim.organization_id, claim.id, messageId, documentId, outcome],
    );
    await client.query(
      `UPDATE app_mailboxes SET imported_count=imported_count+$2,skipped_count=skipped_count+$3,updated_at=now() WHERE id=$1`,
      [
        claim.id,
        outcome === 'imported' ? 1 : 0,
        outcome !== 'imported' ? 1 : 0,
      ],
    );
    await audit(
      client,
      claim.organization_id,
      mailbox.connected_by,
      'mailbox.message.' + outcome,
      documentId ?? claim.id,
      { mailboxId: claim.id },
    );
  });
}
export async function syncMailboxPage(
  claim: MailboxClaim,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const mailbox = await withTenant(claim.organization_id, (client) =>
    assertClaim(client, claim),
  );
  if (!providerConfiguration(mailbox.provider).configured)
    throw new MailboxError('PROVIDER_NOT_CONFIGURED');
  let credentials = CredentialsSchema.parse(
    JSON.parse(
      decrypt(
        mailbox.credentials,
        'mailbox-credentials:' + claim.organization_id + ':' + claim.id,
      ).toString(),
    ),
  );
  if (credentials.expiresAt < Date.now() + 60000) {
    credentials = await withTenant(claim.organization_id, async (client) => {
      const locked = await assertClaim(client, claim, mailbox.generation);
      const current = CredentialsSchema.parse(
        JSON.parse(
          decrypt(
            locked.credentials,
            'mailbox-credentials:' + claim.organization_id + ':' + claim.id,
          ).toString(),
        ),
      );
      if (current.expiresAt >= Date.now() + 60000) return current;
      const refreshed = await exchangeTokens(
        mailbox.provider,
        { grant_type: 'refresh_token', refresh_token: current.refreshToken },
        current,
        fetcher,
      );
      await client.query(
        'UPDATE app_mailboxes SET credentials=$2,updated_at=now() WHERE id=$1',
        [
          claim.id,
          encrypt(
            JSON.stringify(refreshed),
            'mailbox-credentials:' + claim.organization_id + ':' + claim.id,
          ),
        ],
      );
      return refreshed;
    });
  }
  let cursor: MailCursor | null = mailbox.cursor
    ? JSON.parse(
        decrypt(
          mailbox.cursor,
          'mailbox-cursor:' + claim.organization_id + ':' + claim.id,
        ).toString(),
      )
    : null;
  const page = await nextMailPage(
    mailbox.provider,
    credentials.accessToken,
    cursor,
    mailbox.history_days,
    signal,
    fetcher,
  );
  for (const messageId of page.messageIds) {
    if (signal?.aborted) throw new MailboxLeaseLost();
    const exists = await withTenant(claim.organization_id, async (client) => {
      await assertClaim(client, claim, mailbox.generation);
      return (
        await client.query(
          'SELECT 1 FROM app_mailbox_receipts WHERE mailbox_id=$1 AND message_id=$2',
          [claim.id, messageId],
        )
      ).rowCount;
    });
    if (exists) continue;
    try {
      await importMailboxMessage(
        claim,
        mailbox.generation,
        messageId,
        await fetchMailOriginal(
          mailbox.provider,
          credentials.accessToken,
          messageId,
          signal,
          fetcher,
        ),
      );
    } catch (error) {
      if (
        error instanceof MailboxError &&
        ['MESSAGE_TOO_LARGE', 'PROVIDER_NOT_FOUND'].includes(error.code)
      )
        await importMailboxMessage(
          claim,
          mailbox.generation,
          messageId,
          null,
          error.code === 'MESSAGE_TOO_LARGE' ? 'oversize' : 'missing',
        );
      else throw error;
    }
  }
  cursor = page.cursor;
  const serialized = JSON.stringify(cursor);
  if (serialized.length > 1024 * 1024) throw new MailboxError('CURSOR_LIMIT');
  await withTenant(claim.organization_id, async (client) => {
    await assertClaim(client, claim, mailbox.generation);
    await client.query(
      'UPDATE app_mailboxes SET cursor=$2,last_synced_at=CASE WHEN $3 THEN now() ELSE last_synced_at END,error_code=null,updated_at=now() WHERE id=$1',
      [
        claim.id,
        encrypt(
          serialized,
          'mailbox-cursor:' + claim.organization_id + ':' + claim.id,
        ),
        page.complete,
      ],
    );
    await client.query(
      "UPDATE app_mailbox_queue SET available_at=now()+$2*interval '1 second',lease_owner=null,lease_until=null,attempts=0 WHERE id=$1 AND lease_owner=$3",
      [claim.id, page.complete ? 300 : 1, claim.lease_owner],
    );
  });
  return { complete: page.complete, messages: page.messageIds.length };
}
export async function releaseMailboxClaim(
  claim: MailboxClaim,
  error?: unknown,
) {
  await withTenant(claim.organization_id, async (client) => {
    if (!error || error instanceof MailboxLeaseLost) {
      await client.query(
        "UPDATE app_mailbox_queue SET lease_owner=null,lease_until=null,available_at=now()+interval '5 seconds' WHERE id=$1 AND organization_id=$2 AND lease_owner=$3",
        [claim.id, claim.organization_id, claim.lease_owner],
      );
      return;
    }
    const code = error instanceof MailboxError ? error.code : 'SYNC_FAILED';
    const matched = await client.query(
      'SELECT 1 FROM app_mailbox_queue WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 FOR UPDATE',
      [claim.id, claim.organization_id, claim.lease_owner],
    );
    if (!matched.rowCount) return;
    if (['REAUTH_REQUIRED', 'PROVIDER_FORBIDDEN'].includes(code)) {
      await client.query(
        "UPDATE app_mailboxes SET status='reauth_required',generation=generation+1,error_code=$2 WHERE id=$1",
        [claim.id, code],
      );
      await client.query('DELETE FROM app_mailbox_queue WHERE id=$1', [
        claim.id,
      ]);
    } else {
      await client.query('UPDATE app_mailboxes SET error_code=$2 WHERE id=$1', [
        claim.id,
        code,
      ]);
      await client.query(
        "UPDATE app_mailbox_queue SET attempts=attempts+1,available_at=now()+GREATEST($2,LEAST(3600,30*power(2,LEAST(attempts,7)))+random()*10)*interval '1 second',lease_owner=null,lease_until=null WHERE id=$1",
        [claim.id, error instanceof MailboxError ? error.retryAfter : 0],
      );
    }
  });
}
