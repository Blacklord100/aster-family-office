import { lifecycleRoute } from '@/lib/server/lifecycle';
import { errorResponse, requireWorkspace } from '@/lib/server/access';
import { historyLifecycleRequestSchema } from '@/lib/portfolio-history-lifecycle-contract';
import { writeHistoryLifecycle } from '@/lib/server/portfolio-history-lifecycle-store';
import { json, parseJson } from '@/lib/server/http';
async function handlePOST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'write');
    return json(
      await writeHistoryLifecycle(
        ctx,
        await parseJson(request, historyLifecycleRequestSchema),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = lifecycleRoute(handlePOST);
