/** Synthetic transport at the existing collector injection point; production DB,
 * encrypted originals, engine pins, queue, worker and processor remain unchanged.
 * This operator CLI has no public route and never contacts an email provider. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { pool, withTenant } from '../../lib/server/db';
import { encrypt, decrypt } from '../../lib/server/crypto';
import {
  syncMailboxPage,
  type MailboxClaim,
} from '../../lib/server/mailbox-sync';
import {
  saveEngine,
  activateEngine,
  loadEngineRevision,
  sealJobEngine,
} from '../../lib/server/engine-store';
import type { WorkspaceContext } from '../../lib/server/access';

const corpus = dirname(fileURLToPath(import.meta.url));
const app = resolve(corpus, '../..');
const args = process.argv.slice(2);
const command = args[0] ?? 'plan';
function argument(name: string, fallback?: string) {
  const at = args.indexOf('--' + name);
  return at < 0 ? fallback : args[at + 1];
}
const output = resolve(
  argument('output', resolve(app, '../validation-mailroom-v1'))!,
);
if (output === app || output.startsWith(app + '/'))
  throw new Error('Run artifacts must be outside the repository.');
const sha = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString();
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
async function write(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.partial';
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
type Source = {
  id: string;
  filename: string;
  office_id: string;
  mailbox_id: string;
  source_message_id: string;
  sha256: string;
  category?: string;
  duplicate_of?: string;
};
type Manifest = {
  documents: Source[];
  files: Record<string, string>;
  [key: string]: unknown;
};
type Office = {
  id: string;
  organizationId: string;
  userId: string;
  profiles: Record<string, { id: string; revision: number }>;
};
type Mailbox = {
  id: string;
  sourceId: string;
  officeId: string;
  organizationId: string;
  userId: string;
};
type Work = {
  id: string;
  organizationId: string;
  documentId: string;
  sourceId: string;
  sourceIds: string[];
  model: string;
  mode: 'workflow' | 'agentic';
  cell: number;
  origin: 'collector' | 'explicit_same_original_comparison';
  status?: string;
};
type State = {
  version: 1;
  runId: string;
  createdAt: string;
  manifestSha256: string;
  models: string[];
  inventory: unknown[];
  processor: Record<string, string>;
  offices: Office[];
  mailboxes: Mailbox[];
  sources: Record<
    string,
    { organizationId: string; documentId: string; collectedJobId: string }
  >;
  work: Work[];
  collectionComplete?: boolean;
  retiredAt?: string;
};
let state: State;
let admin: Pool;
let manifest: Manifest;

async function loadManifest() {
  manifest = JSON.parse(await readFile(join(corpus, 'manifest.json'), 'utf8'));
  if (
    manifest.documents.length !== 100 ||
    new Set(manifest.documents.map((d) => d.office_id)).size !== 3 ||
    new Set(manifest.documents.map((d) => d.mailbox_id)).size !== 9
  )
    throw new Error('Expected exactly 100 receipts, 3 offices, 9 mailboxes.');
  for (const [path, expected] of Object.entries(manifest.files)) {
    const full = resolve(corpus, path);
    if (
      !full.startsWith(corpus + '/') ||
      sha(await readFile(full)) !== expected
    )
      throw new Error('Frozen corpus mismatch: ' + path);
  }
  for (const source of manifest.documents)
    if (sha(await readFile(resolve(corpus, source.filename))) !== source.sha256)
      throw new Error('Source digest mismatch: ' + source.id);
}
async function fingerprint() {
  const files = [
    'scripts/worker.ts',
    'lib/server/mailbox-sync.ts',
    'lib/server/mailbox-pages.ts',
    'lib/server/processing-result.ts',
    'lib/server/engine-store.ts',
    'lib/processing-contract.ts',
    'processor/requirements.lock.txt',
    'processor/corpus/train.json',
    'benchmark/mailroom-v1/collect.ts',
    'benchmark/mailroom-v1/decode_sources.py',
    'benchmark/mailroom-v1/record_models.py',
  ];
  files.push(
    ...(await readdir(join(app, 'processor/service')))
      .filter((name) => name.endsWith('.py'))
      .map((name) => 'processor/service/' + name),
  );
  files.push(
    ...(await readdir(join(app, 'lib/server')))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => 'lib/server/' + name),
  );
  const hashes: Record<string, string> = {};
  for (const path of files.sort())
    hashes[path] = sha(await readFile(join(app, path)));
  return hashes;
}
async function inventory(models: string[]) {
  const result = await fetch('http://127.0.0.1:11434/api/tags', {
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  if (!result.ok) throw new Error('Local inventory unavailable.');
  const data = await result.json();
  return models.map((model) => {
    const row = data.models?.find(
      (item: { name: string; model: string }) =>
        item.name === model || item.model === model,
    );
    if (
      !row ||
      row.remote_host ||
      row.remote_model ||
      row.details?.format !== 'gguf'
    )
      throw new Error(
        'Selected model must already be installed as a local GGUF: ' + model,
      );
    return row;
  });
}
async function connect() {
  for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) {
    const url = new URL(process.env[key] ?? 'https://invalid');
    if (
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.port !== '55439' ||
      url.pathname !== '/aster'
    )
      throw new Error(
        'Explicit isolated local Aster database on 55439 required.',
      );
  }
  const processor = new URL(
    process.env.PROCESSOR_URL ?? 'http://127.0.0.1:8000',
  );
  if (
    !['127.0.0.1', 'localhost'].includes(processor.hostname) ||
    processor.protocol !== 'http:' ||
    processor.port !== '8000'
  )
    throw new Error(
      'Only the existing loopback processor on 8000 is permitted.',
    );
  admin = new Pool({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    max: 2,
  });
  const role = (
    await pool.query(
      'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    )
  ).rows[0];
  if (role.rolsuper || role.rolbypassrls)
    throw new Error('Runtime connection must enforce row-level security.');
}
async function checkpoint() {
  await write(join(output, 'state.json'), state);
}
async function readState() {
  state = JSON.parse(await readFile(join(output, 'state.json'), 'utf8'));
  if (
    state.manifestSha256 !== sha(await readFile(join(corpus, 'manifest.json')))
  )
    throw new Error('Run belongs to a different frozen corpus.');
  if (state.retiredAt && command !== 'export')
    throw new Error('This run has retired access. Create a new run directory.');
}
function context(office: Office): WorkspaceContext {
  return {
    organizationId: office.organizationId,
    sessionId: randomUUID(),
    role: 'owner',
    user: {
      id: office.userId,
      email: 'owner+' + office.id + '@mailroom.example.invalid',
      name: 'SYNTHETIC mailroom operator',
    },
  };
}

async function provision() {
  try {
    await readState();
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const gemma = argument('gemma', 'gemma4:e4b-m3')!;
  const qwen = argument('qwen', 'qwen3-aster-cpu:1.7b')!;
  if (
    !gemma.toLowerCase().includes('gemma4') ||
    !qwen.toLowerCase().includes('qwen') ||
    [gemma, qwen].some((name) => /cloud/i.test(name))
  )
    throw new Error('Explicit local Gemma 4 then Qwen required.');
  state = {
    version: 1,
    runId: randomUUID(),
    createdAt: stamp(),
    manifestSha256: sha(await readFile(join(corpus, 'manifest.json'))),
    models: [gemma, qwen],
    inventory: await inventory([gemma, qwen]),
    processor: await fingerprint(),
    offices: [],
    mailboxes: [],
    sources: {},
    work: [],
  };
  for (const id of new Set(manifest.documents.map((d) => d.office_id))) {
    const office = {
      id,
      organizationId: randomUUID(),
      userId: randomUUID(),
      profiles: {},
    };
    state.offices.push(office);
    for (const sourceId of new Set(
      manifest.documents
        .filter((d) => d.office_id === id)
        .map((d) => d.mailbox_id),
    ))
      state.mailboxes.push({
        id: randomUUID(),
        sourceId,
        officeId: id,
        organizationId: office.organizationId,
        userId: state.mailboxes.some((m) => m.officeId === id)
          ? randomUUID()
          : office.userId,
      });
  }
  await checkpoint(); // IDs are durable before any DB mutation; re-running is idempotent.
}

async function collect() {
  const queued = Number(
    (
      await admin.query(
        'SELECT count(*) FROM app_job_queue WHERE NOT(organization_id=ANY($1::uuid[]))',
        [state.offices.map((o) => o.organizationId)],
      )
    ).rows[0].count,
  );
  if (queued)
    throw new Error(
      'Pause the normal worker and start with no unrelated document jobs queued.',
    );
  process.env.GOOGLE_CLIENT_ID = 'synthetic-mailroom-only';
  process.env.GOOGLE_CLIENT_SECRET = 'synthetic-mailroom-only';
  for (const office of state.offices) {
    await admin.query(
      'INSERT INTO app_organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',
      [
        office.organizationId,
        'SYNTHETIC MAILROOM ' + office.id + ' ' + state.runId.slice(0, 8),
      ],
    );
    for (const mailbox of state.mailboxes.filter(
      (m) => m.officeId === office.id,
    )) {
      await admin.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$2,$3,true,false) ON CONFLICT(id) DO NOTHING',
        [
          mailbox.userId,
          'SYNTHETIC ' + mailbox.sourceId,
          mailbox.sourceId + '+' + state.runId + '@example.invalid',
        ],
      );
      await admin.query(
        'INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(organization_id,user_id) DO NOTHING',
        [
          office.organizationId,
          mailbox.userId,
          mailbox.userId === office.userId ? 'owner' : 'analyst',
        ],
      );
    }
    for (const model of state.models) {
      if (office.profiles[model]) continue;
      const profile = await withTenant(office.organizationId, (client) =>
        saveEngine(client, context(office), {
          name: 'SYNTHETIC comparison ' + model,
          provider: 'ollama',
          model,
        }),
      );
      office.profiles[model] = {
        id: profile.profileId,
        revision: profile.revision,
      };
      await checkpoint();
    }
    await withTenant(office.organizationId, (client) =>
      activateEngine(
        client,
        context(office),
        office.profiles[state.models[0]].id,
        1,
      ),
    );
    await admin.query(
      "UPDATE app_organizations SET processing_mode='workflow' WHERE id=$1",
      [office.organizationId],
    );
  }
  const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
  function check(name: string, passed: boolean, detail?: unknown) {
    checks.push({ name, passed, detail });
    if (!passed) throw new Error('Collection assertion failed: ' + name);
  }
  const calls: unknown[] = [];
  for (const mailbox of state.mailboxes) {
    const sources = manifest.documents.filter(
      (d) => d.mailbox_id === mailbox.sourceId,
    );
    const backfill = sources.slice(0, -2),
      incremental = sources.slice(-2);
    const credentials = {
      accessToken: 'synthetic-' + mailbox.id,
      refreshToken: 'synthetic-refresh',
      expiresAt: Date.now() + 86400000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    };
    await admin.query(
      `INSERT INTO app_mailboxes(id,organization_id,provider,provider_account_id,email,display_name,connected_by,history_days,credentials) VALUES($1,$2,'gmail',$3,$4,$5,$6,NULL,$7) ON CONFLICT(id) DO NOTHING`,
      [
        mailbox.id,
        mailbox.organizationId,
        mailbox.sourceId,
        mailbox.sourceId + '@example.invalid',
        'SYNTHETIC ' + mailbox.sourceId,
        mailbox.userId,
        encrypt(
          JSON.stringify(credentials),
          'mailbox-credentials:' + mailbox.organizationId + ':' + mailbox.id,
        ),
      ],
    );
    await admin.query(
      'INSERT INTO app_mailbox_queue(id,organization_id,available_at) VALUES($1,$2,now()) ON CONFLICT(id) DO NOTHING',
      [mailbox.id, mailbox.organizationId],
    );
    const adapter: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (
        url.origin !== 'https://gmail.googleapis.com' ||
        new Headers(init?.headers).get('authorization') !==
          'Bearer ' + credentials.accessToken
      )
        throw new Error('Unexpected synthetic provider destination or token.');
      const row: Record<string, unknown> = {
        mailbox: mailbox.sourceId,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        at: stamp(),
      };
      calls.push(row);
      if (url.pathname.endsWith('/profile')) return json({ historyId: '100' });
      if (url.pathname.endsWith('/messages')) {
        const offset = Number(url.searchParams.get('pageToken') ?? 0);
        if (!Number.isInteger(offset) || offset < 0 || offset > backfill.length)
          throw new Error('Unexpected page token.');
        const batch = backfill.slice(offset, offset + 4);
        return json({
          messages: batch.map((d) => ({ id: d.source_message_id })),
          ...(offset + 4 < backfill.length
            ? { nextPageToken: String(offset + 4) }
            : {}),
        });
      }
      if (url.pathname.endsWith('/history')) {
        const historyId = url.searchParams.get('startHistoryId');
        if (!['100', '101'].includes(historyId ?? ''))
          throw new Error('Unexpected history cursor.');
        const rows =
          historyId === '100'
            ? [...incremental, sources[0], sources[0]]
            : [sources[0], ...incremental];
        return json({
          historyId: '101',
          history: [
            {
              messagesAdded: rows.map((d) => ({
                message: { id: d.source_message_id },
              })),
            },
          ],
        });
      }
      const source = sources.find((d) =>
        url.pathname.endsWith(
          '/messages/' + encodeURIComponent(d.source_message_id),
        ),
      );
      if (!source || url.searchParams.get('format') !== 'raw')
        throw new Error('Unexpected synthetic original request.');
      row.sourceId = source.id;
      return json({
        raw: (await readFile(resolve(corpus, source.filename))).toString(
          'base64url',
        ),
      });
    };
    const worker = 'synthetic-collector-' + randomUUID();
    let complete = false,
      pages = 0;
    while (!complete && pages++ < 20) {
      await admin.query(
        "UPDATE app_mailbox_queue SET lease_owner=$2,lease_until=now()+interval '90 seconds' WHERE id=$1",
        [mailbox.id, worker],
      );
      const claim: MailboxClaim = {
        id: mailbox.id,
        organization_id: mailbox.organizationId,
        lease_owner: worker,
      };
      complete = (await syncMailboxPage(claim, undefined, adapter)).complete;
      await admin.query(
        "UPDATE app_job_queue SET available_at='2099-01-01' WHERE organization_id=$1",
        [mailbox.organizationId],
      );
    }
    check(
      mailbox.sourceId + ': checkpoint reached history',
      complete && pages <= 20,
    );
    const before = Number(
      (
        await admin.query(
          'SELECT count(*) FROM app_mailbox_receipts WHERE mailbox_id=$1',
          [mailbox.id],
        )
      ).rows[0].count,
    );
    await admin.query(
      "UPDATE app_mailbox_queue SET lease_owner=$2,lease_until=now()+interval '90 seconds' WHERE id=$1",
      [mailbox.id, worker],
    );
    await syncMailboxPage(
      {
        id: mailbox.id,
        organization_id: mailbox.organizationId,
        lease_owner: worker,
      },
      undefined,
      adapter,
    );
    const after = Number(
      (
        await admin.query(
          'SELECT count(*) FROM app_mailbox_receipts WHERE mailbox_id=$1',
          [mailbox.id],
        )
      ).rows[0].count,
    );
    check(
      mailbox.sourceId + ': replay adds zero receipts',
      before === sources.length && after === before,
      { expected: sources.length, before, after },
    );
    const cursorRow = (
      await admin.query(
        'SELECT cursor,imported_count,last_synced_at FROM app_mailboxes WHERE id=$1',
        [mailbox.id],
      )
    ).rows[0];
    const cursor = JSON.parse(
      decrypt(
        cursorRow.cursor,
        'mailbox-cursor:' + mailbox.organizationId + ':' + mailbox.id,
      ).toString(),
    );
    check(
      mailbox.sourceId + ': durable history cursor',
      cursor.stage === 'history' &&
        cursor.historyId === '101' &&
        !!cursorRow.last_synced_at,
      cursor,
    );
    await admin.query('DELETE FROM app_mailbox_queue WHERE id=$1', [
      mailbox.id,
    ]); // Connector remains inspectable; never schedule fake credentials against real Gmail.
    for (const source of sources) {
      const result = (
        await admin.query(
          'SELECT r.document_id,r.outcome,d.payload,j.id AS job_id FROM app_mailbox_receipts r JOIN app_documents d ON d.id=r.document_id JOIN app_jobs j ON j.document_id=d.id WHERE r.mailbox_id=$1 AND r.message_id=$2 ORDER BY j.created_at LIMIT 1',
          [mailbox.id, source.source_message_id],
        )
      ).rows[0];
      check(
        source.id + ': encrypted original exact',
        !!result &&
          result.outcome === 'imported' &&
          sha(
            decrypt(
              result.payload,
              'document:' + mailbox.organizationId + ':' + result.document_id,
            ),
          ) === source.sha256,
      );
      state.sources[source.id] = {
        organizationId: mailbox.organizationId,
        documentId: result.document_id,
        collectedJobId: result.job_id,
      };
    }
    await checkpoint();
  }
  const unique = new Map<string, Source[]>();
  for (const source of manifest.documents) {
    const key = source.office_id + ':' + source.sha256;
    unique.set(key, [...(unique.get(key) ?? []), source]);
  }
  check(
    '100 persisted mailbox receipts',
    Object.keys(state.sources).length === 100,
  );
  check(
    'Tenant-local identical content shares document and initial job',
    [...unique.values()].every(
      (rows) =>
        new Set(rows.map((d) => state.sources[d.id].documentId)).size === 1 &&
        new Set(rows.map((d) => state.sources[d.id].collectedJobId)).size === 1,
    ),
  );
  check(
    'Source hash dedupe preserves expected unique originals',
    new Set(Object.values(state.sources).map((d) => d.documentId)).size ===
      unique.size,
    { receipts: 100, originals: unique.size },
  );
  const crossGroups = new Map<string, Source[]>();
  for (const source of manifest.documents)
    crossGroups.set(source.sha256, [
      ...(crossGroups.get(source.sha256) ?? []),
      source,
    ]);
  for (const rows of crossGroups.values())
    if (new Set(rows.map((d) => d.office_id)).size > 1)
      check(
        'Identical cross-office original stays isolated: ' + rows[0].id,
        new Set(rows.map((d) => state.sources[d.id].documentId)).size ===
          new Set(rows.map((d) => d.office_id)).size,
      );
  for (const office of state.offices) {
    const foreign = state.offices.find((o) => o.id !== office.id)!;
    const docs = await withTenant(office.organizationId, (client) =>
      client.query('SELECT id FROM app_documents WHERE organization_id=$1', [
        foreign.organizationId,
      ]),
    );
    const receipts = await withTenant(office.organizationId, (client) =>
      client.query(
        'SELECT message_id FROM app_mailbox_receipts WHERE organization_id=$1',
        [foreign.organizationId],
      ),
    );
    check(
      office.id + ': foreign documents and receipts inaccessible under RLS',
      docs.rowCount === 0 && receipts.rowCount === 0,
    );
  }
  if (!state.work.length)
    for (let cell = 0; cell < 4; cell++) {
      const model = state.models[Math.floor(cell / 2)],
        mode = cell % 2 ? 'agentic' : 'workflow';
      for (const rows of unique.values()) {
        const source = rows[0],
          stored = state.sources[source.id];
        state.work.push({
          id: cell === 0 ? stored.collectedJobId : randomUUID(),
          organizationId: stored.organizationId,
          documentId: stored.documentId,
          sourceId: source.id,
          sourceIds: rows.map((d) => d.id),
          model,
          mode,
          cell,
          origin:
            cell === 0 ? 'collector' : 'explicit_same_original_comparison',
        });
      }
    }
  state.collectionComplete = true;
  await checkpoint();
  await write(join(output, 'collection.json'), {
    completedAt: stamp(),
    status: 'passed',
    checks,
    providerCalls: calls,
    networkCallsToMailProviders: 0,
    receiptCount: 100,
    uniqueOriginals: unique.size,
    plannedUniqueJobs: state.work.length,
    plannedReceiptEvaluations: 400,
    ordinaryCollectorCreatedInitialJobs: unique.size,
    models: state.models,
    transport:
      'Production Gmail history/backfill transport replaced through its existing fetcher parameter; no public endpoint or production bypass added.',
    mailboxScheduling:
      'Synthetic connector queues removed after collection; no real provider call can be scheduled.',
  });
  console.log(
    JSON.stringify({
      collection: 'passed',
      receipts: 100,
      uniqueOriginals: unique.size,
      checks: checks.length,
      plannedUniqueJobs: state.work.length,
      output,
    }),
  );
}

async function exportResults() {
  const results = [];
  for (const work of state.work) {
    const row = (
      await admin.query(
        'SELECT status,result,error_code,created_at,updated_at,engine_snapshot,review_revision FROM app_jobs WHERE id=$1 AND organization_id=$2',
        [work.id, work.organizationId],
      )
    ).rows[0];
    const result = row?.result
      ? JSON.parse(
          decrypt(
            row.result,
            'result:' + work.organizationId + ':' + work.id,
          ).toString(),
        )
      : null;
    results.push({
      ...work,
      status: row?.status ?? 'unrun',
      errorCode: row?.error_code ?? null,
      createdAt: row?.created_at ?? null,
      updatedAt: row?.updated_at ?? null,
      engineSnapshot: row?.engine_snapshot ?? null,
      reviewRevision: row?.review_revision ?? null,
      output: result,
    });
  }
  await write(join(output, 'results.json'), results);
  const counts = results.reduce<Record<string, number>>(
    (acc, row) => ({ ...acc, [row.status]: (acc[row.status] ?? 0) + 1 }),
    {},
  );
  await write(join(output, 'progress.json'), {
    at: stamp(),
    plannedUniqueJobs: state.work.length,
    plannedReceiptEvaluations: 400,
    counts,
    completedReceiptEvaluations: results
      .filter((r) => ['awaiting_review', 'failed'].includes(r.status))
      .reduce((sum, r) => sum + r.sourceIds.length, 0),
    actualOriginalsPreserved: new Set(results.map((r) => r.documentId)).size,
    automaticAcceptance: false,
  });
  return results;
}

async function run() {
  if (!state.collectionComplete)
    throw new Error('Collection must finish before inference.');
  if (JSON.stringify(await fingerprint()) !== JSON.stringify(state.processor))
    throw new Error(
      'Processor or harness changed after collection. Use a new preserved run.',
    );
  if (
    JSON.stringify(await inventory(state.models)) !==
    JSON.stringify(state.inventory)
  )
    throw new Error('Selected model inventory changed.');
  const unexpected = (
    await admin.query(
      'SELECT id FROM app_job_queue WHERE NOT(organization_id=ANY($1::uuid[]))',
      [state.offices.map((o) => o.organizationId)],
    )
  ).rowCount;
  if (unexpected)
    throw new Error(
      'Unrelated document jobs are queued; do not start a global worker for this experiment.',
    );
  const lock = await admin.connect();
  if (
    !(
      await lock.query(
        "SELECT pg_try_advisory_lock(hashtextextended('aster-synthetic-mailroom-run',0)) AS locked",
      )
    ).rows[0].locked
  ) {
    lock.release();
    throw new Error('Another mailroom runner owns this experiment.');
  }
  const attemptRoot = join(output, 'attempts');
  await mkdir(attemptRoot, { recursive: true, mode: 0o700 });
  // Resume safely: no pending synthetic job can reach the worker until its
  // expected pin is installed as the recording proxy's current request.
  await admin.query(
    "UPDATE app_job_queue SET available_at='2099-01-01' WHERE organization_id=ANY($1::uuid[])",
    [state.offices.map((o) => o.organizationId)],
  );
  let current: Work | undefined;
  let stopped = false;
  const processorOrigin = new URL(process.env.PROCESSOR_URL!);
  const server = createServer(async (request, response) => {
    const started = Date.now();
    let attemptPath: string | undefined;
    const meta: Record<string, unknown> = { startedAt: stamp() };
    try {
      if (
        !current ||
        request.method !== 'POST' ||
        request.url !== '/v1/extract' ||
        request.headers['x-processor-key'] !== process.env.PROCESSOR_TOKEN
      )
        throw new Error('Unexpected processor proxy request.');
      const work = current;
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 11 * 1024 * 1024)
          throw new Error('Bounded synthetic request exceeded.');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      const contentType = String(request.headers['content-type'] ?? '');
      const form = await new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: bytes,
      }).formData();
      const rawEngine = form.get('engine');
      if (typeof rawEngine !== 'string')
        throw new Error('Missing worker engine pin.');
      const engine = JSON.parse(rawEngine);
      if (
        form.get('document_id') !== work.documentId ||
        form.get('mode') !== work.mode ||
        engine.provider !== 'ollama' ||
        engine.model !== work.model ||
        engine.apiKey
      )
        throw new Error('Worker engine/source pin differs from planned cell.');
      attemptPath = join(
        attemptRoot,
        work.id,
        String(started) + '-' + randomUUID().slice(0, 8),
      );
      await mkdir(attemptPath, { recursive: true, mode: 0o700 });
      Object.assign(meta, {
        jobId: work.id,
        sourceId: work.sourceId,
        sourceIds: work.sourceIds,
        model: work.model,
        mode: work.mode,
        cell: work.cell,
        requestBytes: bytes.length,
        contentType,
        requestSha256: sha(bytes),
        plannedEngineVerified: true,
      });
      await writeFile(join(attemptPath, 'request.multipart.bin'), bytes, {
        mode: 0o600,
      });
      await write(join(attemptPath, 'attempt.json'), meta);
      const upstream = await fetch(new URL('/v1/extract', processorOrigin), {
        method: 'POST',
        headers: {
          'X-Processor-Key': process.env.PROCESSOR_TOKEN!,
          'Content-Type': contentType,
        },
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.timeout(650000),
      });
      meta.httpStatus = upstream.status;
      const received = Buffer.from(await upstream.arrayBuffer());
      if (received.length > 2_000_000)
        throw new Error('Processor response exceeded production bound.');
      await writeFile(join(attemptPath, 'response.json'), received, {
        mode: 0o600,
      });
      meta.responseBytes = received.length;
      meta.responseSha256 = sha(received);
      response.writeHead(upstream.status, {
        'Content-Type':
          upstream.headers.get('content-type') ?? 'application/json',
      });
      response.end(received);
    } catch (error) {
      meta.errorType = error instanceof Error ? error.name : 'UnknownError';
      meta.error = error instanceof Error ? error.message : 'Unknown error';
      if (!response.headersSent)
        response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end('{"error":"SYNTHETIC_RECORDING_PROXY_FAILED"}');
    } finally {
      meta.finishedAt = stamp();
      meta.wallSeconds = (Date.now() - started) / 1000;
      if (attemptPath) await write(join(attemptPath, 'attempt.json'), meta);
    }
  });
  await new Promise<void>((yes, no) => {
    server.once('error', no);
    server.listen(8003, '127.0.0.1', yes);
  });
  const worker = spawn(
    process.execPath,
    [
      '--conditions=react-server',
      '--import',
      'tsx',
      join(app, 'scripts/worker.ts'),
    ],
    {
      cwd: app,
      env: {
        ...process.env,
        PROCESSOR_URL: 'http://127.0.0.1:8003',
        WORKER_HEARTBEAT_FILE: join(output, 'worker-heartbeat'),
        WORKER_ORGANIZATION_IDS: state.offices
          .map((o) => o.organizationId)
          .join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  worker.stdout.on(
    'data',
    (chunk) =>
      void writeFile(join(output, 'worker.stdout.txt'), chunk, {
        flag: 'a',
        mode: 0o600,
      }),
  );
  worker.stderr.on(
    'data',
    (chunk) =>
      void writeFile(join(output, 'worker.stderr.txt'), chunk, {
        flag: 'a',
        mode: 0o600,
      }),
  );
  const stop = () => {
    stopped = true;
    worker.kill('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const cellLimit = Number(argument('through-cell', '3'));
  try {
    for (const work of state.work) {
      if (stopped || work.cell > cellLimit) break;
      if (
        JSON.stringify(await fingerprint()) !== JSON.stringify(state.processor)
      )
        throw new Error(
          'Processing source changed during experiment; remaining jobs are unrun.',
        );
      const existing = (
        await admin.query('SELECT status FROM app_jobs WHERE id=$1', [work.id])
      ).rows[0];
      if (
        existing &&
        [
          'awaiting_review',
          'failed',
          'accepted',
          'rejected',
          'cancelled',
        ].includes(existing.status)
      )
        continue;
      const office = state.offices.find(
        (o) => o.organizationId === work.organizationId,
      )!;
      if (!existing)
        await withTenant(work.organizationId, async (client) => {
          const profile = office.profiles[work.model];
          const selected = await loadEngineRevision(
            client,
            work.organizationId,
            profile.id,
            profile.revision,
          );
          const pinned = sealJobEngine(
            selected.config,
            selected.snapshot,
            work.organizationId,
            work.id,
          );
          await client.query(
            'INSERT INTO app_jobs(id,organization_id,document_id,created_by,mode,policy_revision,engine_snapshot,engine_config) VALUES($1,$2,$3,$4,$5,1,$6,$7)',
            [
              work.id,
              work.organizationId,
              work.documentId,
              office.userId,
              work.mode,
              JSON.stringify(pinned.snapshot),
              pinned.payload,
            ],
          );
          await client.query(
            "INSERT INTO app_job_queue(id,organization_id,available_at) VALUES($1,$2,'2099-01-01')",
            [work.id, work.organizationId],
          );
        });
      current = work;
      await write(join(output, 'current.json'), {
        ...work,
        startedAt: stamp(),
      });
      await admin.query(
        'UPDATE app_job_queue SET available_at=now() WHERE id=$1 AND organization_id=$2',
        [work.id, work.organizationId],
      );
      for (;;) {
        if (stopped) break;
        if (worker.exitCode !== null)
          throw new Error(
            'Production worker exited unexpectedly; retained queue can resume.',
          );
        const row = (
          await admin.query(
            'SELECT status,error_code FROM app_jobs WHERE id=$1',
            [work.id],
          )
        ).rows[0];
        if (
          row &&
          [
            'awaiting_review',
            'failed',
            'accepted',
            'rejected',
            'cancelled',
          ].includes(row.status)
        ) {
          work.status = row.status;
          await checkpoint();
          await exportResults();
          console.log(
            JSON.stringify({
              at: stamp(),
              finished: state.work.filter((w) => w.status).length,
              planned: state.work.length,
              cell: work.cell,
              sourceId: work.sourceId,
              model: work.model,
              mode: work.mode,
              status: row.status,
              errorCode: row.error_code,
            }),
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } finally {
    worker.kill('SIGTERM');
    if (worker.exitCode === null)
      await new Promise<void>((yes) => {
        worker.once('exit', () => yes());
        setTimeout(() => {
          worker.kill('SIGKILL');
          yes();
        }, 10000).unref();
      });
    server.close();
    await lock.query(
      "SELECT pg_advisory_unlock(hashtextextended('aster-synthetic-mailroom-run',0))",
    );
    lock.release();
    await exportResults();
    await write(join(output, 'run-observation.json'), {
      stoppedAt: stamp(),
      interrupted: stopped,
      processorUnchanged:
        JSON.stringify(await fingerprint()) === JSON.stringify(state.processor),
      inventoryUnchanged:
        JSON.stringify(await inventory(state.models)) ===
        JSON.stringify(state.inventory),
      worker:
        'Unmodified scripts/worker.ts, production lease/retry/persistence path',
      retainedEveryHttpAttempt: true,
      modelCalls:
        'Actual production trace model_usage; exact processor requests/results retained. Optional raw model recording is preserved and independently audited by record_models.py.',
      noAutomaticAcceptance: true,
    });
  }
}

async function retire() {
  const orgs = state.offices.map((o) => o.organizationId),
    users = state.mailboxes.map((m) => m.userId);
  const pending = Number(
    (
      await admin.query(
        'SELECT count(*) FROM app_job_queue WHERE organization_id=ANY($1::uuid[])',
        [orgs],
      )
    ).rows[0].count,
  );
  if (pending)
    throw new Error(
      'Finish or explicitly cancel pending comparison jobs before retiring.',
    );
  await admin.query(
    'DELETE FROM app_mailbox_queue WHERE organization_id=ANY($1::uuid[])',
    [orgs],
  );
  await admin.query(
    "UPDATE app_mailboxes SET status='disconnected',credentials=NULL,cursor=NULL,generation=generation+1 WHERE organization_id=ANY($1::uuid[])",
    [orgs],
  );
  await admin.query(
    'UPDATE app_memberships SET revoked_at=now() WHERE organization_id=ANY($1::uuid[]) AND user_id=ANY($2::text[])',
    [orgs, users],
  );
  await admin.query('DELETE FROM auth_session WHERE "userId"=ANY($1::text[])', [
    users,
  ]);
  state.retiredAt = stamp();
  await checkpoint();
  console.log(
    JSON.stringify({
      syntheticAccessRetired: true,
      originalsJobsResultsAndAuditPreserved: true,
    }),
  );
}

try {
  await loadManifest();
  if (command === 'plan')
    console.log(
      JSON.stringify(
        {
          planOnly: true,
          receipts: 100,
          offices: 3,
          mailboxes: 9,
          order: [
            'Gemma4 workflow',
            'Gemma4 agentic',
            'Qwen workflow',
            'Qwen agentic',
          ],
          output,
          transport:
            'fake Gmail fetcher only; real production collector, original storage, job queue, worker and processor',
          modelsContacted: false,
        },
        null,
        2,
      ),
    );
  else {
    if (!args.includes('--execute'))
      throw new Error(
        'Operator must explicitly supply --execute for DB changes or inference.',
      );
    await connect();
    if (command === 'collect') {
      await provision();
      await collect();
    } else {
      await readState();
      if (command === 'run') await run();
      else if (command === 'export') {
        await exportResults();
        console.log(JSON.stringify({ exported: true, output }));
      } else if (command === 'retire') await retire();
      else throw new Error('Unknown command.');
    }
  }
} finally {
  if (admin!) await admin.end();
  await pool.end();
}
