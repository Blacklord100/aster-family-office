import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { LifecycleError } from '../lifecycle-contract';
import { MIGRATION_LOCK, WRITER_BARRIER } from './lifecycle-control';
export async function applyMigrations(
  client: PoolClient,
  options: {
    directory: string;
    runtimeRole: string;
    adoptLegacyChecksums?: boolean;
    onApplied?: (name: string) => void;
  },
) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.runtimeRole))
    throw new Error('Invalid runtime database role');
  const names = (await readdir(options.directory))
    .filter((name) => /^\d{3}-[a-z0-9-]+\.sql$/.test(name))
    .sort();
  if (!names.length) throw new Error('No migrations found');
  const migrations = await Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(options.directory, name), 'utf8');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS aster_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now(),checksum text,checksum_adopted boolean NOT NULL DEFAULT false)',
    );
    await client.query(
      'ALTER TABLE aster_migrations ADD COLUMN IF NOT EXISTS checksum text, ADD COLUMN IF NOT EXISTS checksum_adopted boolean NOT NULL DEFAULT false',
    );
    const applied = (
      await client.query<{ name: string; checksum: string | null }>(
        'SELECT name,checksum FROM aster_migrations ORDER BY name',
      )
    ).rows;
    for (const row of applied) {
      const file = migrations.find((m) => m.name === row.name);
      if (!file || (row.checksum && row.checksum !== file.checksum))
        throw new LifecycleError(
          'MIGRATION_CHECKSUM_MISMATCH',
          'An applied migration is missing or its checksum changed. Migration stopped.',
        );
    }
    const legacy = applied.filter((row) => !row.checksum);
    if (legacy.length && !options.adoptLegacyChecksums)
      throw new LifecycleError(
        'LEGACY_CHECKSUM_ADOPTION_REQUIRED',
        'Applied migrations predate checksums. Compare their trusted release source, then explicitly adopt the baseline with ASTER_ADOPT_LEGACY_MIGRATIONS=1.',
      );
    if (legacy.length) {
      await client.query('BEGIN');
      try {
        for (const row of legacy)
          await client.query(
            'UPDATE aster_migrations SET checksum=$2,checksum_adopted=true WHERE name=$1 AND checksum IS NULL',
            [row.name, migrations.find((m) => m.name === row.name)!.checksum],
          );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    const existing = (
      await client.query(
        "SELECT to_regclass('public.app_lifecycle_control') IS NOT NULL AS present",
      )
    ).rows[0].present;
    const pending = migrations.filter(
      (m) => !applied.some((row) => row.name === m.name),
    );
    if (existing && pending.length) {
      const state = (
        await client.query('SELECT mode FROM app_lifecycle_control WHERE id')
      ).rows[0];
      if (state?.mode !== 'maintenance')
        throw new LifecycleError(
          'MAINTENANCE_READ_ONLY',
          'Schema upgrades require sealed maintenance.',
        );
    }
    for (const migration of pending) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [
          WRITER_BARRIER,
        ]);
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO aster_migrations(name,checksum,checksum_adopted) VALUES($1,$2,false)',
          [migration.name, migration.checksum],
        );
        const version = Number(migration.name.slice(0, 3));
        if (version >= 16)
          await client.query(
            'UPDATE app_lifecycle_control SET schema_version=$1,updated_at=clock_timestamp() WHERE id AND schema_version<>$1',
            [version],
          );
        await client.query('COMMIT');
        options.onApplied?.(migration.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    const target = Number(names.at(-1)!.slice(0, 3)),
      role = options.runtimeRole;
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITER_BARRIER]);
      await client.query('GRANT USAGE ON SCHEMA public TO ' + role);
      await client.query(
        'GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ' +
          role,
      );
      await client.query(
        'GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + role,
      );
      await client.query('REVOKE ALL ON aster_migrations FROM ' + role);
      await client.query(
        'REVOKE UPDATE,DELETE,TRUNCATE ON app_audit FROM ' + role,
      );
      await client.query(
        'GRANT EXECUTE ON FUNCTION claim_report_obligations(uuid,uuid[]),finish_report_obligations(uuid,uuid,bigint,text),claim_folder_connection(uuid,uuid[]),archive_destinations_for_poll(uuid,uuid[]),claim_archive_job(uuid,uuid[]) TO ' +
          role,
      );
      if (target >= 16) {
        await client.query(
          'REVOKE ALL ON app_lifecycle_control,app_lifecycle_operations,app_lifecycle_events FROM ' +
            role,
        );
        await client.query('GRANT SELECT ON app_lifecycle_control TO ' + role);
        await client.query(
          'GRANT EXECUTE ON FUNCTION aster_admit_operation(uuid,text,text),aster_renew_operation(uuid,text),aster_finish_operation(uuid,text),aster_assert_operation() TO ' +
            role,
        );
        await client.query(
          `DO $$ DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'app\\_%' ESCAPE '\\' OR tablename LIKE 'auth\\_%' ESCAPE '\\') AND tablename NOT IN ('app_lifecycle_control','app_lifecycle_operations','app_lifecycle_events') LOOP IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname='aster_runtime_write_guard') THEN EXECUTE format('CREATE TRIGGER aster_runtime_write_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION aster_runtime_write_guard()',t); END IF; END LOOP; END $$`,
        );
        await client.query(
          'UPDATE app_lifecycle_control SET schema_version=$1,updated_at=clock_timestamp() WHERE id AND schema_version<>$1',
          [target],
        );
      }
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return {
      schemaVersion: target,
      applied: pending.map((m) => m.name),
      adopted: legacy.map((m) => m.name),
    };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
  }
}
