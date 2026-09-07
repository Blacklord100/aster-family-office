import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pool, withTenant, assertDatabaseRole } from '../lib/server/db';
import { encrypt, decrypt } from '../lib/server/crypto';
import { audit } from '../lib/server/audit';
import { readProcessingResult } from '../lib/server/processing-result';
const owner = randomUUID();
const endpoint = new URL(process.env.PROCESSOR_URL ?? 'http://processor:8000');
if (
  !['http:', 'https:'].includes(endpoint.protocol) ||
  endpoint.username ||
  endpoint.password
)
  throw new Error('Invalid processor endpoint');
const token = process.env.PROCESSOR_TOKEN;
if (
  !token ||
  token.length < 24 ||
  /^(REPLACE(?:_|$)|CHANGE[_-]?ME|CHANGEME|TODO)/i.test(token.trim())
)
  throw new Error('PROCESSOR_TOKEN must contain at least24 random characters');
await assertDatabaseRole();
let stopping = false;
let activeRequest: AbortController | null = null;
function stop() {
  stopping = true;
  activeRequest?.abort(new Error('WORKER_STOPPING'));
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const heartbeatFile =
  process.env.WORKER_HEARTBEAT_FILE ?? '/tmp/aster-worker-heartbeat';
const heartbeat = setInterval(
  () => void writeFile(heartbeatFile, String(Date.now())).catch(() => {}),
  10000,
);
await writeFile(heartbeatFile, String(Date.now()));
while (!stopping) {
  const claimed = await pool.query<{
    id: string;
    organization_id: string;
    attempts: number;
  }>(
    `UPDATE app_job_queue SET lease_owner=$1,lease_until=now()+interval '90 seconds',attempts=attempts+1 WHERE id=(SELECT id FROM app_job_queue WHERE available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,organization_id,attempts`,
    [owner],
  );
  const queue = claimed.rows[0];
  if (!queue) {
    await new Promise((r) => setTimeout(r, 1000));
    continue;
  }
  const requestController = new AbortController();
  activeRequest = requestController;
  if (stopping) requestController.abort(new Error('WORKER_STOPPING'));
  let renewing = false;
  const renewal = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void pool
      .query(
        "UPDATE app_job_queue SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND lease_owner=$2",
        [queue.id, owner],
      )
      .then((lease) => {
        if (!lease.rowCount) requestController.abort(new Error('LEASE_LOST'));
      })
      .catch(() => requestController.abort(new Error('LEASE_UNVERIFIED')))
      .finally(() => {
        renewing = false;
      });
  }, 20000);
  try {
    const document = await withTenant(queue.organization_id, async (c) => {
      const r = await c.query(
        "SELECT j.mode,j.document_id,d.filename,d.mime_type,d.payload FROM app_jobs j JOIN app_documents d ON d.id=j.document_id WHERE j.id=$1 AND j.organization_id=$2 AND j.status IN ('queued','processing') FOR UPDATE OF j",
        [queue.id, queue.organization_id],
      );
      if (!r.rows[0]) return null;
      // Fence stale claimants before starting, using the same job-then-queue lock order as completion.
      const lease = await c.query(
        'SELECT id FROM app_job_queue WHERE id=$1 AND lease_owner=$2 FOR UPDATE',
        [queue.id, owner],
      );
      if (!lease.rowCount) return null;
      await c.query(
        "UPDATE app_jobs SET status='processing',error_code=NULL,updated_at=now() WHERE id=$1",
        [queue.id],
      );
      return r.rows[0];
    });
    if (!document) {
      await pool.query(
        'DELETE FROM app_job_queue WHERE id=$1 AND lease_owner=$2',
        [queue.id, owner],
      );
      continue;
    }
    requestController.signal.throwIfAborted();
    const bytes = decrypt(
      document.payload,
      'document:' + queue.organization_id + ':' + document.document_id,
    );
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(bytes)], { type: document.mime_type }),
      document.filename,
    );
    form.append('mode', document.mode);
    form.append('document_id', document.document_id);
    const response = await fetch(new URL('/v1/extract', endpoint), {
      method: 'POST',
      headers: { 'X-Processor-Key': token },
      body: form,
      signal: AbortSignal.any([
        requestController.signal,
        AbortSignal.timeout(650000),
      ]),
      redirect: 'error',
    });
    const result = await readProcessingResult(response, {
      documentId: document.document_id,
      mode: document.mode,
    });
    await withTenant(queue.organization_id, async (c) => {
      await c.query('SELECT id FROM app_jobs WHERE id=$1 FOR UPDATE', [
        queue.id,
      ]);
      const lease = await c.query(
        'SELECT id FROM app_job_queue WHERE id=$1 AND lease_owner=$2 FOR UPDATE',
        [queue.id, owner],
      );
      if (!lease.rowCount) return;
      const updated = await c.query(
        "UPDATE app_jobs SET status='awaiting_review',result=$2,error_code=NULL,updated_at=now() WHERE id=$1 AND status='processing' RETURNING id",
        [
          queue.id,
          encrypt(
            JSON.stringify(result),
            'result:' + queue.organization_id + ':' + queue.id,
          ),
        ],
      );
      if (updated.rowCount)
        await audit(
          c,
          queue.organization_id,
          'worker',
          'processing.completed',
          queue.id,
          { mode: result.mode, facts: result.facts.length },
        );
      await c.query(
        'DELETE FROM app_job_queue WHERE id=$1 AND lease_owner=$2',
        [queue.id, owner],
      );
    });
  } catch (error) {
    const code =
      error instanceof Error && /^PROCESSOR_HTTP_\d{3}$/.test(error.message)
        ? error.message
        : error instanceof Error &&
            ['RESULT_TOO_LARGE', 'RESULT_IDENTITY_MISMATCH'].includes(
              error.message,
            )
          ? error.message
          : 'PROCESSING_FAILED';
    await withTenant(queue.organization_id, async (c) => {
      await c.query('SELECT id FROM app_jobs WHERE id=$1 FOR UPDATE', [
        queue.id,
      ]);
      const lease = await c.query(
        'SELECT id FROM app_job_queue WHERE id=$1 AND lease_owner=$2 FOR UPDATE',
        [queue.id, owner],
      );
      if (!lease.rowCount) return;
      if (stopping) {
        // A service shutdown requeues owned work without consuming a failure attempt.
        await c.query(
          "UPDATE app_jobs SET status='queued',error_code=NULL,updated_at=now() WHERE id=$1 AND status='processing'",
          [queue.id],
        );
        await c.query(
          'UPDATE app_job_queue SET lease_owner=NULL,lease_until=NULL,available_at=now(),attempts=GREATEST(attempts-1,0) WHERE id=$1 AND lease_owner=$2',
          [queue.id, owner],
        );
      } else if (queue.attempts < 3) {
        await c.query(
          "UPDATE app_jobs SET status='queued',error_code=$2,updated_at=now() WHERE id=$1 AND status='processing'",
          [queue.id, code],
        );
        await c.query(
          "UPDATE app_job_queue SET lease_owner=NULL,lease_until=NULL,available_at=now()+interval '30 seconds' WHERE id=$1 AND lease_owner=$2",
          [queue.id, owner],
        );
      } else {
        await c.query(
          "UPDATE app_jobs SET status='failed',error_code=$2,updated_at=now() WHERE id=$1 AND status='processing'",
          [queue.id, code],
        );
        await c.query(
          'DELETE FROM app_job_queue WHERE id=$1 AND lease_owner=$2',
          [queue.id, owner],
        );
        await audit(
          c,
          queue.organization_id,
          'worker',
          'processing.failed',
          queue.id,
          { code },
        );
      }
    }).catch(() => console.error('Worker could not persist job outcome.'));
  } finally {
    clearInterval(renewal);
    if (activeRequest === requestController) activeRequest = null;
  }
}
clearInterval(heartbeat);
await pool.end();
