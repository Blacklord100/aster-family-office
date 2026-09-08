import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import {
  getIntelligence,
  changeIntelligence,
} from '@/lib/server/intelligence-store';
import { intelligenceCommandSchema } from '@/lib/intelligence-contract';
export async function GET(request: Request) {
  try {
    return json(await getIntelligence(await requireWorkspace(request, 'read')));
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'write');
    return json(
      await changeIntelligence(
        ctx,
        await parseJson(request, intelligenceCommandSchema),
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
