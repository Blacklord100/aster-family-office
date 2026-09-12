import { lifecycleRoute } from '@/lib/server/lifecycle';
import { z } from 'zod';
import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { indexDocument } from '@/lib/server/intelligence-store';
async function handlePOST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'write');
    const { documentId } = await parseJson(
      request,
      z.object({ documentId: z.uuid() }).strict(),
    );
    return json(await indexDocument(ctx, documentId));
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = lifecycleRoute(handlePOST);
