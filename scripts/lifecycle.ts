import { Pool, type PoolClient } from 'pg';
import {
  controlLifecycle,
  lifecycleStatus,
  type LifecycleCommand,
} from '../lib/server/lifecycle-control';
import { LifecycleError } from '../lib/lifecycle-contract';
let pool: Pool | undefined, client: PoolClient | undefined;
try {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Operator database URL is required');
  const args = process.argv.slice(2),
    action = args.shift(),
    values: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !['--release', '--expected-generation', '--request-id'].includes(key) ||
      !args[i + 1] ||
      values[key]
    )
      throw new Error('Invalid lifecycle arguments');
    values[key] = args[i + 1];
  }
  if (
    (action === 'status' && args.length) ||
    (action !== 'status' &&
      !['drain', 'seal', 'activate', 'resume'].includes(action ?? ''))
  )
    throw new Error('Invalid lifecycle command');
  pool = new Pool({
    connectionString: url,
    max: 1,
    application_name: 'aster-lifecycle',
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  client = await pool.connect();
  const result =
    action === 'status'
      ? await lifecycleStatus(client)
      : await controlLifecycle(client, {
          action: action as LifecycleCommand['action'],
          expectedGeneration: Number(values['--expected-generation']),
          release: values['--release'],
          requestId: values['--request-id'],
        });
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      error:
        error instanceof LifecycleError
          ? error.code
          : 'LIFECYCLE_COMMAND_FAILED',
      message:
        error instanceof LifecycleError
          ? error.message
          : 'Lifecycle command failed. Verify operator credentials and arguments.',
    }),
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
