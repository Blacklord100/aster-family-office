import { z } from 'zod';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json, parseJson } from '@/lib/server/http';
import { activateEngine } from '@/lib/server/engine-store';
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
    const input = await parseJson(
      request,
      z
        .object({
          revision: z.number().int().positive(),
          acknowledgeCloudEgress: z.boolean().default(false),
        })
        .strict(),
    );
    return await withTenant(ctx.organizationId, async (c) =>
      json(
        await activateEngine(
          c,
          ctx,
          id,
          input.revision,
          input.acknowledgeCloudEgress,
        ),
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
