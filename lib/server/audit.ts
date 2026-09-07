import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { signAudit } from './crypto';
export async function audit(
  client: PoolClient,
  organizationId: string,
  actorId: string,
  action: string,
  resourceId: string,
  details: Record<string, string | number | boolean> = {},
) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    organizationId,
  ]);
  const prior = await client.query<{ entry_hash: string }>(
    'SELECT entry_hash FROM app_audit WHERE organization_id=$1 ORDER BY sequence DESC LIMIT 1',
    [organizationId],
  );
  const id = randomUUID(),
    createdAt = new Date().toISOString(),
    previousHash = prior.rows[0]?.entry_hash ?? 'genesis';
  const entryHash = signAudit(
    JSON.stringify({
      id,
      organizationId,
      actorId,
      action,
      resourceId,
      details,
      previousHash,
      createdAt,
    }),
  );
  await client.query(
    'INSERT INTO app_audit(id,organization_id,actor_id,action,resource_id,details,previous_hash,entry_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      organizationId,
      actorId,
      action,
      resourceId,
      details,
      previousHash,
      entryHash,
      createdAt,
    ],
  );
}
export async function rateLimit(
  client: PoolClient,
  key: string,
  limit: number,
  windowSeconds: number,
) {
  const { rows } = await client.query<{ count: number }>(
    `INSERT INTO app_request_limits(key,count,resets_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN app_request_limits.resets_at<=now() THEN 1 ELSE app_request_limits.count+1 END,resets_at=CASE WHEN app_request_limits.resets_at<=now() THEN now()+$2*interval '1 second' ELSE app_request_limits.resets_at END RETURNING count`,
    [key, windowSeconds],
  );
  return rows[0].count <= limit;
}
