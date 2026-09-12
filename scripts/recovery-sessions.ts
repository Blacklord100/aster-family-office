import { Pool, type PoolClient } from 'pg';
import { revokeRestoredSessions } from '../lib/server/recovery-sessions';
import { LifecycleError } from '../lib/lifecycle-contract';
let pool: Pool | undefined, client: PoolClient | undefined;
try {
  const args = process.argv.slice(2),
    url = process.env.MIGRATION_DATABASE_URL;
  if (
    !url ||
    (args.length !== 0 && (args.length !== 2 || args[0] !== '--request-id'))
  )
    throw new Error('Invalid recovery-session configuration');
  pool = new Pool({
    connectionString: url,
    max: 1,
    application_name: 'aster-recovery-sessions',
    statement_timeout: 60_000,
    connectionTimeoutMillis: 10_000,
  });
  client = await pool.connect();
  console.log(JSON.stringify(await revokeRestoredSessions(client, args[1])));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      error:
        error instanceof LifecycleError
          ? error.code
          : 'RECOVERY_SESSIONS_FAILED',
      message:
        error instanceof LifecycleError
          ? error.message
          : 'Restored sessions could not be revoked. Verify sealed maintenance and operator credentials.',
    }),
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
