import { z } from 'zod';
import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { parseJson, json } from '@/lib/server/http';
import { OperationalPolicySchema } from '@/lib/operations-contract';
import {
  operationsStatus,
  readOperationalPolicy,
  saveOperationalPolicy,
  retentionPreview,
  purgeRetainedInputs,
} from '@/lib/server/operations-store';
const action = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('policy'),
      policy: OperationalPolicySchema,
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ action: z.literal('preview') }).strict(),
  z
    .object({
      action: z.literal('purge'),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      confirmation: z.literal('PURGE UNREFERENCED DOCUMENTS'),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    return await withTenant(ctx.organizationId, async (c) =>
      json(await operationsStatus(c, ctx)),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin'),
      input = await parseJson(request, action);
    return await withTenant(ctx.organizationId, async (c) => {
      if (input.action === 'preview')
        return json(
          await retentionPreview(
            c,
            ctx,
            (await readOperationalPolicy(c, ctx.organizationId)).policy,
          ),
        );
      if (input.action === 'purge')
        return json(await purgeRetainedInputs(c, ctx, input.digest));
      await saveOperationalPolicy(c, ctx, input.policy, input.expectedRevision);
      return json({ ok: true });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
