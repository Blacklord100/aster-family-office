import { lifecycleRoute } from '@/lib/server/lifecycle';
import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { json } from '@/lib/server/http';
import { listMailboxes } from '@/lib/server/mailbox-store';
export const runtime = 'nodejs';
async function handleGET(request: Request) {
  try {
    return json(await listMailboxes(await requireWorkspace(request)));
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = lifecycleRoute(handleGET);
