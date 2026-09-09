import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, isOrganizationId } from './db';
import { workerOrganizationScope } from './worker-scope';

export interface ReportObligationsClaim {
  organizationId: string;
  generation: string;
  owner: string;
}
export type ReportObligationsError =
  | 'RECONCILIATION_FAILED'
  | 'WORKER_STOPPING';

/** First visit enrolls monitoring without waking an existing lease on every poll. */
export async function ensureReportObligations(
  client: PoolClient,
  organizationId: string,
) {
  if (!isOrganizationId(organizationId))
    throw new Error('Invalid report monitor workspace');
  await client.query(
    'INSERT INTO app_report_obligations_queue(organization_id) VALUES($1) ON CONFLICT(organization_id) DO NOTHING',
    [organizationId],
  );
}

/** Called within the requesting tenant's existing transaction. Never steals a lease. */
export async function scheduleReportObligations(
  client: PoolClient,
  organizationId: string,
) {
  if (!isOrganizationId(organizationId))
    throw new Error('Invalid report monitor workspace');
  await client.query(
    `INSERT INTO app_report_obligations_queue(organization_id) VALUES($1)
     ON CONFLICT(organization_id) DO UPDATE SET
      run_after=LEAST(app_report_obligations_queue.run_after,now()),
      generation=app_report_obligations_queue.generation+1`,
    [organizationId],
  );
}

/** The database returns only one leased routing record, never workspace content. */
export async function claimReportObligations(
  organizations: string[] | null = null,
): Promise<ReportObligationsClaim | null> {
  const scope =
    organizations === null
      ? null
      : workerOrganizationScope(organizations.join(','));
  const owner = randomUUID();
  const { rows } = await pool.query<{
    organization_id: string;
    generation: string;
    lease_owner: string;
  }>('SELECT * FROM claim_report_obligations($1::uuid,$2::uuid[])', [
    owner,
    scope,
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    generation: String(row.generation),
    owner: row.lease_owner,
  };
}

/** A wake that raced evaluation remains due; a stale claimant cannot finish it. */
export async function finishReportObligations(
  claim: ReportObligationsClaim,
  error: ReportObligationsError | null = null,
): Promise<boolean> {
  const { rows } = await pool.query<{ finished: boolean }>(
    'SELECT finish_report_obligations($1::uuid,$2::uuid,$3::bigint,$4::text) AS finished',
    [claim.organizationId, claim.owner, claim.generation, error],
  );
  return rows[0]?.finished === true;
}

/** Shared by the worker and focused tests; errors never enter routing metadata. */
export async function processReportObligationsClaim(
  claim: ReportObligationsClaim,
  reconcile: (organizationId: string) => Promise<{ changed: boolean }>,
  stopping: () => boolean = () => false,
): Promise<'changed' | 'unchanged' | 'failed' | 'stopped' | 'lease_lost'> {
  if (stopping()) {
    return (await finishReportObligations(claim, 'WORKER_STOPPING'))
      ? 'stopped'
      : 'lease_lost';
  }
  let changed: boolean;
  try {
    changed = (await reconcile(claim.organizationId)).changed;
  } catch {
    return (await finishReportObligations(claim, 'RECONCILIATION_FAILED'))
      ? 'failed'
      : 'lease_lost';
  }
  if (!(await finishReportObligations(claim))) return 'lease_lost';
  return changed ? 'changed' : 'unchanged';
}
