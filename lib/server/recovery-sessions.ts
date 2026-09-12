import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { LifecycleError } from '../lifecycle-contract';
import { assertSealedMaintenance } from './lifecycle-control';
export type RecoverySessionReceipt = { ok: true; revokedSessions: number };
/** Disaster restore only. Ordinary upgrades preserve their authenticated sessions. */
export async function revokeRestoredSessions(
  client: PoolClient,
  requestId: string = randomUUID(),
): Promise<RecoverySessionReceipt> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId))
    throw new Error('Invalid recovery request ID');
  const hash = createHash('sha256')
    .update('recovery.sessions_revoked:v1')
    .digest('hex');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    const owner = (
      await client.query(
        "SELECT count(*)=2 AND bool_and(pg_has_role(session_user,relowner,'MEMBER')) AS allowed FROM pg_class WHERE oid IN ('public.auth_session'::regclass,'public.app_lifecycle_control'::regclass)",
      )
    ).rows[0]?.allowed;
    if (owner !== true)
      throw new Error('Recovery session revocation requires the schema owner');
    const state = await assertSealedMaintenance(client);
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
          'Request ID belongs to a different operator command.',
        );
      await client.query('COMMIT');
      return prior.result as RecoverySessionReceipt;
    }
    // OAuth authorization states referencing these restored sessions expire with them.
    const revoked = await client.query('DELETE FROM auth_session');
    const result: RecoverySessionReceipt = {
      ok: true,
      revokedSessions: revoked.rowCount ?? 0,
    };
    await client.query(
      'INSERT INTO app_lifecycle_events(id,request_id,command_hash,action,generation,release_id,mode,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        requestId,
        hash,
        'recovery.sessions_revoked',
        state.generation,
        state.activeRelease,
        state.mode,
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
