import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { assertDisposableDatabase } from '../test-support/disposable-database';
vi.mock('server-only', () => ({}));
import {
  RUNTIME_ROLE_QUERY,
  isRestrictedRuntimeRole,
  type RuntimeRolePrivileges,
  pool,
} from './db';

describe.skipIf(process.env.ASTER_OPERATIONS_INTEGRATION !== '1')(
  'real PostgreSQL production runtime privilege boundary',
  () => {
    const suffix = randomBytes(8).toString('hex');
    const owner = 'aster_fixture_owner_' + suffix;
    const member = 'aster_fixture_member_' + suffix;
    const table = 'aster_fixture_owned_' + suffix;
    let admin: Pool;
    beforeAll(async () => {
      const { admin: url } = assertDisposableDatabase();
      admin = new Pool({ connectionString: url.toString() });
      await admin.query(
        `CREATE ROLE ${owner} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await admin.query(
        `CREATE ROLE ${member} NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await admin.query(`GRANT ${owner} TO ${member}`);
      await admin.query(`CREATE TABLE public.${table}(id int)`);
      await admin.query(`ALTER TABLE public.${table} OWNER TO ${owner}`);
    });
    afterAll(async () => {
      if (admin) {
        await admin.query(`DROP TABLE IF EXISTS public.${table}`);
        await admin.query(`DROP ROLE IF EXISTS ${member}`);
        await admin.query(`DROP ROLE IF EXISTS ${owner}`);
        await admin.end();
      }
      await pool.end();
    });
    async function roleProfile(role: string) {
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        return (await client.query<RuntimeRolePrivileges>(RUNTIME_ROLE_QUERY))
          .rows[0];
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }
    it('accepts the actual restricted runtime login and rejects the schema-owning administrative login', async () => {
      expect(
        isRestrictedRuntimeRole(
          (await pool.query<RuntimeRolePrivileges>(RUNTIME_ROLE_QUERY)).rows[0],
        ),
      ).toBe(true);
      expect(
        isRestrictedRuntimeRole(
          (await admin.query<RuntimeRolePrivileges>(RUNTIME_ROLE_QUERY))
            .rows[0],
        ),
      ).toBe(false);
    });
    it('rejects an application object owner even with every elevated role flag disabled', async () => {
      const profile = await roleProfile(owner);
      expect(profile).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        owns_application_objects: true,
      });
      expect(isRestrictedRuntimeRole(profile)).toBe(false);
    });
    it('rejects a NOINHERIT member that can switch to an owner role', async () => {
      const profile = await roleProfile(member);
      expect(profile.owns_application_objects).toBe(true);
      expect(isRestrictedRuntimeRole(profile)).toBe(false);
    });
  },
);
