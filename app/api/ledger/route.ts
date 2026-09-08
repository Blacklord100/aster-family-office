import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { ledgerRequestSchema } from '@/lib/ledger-contract';
import { readLedger, writeLedger } from '@/lib/server/ledger-store';
export async function GET(request: Request) {
  try {
    return json(await readLedger(await requireWorkspace(request, 'read')));
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const context = await requireWorkspace(request, 'write');
    const input = await parseJson(request, ledgerRequestSchema);
    return json(await writeLedger(context, input));
  } catch (error) {
    return errorResponse(error);
  }
}
