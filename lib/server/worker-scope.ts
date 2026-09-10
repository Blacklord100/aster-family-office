import type { Pool } from 'pg';

/** Operator queue routing for dedicated worker pools, never an authorization boundary. */
export function workerOrganizationScope(
  value: string | undefined,
): string[] | null {
  if (value === undefined) return null;
  const identifiers = value.split(',').map((item) => item.trim());
  if (
    identifiers.length > 100 ||
    identifiers.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
    ) ||
    new Set(identifiers.map((id) => id.toLowerCase())).size !==
      identifiers.length
  )
    throw new Error(
      'WORKER_ORGANIZATION_IDS must contain 1–100 unique organization UUIDs.',
    );
  return identifiers.map((id) => id.toLowerCase());
}

export async function claimDocumentJob(
  database: Pool,
  owner: string,
  organizations: string[] | null,
) {
  const result = await database.query<{
    id: string;
    organization_id: string;
    attempts: number;
    capacity_deferrals: number;
  }>(
    `UPDATE app_job_queue SET lease_owner=$1,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 WHERE id=(SELECT id FROM app_job_queue WHERE available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND ($2::uuid[] IS NULL OR organization_id=ANY($2::uuid[])) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,organization_id,attempts,capacity_deferrals`,
    [owner, organizations],
  );
  return result.rows[0];
}

/** Expiration is a fencing boundary even before another worker reclaims the job. */
export async function renewDocumentLease(
  database: Pool,
  id: string,
  owner: string,
): Promise<boolean> {
  const lease = await database.query(
    "UPDATE app_job_queue SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND lease_owner=$2 AND lease_until>clock_timestamp()",
    [id, owner],
  );
  return lease.rowCount === 1;
}
