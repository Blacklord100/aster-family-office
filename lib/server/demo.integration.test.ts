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
import { dropTestDatabase } from '../test-support/database-cleanup';
import type { WorkspaceContext } from './access';
import type { Extraction, ExtractedFact } from '../processing-contract';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
}));
const enabled = process.env.ASTER_DEMO_INTEGRATION === '1';
describe.skipIf(!enabled)(
  'isolated PostgreSQL source-derived demo lifecycle and publisher',
  () => {
    const org = randomUUID(),
      user = randomUUID(),
      session = randomUUID();
    const context: WorkspaceContext = {
      organizationId: org,
      role: 'owner',
      sessionId: session,
      user: {
        id: user,
        name: 'Synthetic demo reviewer',
        email: user + '@example.invalid',
      },
    };
    let admin: Pool,
      target: Pool,
      databaseName: string,
      intake: string,
      role: string;
    let db: typeof import('./db'),
      crypto: typeof import('./crypto'),
      demo: typeof import('./demo-workspace'),
      publisher: typeof import('./demo-publish'),
      folders: typeof import('./folder-store'),
      sync: typeof import('./folder-sync'),
      workspace: typeof import('../workspace-store');
    let run: Awaited<
        ReturnType<(typeof import('./demo-workspace'))['createDemoRun']>
      >,
      firstDocument: string,
      firstJob: string;
    const sourceFact: ExtractedFact = {
      kind: 'valuation',
      investmentName: 'Luma Vale Infrastructure II',
      effectiveDate: '2026-06-30',
      amount: '1823405.67',
      currency: 'EUR',
      dueDate: null,
      summary: 'Reported investor NAV.',
      evidence: {
        page: 1,
        quote:
          'Luma Vale Infrastructure II\r\nInvestor NAV at 30 June 2026: EUR 1,823,405.67.',
      },
    };
    async function finishJob(
      organizationId: string,
      jobId: string,
      facts: ExtractedFact[],
    ) {
      const row = (
        await target.query(
          'SELECT document_id,mode FROM app_jobs WHERE organization_id=$1 AND id=$2',
          [organizationId, jobId],
        )
      ).rows[0];
      const extraction: Extraction = {
        schemaVersion: 1,
        documentId: row.document_id,
        mode: row.mode,
        execution: 'local',
        documentType: 'nav_statement',
        relevant: true,
        confidence: 1,
        facts,
        warnings: [],
        trace: [
          {
            stage: 'validate',
            status: 'ok',
            detail:
              'Test-only processor response derived from the retained synthetic source; no model call.',
          },
        ],
        model: 'gemma4:e4b-m3',
      };
      await target.query(
        "UPDATE app_jobs SET status='awaiting_review',result=$3,updated_at=now() WHERE organization_id=$1 AND id=$2",
        [
          organizationId,
          jobId,
          crypto.encrypt(
            JSON.stringify(extraction),
            `result:${organizationId}:${jobId}`,
          ),
        ],
      );
    }
    async function scan(organizationId: string) {
      for (let i = 0; i < 10; i++) {
        await target.query(
          'UPDATE app_folder_queue SET available_at=now() WHERE organization_id=$1',
          [organizationId],
        );
        const claim = await sync.claimFolderConnection([organizationId]);
        expect(claim).not.toBeNull();
        const result = await sync.syncFolderConnection(claim!);
        if (result.complete) return result;
      }
      throw new Error('Bounded fixture scan did not complete');
    }
    async function state() {
      return db.withTenant(run.organizationId, (c) =>
        workspace.readWorkspaceInTransaction(c, run.organizationId),
      );
    }
    beforeAll(async () => {
      for (const key of ['MIGRATION_DATABASE_URL', 'DATABASE_URL']) {
        const value = process.env[key];
        if (!value)
          throw new Error(
            'Explicit local isolated-database credentials required',
          );
        const url = new URL(value);
        if (
          !['localhost', '127.0.0.1'].includes(url.hostname) ||
          url.port !== '55439' ||
          url.pathname !== '/aster'
        )
          throw new Error(
            'Demo integration only creates an isolated database on the local Aster cluster',
          );
      }
      const adminUrl = new URL(process.env.MIGRATION_DATABASE_URL!),
        runtimeUrl = new URL(process.env.DATABASE_URL!);
      admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
      databaseName = 'aster_demo_' + randomBytes(8).toString('hex');
      await admin.query('CREATE DATABASE ' + databaseName);
      adminUrl.pathname = '/' + databaseName;
      runtimeUrl.pathname = '/' + databaseName;
      target = new Pool({ connectionString: adminUrl.toString(), max: 2 });
      for (const filename of (await readdir('migrations'))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await target.query(await readFile('migrations/' + filename, 'utf8'));
      role = decodeURIComponent(runtimeUrl.username);
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
      vi.stubEnv('ASTER_ENABLE_DEMO', 'true');
      vi.stubEnv('ASTER_DEMO_MODEL', 'gemma4:e4b-m3');
      intake = await mkdtemp(path.join(tmpdir(), 'aster-demo-integration-'));
      vi.stubEnv('ASTER_INTAKE_ROOT', intake);
      await target.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified","twoFactorEnabled") VALUES($1,$2,$3,true,true)',
        [user, context.user.name, context.user.email],
      );
      await target.query(
        'INSERT INTO auth_session(id,"userId",token,"expiresAt","mfaVerifiedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now())',
        [session, user, randomUUID()],
      );
      await target.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2)',
        [org, 'Ordinary isolated test office'],
      );
      await target.query(
        "INSERT INTO app_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
        [org, user],
      );
      db = await import('./db');
      crypto = await import('./crypto');
      demo = await import('./demo-workspace');
      publisher = await import('./demo-publish');
      folders = await import('./folder-store');
      sync = await import('./folder-sync');
      workspace = await import('../workspace-store');
    }, 30000);
    afterAll(async () => {
      await db?.pool.end();
      await target?.end();
      if (admin) {
        if (databaseName)
          await dropTestDatabase(admin, databaseName);
        await admin.end();
      }
      if (intake) await rm(intake, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });
    it('creates an empty three-family workspace and processes100 source receipts into95 pinned Gemma jobs', async () => {
      run = await demo.createDemoRun(context);
      const before = (await state()).state;
      expect(before.portfolio?.families).toHaveLength(3);
      expect(before.portfolio?.holdings).toEqual([]);
      expect(before.portfolio?.history).toEqual([]);
      expect(before.demo).toMatchObject({
        autoPublish: true,
        sourceFiles: 100,
        runId: run.organizationId,
      });
      expect((await scan(run.organizationId)).files).toBe(100);
      const receiptCount = await target.query(
        'SELECT count(*)::int AS count FROM app_folder_receipts WHERE organization_id=$1',
        [run.organizationId],
      );
      expect(receiptCount.rows[0].count).toBe(100);
      const jobs = await target.query(
        'SELECT j.*,d.filename FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id WHERE j.organization_id=$1',
        [run.organizationId],
      );
      expect(jobs.rowCount).toBe(95);
      expect(
        jobs.rows.every(
          (row) =>
            row.mode === 'agentic' &&
            row.status === 'queued' &&
            row.engine_snapshot.model === 'gemma4:e4b-m3' &&
            row.engine_snapshot.execution === 'local' &&
            !row.engine_legacy,
        ),
      ).toBe(true);
      const first = jobs.rows.find((row) => row.filename.startsWith('001-'));
      expect(first).toBeTruthy();
      firstDocument = first.document_id;
      firstJob = first.id;
      const saved = await target.query(
        'SELECT payload FROM app_documents WHERE id=$1',
        [firstDocument],
      );
      const original = crypto.decrypt(
        saved.rows[0].payload,
        `document:${run.organizationId}:${firstDocument}`,
      );
      // Evidence is read from the immutable email fixture, never from a benchmark answer key.
      expect(original.toString()).toContain('Luma Vale Infrastructure II');
      expect(original.toString()).toContain('1,823,405.67');
    }, 30000);
    it('posts one sourced valuation under the named demo actor, preserving original bytes and unknown cost/commitments', async () => {
      await finishJob(run.organizationId, firstJob, [sourceFact]);
      await publisher.publishDemoJob(run.organizationId, firstJob);
      const after = (await state()).state;
      expect(after.portfolio?.holdings).toHaveLength(1);
      expect(after.portfolio?.holdings[0]).toMatchObject({
        name: 'Luma Vale Infrastructure II',
        valueEUR: 1823405.67,
        valuationStatus: 'reported',
        costBasisStatus: 'unknown',
        unfundedStatus: 'unknown',
      });
      expect(after.finance?.valuations).toHaveLength(1);
      expect(after.finance?.transactions).toEqual([]);
      expect(after.portfolio?.evidence[0]).toMatchObject({
        documentId: firstDocument,
        demoSource: true,
        synthetic: false,
      });
      const actor = 'demo-agent:' + run.organizationId;
      const audits = await target.query(
        'SELECT action,actor_id FROM app_audit WHERE organization_id=$1',
        [run.organizationId],
      );
      expect(
        audits.rows.some(
          (row) =>
            row.action === 'demo.source_verified' && row.actor_id === actor,
        ),
      ).toBe(true);
      expect(
        audits.rows.some((row) =>
          ['document.previewed', 'document.downloaded'].includes(row.action),
        ),
      ).toBe(false);
      expect(
        (
          await target.query(
            'SELECT status,review_revision,reviewed_by FROM app_jobs WHERE id=$1',
            [firstJob],
          )
        ).rows[0],
      ).toEqual({ status: 'accepted', review_revision: 1, reviewed_by: actor });
    });
    it('deduplicates repeated publication and a separately queued replay of the same economic fact', async () => {
      await publisher.publishDemoJob(run.organizationId, firstJob);
      const replay = await db.withTenant(run.organizationId, (c) =>
        folders.queueFolderDocument(c, run.organizationId, firstDocument, user),
      );
      await finishJob(run.organizationId, replay, [sourceFact]);
      await publisher.publishDemoJob(run.organizationId, replay);
      const after = (await state()).state;
      expect(after.finance?.valuations).toHaveLength(1);
      expect(after.portfolio?.evidence).toHaveLength(1);
      expect(
        (
          await target.query(
            'SELECT count(*)::int AS count FROM app_accepted_facts WHERE organization_id=$1',
            [run.organizationId],
          )
        ).rows[0].count,
      ).toBe(1);
    });
    it('defers all competing same-date amounts and missing currency without changing the accepted mark', async () => {
      const conflict = await db.withTenant(run.organizationId, (c) =>
        folders.queueFolderDocument(c, run.organizationId, firstDocument, user),
      );
      await finishJob(run.organizationId, conflict, [
        sourceFact,
        { ...sourceFact, amount: '1823406.67' },
      ]);
      await publisher.publishDemoJob(run.organizationId, conflict);
      const first = (
        await target.query(
          'SELECT review_state,review_revision,status FROM app_jobs WHERE id=$1',
          [conflict],
        )
      ).rows[0];
      const review = JSON.parse(
        crypto
          .decrypt(
            first.review_state,
            `review:${run.organizationId}:${conflict}`,
          )
          .toString(),
      );
      expect(first.status).toBe('awaiting_review');
      expect(
        review.facts.every(
          (fact: { status: string }) => fact.status === 'deferred',
        ),
      ).toBe(true);
      // A separate queued fixture allows a malformed extraction to exercise currency validation.
      const another = (
        await target.query(
          "SELECT j.id FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id WHERE j.organization_id=$1 AND j.status='queued' AND d.filename LIKE '002-%' LIMIT 1",
          [run.organizationId],
        )
      ).rows[0].id;
      await finishJob(run.organizationId, another, [
        { ...sourceFact, currency: null },
      ]);
      await publisher.publishDemoJob(run.organizationId, another);
      const invalid = (
        await target.query(
          'SELECT status,review_state FROM app_jobs WHERE id=$1',
          [another],
        )
      ).rows[0];
      expect(invalid.status).toBe('awaiting_review');
      expect(
        JSON.parse(
          crypto
            .decrypt(
              invalid.review_state,
              `review:${run.organizationId}:${another}`,
            )
            .toString(),
        ).facts[0].status,
      ).toBe('deferred');
      expect((await state()).state.finance?.valuations).toHaveLength(1);
    });
    it('retains human review for an ordinary office and for noncorpus bytes inside Demo mails', async () => {
      const sourceFilename = (
        await readdir('benchmark/mailroom-v1/fixtures/emails')
      ).find((name) => name.startsWith('001-'))!;
      await mkdir(path.join(intake, org, 'Demo mails'), { recursive: true });
      await writeFile(
        path.join(intake, org, 'Demo mails', 'ordinary.eml'),
        await readFile(
          'benchmark/mailroom-v1/fixtures/emails/' + sourceFilename,
        ),
      );
      await folders.connectFolder(context, {
        directory: 'Demo mails',
        displayName: 'Ordinary local files',
      });
      await scan(org);
      const ordinary = (
        await target.query('SELECT id FROM app_jobs WHERE organization_id=$1', [
          org,
        ])
      ).rows[0].id;
      await finishJob(org, ordinary, [sourceFact]);
      await publisher.publishDemoJob(org, ordinary);
      expect(
        (
          await target.query(
            'SELECT status,review_revision FROM app_jobs WHERE id=$1',
            [ordinary],
          )
        ).rows[0],
      ).toEqual({ status: 'awaiting_review', review_revision: 0 });
      expect(
        (
          await target.query(
            'SELECT fingerprint FROM app_accepted_facts WHERE organization_id=$1',
            [org],
          )
        ).rowCount,
      ).toBe(0);
      await writeFile(
        path.join(intake, run.organizationId, 'Demo mails', 'unregistered.eml'),
        'From: synthetic@example.invalid\r\nSubject: Unregistered test source\r\n\r\nLuma Vale Infrastructure II NAV EUR 1,823,405.67.\r\n',
      );
      await scan(run.organizationId);
      const outsider = (
        await target.query(
          "SELECT j.id FROM app_jobs j JOIN app_documents d ON d.id=j.document_id WHERE j.organization_id=$1 AND d.filename='unregistered.eml'",
          [run.organizationId],
        )
      ).rows[0].id;
      await finishJob(run.organizationId, outsider, [sourceFact]);
      await publisher.publishDemoJob(run.organizationId, outsider);
      expect(
        (
          await target.query(
            'SELECT status,review_revision FROM app_jobs WHERE id=$1',
            [outsider],
          )
        ).rows[0],
      ).toEqual({ status: 'awaiting_review', review_revision: 0 });
      expect((await state()).state.finance?.valuations).toHaveLength(1);
    }, 30000);
    it('denies expired sessions and quotas without creating directories, and removes fresh files on transactional connection failure', async () => {
      const before = (await readdir(intake)).sort();
      await target.query(
        'UPDATE auth_session SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',
        [session],
      );
      await expect(demo.createDemoRun(context)).rejects.toMatchObject({
        status: 403,
      });
      expect((await readdir(intake)).sort()).toEqual(before);
      await target.query(
        'UPDATE auth_session SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1',
        [session],
      );
      const quotaIds = Array.from({ length: 19 }, () => randomUUID());
      for (const id of quotaIds)
        await target.query(
          "INSERT INTO app_organizations(id,name,demo_owner_user_id,demo_source_directory) VALUES($1,'Quota fixture',$2,'Demo mails')",
          [id, user],
        );
      await expect(demo.createDemoRun(context)).rejects.toMatchObject({
        code: 'DEMO_LIMIT',
      });
      expect((await readdir(intake)).sort()).toEqual(before);
      await target.query(
        'DELETE FROM app_organizations WHERE id=ANY($1::uuid[])',
        [quotaIds],
      );
      await target.query('REVOKE INSERT ON app_folder_queue FROM ' + role);
      try {
        await expect(demo.createDemoRun(context)).rejects.toThrow();
      } finally {
        await target.query('GRANT INSERT ON app_folder_queue TO ' + role);
      }
      expect((await readdir(intake)).sort()).toEqual(before);
      expect(
        (
          await target.query(
            'SELECT count(*)::int AS count FROM app_organizations WHERE demo_owner_user_id=$1',
            [user],
          )
        ).rows[0].count,
      ).toBe(1);
    }, 30000);
  },
);
