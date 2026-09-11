import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { assertDisposableDatabase } from '../test-support/disposable-database';
import type { WorkspaceContext } from './access';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
}));
const enabled = process.env.ASTER_ARCHIVE_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'durable archive with disposable PostgreSQL and real local files',
  () => {
    let admin: Pool,
      db: typeof import('./db'),
      store: typeof import('./archive-store'),
      crypto: typeof import('./crypto');
    let root: string, ctx: WorkspaceContext, foreign: string;
    const orgs: string[] = [],
      users: string[] = [];
    beforeAll(async () => {
      assertDisposableDatabase();
      admin = new Pool({
        connectionString: process.env.MIGRATION_DATABASE_URL,
        max: 3,
      });
      root = await mkdtemp(path.join(tmpdir(), 'aster-archive-test-'));
      vi.stubEnv('ASTER_ARCHIVE_ROOT', root);
      db = await import('./db');
      store = await import('./archive-store');
      crypto = await import('./crypto');
    });
    beforeEach(async () => {
      const org = randomUUID(),
        user = randomUUID(),
        session = randomUUID();
      foreign = randomUUID();
      orgs.push(org, foreign);
      users.push(user);
      ctx = {
        organizationId: org,
        role: 'owner',
        sessionId: session,
        user: {
          id: user,
          name: 'Archive fixture owner',
          email: user + '@example.invalid',
        },
      };
      await admin.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$2,$3,true,true)',
        [user, ctx.user.name, ctx.user.email],
      );
      await admin.query(
        'INSERT INTO auth_session(id,"userId",token,"expiresAt","mfaVerifiedAt") VALUES($1,$2,$3,clock_timestamp()+interval \'1 hour\',clock_timestamp())',
        [session, user, randomUUID()],
      );
      await admin.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2),($3,$4)',
        [org, 'Synthetic archive office', foreign, 'Foreign synthetic office'],
      );
      await admin.query(
        "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
        [org, user],
      );
    });
    afterEach(() => vi.restoreAllMocks());
    afterAll(async () => {
      if (admin) {
        for (const table of [
          'app_archive_commands',
          'app_archive_jobs',
          'app_archive_destinations',
          'app_document_access',
          'app_documents',
          'app_audit',
          'app_memberships',
        ])
          await admin.query(
            'DELETE FROM ' + table + ' WHERE organization_id=ANY($1::uuid[])',
            [orgs],
          );
        await admin.query(
          'DELETE FROM app_organizations WHERE id=ANY($1::uuid[])',
          [orgs],
        );
        await admin.query('DELETE FROM auth_user WHERE id=ANY($1::text[])', [
          users,
        ]);
        await admin.end();
      }
      await db?.pool.end();
      if (root) await rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    async function source(old = false, org = ctx.organizationId) {
      const id = randomUUID(),
        bytes = Buffer.from(
          'Synthetic retained source ' + id + '; extraction may fail.',
        );
      await admin.query(
        "INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $9 THEN '2020-01-01'::timestamptz ELSE clock_timestamp() END)",
        [
          id,
          org,
          ctx.user.id,
          'source.txt',
          'text/plain',
          crypto.sha256(bytes),
          bytes.length,
          crypto.encrypt(bytes, 'document:' + org + ':' + id),
          old,
        ],
      );
      return { id, bytes };
    }
    async function configure(enabled = true, directory = 'Documents') {
      const current = (await store.listArchives(ctx)).destination;
      return store.archiveCommand(ctx, {
        action: 'configure',
        expectedRevision: current?.revision ?? 0,
        idempotencyKey: randomUUID(),
        destination: {
          provider: 'local',
          label: 'Local source archive',
          directory,
          enabled,
        },
      });
    }
    async function backfill() {
      return store.archiveCommand(ctx, {
        action: 'backfill',
        expectedRevision: (await store.listArchives(ctx)).destination!.revision,
        idempotencyKey: randomUUID(),
      });
    }
    async function claim() {
      const claim = await store.claimArchive([ctx.organizationId]);
      expect(claim).not.toBeNull();
      return claim!;
    }
    it('automatically discovers new retained documents independently of jobs and requires explicit historical backfill', async () => {
      const old = await source(true);
      await configure();
      const fresh = await source();
      expect((await store.discoverArchives([ctx.organizationId])).queued).toBe(
        1,
      );
      let state = await store.listArchives(ctx);
      expect(state.records.map((r) => r.documentId)).toEqual([fresh.id]);
      expect(state.eligibleUnqueued).toBe(1);
      expect((await backfill()).affected).toBe(1);
      await store.discoverArchives([ctx.organizationId]);
      state = await store.listArchives(ctx);
      expect(state.records.map((r) => r.documentId).sort()).toEqual(
        [old.id, fresh.id].sort(),
      );
      expect(state.counts.queued).toBe(2);
    });
    it('archives original exact bytes once, encrypts metadata/receipts and detects later artifact tampering', async () => {
      await configure();
      const doc = await source();
      await store.discoverArchives([ctx.organizationId]);
      const job = await claim();
      const receipt = await store.processArchive(job);
      expect(receipt.originalSha256).toBe(crypto.sha256(doc.bytes));
      const original = path.join(
        root,
        ctx.organizationId,
        'Documents',
        receipt.relativePath,
        'original.txt',
      );
      expect(await readFile(original)).toEqual(doc.bytes);
      await expect(store.processArchive(job)).rejects.toThrow(
        'ARCHIVE_LEASE_LOST',
      );
      expect(await store.claimArchive([ctx.organizationId])).toBeNull();
      const raw = (
        await admin.query(
          'SELECT metadata,receipt FROM app_archive_jobs WHERE id=$1',
          [job.id],
        )
      ).rows[0];
      expect(raw.metadata.includes(Buffer.from('Documents'))).toBe(false);
      expect(raw.receipt.includes(Buffer.from(receipt.relativePath))).toBe(
        false,
      );
      expect(
        (await store.archiveCommand(ctx, { action: 'verify', jobId: job.id }))
          .issues,
      ).toEqual([]);
      await writeFile(original, 'tampered', { mode: 0o600 });
      const verified = await store.archiveCommand(ctx, {
        action: 'verify',
        jobId: job.id,
      });
      expect(verified.issues?.length).toBeGreaterThan(0);
      expect(
        (await store.documentArchives(ctx, doc.id)).records[0].lastVerification
          ?.ok,
      ).toBe(false);
    });
    it('preserves configuration idempotency, rejects stale revisions and different reused commands', async () => {
      const command = {
        action: 'configure' as const,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
        destination: {
          provider: 'local' as const,
          label: 'Private archive',
          directory: 'Documents',
          enabled: true,
        },
      };
      const result = await store.archiveCommand(ctx, command);
      expect(await store.archiveCommand(ctx, command)).toEqual(result);
      await expect(
        store.archiveCommand(ctx, {
          ...command,
          destination: { ...command.destination, label: 'Other' },
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await expect(
        store.archiveCommand(ctx, { ...command, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect((await store.listArchives(ctx)).destination?.archiveRevision).toBe(
        1,
      );
    });
    it('pauses claimed work, fences old claims and resumes the same destination edition', async () => {
      await configure();
      await source();
      await store.discoverArchives([ctx.organizationId]);
      const old = await claim();
      await configure(false);
      await expect(store.processArchive(old)).rejects.toThrow(
        'ARCHIVE_LEASE_LOST',
      );
      expect(await store.claimArchive([ctx.organizationId])).toBeNull();
      await configure(true);
      expect((await store.listArchives(ctx)).destination?.archiveRevision).toBe(
        1,
      );
      const next = await claim();
      expect(next.id).toBe(old.id);
      expect(next.owner).not.toBe(old.owner);
      await store.processArchive(next);
    });
    it('changing directory invalidates pending claims; explicit backfill creates a fresh edition', async () => {
      await configure();
      const doc = await source();
      await store.discoverArchives([ctx.organizationId]);
      const old = await claim();
      await configure(true, 'New destination');
      await expect(store.processArchive(old)).rejects.toThrow(
        'ARCHIVE_LEASE_LOST',
      );
      expect((await store.listArchives(ctx)).records[0]).toMatchObject({
        status: 'failed',
        errorCode: 'DESTINATION_CHANGED',
      });
      await expect(
        store.archiveCommand(ctx, {
          action: 'retry',
          jobId: old.id,
          expectedRevision: 2,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'DESTINATION_CHANGED' });
      expect((await store.discoverArchives([ctx.organizationId])).queued).toBe(
        0,
      );
      await backfill();
      const next = await claim();
      expect(next.id).not.toBe(old.id);
      const receipt = await store.processArchive(next);
      expect(receipt.relativePath.startsWith('r2/')).toBe(true);
      expect((await store.documentArchives(ctx, doc.id)).records).toHaveLength(
        2,
      );
    });
    it('expired leases cannot renew, publish, or overwrite a newer worker result', async () => {
      await configure();
      await source();
      await store.discoverArchives([ctx.organizationId]);
      const old = await claim();
      await admin.query(
        "UPDATE app_archive_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [old.id],
      );
      expect(await store.renewArchiveLease(old)).toBe(false);
      await expect(store.processArchive(old)).rejects.toThrow(
        'ARCHIVE_LEASE_LOST',
      );
      const next = await claim();
      await store.processArchive(next);
      await store.failArchive(old, new Error('late failure private contents'));
      expect((await store.listArchives(ctx)).records[0].status).toBe(
        'archived',
      );
    });
    it('capacity deferrals do not exhaust attempts; terminal failures require an idempotent explicit retry', async () => {
      await configure();
      await source();
      await store.discoverArchives([ctx.organizationId]);
      let job = await claim();
      await store.failArchive(job, { code: 'PROCESSOR_BUSY' });
      expect((await store.listArchives(ctx)).records[0]).toMatchObject({
        status: 'queued',
        attempts: 0,
        errorCode: 'PROCESSOR_BUSY',
      });
      for (let i = 0; i < 3; i++) {
        await admin.query(
          'UPDATE app_archive_jobs SET available_at=clock_timestamp() WHERE id=$1',
          [job.id],
        );
        job = await claim();
        await store.failArchive(
          job,
          new Error('/secret/source.pdf customer data'),
        );
      }
      expect((await store.listArchives(ctx)).records[0]).toMatchObject({
        status: 'failed',
        attempts: 3,
        errorCode: 'ARCHIVE_FAILED',
      });
      const command = {
        action: 'retry' as const,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
        jobId: job.id,
      };
      expect((await store.archiveCommand(ctx, command)).affected).toBe(1);
      expect((await store.archiveCommand(ctx, command)).affected).toBe(1);
      await store.processArchive(await claim());
      expect((await store.listArchives(ctx)).counts.archived).toBe(1);
    });
    it('enforces office RLS, document scope, current administrator role and MFA on mutations', async () => {
      await configure();
      const doc = await source();
      await store.discoverArchives([ctx.organizationId]);
      const job = await claim();
      await store.processArchive(job);
      expect(
        (
          await db.withTenant(foreign, (c) =>
            c.query('SELECT * FROM app_archive_jobs'),
          )
        ).rowCount,
      ).toBe(0);
      expect(await store.claimArchive([foreign])).toBeNull();
      await expect(
        store.archiveCommand(
          { ...ctx, role: 'analyst' },
          { action: 'test', directory: 'Documents' },
        ),
      ).rejects.toMatchObject({ status: 403 });
      await admin.query(
        "UPDATE app_memberships SET role='viewer',data_scope=$1 WHERE organization_id=$2 AND user_id=$3",
        [
          JSON.stringify({ familyIds: ['family-a'] }),
          ctx.organizationId,
          ctx.user.id,
        ],
      );
      const scoped = {
        ...ctx,
        role: 'viewer' as const,
        scope: { familyIds: ['family-a'] },
      };
      await expect(
        store.documentArchives(scoped, doc.id),
      ).rejects.toMatchObject({ status: 404 });
      await admin.query(
        'INSERT INTO app_document_access(organization_id,document_id,family_ids,reviewed_by) VALUES($1,$2,$3,$4)',
        [ctx.organizationId, doc.id, ['family-a'], ctx.user.id],
      );
      const visible = await store.documentArchives(scoped, doc.id);
      expect(visible.records[0].status).toBe('archived');
      expect(visible.records[0].receipt).toBeNull();
      expect(visible.canManage).toBe(false);
      await expect(
        store.archiveCommand(ctx, { action: 'test', directory: 'Documents' }),
      ).rejects.toMatchObject({ status: 403 });
      await admin.query(
        "UPDATE app_memberships SET role='owner',data_scope=NULL WHERE organization_id=$1 AND user_id=$2",
        [ctx.organizationId, ctx.user.id],
      );
      await admin.query(
        'UPDATE auth_session SET "mfaVerifiedAt"=NULL WHERE id=$1',
        [ctx.sessionId],
      );
      await expect(
        store.archiveCommand(ctx, { action: 'test', directory: 'Documents' }),
      ).rejects.toMatchObject({ status: 403 });
    });
    it('continues bounded historical discovery beyond one batch and filters actionable lists', async () => {
      await configure();
      for (let i = 0; i < 103; i++) await source(true);
      expect((await backfill()).affected).toBe(100);
      expect((await store.discoverArchives([ctx.organizationId])).queued).toBe(
        3,
      );
      expect((await store.discoverArchives([ctx.organizationId])).queued).toBe(
        0,
      );
      const state = await store.listArchives(ctx);
      expect(state.records).toHaveLength(50);
      expect(state.hasMore).toBe(true);
      expect(state.counts.queued).toBe(103);
      expect((await store.listArchives(ctx, 100)).records).toHaveLength(3);
      expect((await store.listArchives(ctx, 0, 'failed')).records).toHaveLength(
        0,
      );
    });
    it('keeps archive receipts verifiable after retained inputs are purged', async () => {
      await configure();
      const doc = await source();
      await store.discoverArchives([ctx.organizationId]);
      const job = await claim();
      await store.processArchive(job);
      await admin.query(
        'DELETE FROM app_documents WHERE id=$1 AND organization_id=$2',
        [doc.id, ctx.organizationId],
      );
      const record = (await store.listArchives(ctx)).records[0];
      expect(record.sourceRetained).toBe(false);
      expect(record.filename).toBe('source.txt');
      expect(record.receipt).not.toBeNull();
      expect(
        (await store.archiveCommand(ctx, { action: 'verify', jobId: job.id }))
          .issues,
      ).toEqual([]);
      await expect(store.documentArchives(ctx, doc.id)).rejects.toMatchObject({
        status: 404,
      });
    });
    it.each(['pause', 'revoke'] as const)(
      'fences publication when administrator %s occurs during an email render',
      async (change) => {
        let started!: () => void, release!: () => void;
        const startedPromise = new Promise<void>((resolve) => {
            started = resolve;
          }),
          barrier = new Promise<void>((resolve) => {
            release = resolve;
          });
        const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          pdf = Buffer.from('%PDF-1.7 synthetic fixture');
        const artifact = (bytes: Buffer) => ({
          base64: bytes.toString('base64'),
          sha256: crypto.sha256(bytes),
        });
        const server = createServer(async (request, response) => {
          request.resume();
          started();
          await barrier;
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({
              schemaVersion: 1,
              rendererVersion: 'synthetic',
              canonicalText: 'Synthetic email',
              warnings: [],
              truncated: false,
              pageCount: 1,
              fontProfile: 'fixture',
              pngPages: [{ ...artifact(png), page: 1, width: 1, height: 1 }],
              pdf: artifact(pdf),
            }),
          );
        });
        await new Promise<void>((resolve) =>
          server.listen(0, '127.0.0.1', resolve),
        );
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Fixture server missing');
        const prior = process.env.PROCESSOR_URL;
        vi.stubEnv('PROCESSOR_URL', 'http://127.0.0.1:' + address.port);
        try {
          await configure();
          const doc = await source();
          const bytes = Buffer.from(
            'From: synthetic@example.invalid\r\nSubject: Synthetic notice\r\n\r\nSynthetic retained email.',
          );
          await admin.query(
            'UPDATE app_documents SET filename=$1,mime_type=$2,content_hash=$3,byte_size=$4,payload=$5 WHERE id=$6',
            [
              'notice.eml',
              'message/rfc822',
              crypto.sha256(bytes),
              bytes.length,
              crypto.encrypt(
                bytes,
                'document:' + ctx.organizationId + ':' + doc.id,
              ),
              doc.id,
            ],
          );
          await store.discoverArchives([ctx.organizationId]);
          const job = await claim();
          const processing = store.processArchive(job);
          const rejected = expect(processing).rejects.toThrow(
            change === 'pause'
              ? 'ARCHIVE_LEASE_LOST'
              : 'ARCHIVE_AUTHORIZATION_CHANGED',
          );
          await startedPromise;
          if (change === 'pause') await configure(false);
          else
            await admin.query(
              'UPDATE app_memberships SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND user_id=$2',
              [ctx.organizationId, ctx.user.id],
            );
          release();
          await rejected;
          if (change === 'revoke') {
            await store.failArchive(job, {
              code: 'ARCHIVE_AUTHORIZATION_CHANGED',
            });
            expect(
              (await store.discoverArchives([ctx.organizationId])).queued,
            ).toBe(0);
          }
          const row = (
            await admin.query(
              'SELECT status,receipt,metadata FROM app_archive_jobs WHERE id=$1',
              [job.id],
            )
          ).rows[0];
          expect(row.receipt).toBeNull();
          expect(row.status).not.toBe('archived');
          if (change === 'revoke') expect(row.status).toBe('failed');
          const meta = JSON.parse(
            crypto
              .decrypt(
                row.metadata,
                'archive-metadata:' + ctx.organizationId + ':' + job.id,
              )
              .toString(),
          );
          expect(meta.source.classificationFrozenAt).toBeTruthy();
        } finally {
          release();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          if (prior === undefined) delete process.env.PROCESSOR_URL;
          else process.env.PROCESSOR_URL = prior;
        }
      },
    );
    it('runs the packaged worker with office scope and exits cleanly while idle', async () => {
      await configure();
      const doc = await source();
      const foreignDoc = await source(false, foreign);
      const child = spawn(process.execPath, ['dist-archive-worker/index.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ARCHIVE_ORGANIZATION_IDS: ctx.organizationId,
          ARCHIVE_HEARTBEAT_FILE: path.join(root, 'worker-heartbeat'),
        },
        stdio: 'ignore',
      });
      const exit = once(child, 'exit');
      try {
        const deadline = Date.now() + 15_000;
        let archived = false;
        while (Date.now() < deadline) {
          const row = (
            await admin.query(
              'SELECT status FROM app_archive_jobs WHERE organization_id=$1 AND document_id=$2',
              [ctx.organizationId, doc.id],
            )
          ).rows[0];
          if (row?.status === 'archived') {
            archived = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(archived).toBe(true);
        expect(
          (
            await admin.query(
              'SELECT 1 FROM app_archive_jobs WHERE document_id=$1',
              [foreignDoc.id],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          Number(await readFile(path.join(root, 'worker-heartbeat'), 'utf8')),
        ).toBeGreaterThan(Date.now() - 10_000);
        child.kill('SIGTERM');
        expect(
          await Promise.race([
            exit,
            new Promise((resolve) =>
              setTimeout(() => resolve('timeout'), 3000),
            ),
          ]),
        ).toEqual([0, null]);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await exit;
        }
      }
    });

    it('restores archive destinations, frozen metadata and encrypted receipts with enforced foreign keys', async () => {
      await configure();
      await source();
      await store.discoverArchives([ctx.organizationId]);
      await store.processArchive(await claim());
      const child = spawn(
        process.execPath,
        ['operations/scripts/native-recovery-drill.mjs'],
        {
          cwd: process.cwd(),
          env: { ...process.env, ASTER_NATIVE_RECOVERY_DRILL: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output = '',
        diagnostic = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        diagnostic += chunk.toString();
      });
      const [code] = await once(child, 'exit');
      expect({ code, diagnostic }).toEqual({ code: 0, diagnostic: '' });
      const receipt = JSON.parse(output.trim());
      expect(receipt.result).toBe('passed');
      expect(
        receipt.decryptedFields['app_archive_destinations.config'],
      ).toBeGreaterThan(0);
      expect(
        receipt.decryptedFields['app_archive_jobs.metadata'],
      ).toBeGreaterThan(0);
      expect(
        receipt.decryptedFields['app_archive_jobs.receipt'],
      ).toBeGreaterThan(0);
      expect(
        receipt.decryptedFields['app_archive_commands.result'],
      ).toBeGreaterThan(0);
    });
    it('downloads only receipt-verified files and enforces office, source-retention and scope boundaries', async () => {
      await configure();
      const doc = await source();
      await store.discoverArchives([ctx.organizationId]);
      const job = await claim();
      const receipt = await store.processArchive(job);
      const fileIndex = receipt.files.findIndex(
        (f) => f.path === 'original.txt',
      );
      expect(
        (await store.downloadArchiveFile(ctx, job.id, fileIndex)).bytes,
      ).toEqual(doc.bytes);
      expect((await store.listArchives(ctx)).records[0].canDownload).toBe(true);
      await expect(
        store.downloadArchiveFile(ctx, job.id, 79),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        store.downloadArchiveFile(
          { ...ctx, scope: { familyIds: ['allowed'] } },
          job.id,
          fileIndex,
        ),
      ).rejects.toMatchObject({ status: 403 });
      await admin.query(
        "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
        [foreign, ctx.user.id],
      );
      await expect(
        store.downloadArchiveFile(
          { ...ctx, organizationId: foreign },
          job.id,
          fileIndex,
        ),
      ).rejects.toMatchObject({ status: 404 });
      await admin.query(
        "UPDATE app_memberships SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
        [ctx.organizationId, ctx.user.id],
      );
      const viewer = { ...ctx, role: 'viewer' as const };
      expect(
        (await store.downloadArchiveFile(viewer, job.id, fileIndex)).bytes,
      ).toEqual(doc.bytes);
      await admin.query(
        'DELETE FROM app_documents WHERE id=$1 AND organization_id=$2',
        [doc.id, ctx.organizationId],
      );
      expect((await store.listArchives(viewer)).records[0].canDownload).toBe(
        false,
      );
      await expect(
        store.downloadArchiveFile(viewer, job.id, fileIndex),
      ).rejects.toMatchObject({ status: 403 });
      await admin.query(
        "UPDATE app_memberships SET role='owner' WHERE organization_id=$1 AND user_id=$2",
        [ctx.organizationId, ctx.user.id],
      );
      expect(
        (await store.downloadArchiveFile(ctx, job.id, fileIndex)).bytes,
      ).toEqual(doc.bytes);
      await writeFile(
        path.join(
          root,
          ctx.organizationId,
          'Documents',
          receipt.relativePath,
          'original.txt',
        ),
        'tampered',
        { mode: 0o600 },
      );
      await expect(
        store.downloadArchiveFile(ctx, job.id, fileIndex),
      ).rejects.toMatchObject({ code: 'ARCHIVE_FILE_CHANGED' });
    });
    it('rechecks the current session and office membership after reading an archived file', async () => {
      await configure();
      await source();
      await store.discoverArchives([ctx.organizationId]);
      const job = await claim();
      await store.processArchive(job);
      const provider = await import('./archive-provider'),
        read = provider.readLocalArchiveFile;
      vi.spyOn(provider, 'readLocalArchiveFile').mockImplementationOnce(
        async (...args) => {
          const bytes = await read(...args);
          await admin.query(
            'UPDATE app_memberships SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND user_id=$2',
            [ctx.organizationId, ctx.user.id],
          );
          return bytes;
        },
      );
      await expect(
        store.downloadArchiveFile(ctx, job.id, 0),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        (
          await admin.query(
            "SELECT 1 FROM app_audit WHERE organization_id=$1 AND action='archive.file_downloaded'",
            [ctx.organizationId],
          )
        ).rowCount,
      ).toBe(0);
    });
  },
);
