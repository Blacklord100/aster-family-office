import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  poolQuery: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('pg', () => ({
  Pool: class {
    query = mocked.poolQuery;
    connect = mocked.connect;
  },
}));
import {
  assertDatabaseRole,
  isRestrictedRuntimeRole,
  type RuntimeRolePrivileges,
  withTenant,
} from './db';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://unit-test@localhost/aster_test');
  mocked.connect.mockResolvedValue({
    query: mocked.query,
    release: mocked.release,
  });
  mocked.query.mockResolvedValue({ rows: [] });
});

describe('tenant transactions', () => {
  const org = '11111111-1111-4111-8111-111111111111';
  it('sets tenant context transaction-locally before application SQL and commits', async () => {
    const result = await withTenant(org, async (client) => {
      await client.query('SELECT tenant_data');
      return 42;
    });
    expect(result).toBe(42);
    expect(mocked.query.mock.calls).toEqual([
      [
        "SELECT set_config('app.operation_id',$1,false),set_config('app.operation_token',$2,false)",
        ['', ''],
      ],
      ['BEGIN'],
      ["SELECT set_config('app.organization_id', $1, true)", [org]],
      ['SELECT tenant_data'],
      ['COMMIT'],
    ]);
    expect(mocked.release).toHaveBeenCalledWith(false);
  });
  it('rolls back on failure and preserves the original error', async () => {
    const error = new Error('operation failed');
    await expect(
      withTenant(org, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(mocked.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    expect(mocked.release).toHaveBeenCalledWith(false);
  });
  it('opts a multi-query read into one read-only snapshot before tenant setup', async () => {
    await withTenant(
      org,
      async (client) => {
        await client.query('SELECT tenant_data');
      },
      { readOnlySnapshot: true },
    );
    expect(mocked.query.mock.calls).toEqual([
      [
        "SELECT set_config('app.operation_id',$1,false),set_config('app.operation_token',$2,false)",
        ['', ''],
      ],
      ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'],
      ["SELECT set_config('app.organization_id', $1, true)", [org]],
      ['SELECT tenant_data'],
      ['COMMIT'],
    ]);
  });
  it('discards connection if rollback itself fails', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql === 'ROLLBACK') throw new Error('lost connection');
      return { rows: [] };
    });
    await expect(
      withTenant(org, async () => {
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
    expect(mocked.release).toHaveBeenCalledWith(true);
  });
  it('does not acquire a connection for invalid organization identifiers', async () => {
    await expect(withTenant('invalid', async () => true)).rejects.toThrow(
      'organization',
    );
    expect(mocked.connect).not.toHaveBeenCalled();
  });
  it('rejects dangerous runtime roles in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    mocked.poolQuery.mockResolvedValue({
      rows: [
        {
          rolsuper: true,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
        },
      ],
    });
    await expect(assertDatabaseRole()).rejects.toThrow(
      'restricted runtime role',
    );
  });
});

describe('production runtime privilege boundaries', () => {
  const restricted: RuntimeRolePrivileges = {
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    database_create: false,
    schema_create: false,
    elevated_membership: false,
    owns_application_objects: false,
  };
  it.each(Object.keys(restricted) as (keyof RuntimeRolePrivileges)[])(
    'rejects %s even when the other privileges are restricted',
    (key) => {
      expect(isRestrictedRuntimeRole({ ...restricted, [key]: true })).toBe(
        false,
      );
    },
  );
  it('rejects absent or incomplete privilege evidence and permits the exact restricted profile', () => {
    expect(isRestrictedRuntimeRole(undefined)).toBe(false);
    expect(isRestrictedRuntimeRole({} as RuntimeRolePrivileges)).toBe(false);
    expect(isRestrictedRuntimeRole(restricted)).toBe(true);
  });
});
