import { assertSealedMaintenance } from '../lib/server/lifecycle-control';
import { Pool } from 'pg';
import { readFile, writeFile } from 'node:fs/promises';
import { rotateEncryptedRecords } from '../lib/server/key-rotation';
const apply = process.argv.includes('--apply');
let stage = 'configuration',
  committed = false;
try {
  const url = process.env.ROTATION_DATABASE_URL;
  if (!url || !process.argv.includes(apply ? '--apply' : '--dry-run'))
    throw new Error('Use ROTATION_DATABASE_URL and --dry-run or --apply');
  if (apply) {
    if (
      process.env.ASTER_MAINTENANCE !== '1' ||
      !process.env.ROTATION_BACKUP_RECEIPT
    )
      throw new Error(
        'Apply requires maintenance mode and a recent backup receipt',
      );
    const receipt = JSON.parse(
      await readFile(process.env.ROTATION_BACKUP_RECEIPT, 'utf8'),
    );
    const age = Date.now() - Date.parse(receipt.at);
    if (
      receipt.result !== 'passed' ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 86400000 ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256)
    )
      throw new Error(
        'A verified backup receipt less than 24 hours old is required',
      );
  }
  const pool = new Pool({ connectionString: url, max: 1 }),
    client = await pool.connect();
  try {
    stage = 'transaction';
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SELECT pg_advisory_xact_lock(176334523)');
    if (apply) await assertSealedMaintenance(client);
    stage = 'verify-and-rotate';
    const report = await rotateEncryptedRecords(client, apply);
    stage = 'commit';
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    committed = apply;
    stage = 'receipt';
    const receipt = { ...report, at: new Date().toISOString() };
    if (process.env.ROTATION_REPORT_FILE)
      await writeFile(
        process.env.ROTATION_REPORT_FILE,
        JSON.stringify(receipt, null, 2) + '\n',
        { mode: 0o600, flag: 'wx' },
      );
    console.log(JSON.stringify(receipt));
  } catch (e) {
    if (!committed) await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
} catch {
  console.error(
    committed
      ? 'Rotation committed, but its receipt could not be written. Run a dry-run to verify key versions; do not discard old keys.'
      : 'Encryption maintenance failed at ' +
          stage +
          '. Record contents and credentials suppressed. Check configuration, backup receipt, schema ownership and maintenance locks.',
  );
  process.exitCode = 1;
}
