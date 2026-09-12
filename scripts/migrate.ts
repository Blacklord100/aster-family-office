import { Pool } from 'pg';
import { applyMigrations } from '../lib/server/migration-runner';
const url = process.env.MIGRATION_DATABASE_URL;
if (!url)
  throw new Error(
    'MIGRATION_DATABASE_URL is required; do not use the application runtime credential.',
  );
const pool = new Pool({
  connectionString: url,
  max: 1,
  application_name: 'aster-migrate',
});
const client = await pool.connect();
try {
  const result = await applyMigrations(client, {
    directory: 'migrations',
    runtimeRole: process.env.RUNTIME_DATABASE_ROLE ?? 'aster_runtime',
    adoptLegacyChecksums: process.env.ASTER_ADOPT_LEGACY_MIGRATIONS === '1',
    onApplied: (name) => console.log('Applied ' + name),
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} finally {
  client.release();
  await pool.end();
}
