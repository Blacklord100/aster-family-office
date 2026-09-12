import { revokeRestoredSessions } from './recovery-sessions';
import { spawn } from 'node:child_process';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { assertDisposableDatabase } from '../test-support/disposable-database';
import { databaseWriterOptions } from '../lifecycle-contract';
vi.mock('server-only', () => ({}));
import {
  controlLifecycle,
  assertSealedMaintenance,
  lifecycleStatus,
  type LifecycleCommand,
} from './lifecycle-control';
import { applyMigrations } from './migration-runner';
import { pool } from './db';
import {
  lifecycleRoute,
  withLifecycleOperation,
  readLifecycleState,
} from './lifecycle';
const enabled = process.env.ASTER_LIFECYCLE_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'durable appliance admission, schema and release fencing',
  () => {
    let admin: Pool;
    const key = 'lifecycle-' + randomUUID();
    beforeAll(() => {
      assertDisposableDatabase();
      admin = new Pool({
        connectionString: process.env.MIGRATION_DATABASE_URL,
        max: 5,
      });
    });
    beforeEach(async () => {
      await admin.query(
        "UPDATE app_lifecycle_control SET mode='open',generation=1,active_release='legacy',schema_version=16,resumed_at=NULL WHERE id",
      );
      await admin.query('DELETE FROM app_lifecycle_operations');
      await admin.query('DELETE FROM app_lifecycle_events');
    });
    afterAll(async () => {
      if (admin) {
        await admin.query(
          "UPDATE app_lifecycle_control SET mode='open',generation=1,active_release='legacy',schema_version=16 WHERE id",
        );
        await admin.query('DELETE FROM app_lifecycle_operations');
        await admin.query('DELETE FROM app_lifecycle_events');
        await admin.query('DELETE FROM app_request_limits WHERE key=$1', [key]);
        await admin.end();
      }
      await pool.end();
    });
    async function control(command: LifecycleCommand) {
      const c = await admin.connect();
      try {
        return await controlLifecycle(c, command);
      } finally {
        c.release();
      }
    }
    async function status() {
      const c = await admin.connect();
      try {
        return await lifecycleStatus(c);
      } finally {
        c.release();
      }
    }
    const write = () =>
      pool.query(
        "INSERT INTO app_request_limits(key,count,resets_at) VALUES($1,1,clock_timestamp()+interval '1 minute') ON CONFLICT(key) DO UPDATE SET count=app_request_limits.count+1",
        [key],
      );
    async function seal() {
      await control({ action: 'drain', expectedGeneration: 1 });
      return control({ action: 'seal', expectedGeneration: 1 });
    }
    async function cli(
      args: string[],
      env: NodeJS.ProcessEnv = process.env,
      script = 'lifecycle',
    ) {
      return new Promise<{
        code: number | null;
        body: Record<string, unknown>;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['dist-ops/' + script + '.js', ...args],
          { env, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '',
          stderr = '';
        child.stdout.on('data', (chunk) => (output += String(chunk)));
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.once('error', reject);
        child.once('exit', (code) => {
          try {
            resolve({ code, body: JSON.parse(output), stderr });
          } catch {
            reject(new Error('Lifecycle CLI did not emit JSON'));
          }
        });
      });
    }
    it('exposes the actual operator JSON protocol and persists replay receipts across CLI processes', async () => {
      const initial = await cli(['status']);
      expect(initial.code).toBe(0);
      expect(initial.body).toMatchObject({
        ok: true,
        mode: 'open',
        generation: 1,
        schemaVersion: 16,
      });
      const request = randomUUID(),
        args = ['drain', '--expected-generation', '1', '--request-id', request];
      const drained = await cli(args);
      expect(drained.code).toBe(0);
      expect(drained.body.mode).toBe('draining');
      expect((await cli(args)).body).toEqual(drained.body);
      expect(
        (await cli(['seal', '--expected-generation', '1'])).body.mode,
      ).toBe('maintenance');
      const reserved = await cli([
        'activate',
        '--release',
        'cli-candidate',
        '--expected-generation',
        '1',
      ]);
      expect(reserved.body).toMatchObject({
        mode: 'maintenance',
        generation: 2,
      });
      expect(
        (
          await cli([
            'resume',
            '--release',
            'cli-candidate',
            '--expected-generation',
            '2',
          ])
        ).body,
      ).toMatchObject({
        mode: 'open',
        generation: 2,
        activeRelease: 'cli-candidate',
      });
    });
    it('fails operator commands with bounded JSON instead of raw connection or SQL details', async () => {
      for (const args of [
        ['invalid'],
        ['status', '--invalid', 'value'],
        ['drain', '--expected-generation', '0'],
      ]) {
        const result = await cli(args);
        expect(result.code).toBe(1);
        expect(result.body).toMatchObject({
          ok: false,
          error: 'LIFECYCLE_COMMAND_FAILED',
        });
        expect(result.stderr).toBe('');
      }
      const denied = await cli(['drain', '--expected-generation', '1'], {
        ...process.env,
        MIGRATION_DATABASE_URL: process.env.DATABASE_URL,
      });
      expect(denied.code).toBe(1);
      expect(denied.body.ok).toBe(false);
      expect((await status()).mode).toBe('open');
    });
    it('includes externally leased deliveries in drain status and excludes expired leases using wall clock', async () => {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO app_delivery_outbox(id,recipient_hash,payload,kind,status,lease_until,expires_at) VALUES($1,'synthetic',$2,'invitation','sending',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')`,
        [id, Buffer.from('synthetic test only')],
      );
      try {
        const result = await control({
          action: 'drain',
          expectedGeneration: 1,
        });
        expect(result.activeLeases.delivery).toBe(1);
        expect(result.canSeal).toBe(false);
        await expect(
          control({ action: 'seal', expectedGeneration: 1 }),
        ).rejects.toMatchObject({ code: 'DRAIN_BUSY' });
        await admin.query(
          "UPDATE app_delivery_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
          [id],
        );
        expect(
          (await control({ action: 'seal', expectedGeneration: 1 })).canSeal,
        ).toBe(true);
      } finally {
        await admin.query('DELETE FROM app_delivery_outbox WHERE id=$1', [id]);
      }
    });
    it('requires sealed maintenance for privileged operational writes and holds the control lock until commit', async () => {
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await expect(assertSealedMaintenance(c)).rejects.toMatchObject({
          code: 'MAINTENANCE_READ_ONLY',
        });
        await c.query('ROLLBACK');
        await seal();
        await c.query('BEGIN');
        expect((await assertSealedMaintenance(c)).mode).toBe('maintenance');
        let reopened = false;
        const resume = control({
          action: 'resume',
          release: 'legacy',
          expectedGeneration: 1,
        }).then((value) => {
          reopened = true;
          return value;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(reopened).toBe(false);
        await c.query('COMMIT');
        expect((await resume).mode).toBe('open');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
    async function restoredSession() {
      const user = randomUUID(),
        session = randomUUID(),
        organization = randomUUID(),
        oauth = randomUUID();
      await admin.query(
        `INSERT INTO auth_user(id,name,email) VALUES($1,'Synthetic restored user',$2)`,
        [user, user + '@example.invalid'],
      );
      await admin.query(
        `INSERT INTO auth_session(id,token,"userId","expiresAt") VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,
        [session, randomUUID(), user],
      );
      await admin.query(
        "INSERT INTO app_organizations(id,name) VALUES($1,'Synthetic restore scope')",
        [organization],
      );
      await admin.query(
        "INSERT INTO app_mailbox_oauth_states(state_hash,organization_id,user_id,session_id,provider,payload) VALUES($1,$2,$3,$4,'gmail',$5)",
        [
          oauth,
          organization,
          user,
          session,
          Buffer.from('synthetic restore state'),
        ],
      );
      return {
        user,
        session,
        oauth,
        async close() {
          await admin.query(
            'DELETE FROM app_mailbox_oauth_states WHERE state_hash=$1',
            [oauth],
          );
          await admin.query('DELETE FROM auth_user WHERE id=$1', [user]);
          await admin.query('DELETE FROM app_organizations WHERE id=$1', [
            organization,
          ]);
        },
      };
    }
    it('rejects disaster-session revocation outside sealed maintenance and preserves ordinary upgrade sessions', async () => {
      const fixture = await restoredSession(),
        c = await admin.connect();
      try {
        await expect(revokeRestoredSessions(c)).rejects.toMatchObject({
          code: 'MAINTENANCE_READ_ONLY',
        });
        await control({ action: 'drain', expectedGeneration: 1 });
        await expect(revokeRestoredSessions(c)).rejects.toMatchObject({
          code: 'MAINTENANCE_READ_ONLY',
        });
        await control({ action: 'seal', expectedGeneration: 1 });
        await control({
          action: 'resume',
          release: 'legacy',
          expectedGeneration: 1,
        });
        expect(
          (
            await admin.query('SELECT 1 FROM auth_session WHERE id=$1', [
              fixture.session,
            ])
          ).rowCount,
        ).toBe(1);
      } finally {
        c.release();
        await fixture.close();
      }
    });
    it('revokes restored browser/OAuth sessions with a durable count-only receipt and interruption-safe CLI replay', async () => {
      const fixture = await restoredSession(),
        request = randomUUID();
      try {
        const count = (
          await admin.query('SELECT count(*)::int AS count FROM auth_session')
        ).rows[0].count;
        await seal();
        const receipt = await cli(
          ['--request-id', request],
          process.env,
          'recovery-sessions',
        );
        expect(receipt).toEqual({
          code: 0,
          body: { ok: true, revokedSessions: count },
          stderr: '',
        });
        expect((await admin.query('SELECT 1 FROM auth_session')).rowCount).toBe(
          0,
        );
        expect(
          (
            await admin.query(
              'SELECT 1 FROM app_mailbox_oauth_states WHERE state_hash=$1',
              [fixture.oauth],
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await admin.query('SELECT 1 FROM auth_user WHERE id=$1', [
              fixture.user,
            ])
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await cli(
              ['--request-id', request],
              process.env,
              'recovery-sessions',
            )
          ).body,
        ).toEqual(receipt.body);
        const saved = (
          await admin.query(
            'SELECT action,result FROM app_lifecycle_events WHERE request_id=$1',
            [request],
          )
        ).rows[0];
        expect(saved).toEqual({
          action: 'recovery.sessions_revoked',
          result: receipt.body,
        });
      } finally {
        await fixture.close();
      }
    });
    it('refuses runtime recovery credentials and rolls back session deletion if its durable receipt fails', async () => {
      const fixture = await restoredSession(),
        c = await admin.connect();
      try {
        await seal();
        const refused = await cli(
          [],
          { ...process.env, MIGRATION_DATABASE_URL: process.env.DATABASE_URL },
          'recovery-sessions',
        );
        expect(refused.code).toBe(1);
        expect(refused.body.error).toBe('RECOVERY_SESSIONS_FAILED');
        await admin.query(
          `CREATE FUNCTION aster_fixture_recovery_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='recovery.sessions_revoked' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER aster_fixture_recovery_failure BEFORE INSERT ON app_lifecycle_events FOR EACH ROW EXECUTE FUNCTION aster_fixture_recovery_failure()`,
        );
        await expect(revokeRestoredSessions(c)).rejects.toThrow(
          'Synthetic receipt failure',
        );
        expect(
          (
            await admin.query('SELECT 1 FROM auth_session WHERE id=$1', [
              fixture.session,
            ])
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await admin.query(
              'SELECT 1 FROM app_mailbox_oauth_states WHERE state_hash=$1',
              [fixture.oauth],
            )
          ).rowCount,
        ).toBe(1);
      } finally {
        await admin.query(
          'DROP TRIGGER IF EXISTS aster_fixture_recovery_failure ON app_lifecycle_events',
        );
        await admin.query(
          'DROP FUNCTION IF EXISTS aster_fixture_recovery_failure()',
        );
        c.release();
        await fixture.close();
      }
    });
    it('restricts operator state and installs guards on every runtime table', async () => {
      expect((await status()).schemaVersion).toBe(16);
      for (const table of [
        'app_lifecycle_control',
        'app_lifecycle_operations',
        'app_lifecycle_events',
      ])
        await expect(pool.query('DELETE FROM ' + table)).rejects.toMatchObject({
          code: '42501',
        });
      const uncovered = (
        await admin.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'app\\_%' ESCAPE '\\' OR tablename LIKE 'auth\\_%' ESCAPE '\\') AND tablename NOT LIKE 'app_lifecycle_%' AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||tablename)::regclass AND tgname='aster_runtime_write_guard')",
        )
      ).rows;
      expect(uncovered).toEqual([]);
    });
    it('drains existing asynchronous work, denies new work, then seals without dropping changes', async () => {
      let ready!: () => void, finish!: () => void;
      const started = new Promise<void>((r) => (ready = r)),
        wait = new Promise<void>((r) => (finish = r));
      const inFlight = withLifecycleOperation('document', async () => {
        await write();
        ready();
        await wait;
        await write();
      });
      await started;
      expect((await status()).activeOperations).toBe(1);
      await control({ action: 'drain', expectedGeneration: 1 });
      await expect(
        withLifecycleOperation('request', async () => {}),
      ).rejects.toMatchObject({ code: 'MAINTENANCE_READ_ONLY' });
      await expect(
        control({ action: 'seal', expectedGeneration: 1 }),
      ).rejects.toMatchObject({ code: 'DRAIN_BUSY' });
      await expect(write()).rejects.toMatchObject({ code: 'P1601' });
      finish();
      await inFlight;
      expect(
        (await control({ action: 'seal', expectedGeneration: 1 })).mode,
      ).toBe('maintenance');
      await expect(write()).rejects.toMatchObject({ code: 'P1601' });
    });
    it('waits for an already writing transaction before confirming drain', async () => {
      const c = await pool.connect();
      await c.query('BEGIN');
      await c.query('UPDATE app_request_limits SET count=count WHERE key=$1', [
        key,
      ]);
      let done = false;
      const drained = control({ action: 'drain', expectedGeneration: 1 }).then(
        (result) => {
          done = true;
          return result;
        },
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(done).toBe(false);
      await c.query('COMMIT');
      c.release();
      await drained;
    });
    it('fences auth tables, empty security-definer claims and all direct writes while sealed', async () => {
      await seal();
      for (const sql of [
        'UPDATE auth_session SET token=token WHERE false',
        'DELETE FROM app_job_queue WHERE false',
        'SELECT * FROM claim_folder_connection(gen_random_uuid(),NULL)',
        'SELECT * FROM claim_report_obligations(gen_random_uuid(),NULL)',
        'SELECT * FROM claim_archive_job(gen_random_uuid(),NULL)',
      ]) {
        await expect(pool.query(sql)).rejects.toMatchObject({ code: 'P1601' });
      }
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM auth_user'))
          .rows[0].count,
      ).toBeGreaterThanOrEqual(0);
    });
    it('reserves a generation before candidate reads and prevents old writers after resume', async () => {
      await seal();
      const reserved = await control({
        action: 'activate',
        release: 'release-2',
        expectedGeneration: 1,
      });
      expect(reserved).toMatchObject({
        generation: 2,
        mode: 'maintenance',
        activeRelease: 'release-2',
      });
      const next = new Pool({
        connectionString: process.env.DATABASE_URL,
        options: databaseWriterOptions({
          ASTER_RELEASE_ID: 'release-2',
          ASTER_WRITER_GENERATION: '2',
        }),
      });
      try {
        await expect(
          next.query('UPDATE app_request_limits SET count=count WHERE false'),
        ).rejects.toMatchObject({ code: 'P1601' });
        expect(
          (await next.query('SELECT schema_version FROM app_lifecycle_control'))
            .rows[0].schema_version,
        ).toBe(16);
        await expect(
          control({
            action: 'resume',
            release: 'release-2',
            expectedGeneration: 1,
          }),
        ).rejects.toMatchObject({ code: 'GENERATION_CONFLICT' });
        const resumed = await control({
          action: 'resume',
          release: 'release-2',
          expectedGeneration: 2,
        });
        expect(resumed.resumedAt).toBeTruthy();
        await next.query(
          'UPDATE app_request_limits SET count=count WHERE false',
        );
        await expect(write()).rejects.toMatchObject({ code: 'P1602' });
      } finally {
        await next.end();
      }
    });
    it('replays interrupted operator commands without advancing twice and rejects mismatched replay', async () => {
      await seal();
      const requestId = randomUUID(),
        command = {
          action: 'activate' as const,
          release: 'candidate',
          expectedGeneration: 1,
          requestId,
        };
      const first = await control(command);
      expect(await control(command)).toEqual(first);
      expect((await status()).generation).toBe(2);
      await expect(
        control({ ...command, release: 'different' }),
      ).rejects.toMatchObject({ code: 'LIFECYCLE_STATE_CONFLICT' });
    });
    it('does not revive expired admissions and validates the unguessable operation token', async () => {
      const id = randomUUID(),
        token = randomUUID(),
        hash = createHash('sha256').update(token).digest('hex');
      expect(
        (
          await pool.query('SELECT aster_admit_operation($1,$2,$3) AS ok', [
            id,
            hash,
            'request',
          ])
        ).rows[0].ok,
      ).toBe(true);
      await admin.query(
        "UPDATE app_lifecycle_operations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
      expect(
        (
          await pool.query('SELECT aster_renew_operation($1,$2) AS ok', [
            id,
            hash,
          ])
        ).rows[0].ok,
      ).toBe(false);
      const c = await pool.connect();
      try {
        await c.query(
          "SELECT set_config('app.operation_id',$1,false),set_config('app.operation_token',$2,false)",
          [id, token],
        );
        await expect(
          c.query('UPDATE app_request_limits SET count=count WHERE false'),
        ).rejects.toMatchObject({ code: 'P1604' });
      } finally {
        c.release();
      }
      await write(); // next checkout must clear the expired token
    });
    it('does not mutate expired routing metadata through cleanup functions while sealed', async () => {
      const id = randomUUID(),
        hash = 'a'.repeat(64);
      await pool.query('SELECT aster_admit_operation($1,$2,$3)', [
        id,
        hash,
        'request',
      ]);
      await admin.query(
        "UPDATE app_lifecycle_operations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
      await seal();
      await pool.query('SELECT aster_finish_operation($1,$2)', [id, hash]);
      expect(
        (
          await admin.query(
            'SELECT 1 FROM app_lifecycle_operations WHERE id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(1);
      await control({
        action: 'resume',
        release: 'legacy',
        expectedGeneration: 1,
      });
      await pool.query('SELECT aster_finish_operation($1,$2)', [id, hash]);
      expect(
        (
          await admin.query(
            'SELECT 1 FROM app_lifecycle_operations WHERE id=$1',
            [id],
          )
        ).rowCount,
      ).toBe(0);
    });
    it('keeps core GET reads available but returns explicit503 for new mutations and audited exports', async () => {
      await seal();
      const handler = vi.fn(async (_request: Request) =>
          Response.json({ ok: true }),
        ),
        wrapped = lifecycleRoute(handler);
      const get = await wrapped(
        new Request('http://localhost:3000/api/workspace'),
      );
      expect(get.status).toBe(200);
      expect(get.headers.get('x-aster-maintenance')).toBe('maintenance');
      for (const req of [
        new Request('http://localhost:3000/api/workspace', { method: 'POST' }),
        new Request(
          'http://localhost:3000/api/documents/' + randomUUID() + '/preview',
        ),
        new Request('http://localhost:3000/api/mailboxes/callback/google'),
      ])
        expect((await wrapped(req)).status).toBe(503);
      expect(handler).toHaveBeenCalledTimes(1);
    });
    it('fails closed on unsupported schema for reads and writes', async () => {
      await admin.query(
        'UPDATE app_lifecycle_control SET schema_version=17 WHERE id',
      );
      await expect(readLifecycleState()).rejects.toMatchObject({
        code: 'SCHEMA_INCOMPATIBLE',
      });
      await expect(write()).rejects.toMatchObject({ code: 'P1602' });
    });
    it('checks migration content and records explicit adoption rather than fabricating historic checksums', async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'aster-migration-fixture-'),
      );
      const c = await admin.connect();
      try {
        await cp('migrations', directory, { recursive: true });
        await applyMigrations(c, { directory, runtimeRole: 'aster_runtime' });
        const filename = '001-auth.sql',
          content = await readFile(join(directory, filename), 'utf8');
        await writeFile(
          join(directory, filename),
          content + '\n-- modified fixture\n',
        );
        await expect(
          applyMigrations(c, { directory, runtimeRole: 'aster_runtime' }),
        ).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' });
        await writeFile(join(directory, filename), content);
        await c.query(
          'UPDATE aster_migrations SET checksum=NULL WHERE name=$1',
          [filename],
        );
        await expect(
          applyMigrations(c, { directory, runtimeRole: 'aster_runtime' }),
        ).rejects.toMatchObject({ code: 'LEGACY_CHECKSUM_ADOPTION_REQUIRED' });
        const result = await applyMigrations(c, {
          directory,
          runtimeRole: 'aster_runtime',
          adoptLegacyChecksums: true,
        });
        expect(result.adopted).toEqual([filename]);
        expect(
          (
            await c.query(
              'SELECT checksum_adopted FROM aster_migrations WHERE name=$1',
              [filename],
            )
          ).rows[0].checksum_adopted,
        ).toBe(true);
      } finally {
        c.release();
        await rm(directory, { recursive: true, force: true });
      }
    });
    it('requires maintenance for later migrations and rolls back interrupted migration content', async () => {
      const directory = await mkdtemp(
          join(tmpdir(), 'aster-migration-failure-'),
        ),
        c = await admin.connect();
      try {
        await cp('migrations', directory, { recursive: true });
        await writeFile(
          join(directory, '017-failed-fixture.sql'),
          'CREATE TABLE fixture_interrupted(id int); SELECT deliberately_missing_function();',
        );
        await expect(
          applyMigrations(c, { directory, runtimeRole: 'aster_runtime' }),
        ).rejects.toMatchObject({ code: 'MAINTENANCE_READ_ONLY' });
        await seal();
        await expect(
          applyMigrations(c, { directory, runtimeRole: 'aster_runtime' }),
        ).rejects.toMatchObject({ code: '42883' });
        expect(
          (
            await c.query(
              "SELECT to_regclass('public.fixture_interrupted') AS found",
            )
          ).rows[0].found,
        ).toBeNull();
        expect(
          (
            await c.query(
              "SELECT 1 FROM aster_migrations WHERE name='017-failed-fixture.sql'",
            )
          ).rowCount,
        ).toBe(0);
      } finally {
        c.release();
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
