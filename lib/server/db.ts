import 'server-only';
import { Pool, type PoolClient } from 'pg';

// Connections open on first use. Importing a route during `next build` does not
// connect to production or require build workers to carry runtime credentials.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  application_name: 'aster',
});

let roleCheck: Promise<void> | undefined;

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
    const result = await pool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
    }>(
      'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user',
    );
    const role = result.rows[0];
    if (
      !role ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolcreaterole ||
      role.rolcreatedb
    ) {
      throw new Error(
        'DATABASE_URL must use a restricted runtime role without SUPERUSER, BYPASSRLS, CREATEROLE, or CREATEDB. Use MIGRATION_DATABASE_URL only for migrations.',
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
