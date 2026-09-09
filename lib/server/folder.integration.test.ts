import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import type { WorkspaceContext } from './access';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
}));
const enabled = process.env.ASTER_FOLDER_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'isolated folder connector database lifecycle',
  () => {
    const org = randomUUID(),
      foreign = randomUUID(),
      user = randomUUID(),
      session = randomUUID();
    const context: WorkspaceContext = {
      organizationId: org,
      role: 'owner',
      sessionId: session,
      user: {
        id: user,
        name: 'Synthetic intake reviewer',
        email: user + '@example.invalid',
      },
    };
    let admin: Pool,
      target: Pool,
      databaseName: string,
      intake: string,
      connectionId: string;
    let store: typeof import('./folder-store'),
      sync: typeof import('./folder-sync'),
      db: typeof import('./db'),
      crypto: typeof import('./crypto');
    const source = Buffer.from(
      'From: synthetic-manager@example.invalid\r\nSubject: Synthetic fund NAV\r\n\r\nSYNTHETIC TEST DATA. Fund NAV EUR 100 as of 2026-06-30.\r\n',
    );
    beforeAll(async () => {
      for (const setting of ['MIGRATION_DATABASE_URL', 'DATABASE_URL']) {
        const value = process.env[setting];
        if (!value)
          throw new Error(
            'Explicit isolated local database credentials required.',
          );
        const url = new URL(value);
        if (
          !['localhost', '127.0.0.1'].includes(url.hostname) ||
          url.port !== '55439' ||
          url.pathname !== '/aster'
        )
          throw new Error(
            'Folder integration only runs on the isolated local Aster cluster.',
          );
      }
      const adminUrl = new URL(process.env.MIGRATION_DATABASE_URL!),
        runtimeUrl = new URL(process.env.DATABASE_URL!);
      admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
      databaseName = 'aster_folder_' + randomBytes(8).toString('hex');
      await admin.query('CREATE DATABASE ' + databaseName);
      adminUrl.pathname = '/' + databaseName;
      runtimeUrl.pathname = '/' + databaseName;
      target = new Pool({ connectionString: adminUrl.toString(), max: 2 });
      for (const name of (await readdir('migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await target.query(await readFile('migrations/' + name, 'utf8'));
      const role = decodeURIComponent(runtimeUrl.username);
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role))
        throw new Error('Invalid restricted test role');
      await target.query('GRANT USAGE ON SCHEMA public TO ' + role);
      await target.query(
        'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ' +
          role,
      );
      await target.query(
        'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + role,
      );
      await target.query(
        'GRANT EXECUTE ON FUNCTION claim_folder_connection(uuid,uuid[]) TO ' +
          role,
      );
      vi.stubEnv('DATABASE_URL', runtimeUrl.toString());
      intake = await mkdtemp(path.join(tmpdir(), 'aster-folder-integration-'));
      vi.stubEnv('ASTER_INTAKE_ROOT', intake);
      await mkdir(path.join(intake, org, 'Demo mails'), { recursive: true });
      await mkdir(path.join(intake, foreign, 'Foreign mails'), {
        recursive: true,
      });
      await writeFile(
        path.join(intake, org, 'Demo mails', 'first.eml'),
        source,
      );
      await writeFile(path.join(intake, org, 'Demo mails', 'copy.eml'), source);
      await writeFile(
        path.join(intake, org, 'Demo mails', 'invalid.pdf'),
        'Not PDF',
      );
      await target.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$2,$3,true,true)',
        [user, context.user.name, context.user.email],
      );
      await target.query(
        'INSERT INTO auth_session(id,"userId",token,"expiresAt","mfaVerifiedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now())',
        [session, user, randomUUID()],
      );
      await target.query(
        'INSERT INTO app_organizations(id,name,demo_owner_user_id,demo_source_directory) VALUES($1,$2,$3,$4),($5,$6,NULL,NULL)',
        [
          org,
          'Synthetic local intake',
          user,
          'Demo mails',
          foreign,
          'Foreign synthetic office',
        ],
      );
      await target.query(
        "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
        [org, user],
      );
      store = await import('./folder-store');
      sync = await import('./folder-sync');
      db = await import('./db');
      crypto = await import('./crypto');
    }, 30_000);
    afterAll(async () => {
      await db?.pool.end();
      await target?.end();
      if (admin) {
        if (databaseName)
          await admin.query('DROP DATABASE ' + databaseName + ' WITH (FORCE)');
        await admin.end();
      }
      if (intake) await rm(intake, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    it('creates an encrypted trusted demo connection only for an active administrator', async () => {
      await expect(
        store.connectFolder(
          { ...context, role: 'analyst' },
          { directory: 'Demo mails', displayName: 'Demo' },
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        store.connectFolder(
          { ...context, sessionId: randomUUID() },
          { directory: 'Demo mails', displayName: 'Demo' },
        ),
      ).rejects.toMatchObject({ status: 403 });
      connectionId = (
        await store.connectFolder(context, {
          directory: 'Demo mails',
          displayName: 'Demo mails',
        })
      ).id;
      expect(
        await store.connectFolder(context, {
          directory: 'Demo mails',
          displayName: 'Demo mails',
        }),
      ).toMatchObject({ id: connectionId, duplicate: true });
      const row = (
        await target.query(
          'SELECT config FROM app_folder_connections WHERE id=$1',
          [connectionId],
        )
      ).rows[0];
      expect(row.config.toString()).not.toContain('Demo mails');
      expect(
        store.openFolderConfig(row.config, org, connectionId),
      ).toMatchObject({ directory: 'Demo mails', isDemo: true });
      expect((await store.listFolderConnections(context)).directories).toEqual([
        { directory: 'Demo mails', displayName: 'Demo mails', isDemo: true },
      ]);
    });
    it('keeps connections and routing rows inside database tenant boundaries', async () => {
      for (const table of [
        'app_folder_connections',
        'app_folder_queue',
        'app_folder_receipts',
      ]) {
        expect(
          (
            await db.withTenant(foreign, (client) =>
              client.query('SELECT * FROM ' + table),
            )
          ).rows,
        ).toEqual([]);
      }
      expect(await sync.claimFolderConnection([foreign])).toBeNull();
      expect(
        (await db.pool.query('SELECT * FROM app_folder_connections')).rows,
      ).toEqual([]);
      const fn = await target.query(
        "SELECT prosecdef,proconfig,has_function_privilege('public','claim_folder_connection(uuid,uuid[])','EXECUTE') AS public_execute FROM pg_proc WHERE proname='claim_folder_connection'",
      );
      expect(fn.rows[0]).toMatchObject({
        prosecdef: true,
        public_execute: false,
      });
      expect(fn.rows[0].proconfig).toContain('search_path=pg_catalog, pg_temp');
    });
    it('imports exact bytes once, preserves duplicate receipts and pins engine configuration', async () => {
      const claim = await sync.claimFolderConnection([org]);
      expect(claim?.id).toBe(connectionId);
      expect(await sync.claimFolderConnection([org])).toBeNull();
      expect(await sync.syncFolderConnection(claim!)).toMatchObject({
        complete: true,
        examined: 3,
      });
      const docs = await target.query(
        'SELECT * FROM app_documents WHERE organization_id=$1',
        [org],
      );
      expect(docs.rowCount).toBe(1);
      expect(
        crypto.decrypt(
          docs.rows[0].payload,
          'document:' + org + ':' + docs.rows[0].id,
        ),
      ).toEqual(source);
      const jobs = await target.query(
        'SELECT * FROM app_jobs WHERE organization_id=$1',
        [org],
      );
      expect(jobs.rowCount).toBe(1);
      expect(jobs.rows[0]).toMatchObject({
        mode: 'workflow',
        status: 'queued',
        engine_legacy: false,
        policy_revision: 1,
      });
      expect(jobs.rows[0].engine_snapshot.model).toBeTruthy();
      expect(jobs.rows[0].engine_config).toBeInstanceOf(Buffer);
      const response = await store.listFolderConnections(context);
      expect(response.connections[0]).toMatchObject({
        importedCount: 2,
        skippedCount: 1,
        duplicateCount: 1,
        uniqueDocumentCount: 1,
        counts: { queued: 1 },
      });
      expect(
        response.connections[0].recentFiles.map((file) => file.outcome).sort(),
      ).toEqual(['duplicate', 'imported', 'invalid']);
      expect(
        await readFile(path.join(intake, org, 'Demo mails', 'first.eml')),
      ).toEqual(source);
    });
    it('resumes without duplicate jobs and imports revised bytes as a new retained original', async () => {
      await store.updateFolderConnection(context, connectionId, 'sync');
      await sync.syncFolderConnection(
        (await sync.claimFolderConnection([org]))!,
      );
      expect(
        (
          await target.query(
            'SELECT id FROM app_jobs WHERE organization_id=$1',
            [org],
          )
        ).rowCount,
      ).toBe(1);
      await writeFile(
        path.join(intake, org, 'Demo mails', 'first.eml'),
        Buffer.concat([source, Buffer.from('Revision: EUR 110.\r\n')]),
      );
      await store.updateFolderConnection(context, connectionId, 'sync');
      await sync.syncFolderConnection(
        (await sync.claimFolderConnection([org]))!,
      );
      expect(
        (
          await target.query(
            'SELECT id FROM app_documents WHERE organization_id=$1',
            [org],
          )
        ).rowCount,
      ).toBe(2);
      expect(
        (
          await target.query(
            'SELECT receipt_key FROM app_folder_receipts WHERE organization_id=$1',
            [org],
          )
        ).rowCount,
      ).toBe(4);
    });
    it('fences expired leases and pauses/disconnects without deleting originals', async () => {
      await store.updateFolderConnection(context, connectionId, 'sync');
      const old = (await sync.claimFolderConnection([org]))!;
      await target.query(
        "UPDATE app_folder_queue SET lease_until=now()-interval '1 second' WHERE id=$1",
        [connectionId],
      );
      const replacement = (await sync.claimFolderConnection([org]))!;
      expect(replacement.owner).not.toBe(old.owner);
      await expect(sync.syncFolderConnection(old)).rejects.toBeInstanceOf(
        sync.FolderLeaseLost,
      );
      expect(await sync.releaseFolderClaim(old)).toBe(false);
      await store.updateFolderConnection(context, connectionId, 'pause');
      await expect(
        sync.syncFolderConnection(replacement),
      ).rejects.toBeInstanceOf(sync.FolderLeaseLost);
      await expect(
        store.updateFolderConnection(context, connectionId, 'sync'),
      ).rejects.toMatchObject({ code: 'PAUSED' });
      await store.updateFolderConnection(context, connectionId, 'resume');
      await store.updateFolderConnection(context, connectionId, 'disconnect');
      expect(
        (
          await target.query(
            'SELECT id FROM app_folder_queue WHERE organization_id=$1',
            [org],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await target.query(
            'SELECT id FROM app_documents WHERE organization_id=$1',
            [org],
          )
        ).rowCount,
      ).toBe(2);
      await expect(
        store.updateFolderConnection(context, connectionId, 'resume'),
      ).rejects.toMatchObject({ code: 'RECONNECT_REQUIRED' });
    });
    it('requeues failed documents once while preserving original jobs and their engine pins', async () => {
      await store.connectFolder(context, {
        directory: 'Demo mails',
        displayName: 'Demo mails',
      });
      await target.query(
        "UPDATE app_jobs SET status='failed',error_code='TEST_FAILURE' WHERE organization_id=$1",
        [org],
      );
      await target.query('DELETE FROM app_job_queue WHERE organization_id=$1', [
        org,
      ]);
      await store.updateFolderConnection(context, connectionId, 'retry');
      await store.updateFolderConnection(context, connectionId, 'retry');
      expect(
        (
          await target.query(
            "SELECT id FROM app_jobs WHERE organization_id=$1 AND status='queued'",
            [org],
          )
        ).rowCount,
      ).toBe(2);
      expect(
        (
          await target.query(
            "SELECT id FROM app_jobs WHERE organization_id=$1 AND status='failed'",
            [org],
          )
        ).rowCount,
      ).toBe(2);
    });
    it('retrieves the oldest source across 95 encrypted index records using the real bounded SQL selection', async () => {
      const { searchIntelligence } = await import('./intelligence-store');
      let oldest = '';
      for (let index = 0; index < 95; index++) {
        const id = randomUUID(),
          text =
            index === 0
              ? 'Quartz Halcyon Memorandum oldest relevant source.'
              : 'Ordinary newer source number ' + index;
        if (index === 0) oldest = id;
        const hash = crypto.sha256(text),
          at = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
        await target.query(
          "INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload) VALUES($1,$2,$3,$4,'text/plain',$5,$6,$7)",
          [
            id,
            org,
            user,
            'library-' + index + '.txt',
            hash,
            Buffer.byteLength(text),
            crypto.encrypt(text, 'document:' + org + ':' + id),
          ],
        );
        const indexed = {
          documentId: id,
          filename: 'library-' + index + '.txt',
          contentHash: hash,
          indexedAt: at.toISOString(),
          pages: [{ number: 1, source: 'document', text }],
          warnings: [],
        };
        await target.query(
          'INSERT INTO app_intelligence_documents(document_id,organization_id,payload,page_count,indexed_at) VALUES($1,$2,$3,1,$4)',
          [
            id,
            org,
            crypto.encrypt(
              JSON.stringify(indexed),
              'intelligence-index:' + org + ':' + id,
            ),
            at,
          ],
        );
      }
      const found = await searchIntelligence(
        context,
        'Quartz Halcyon Memorandum',
      );
      expect(found.hits).toHaveLength(1);
      expect(found.hits[0].documentId).toBe(oldest);
      expect(found.coverage).toMatchObject({
        indexedDocuments: 95,
        searchedDocuments: 95,
        truncated: false,
        documentLimit: 500,
      });
    });
    it('halts unattended collection when the connecting administrator is revoked', async () => {
      const claim = (await sync.claimFolderConnection([org]))!;
      await target.query(
        'UPDATE app_memberships SET revoked_at=now() WHERE organization_id=$1 AND user_id=$2',
        [org, user],
      );
      let failure: unknown;
      try {
        await sync.syncFolderConnection(claim);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      await sync.releaseFolderClaim(claim, failure);
      const row = (
        await target.query(
          'SELECT status,error_code FROM app_folder_connections WHERE id=$1',
          [connectionId],
        )
      ).rows[0];
      expect(row).toEqual({
        status: 'paused',
        error_code: 'MEMBERSHIP_REVOKED',
      });
      expect(await sync.claimFolderConnection([org])).toBeNull();
    });
  },
);
