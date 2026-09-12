import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { LifecycleError, type LifecycleStatus } from '../lifecycle-contract';
export const MIGRATION_LOCK = 176334523;
export const WRITER_BARRIER = 176334525;
export type LifecycleCommand = {
  action: 'drain' | 'seal' | 'activate' | 'resume';
  expectedGeneration: number;
  release?: string;
  requestId?: string;
};
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export async function lifecycleStatus(
  client: PoolClient,
): Promise<LifecycleStatus> {
  const row = (
    await client.query(
      'SELECT *,clock_timestamp() AS checked_at FROM app_lifecycle_control WHERE id',
    )
  ).rows[0];
  if (!row)
    throw new LifecycleError(
      'LIFECYCLE_UNAVAILABLE',
      'Lifecycle control has not been initialized.',
    );
  const counts = (
    await client.query(`SELECT
 (SELECT count(*)::int FROM app_lifecycle_operations WHERE expires_at>clock_timestamp()) AS operations,
 (SELECT count(*)::int FROM app_job_queue WHERE lease_until>clock_timestamp()) AS document,
 (SELECT count(*)::int FROM app_mailbox_queue WHERE lease_until>clock_timestamp()) AS mailbox,
 (SELECT count(*)::int FROM app_folder_queue WHERE lease_until>clock_timestamp()) AS folder,
 (SELECT count(*)::int FROM app_archive_jobs WHERE lease_until>clock_timestamp()) AS archive,
 (SELECT count(*)::int FROM app_report_obligations_queue WHERE lease_until>clock_timestamp()) AS reporting,
 (SELECT count(*)::int FROM app_delivery_outbox WHERE lease_until>clock_timestamp()) AS delivery`)
  ).rows[0];
  const { operations, ...leases } = counts;
  const total = Object.values(leases).reduce<number>(
    (sum, value) => sum + Number(value),
    0,
  );
  return {
    ok: true,
    enabled: true,
    mode: row.mode,
    generation: Number(row.generation),
    activeRelease: row.active_release,
    schemaVersion: row.schema_version,
    resumedAt: row.resumed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    activeOperations: operations,
    activeLeases: { ...leases, total },
    canSeal: row.mode !== 'open' && operations === 0 && total === 0,
  };
}
/** Only the schema owner can operate the barrier; runtime credentials cannot change it. */
export async function controlLifecycle(
  client: PoolClient,
  command: LifecycleCommand,
): Promise<LifecycleStatus> {
  if (
    !Number.isSafeInteger(command.expectedGeneration) ||
    command.expectedGeneration < 1 ||
    (command.release !== undefined && !RELEASE.test(command.release)) ||
    !['drain', 'seal', 'activate', 'resume'].includes(command.action)
  )
    throw new Error('Invalid lifecycle command');
  if (['activate', 'resume'].includes(command.action) && !command.release)
    throw new Error('--release is required');
  const requestId = command.requestId ?? randomUUID();
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId))
    throw new Error('Invalid request ID');
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        action: command.action,
        expectedGeneration: command.expectedGeneration,
        release: command.release ?? null,
      }),
    )
    .digest('hex');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    const prior = (
      await client.query(
        'SELECT command_hash,result FROM app_lifecycle_events WHERE request_id=$1',
        [requestId],
      )
    ).rows[0];
    if (prior) {
      if (prior.command_hash !== hash)
        throw new LifecycleError(
          'LIFECYCLE_STATE_CONFLICT',
          'Request ID belongs to a different lifecycle command.',
        );
      await client.query('COMMIT');
      return prior.result as LifecycleStatus;
    }
    // Do not hold this lock while waiting for asynchronous work: a busy seal returns immediately.
    await client.query('SELECT pg_advisory_xact_lock($1)', [WRITER_BARRIER]);
    const row = (
      await client.query(
        'SELECT * FROM app_lifecycle_control WHERE id FOR UPDATE',
      )
    ).rows[0];
    if (Number(row.generation) !== command.expectedGeneration)
      throw new LifecycleError(
        'GENERATION_CONFLICT',
        'Lifecycle generation changed. Read status before retrying.',
      );
    const before = await lifecycleStatus(client);
    if (command.action === 'drain') {
      if (row.mode === 'maintenance')
        throw new LifecycleError(
          'LIFECYCLE_STATE_CONFLICT',
          'Already sealed; activate or resume explicitly.',
        );
      await client.query(
        "UPDATE app_lifecycle_control SET mode='draining',updated_at=clock_timestamp() WHERE id",
      );
    } else if (command.action === 'seal') {
      if (row.mode === 'open')
        throw new LifecycleError(
          'LIFECYCLE_STATE_CONFLICT',
          'Drain before sealing.',
        );
      if (before.activeOperations || before.activeLeases.total)
        throw new LifecycleError(
          'DRAIN_BUSY',
          'Admitted operations or queue leases are still active.',
        );
      await client.query(
        "UPDATE app_lifecycle_control SET mode='maintenance',updated_at=clock_timestamp() WHERE id",
      );
    } else if (command.action === 'activate') {
      if (
        row.mode !== 'maintenance' ||
        before.activeOperations ||
        before.activeLeases.total
      )
        throw new LifecycleError(
          'LIFECYCLE_STATE_CONFLICT',
          'Activation requires a sealed, drained database.',
        );
      await client.query(
        'UPDATE app_lifecycle_control SET generation=generation+1,active_release=$1,updated_at=clock_timestamp() WHERE id',
        [command.release],
      );
    } else {
      if (row.mode !== 'maintenance' || row.active_release !== command.release)
        throw new LifecycleError(
          'LIFECYCLE_STATE_CONFLICT',
          'Resume requires the explicitly reserved release in sealed maintenance.',
        );
      await client.query(
        "UPDATE app_lifecycle_control SET mode='open',resumed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id",
      );
    }
    const result = await lifecycleStatus(client);
    await client.query(
      'INSERT INTO app_lifecycle_events(id,request_id,command_hash,action,generation,release_id,mode,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        requestId,
        hash,
        command.action,
        result.generation,
        result.activeRelease,
        result.mode,
        JSON.stringify(result),
      ],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** The caller owns a transaction and must hold these locks until its operator write commits. */
export async function assertSealedMaintenance(
  client: PoolClient,
): Promise<LifecycleStatus> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
  await client.query('SELECT pg_advisory_xact_lock($1)', [WRITER_BARRIER]);
  await client.query(
    'SELECT id FROM app_lifecycle_control WHERE id FOR UPDATE',
  );
  const status = await lifecycleStatus(client);
  if (status.mode !== 'maintenance' || !status.canSeal)
    throw new LifecycleError(
      'MAINTENANCE_READ_ONLY',
      'Operator changes require sealed, fully drained maintenance.',
    );
  return status;
}
