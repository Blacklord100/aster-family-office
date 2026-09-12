import { lifecycleRoute } from '@/lib/server/lifecycle';
import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { ledgerRequestSchema } from '@/lib/ledger-contract';
import { readLedger, writeLedger } from '@/lib/server/ledger-store';
async function handleGET(request: Request) {
  try {
    return json(await readLedger(await requireWorkspace(request, 'read')));
  } catch (error) {
    return errorResponse(error);
  }
}
async function handlePOST(request: Request) {
  try {
    const context = await requireWorkspace(request, 'write');
    const input = await parseJson(request, ledgerRequestSchema);
    return json(await writeLedger(context, input));
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = lifecycleRoute(handleGET);
export const POST = lifecycleRoute(handlePOST);
