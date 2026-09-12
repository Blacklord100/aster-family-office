import 'server-only';
import { Pool, type PoolClient } from 'pg';
import { databaseWriterOptions } from '../lifecycle-contract';
import { lifecycleContext } from './lifecycle-context';

// Connections open on first use. Importing a route during `next build` does not
// connect to production or require build workers to carry runtime credentials.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  application_name: 'aster',
  options: databaseWriterOptions(),
});

// Every checked-out connection receives fresh operation context, including Kysely/Better Auth
// clients and pool.query callers. Context is reset before a connection can serve another request.
const acquireConnection = pool.connect.bind(pool);
pool.connect = ((
  callback?: (
    error: Error | undefined,
    client?: PoolClient,
    release?: PoolClient['release'],
  ) => void,
) => {
  const context = lifecycleContext.getStore();
  const pending = acquireConnection().then(async (client) => {
    try {
      await client.query(
        "SELECT set_config('app.operation_id',$1,false),set_config('app.operation_token',$2,false)",
        [context?.operation?.id ?? '', context?.operation?.token ?? ''],
      );
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  });
  if (callback) {
    void pending.then(
      (client) => callback(undefined, client, client.release.bind(client)),
      (error) => callback(error),
    );
    return;
  }
  return pending;
}) as typeof pool.connect;

let roleCheck: Promise<void> | undefined;

export const RUNTIME_ROLE_QUERY = `
  SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
    has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
    has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
    EXISTS (
      SELECT 1 FROM pg_roles elevated
      WHERE pg_has_role(current_user, elevated.oid, 'MEMBER')
        AND (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreaterole
          OR elevated.rolcreatedb OR elevated.rolreplication
          OR elevated.rolname IN ('pg_read_all_data', 'pg_write_all_data',
            'pg_read_server_files', 'pg_write_server_files', 'pg_execute_server_program',
            'pg_signal_backend', 'pg_checkpoint', 'pg_maintain', 'pg_create_subscription'))
    ) AS elevated_membership,
    EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND pg_has_role(current_user, c.relowner, 'MEMBER')
      UNION ALL
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND pg_has_role(current_user, p.proowner, 'MEMBER')
    ) AS owns_application_objects
  FROM pg_roles r WHERE r.rolname = current_user`;

export type RuntimeRolePrivileges = {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  database_create: boolean;
  schema_create: boolean;
  elevated_membership: boolean;
  owns_application_objects: boolean;
};

export function isRestrictedRuntimeRole(
  role: RuntimeRolePrivileges | undefined,
): boolean {
  return (
    !!role &&
    (
      [
        'rolsuper',
        'rolbypassrls',
        'rolcreaterole',
        'rolcreatedb',
        'rolreplication',
        'database_create',
        'schema_create',
        'elevated_membership',
        'owns_application_objects',
      ] as const
    ).every((key) => role[key] === false)
  );
}

export function validateDatabaseEnvironment(): void {
  const value = process.env.DATABASE_URL;
  if (!value)
    throw new Error('DATABASE_URL is required for the application runtime.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }
}

export async function assertDatabaseRole(): Promise<void> {
  validateDatabaseEnvironment();
  if (process.env.NODE_ENV !== 'production') return;
  roleCheck ??= (async () => {
    const result = await pool.query<RuntimeRolePrivileges>(RUNTIME_ROLE_QUERY);
    const role = result.rows[0];
    if (!isRestrictedRuntimeRole(role)) {
      throw new Error(
        'DATABASE_URL must use a restricted runtime role without elevated role membership, schema/database CREATE privileges, application-object ownership, SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, or REPLICATION. Use MIGRATION_DATABASE_URL only for migrations.',
      );
    }
  })().catch((error: unknown) => {
    roleCheck = undefined;
    throw error;
  });
  await roleCheck;
}

export const isOrganizationId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Tenant state is transaction-local and never survives a pooled connection. */
export async function withTenant<T>(
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: { readOnlySnapshot?: boolean } = {},
): Promise<T> {
  if (!isOrganizationId(organizationId))
    throw new Error('Invalid organization ID.');
  await assertDatabaseRole();
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query(
      options.readOnlySnapshot
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN',
    );
    // Acquire the maintenance barrier before tenant row locks or filesystem publication.
    if (lifecycleContext.getStore()?.operation && !options.readOnlySnapshot)
      await client.query('SELECT aster_assert_operation()');
    await client.query("SELECT set_config('app.organization_id', $1, true)", [
      organizationId,
    ]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      failed = true;
    }
    throw error;
  } finally {
    client.release(failed);
  }
}
