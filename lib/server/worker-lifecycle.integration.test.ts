import { assertDisposableDatabase } from '../test-support/disposable-database';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { encrypt, decrypt, sha256 } from './crypto';

vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
  mfaRequired: () => true,
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('x-test-user');
        return id
          ? {
              user: {
                id,
                name: 'Disposable worker reviewer',
                email: 'fixture@example.invalid',
                twoFactorEnabled: true,
              },
              session: {
                id: 'worker-lifecycle-test',
                mfaVerifiedAt: new Date(),
              },
            }
          : null;
      },
    },
  },
}));

// Opt-in only. Pause other workers and keep the app upload queue idle first.
// Uses real compiled worker processes, real runtime-role PostgreSQL transactions,
// and an authenticated fake processor bound exclusively to 127.0.0.1:8012.
const enabled = process.env.ASTER_WORKER_INTEGRATION === '1';
const suite = enabled ? describe : describe.skip;
const org = randomUUID(),
  user = randomUUID();
const workers = new Set<{
  child: ChildProcess;
  done: Promise<void>;
  stderrBytes: number;
}>();
const requests = new Map<string, PendingRequest[]>();
const behavior = new Map<string, 'hold' | 'fail' | 'busy' | 'success'>();
let admin: Pool, server: Server, temp: string;
let db: typeof import('./db');
let review: typeof import('../../app/api/processing/[id]/route');
let processing: typeof import('../../app/api/processing/route');
type PendingRequest = {
  response: ServerResponse;
  disconnected: boolean;
  release: (marker: string) => void;
};
type JobState = {
  status: string;
  result: Buffer | null;
  error_code: string | null;
  attempts: number | null;
  lease_owner: string | null;
  available_at: Date | null;
  capacity_deferrals: number | null;
};

async function eventually<T>(
  read: () => Promise<T>,
  valid: (value: T) => boolean,
  label: string,
  timeout = 10000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (valid(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}
async function state(id: string): Promise<JobState> {
  const result = await admin.query<JobState>(
    `SELECT j.status,j.result,j.error_code,q.attempts,q.lease_owner,q.available_at,q.capacity_deferrals
    FROM app_jobs j LEFT JOIN app_job_queue q ON q.id=j.id WHERE j.id=$1 AND j.organization_id=$2`,
    [id, org],
  );
  return result.rows[0];
}
async function fixture(kind: 'hold' | 'fail' | 'busy' | 'success' = 'hold') {
  // A shared local DB must never contain someone else's runnable work during this suite.
  const other = await admin.query(
    'SELECT count(*)::int AS count FROM app_job_queue WHERE organization_id<>$1',
    [org],
  );
  if (other.rows[0].count !== 0)
    throw new Error(
      'Other queued work exists; pause uploads and finish that work before running this suite.',
    );
  const id = randomUUID(),
    documentId = randomUUID();
  const bytes = Buffer.from('Synthetic worker lifecycle fixture ' + documentId);
  await admin.query(
    `INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload)
    VALUES($1,$2,$3,'worker-lifecycle.txt','text/plain',$4,$5,$6)`,
    [
      documentId,
      org,
      user,
      sha256(bytes),
      bytes.length,
      encrypt(bytes, 'document:' + org + ':' + documentId),
    ],
  );
  await admin.query(
    `INSERT INTO app_jobs(id,organization_id,document_id,created_by,mode,policy_revision,engine_legacy) VALUES($1,$2,$3,$4,'workflow',1,true)`,
    [id, org, documentId, user],
  );
  await admin.query(
    'INSERT INTO app_job_queue(id,organization_id) VALUES($1,$2)',
    [id, org],
  );
  behavior.set(documentId, kind);
  return { id, documentId };
}
function startWorker(): {
  child: ChildProcess;
  done: Promise<void>;
  stderrBytes: number;
} {
  const child = spawn(process.execPath, ['dist-worker/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PROCESSOR_URL: 'http://127.0.0.1:8012',
      WORKER_HEARTBEAT_FILE: join(temp, randomUUID()),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const item = {
    child,
    done: new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', () =>
        reject(new Error('The fixture worker could not start.')),
      );
    }),
    stderrBytes: 0,
  };
  child.stderr?.on('data', (chunk: Buffer) => {
    item.stderrBytes += chunk.length;
  });
  workers.add(item);
  return item;
}
async function stopWorker(item: ReturnType<typeof startWorker>) {
  if (item.child.exitCode === null && item.child.signalCode === null)
    item.child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      item.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          item.child.kill('SIGKILL');
          reject(new Error('Worker did not stop within ten seconds.'));
        }, 10000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    workers.delete(item);
  }
}
async function firstRequest(documentId: string) {
  return (
    await eventually(
      async () => requests.get(documentId) ?? [],
      (r) => r.length > 0,
      'processor request',
    )
  )[0];
}
async function action(id: string, value: 'cancel' | 'retry') {
  return review.PATCH(
    new Request('http://localhost:3000/api/processing/' + id, {
      method: 'PATCH',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
        'x-test-user': user,
      },
      body: JSON.stringify({ action: value }),
    }),
    { params: Promise.resolve({ id }) },
  );
}
function completedResult(documentId: string, marker: string) {
  return {
    schemaVersion: 1,
    documentId,
    mode: 'workflow',
    execution: 'local',
    documentType: 'test_notice',
    relevant: true,
    confidence: 0.5,
    facts: [
      {
        kind: 'news',
        investmentName: 'Synthetic fixture',
        effectiveDate: null,
        amount: null,
        currency: null,
        dueDate: null,
        summary: marker,
        evidence: { page: 1, quote: 'Synthetic worker lifecycle fixture' },
      },
    ],
    warnings: ['Synthetic integration fixture'],
    trace: [],
    model: null,
  };
}

