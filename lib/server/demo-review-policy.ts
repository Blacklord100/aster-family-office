import 'server-only';
import type { PoolClient } from 'pg';
import type { WorkspaceContext } from './access';
import { demoActorId } from './demo-corpus';

/** No browser request can select this actor. It has no sign-in account/session. */
export async function hasDemoSourceVerification(
  c: PoolClient,
  ctx: WorkspaceContext,
  documentId: string,
) {
  if (
    process.env.ASTER_ENABLE_DEMO !== 'true' ||
    ctx.user.id !== demoActorId(ctx.organizationId) ||
    ctx.sessionId !== 'demo-system'
  )
    return false;
  const allowed = await c.query(
    `SELECT 1 FROM app_organizations o JOIN app_audit a ON a.organization_id=o.id
     WHERE o.id=$1 AND o.demo_owner_user_id IS NOT NULL AND o.demo_source_directory='Demo mails'
      AND a.actor_id=$2 AND a.resource_id=$3 AND a.action='demo.source_verified' LIMIT 1`,
    [ctx.organizationId, ctx.user.id, documentId],
  );
  return !!allowed.rowCount;
}
