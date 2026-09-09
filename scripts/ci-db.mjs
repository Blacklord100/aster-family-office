import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
if (process.env.CI !== 'true' || !process.env.GITHUB_ENV)
  throw new Error('CI-only fixture setup');
const url = new URL(process.env.MIGRATION_DATABASE_URL);
if (
  url.hostname !== '127.0.0.1' ||
  url.port !== '55439' ||
  url.pathname !== '/aster'
)
  throw new Error('CI fixture target refused');
const pool = new pg.Pool({ connectionString: url.toString() });
try {
  await pool.query(
    "CREATE ROLE aster_runtime LOGIN PASSWORD 'synthetic-ci-runtime-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
  );
  const generated = {
    BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PROCESSOR_TOKEN: randomBytes(48).toString('base64url'),
  };
  // Register generated fixture values before later step environment summaries.
  for (const value of Object.values(generated))
    process.stdout.write('::add-mask::' + value + '\n');
  await appendFile(process.env.GITHUB_ENV,
    Object.entries(generated).map(([key, value]) => key + '=' + value).join('\n') + '\n');
} finally {
  await pool.end();
}