suite('real durable worker lifecycle', () => {
  beforeAll(async () => {
    if (
      !process.env.DATABASE_URL ||
      !process.env.MIGRATION_DATABASE_URL ||
      !process.env.ENCRYPTION_KEY ||
      !process.env.PROCESSOR_TOKEN
    ) {
      throw new Error(
        'Set runtime/admin PostgreSQL URLs, encryption key, and processor token in a private environment.',
      );
    }
    assertDisposableDatabase();
    temp = await mkdtemp(join(tmpdir(), 'aster-worker-lifecycle-'));
    admin = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL,
      max: 2,
    });
    db = await import('./db');
    review = await import('../../app/api/processing/[id]/route');
    processing = await import('../../app/api/processing/route');
    const role = await db.pool.query(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    await admin.query(
      'INSERT INTO auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
      [user, 'Disposable lifecycle test', user + '@example.invalid'],
    );
    await admin.query('INSERT INTO app_organizations(id,name) VALUES($1,$2)', [
      org,
      'Disposable worker lifecycle',
    ]);
    await admin.query(
      "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
      [org, user],
    );
    server = createServer((incoming, response) => {
      void (async () => {
        if (
          incoming.url !== '/v1/extract' ||
          incoming.method !== 'POST' ||
          incoming.headers['x-processor-key'] !== process.env.PROCESSOR_TOKEN
        ) {
          response.writeHead(401).end();
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of incoming) {
          length += chunk.length;
          if (length > 65536) throw new Error('Oversized synthetic request');
          chunks.push(chunk);
        }
        const form = await new Request('http://127.0.0.1:8012/v1/extract', {
          method: 'POST',
          headers: { 'content-type': String(incoming.headers['content-type']) },
          body: Buffer.concat(chunks),
        }).formData();
        const documentId = form.get('document_id');
        if (typeof documentId !== 'string') {
          response.writeHead(400).end();
          return;
        }
        if (!behavior.has(documentId)) {
          response.writeHead(400).end();
          return;
        }
        const item: PendingRequest = {
          response,
          disconnected: false,
          release: (marker) => {
            if (!response.destroyed && !response.writableEnded)
              response
                .writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify(completedResult(documentId, marker)));
          },
        };
        response.on('close', () => {
          if (!response.writableEnded) item.disconnected = true;
        });
        requests.set(documentId, [...(requests.get(documentId) ?? []), item]);
        if (behavior.get(documentId) === 'fail') response.writeHead(500).end();
        if (behavior.get(documentId) === 'busy') response.writeHead(503).end();
        if (behavior.get(documentId) === 'success')
          item.release('fresh worker result');
      })().catch(() => {
        if (!response.destroyed) response.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(8012, '127.0.0.1', resolve);
    });
  }, 20000);

  afterEach(async () => {
    await Promise.all([...workers].map(stopWorker));
    // Stop a shutdown-requeued fixture from being picked up by the next test.
    if (admin)
      await admin.query('DELETE FROM app_job_queue WHERE organization_id=$1', [
        org,
      ]);
  }, 15000);
  afterAll(async () => {
    await Promise.all([...workers].map(stopWorker));
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (admin) {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        for (const table of [
          'app_job_queue',
          'app_accepted_facts',
          'app_audit',
          'app_jobs',
          'app_documents',
          'app_memberships',
        ]) {
          await client.query(
            'DELETE FROM ' + table + ' WHERE organization_id=$1',
            [org],
          );
        }
        await client.query('DELETE FROM app_organizations WHERE id=$1', [org]);
        await client.query('DELETE FROM auth_user WHERE id=$1', [user]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
        await admin.end();
      }
    }
    if (db) await db.pool.end();
    if (temp) await rm(temp, { recursive: true, force: true });
  }, 20000);

  it('finishes an admitted extraction while draining and leaves the next job untouched until resume', async () => {
    const { controlLifecycle, lifecycleStatus } =
      await import('./lifecycle-control');
    const job = await fixture(),
      worker = startWorker();
    const request = await firstRequest(job.documentId);
    const next = await fixture('success');
    const c = await admin.connect();
    try {
      const drained = await controlLifecycle(c, {
        action: 'drain',
        expectedGeneration: 1,
      });
      expect(drained.activeOperations).toBeGreaterThan(0);
      expect(drained.activeLeases.document).toBe(1);
      await expect(
        controlLifecycle(c, { action: 'seal', expectedGeneration: 1 }),
      ).rejects.toMatchObject({ code: 'DRAIN_BUSY' });
      request.release('completed during drain');
      await eventually(
        () => state(job.id),
        (s) => s.status === 'awaiting_review',
        'admitted extraction drain',
      );
      await eventually(
        () => lifecycleStatus(c),
        (s) => s.canSeal,
        'durable drain without active leases',
      );
      await controlLifecycle(c, { action: 'seal', expectedGeneration: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await state(next.id)).toMatchObject({
        status: 'queued',
        attempts: 0,
        lease_owner: null,
      });
      expect(requests.get(next.documentId)).toBeUndefined();
      await controlLifecycle(c, {
        action: 'resume',
        release: 'legacy',
        expectedGeneration: 1,
      });
      await eventually(
        () => state(next.id),
        (s) => s.status === 'awaiting_review',
        'queued extraction after resume',
      );
      await stopWorker(worker);
      expect(worker.stderrBytes).toBe(0);
    } finally {
      await admin.query(
        "UPDATE app_lifecycle_control SET mode='open' WHERE id",
      );
      c.release();
    }
  }, 20000);

  it('requeues an interrupted attempt without charging a failure and disconnects the processor', async () => {
    const job = await fixture(),
      worker = startWorker();
    const request = await firstRequest(job.documentId);
    expect(await state(job.id)).toMatchObject({
      status: 'processing',
      attempts: 1,
    });
    await stopWorker(worker);
    expect(await state(job.id)).toMatchObject({
      status: 'queued',
      attempts: 0,
      lease_owner: null,
      result: null,
      error_code: null,
    });
    await eventually(
      async () => request.disconnected,
      Boolean,
      'shutdown processor disconnect',
    );
    const audits = await admin.query(
      'SELECT action,details FROM app_audit WHERE organization_id=$1 AND resource_id=$2 ORDER BY sequence',
      [org, job.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      'processing.started',
      'processing.requeued',
    ]);
    expect(audits.rows[1].details).toMatchObject({
      attemptId: audits.rows[0].details.attemptId,
      reason: 'shutdown',
    });
    expect(audits.rows[1].details.durationMs).toBeGreaterThanOrEqual(0);
    expect(worker.stderrBytes).toBe(0);
  }, 20000);

  it('keeps pipeline counts and row summaries in the same read-only snapshot during a concurrent status change', async () => {
    const job = await fixture();
    const { listProcessingJobs, processingListQuery } =
      await import('./processing-list');
    await db.withTenant(
      org,
      async (client) => {
        // Establish the snapshot before a separate writer commits a new stage.
        expect(
          (
            await client.query(
              'SELECT status FROM app_jobs WHERE organization_id=$1 AND id=$2',
              [org, job.id],
            )
          ).rows[0].status,
        ).toBe('queued');
        await admin.query(
          "UPDATE app_jobs SET status='processing' WHERE organization_id=$1 AND id=$2",
          [org, job.id],
        );
        const listing = await listProcessingJobs(
          client,
          {
            organizationId: org,
            user: {
              id: user,
              name: 'Fixture',
              email: 'fixture@example.invalid',
            },
            role: 'owner',
            sessionId: 'fixture',
          },
          processingListQuery(
            new URL(
              'http://localhost:3000/api/processing?status=queued&jobId=' +
                job.id,
            ),
          ),
        );
        expect(listing.page.statusCounts.queued).toBeGreaterThan(0);
        expect(listing.page.jobIds).toContain(job.id);
        expect(listing.jobs.find((row) => row.id === job.id)).toMatchObject({
          status: 'queued',
          summary: { availability: 'not_extracted' },
        });
      },
      { readOnlySnapshot: true },
    );
    expect((await state(job.id)).status).toBe('processing');
    await expect(
      db.withTenant(
        org,
        async (client) => {
          await client.query(
            "UPDATE app_jobs SET status='queued' WHERE organization_id=$1 AND id=$2",
            [org, job.id],
          );
        },
        { readOnlySnapshot: true },
      ),
    ).rejects.toMatchObject({ code: '25006' });
  });

  it('cancels through the real review route, aborts the active request, and never stores its result', async () => {
    const job = await fixture(),
      worker = startWorker();
    const request = await firstRequest(job.documentId);
    expect((await action(job.id, 'cancel')).status).toBe(200);
    expect(await state(job.id)).toMatchObject({
      status: 'cancelled',
      attempts: null,
      result: null,
    });
    await eventually(
      async () => request.disconnected,
      Boolean,
      'cancelled processor disconnect',
      30000,
    );
    request.release('cancelled result must never appear');
    expect(await state(job.id)).toMatchObject({
      status: 'cancelled',
      result: null,
    });
    await stopWorker(worker);
    const audits = await admin.query(
      'SELECT action,details FROM app_audit WHERE organization_id=$1 AND resource_id=$2 ORDER BY sequence',
      [org, job.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      'processing.started',
      'processing.cancel',
    ]);
    expect(worker.stderrBytes).toBe(0);
  }, 40000);

  it('fences a stale successful result after another worker takes over an expired lease', async () => {
    const job = await fixture(),
      oldWorker = startWorker();
    const oldRequest = await firstRequest(job.documentId);
    const firstOwner = (await state(job.id)).lease_owner;
    await admin.query(
      "UPDATE app_job_queue SET lease_until=now()-interval '1 second' WHERE id=$1 AND organization_id=$2",
      [job.id, org],
    );
    const newWorker = startWorker();
    await eventually(
      async () => requests.get(job.documentId) ?? [],
      (r) => r.length === 2,
      'replacement processor request',
    );
    expect((await state(job.id)).lease_owner).not.toBe(firstOwner);
    requests.get(job.documentId)![1].release('fresh worker result');
    await eventually(
      () => state(job.id),
      (s) => s.status === 'awaiting_review',
      'fresh result',
    );
    await stopWorker(newWorker);
    // A second completed fixture proves the old worker consumed the stale response
    // and returned to its claim loop before we stop it.
    const sentinel = await fixture('success');
    oldRequest.release('stale result must never appear');
    await eventually(
      () => state(sentinel.id),
      (s) => s.status === 'awaiting_review',
      'old worker continues after fenced result',
    );
    await stopWorker(oldWorker);
    const final = await state(job.id);
    expect(final).toMatchObject({ status: 'awaiting_review', attempts: null });
    const result = JSON.parse(
      decrypt(final.result!, 'result:' + org + ':' + job.id).toString(),
    );
    expect(result.facts[0].summary).toBe('fresh worker result');
    const audits = await admin.query(
      'SELECT action,details FROM app_audit WHERE organization_id=$1 AND resource_id=$2 ORDER BY sequence',
      [org, job.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      'processing.started',
      'processing.started',
      'processing.completed',
    ]);
    // The fenced claimant has no terminal receipt. Only the replacement's
    // attempt identity may own the completed result and measured duration.
    expect(audits.rows[0].details.attemptId).not.toBe(
      audits.rows[1].details.attemptId,
    );
    expect(audits.rows[2].details.attemptId).toBe(
      audits.rows[1].details.attemptId,
    );
    expect(audits.rows[2].details.durationMs).toBeGreaterThanOrEqual(0);
    const pipelineResponse = await processing.GET(
      new Request('http://localhost:3000/api/processing?jobId=' + job.id, {
        headers: { 'x-test-user': user },
      }),
    );
    expect(pipelineResponse.status).toBe(200);
    const pipeline = await pipelineResponse.json();
    const selected = pipeline.jobs.find(
      (row: { id: string }) => row.id === job.id,
    );
    expect(selected.summary).toMatchObject({
      extractedCount: 1,
      pendingCount: 1,
      remainingCount: 1,
    });
    expect(selected.timing).toMatchObject({
      attemptCount: 2,
      processingDurationMs: audits.rows[2].details.durationMs,
    });
    expect(selected.timing.startedAt).not.toBeNull();
    expect(selected.timing.completedAt).not.toBeNull();
    expect(
      pipeline.jobs.filter((row: { result: unknown }) => row.result !== null),
    ).toHaveLength(1);
    expect(oldWorker.stderrBytes + newWorker.stderrBytes).toBe(0);
  }, 20000);

  it('never renews or accepts a result after lease expiry, even before replacement ownership', async () => {
    const job = await fixture(),
      worker = startWorker();
    const request = await firstRequest(job.documentId);
    const owner = (await state(job.id)).lease_owner!;
    await admin.query(
      "UPDATE app_job_queue SET lease_until=clock_timestamp()-interval '1 second',available_at=clock_timestamp()+interval '1 hour' WHERE id=$1 AND organization_id=$2",
      [job.id, org],
    );
    const { renewDocumentLease } = await import('./worker-scope');
    expect(await renewDocumentLease(db.pool, job.id, owner)).toBe(false);
    const sentinel = await fixture('success');
    request.release('expired result must never appear');
    await eventually(
      () => state(sentinel.id),
      (value) => value.status === 'awaiting_review',
      'worker continuing after expired response',
    );
    expect(await state(job.id)).toMatchObject({
      status: 'processing',
      result: null,
      lease_owner: owner,
    });
    const audits = (
      await admin.query(
        'SELECT action FROM app_audit WHERE organization_id=$1 AND resource_id=$2 ORDER BY sequence',
        [org, job.id],
      )
    ).rows.map((row) => row.action);
    expect(audits).toEqual(['processing.started']);
    await stopWorker(worker);
    expect(worker.stderrBytes).toBe(0);
  }, 20000);

  it('backs off twice, fails on attempt three, and resets attempts only on explicit retry', async () => {
    const job = await fixture('fail'),
      worker = startWorker();
    for (const attempt of [1, 2]) {
      const queued = await eventually(
        () => state(job.id),
        (s) =>
          s.status === 'queued' &&
          s.attempts === attempt &&
          s.lease_owner === null,
        'retry backoff ' + attempt,
      );
      expect(queued.error_code).toBe('PROCESSOR_HTTP_500');
      expect(queued.available_at!.getTime() - Date.now()).toBeGreaterThan(
        20000,
      );
      // Accelerate only this fixture's durable clock after checking its real thirty-second backoff.
      await admin.query(
        'UPDATE app_job_queue SET available_at=now() WHERE id=$1 AND organization_id=$2',
        [job.id, org],
      );
    }
    const failed = await eventually(
      () => state(job.id),
      (s) => s.status === 'failed',
      'terminal third failure',
    );
    expect(failed).toMatchObject({
      attempts: null,
      result: null,
      error_code: 'PROCESSOR_HTTP_500',
    });
    expect(requests.get(job.documentId)).toHaveLength(3);
    behavior.set(job.documentId, 'hold');
    expect((await action(job.id, 'retry')).status).toBe(200);
    await eventually(
      async () => requests.get(job.documentId) ?? [],
      (r) => r.length === 4,
      'explicit retry',
    );
    expect(await state(job.id)).toMatchObject({
      status: 'processing',
      attempts: 1,
      error_code: null,
    });
    requests.get(job.documentId)![3].release('explicit retry result');
    await eventually(
      () => state(job.id),
      (s) => s.status === 'awaiting_review',
      'retried result',
    );
    await stopWorker(worker);
    const audits = await admin.query(
      'SELECT action,details FROM app_audit WHERE organization_id=$1 AND resource_id=$2 ORDER BY sequence',
      [org, job.id],
    );
    expect(audits.rows.map((row) => row.action)).toEqual([
      'processing.started',
      'processing.requeued',
      'processing.started',
      'processing.requeued',
      'processing.started',
      'processing.failed',
      'processing.retry',
      'processing.started',
      'processing.completed',
    ]);
    const starts = audits.rows.filter(
      (row) => row.action === 'processing.started',
    );
    expect(new Set(starts.map((row) => row.details.attemptId)).size).toBe(4);
    for (const [startIndex, endIndex] of [
      [0, 1],
      [2, 3],
      [4, 5],
      [7, 8],
    ]) {
      expect(audits.rows[endIndex].details.attemptId).toBe(
        audits.rows[startIndex].details.attemptId,
      );
      expect(
        Number.isSafeInteger(audits.rows[endIndex].details.durationMs),
      ).toBe(true);
      expect(audits.rows[endIndex].details.durationMs).toBeGreaterThanOrEqual(
        0,
      );
    }
    expect(worker.stderrBytes).toBe(0);
  }, 30000);

  it('defers busy capacity without charging failures and terminates at the explicit deferral bound', async () => {
    const job = await fixture('busy'),
      worker = startWorker();
    const queued = await eventually(
      () => state(job.id),
      (s) => s.status === 'queued' && s.capacity_deferrals === 1,
      'capacity deferral',
    );
    expect(queued).toMatchObject({
      attempts: 0,
      lease_owner: null,
      error_code: 'PROCESSOR_BUSY',
    });
    expect(queued.available_at!.getTime() - Date.now()).toBeGreaterThan(20000);
    // Advance only this fixture's recorded count/clock to exercise both sides of the bound.
    await admin.query(
      'UPDATE app_job_queue SET capacity_deferrals=29,available_at=now() WHERE id=$1 AND organization_id=$2',
      [job.id, org],
    );
    await eventually(
      () => state(job.id),
      (s) => s.status === 'queued' && s.capacity_deferrals === 30,
      'last allowed capacity deferral',
    );
    expect((await state(job.id)).attempts).toBe(0);
    await admin.query(
      'UPDATE app_job_queue SET available_at=now() WHERE id=$1 AND organization_id=$2',
      [job.id, org],
    );
    const failed = await eventually(
      () => state(job.id),
      (s) => s.status === 'failed',
      'bounded capacity failure',
    );
    expect(failed).toMatchObject({
      attempts: null,
      capacity_deferrals: null,
      result: null,
      error_code: 'PROCESSOR_HTTP_503',
    });
    expect(requests.get(job.documentId)).toHaveLength(3);
    await stopWorker(worker);
    expect(worker.stderrBytes).toBe(0);
  }, 20000);
});
