import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertDisposableDatabase } from '../test-support/disposable-database';

vi.mock('server-only', () => ({}));
// Explicit opt-in after migration 011. Every read/write/claim is restricted to
// freshly generated synthetic organizations; no ordinary queue is consumed.
const enabled = process.env.ASTER_REPORT_OBLIGATIONS_INTEGRATION === '1';
const suite = enabled ? describe : describe.skip;
const organizations = [randomUUID(), randomUUID()];
const label = 'SYNTHETIC report queue test ' + randomUUID();
let admin: Pool;
let db: typeof import('./db');
let queue: typeof import('./report-obligations-queue');

async function due(org: string) {
  await admin.query(
    "UPDATE app_report_obligations_queue SET run_after=now()-interval '1 second',lease_owner=NULL,lease_until=NULL WHERE organization_id=$1",
    [org],
  );
}
async function read(org: string) {
  return (
    await admin.query(
      'SELECT *,run_after<=now() AS due FROM app_report_obligations_queue WHERE organization_id=$1',
      [org],
    )
  ).rows[0];
}

suite('report monitor PostgreSQL leases and tenant boundary', () => {
  beforeAll(async () => {
    assertDisposableDatabase();
    const runtimeURL = process.env.DATABASE_URL;
    const adminURL = process.env.MIGRATION_DATABASE_URL;
    if (!runtimeURL || !adminURL)
      throw new Error(
        'Synthetic queue tests require local runtime and fixture administrator configuration',
      );
    for (const value of [runtimeURL, adminURL]) {
      const url = new URL(value);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname))
        throw new Error('Queue integration accepts local PostgreSQL only');
    }
    vi.stubEnv('NODE_ENV', 'production');
    db = await import('./db');
    await db.assertDatabaseRole();
    admin = new Pool({ connectionString: adminURL, max: 2 });
    if (
      !(
        await admin.query(
          "SELECT to_regclass('public.app_report_obligations_queue') IS NOT NULL AS ready",
        )
      ).rows[0].ready
    )
      throw new Error('Run reviewed migration 011 before this opt-in test');
    queue = await import('./report-obligations-queue');
    await admin.query(
      'INSERT INTO app_organizations(id,name) VALUES($1,$3),($2,$3)',
      [...organizations, label],
    );
  });
  afterAll(async () => {
    if (admin) {
      // The label and generated UUIDs jointly guard cleanup. No memberships,
      // workspace content, documents or real processing jobs are ever inserted.
      await admin.query(
        'DELETE FROM app_organizations WHERE id=ANY($1::uuid[]) AND name=$2',
        [organizations, label],
      );
      await admin.end();
    }
    if (db) await db.pool.end();
    vi.unstubAllEnvs();
  });
  it('enrolls idempotently, keeps unscoped runtime reads empty and rejects another tenant write', async () => {
    for (const org of organizations)
      await db.withTenant(org, async (c) => {
        await queue.ensureReportObligations(c, org);
        await queue.ensureReportObligations(c, org);
      });
    expect((await read(organizations[0])).generation).toBe('1');
    expect(
      (await db.pool.query('SELECT * FROM app_report_obligations_queue')).rows,
    ).toEqual([]);
    expect(
      (
        await db.withTenant(organizations[0], (c) =>
          c.query('SELECT organization_id FROM app_report_obligations_queue'),
        )
      ).rows,
    ).toEqual([{ organization_id: organizations[0] }]);
    await expect(
      db.withTenant(organizations[0], (c) =>
        queue.scheduleReportObligations(c, organizations[1]),
      ),
    ).rejects.toThrow();
  });
  it('claims each synthetic office only once under concurrency and never returns unscoped content', async () => {
    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        queue.claimReportObligations(organizations),
      ),
    );
    const acquired = claims.filter((v) => v !== null);
    expect(acquired).toHaveLength(2);
    expect(new Set(acquired.map((v) => v.organizationId))).toEqual(
      new Set(organizations),
    );
    for (const claim of acquired) {
      expect(Object.keys(claim).sort()).toEqual([
        'generation',
        'organizationId',
        'owner',
      ]);
      expect(await queue.finishReportObligations(claim)).toBe(true);
    }
    expect(await queue.claimReportObligations(organizations)).toBeNull();
  });
  it('honors a single-office route and keeps an in-flight wake due after completion', async () => {
    const org = organizations[0];
    await due(org);
    const claim = (await queue.claimReportObligations([org]))!;
    expect(claim.organizationId).toBe(org);
    await db.withTenant(org, (c) => queue.scheduleReportObligations(c, org));
    const changed = await read(org);
    expect(changed.lease_owner).toBe(claim.owner);
    expect(BigInt(changed.generation)).toBe(BigInt(claim.generation) + 1n);
    expect(await queue.finishReportObligations(claim)).toBe(true);
    expect((await read(org)).due).toBe(true);
    const followup = (await queue.claimReportObligations([org]))!;
    expect(followup.generation).toBe(changed.generation);
    expect(await queue.finishReportObligations(followup)).toBe(true);
    expect((await read(org)).due).toBe(false);
  });
  it('fences expired workers and recovers abandoned work after the 90-second lease', async () => {
    const org = organizations[0];
    await due(org);
    const stale = (await queue.claimReportObligations([org]))!;
    await admin.query(
      "UPDATE app_report_obligations_queue SET lease_until=now()-interval '1 second' WHERE organization_id=$1",
      [org],
    );
    expect(await queue.finishReportObligations(stale)).toBe(false);
    const next = (await queue.claimReportObligations([org]))!;
    expect(next.owner).not.toBe(stale.owner);
    expect(await queue.finishReportObligations(stale)).toBe(false);
    expect((await read(org)).lease_owner).toBe(next.owner);
    expect(await queue.finishReportObligations(next)).toBe(true);
  });
  it('stores only a fixed retry code, bounds failure delay and preserves a wake during failure', async () => {
    const org = organizations[0];
    await due(org);
    const first = (await queue.claimReportObligations([org]))!;
    const result = await queue.processReportObligationsClaim(
      first,
      async () => {
        throw new Error('Synthetic sensitive source details');
      },
    );
    expect(result).toBe('failed');
    const failure = await read(org);
    expect(failure.error_code).toBe('RECONCILIATION_FAILED');
    expect(failure.lease_owner).toBeNull();
    expect(failure.run_after.getTime() - Date.now()).toBeGreaterThan(45000);
    expect(failure.run_after.getTime() - Date.now()).toBeLessThanOrEqual(60000);
    expect(JSON.stringify(failure)).not.toContain('sensitive');
    await due(org);
    const second = (await queue.claimReportObligations([org]))!;
    await db.withTenant(org, (c) => queue.scheduleReportObligations(c, org));
    expect(
      await queue.finishReportObligations(second, 'RECONCILIATION_FAILED'),
    ).toBe(true);
    expect((await read(org)).due).toBe(true);
  });
  it('immediately releases a claimed office on shutdown before evaluation', async () => {
    const org = organizations[0];
    const claim = (await queue.claimReportObligations([org]))!;
    const reconcile = vi.fn();
    expect(
      await queue.processReportObligationsClaim(claim, reconcile, () => true),
    ).toBe('stopped');
    expect(reconcile).not.toHaveBeenCalled();
    expect((await read(org)).due).toBe(true);
    const next = (await queue.claimReportObligations([org]))!;
    expect(await queue.finishReportObligations(next)).toBe(true);
  });
  it('locks down function execution/search paths and rejects arbitrary error data or invalid scope', async () => {
    const acl = await admin.query(
      `SELECT p.proname,p.prosecdef,p.proconfig,
       EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname=ANY($1::text[])`,
      [['claim_report_obligations', 'finish_report_obligations']],
    );
    expect(acl.rows).toHaveLength(2);
    for (const row of acl.rows) {
      expect(row.prosecdef).toBe(true);
      expect(row.public_execute).toBe(false);
      expect(row.proconfig).toContain('search_path=pg_catalog, pg_temp');
    }
    await expect(
      db.pool.query('SELECT * FROM claim_report_obligations($1,$2::uuid[])', [
        randomUUID(),
        [],
      ]),
    ).rejects.toThrow();
    await expect(
      db.pool.query('SELECT finish_report_obligations($1,$2,1,$3)', [
        organizations[0],
        randomUUID(),
        'arbitrary private report data',
      ]),
    ).rejects.toThrow();
  });
});
