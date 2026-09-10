import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { claimDocumentJob, workerOrganizationScope } from './worker-scope';
import { assertDisposableDatabase } from '../test-support/disposable-database';

describe('dedicated worker organization routing', () => {
  it('leaves the deployment default unrestricted only when the option is absent', () => {
    expect(workerOrganizationScope(undefined)).toBeNull();
    const first = randomUUID(),
      second = randomUUID();
    expect(
      workerOrganizationScope(` ${first.toUpperCase()}, ${second} `),
    ).toEqual([first, second]);
  });
  it('fails closed on empty, malformed, duplicate, oversized or injection-like settings', () => {
    const id = randomUUID();
    for (const input of [
      '',
      ' ',
      ',',
      id + ',',
      id + ',' + id.toUpperCase(),
      '*',
      'null',
      "' OR true --",
      Array.from({ length: 101 }, randomUUID).join(','),
    ])
      expect(() => workerOrganizationScope(input)).toThrow(
        'WORKER_ORGANIZATION_IDS',
      );
  });
});

describe.skipIf(process.env.ASTER_WORKER_SCOPE_INTEGRATION !== '1')(
  'actual scoped queue claims',
  () => {
    let admin: Pool, runtime: Pool;
    const user = randomUUID(),
      allowed = randomUUID(),
      foreign = randomUUID();
    const first = randomUUID(),
      lateForeign = randomUUID(),
      owner = 'synthetic-scope-' + randomUUID();
    async function addJob(id: string, org: string, available: string) {
      await admin.query(
        "INSERT INTO app_documents(id,organization_id,created_by,filename,mime_type,content_hash,byte_size,payload) VALUES($1,$2,$3,'scope.txt','text/plain',$5,1,$4)",
        [id, org, user, Buffer.from('x'), id],
      );
      await admin.query(
        "INSERT INTO app_jobs(id,organization_id,document_id,created_by,mode,policy_revision,engine_legacy) VALUES($1,$2,$1,$3,'workflow',1,true)",
        [id, org, user],
      );
      await admin.query(
        'INSERT INTO app_job_queue(id,organization_id,available_at) VALUES($1,$2,$3)',
        [id, org, available],
      );
    }
    beforeAll(async () => {
      assertDisposableDatabase();
      admin = new Pool({
        connectionString: process.env.MIGRATION_DATABASE_URL,
      });
      runtime = new Pool({ connectionString: process.env.DATABASE_URL });
      await admin.query(
        'INSERT INTO auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
        [user, 'SYNTHETIC worker scope', user + '@example.invalid'],
      );
      await admin.query(
        'INSERT INTO app_organizations(id,name) VALUES($1,$2),($3,$4)',
        [allowed, 'SYNTHETIC selected', foreign, 'SYNTHETIC unselected'],
      );
    });
    afterAll(async () => {
      if (admin) {
        for (const table of ['app_job_queue', 'app_jobs', 'app_documents'])
          await admin.query(
            `DELETE FROM ${table} WHERE organization_id=ANY($1::uuid[])`,
            [[allowed, foreign]],
          );
        await admin.query(
          'DELETE FROM app_organizations WHERE id=ANY($1::uuid[])',
          [[allowed, foreign]],
        );
        await admin.query('DELETE FROM auth_user WHERE id=$1', [user]);
        await admin.end();
      }
      if (runtime) await runtime.end();
    });
    it('claims only configured organizations, including after a foreign job arrives later', async () => {
      await addJob(first, allowed, '2020-01-02');
      expect(await claimDocumentJob(runtime, owner, [allowed])).toMatchObject({
        id: first,
        organization_id: allowed,
        attempts: 1,
      });
      await addJob(lateForeign, foreign, '2020-01-01');
      expect(await claimDocumentJob(runtime, owner, [allowed])).toBeUndefined();
      const foreignRow = (
        await admin.query(
          'SELECT lease_owner,lease_until,attempts FROM app_job_queue WHERE id=$1',
          [lateForeign],
        )
      ).rows[0];
      expect(foreignRow).toEqual({
        lease_owner: null,
        lease_until: null,
        attempts: 0,
      });
      const selected = (
        await admin.query('SELECT status FROM app_jobs WHERE id=$1', [
          lateForeign,
        ])
      ).rows[0];
      expect(selected.status).toBe('queued');
    });
  },
);
