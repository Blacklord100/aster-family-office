import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
const url = process.env.MIGRATION_DATABASE_URL;
if (!url)
  throw new Error(
    'MIGRATION_DATABASE_URL is required; do not use the application runtime credential.',
  );
const pool = new Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
try {
  await client.query('SELECT pg_advisory_lock(176334523)');
  await client.query(
    'CREATE TABLE IF NOT EXISTS aster_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())',
  );
  for (const name of (await readdir('migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const done = await client.query(
      'SELECT 1 FROM aster_migrations WHERE name=$1',
      [name],
    );
    if (done.rowCount) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile('migrations/' + name, 'utf8'));
      await client.query('INSERT INTO aster_migrations(name) VALUES($1)', [
        name,
      ]);
      await client.query('COMMIT');
      console.log('Applied ' + name);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
  const role = process.env.RUNTIME_DATABASE_ROLE ?? 'aster_runtime';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role))
    throw new Error('Invalid runtime database role');
  await client.query('GRANT USAGE ON SCHEMA public TO ' + role);
  await client.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ' +
      role,
  );
  await client.query(
    'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + role,
  );
  await client.query('REVOKE ALL ON aster_migrations FROM ' + role);
  await client.query('REVOKE UPDATE,DELETE,TRUNCATE ON app_audit FROM ' + role);
  await client.query(
    'GRANT EXECUTE ON FUNCTION claim_report_obligations(uuid,uuid[]),finish_report_obligations(uuid,uuid,bigint,text),claim_folder_connection(uuid,uuid[]) TO ' +
      role,
  );
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  console.log('Migrations complete; runtime grants applied.');
} finally {
  await client.query('SELECT pg_advisory_unlock(176334523)');
  client.release();
  await pool.end();
}
