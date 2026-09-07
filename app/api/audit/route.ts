import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json } from '@/lib/server/http';
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    return await withTenant(ctx.organizationId, async (c) =>
      json({
        events: (
          await c.query(
            'SELECT id,actor_id AS "actorId",action,resource_id AS "resourceId",details,entry_hash AS "entryHash",created_at AS "createdAt" FROM app_audit WHERE organization_id=$1 ORDER BY sequence DESC LIMIT 200',
            [ctx.organizationId],
          )
        ).rows,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
