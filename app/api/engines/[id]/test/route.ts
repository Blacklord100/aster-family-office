import { z } from 'zod';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json, parseJson } from '@/lib/server/http';
import { loadEngineRevision } from '@/lib/server/engine-store';
import { testEngine } from '@/lib/server/engine-processor';
import { audit, rateLimit } from '@/lib/server/audit';
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    const { id } = await params;
    if (!z.uuid().safeParse(id).success)
      throw new AccessError(
        404,
        'ENGINE_NOT_FOUND',
        'Engine profile not found.',
      );
    const { revision } = await parseJson(
      request,
      z.object({ revision: z.number().int().positive() }).strict(),
    );
    const selected = await withTenant(ctx.organizationId, async (c) => {
      if (!(await rateLimit(c, 'engine-test:' + ctx.organizationId, 6, 3600)))
        throw new AccessError(
          429,
          'RATE_LIMITED',
          'Synthetic engine check limit reached.',
        );
      return loadEngineRevision(c, ctx.organizationId, id, revision);
    });
    const result = await testEngine(selected.config);
    await withTenant(ctx.organizationId, async (c) => {
      await c.query(
        'UPDATE app_engine_revisions SET tested_at=$4,test_ok=$5,test_error=$6 WHERE profile_id=$1 AND organization_id=$2 AND revision=$3',
        [
          id,
          ctx.organizationId,
          revision,
          result.testedAt,
          result.ok,
          result.errorCode,
        ],
      );
      await audit(
        c,
        ctx.organizationId,
        ctx.user.id,
        'engine.synthetic_test',
        id,
        { revision, ok: result.ok },
      );
    });
    return json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
