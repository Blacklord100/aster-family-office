import { z } from 'zod';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { json, parseJson } from '@/lib/server/http';
import { EngineInputSchema } from '@/lib/engine-contract';
import { saveEngine, deleteEngine } from '@/lib/server/engine-store';
export async function PATCH(
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
    const { revision, ...input } = await parseJson(
      request,
      EngineInputSchema.extend({ revision: z.number().int().positive() }),
    );
    return await withTenant(ctx.organizationId, async (c) =>
      json(await saveEngine(c, ctx, input, id, revision)),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function DELETE(
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
    return await withTenant(ctx.organizationId, async (c) => {
      await deleteEngine(c, ctx, id);
      return json({ ok: true });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
