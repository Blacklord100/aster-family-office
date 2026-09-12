import { lifecycleRoute } from '@/lib/server/lifecycle';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import {
  periodQuerySchema,
  reportingRequestSchema,
} from '@/lib/reporting-contract';
import { readReporting, saveReporting } from '@/lib/server/reporting-store';
async function handleGET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'read'),
      params = new URL(request.url).searchParams,
      raw = params.get('query');
    let query;
    if (raw) {
      try {
        if (raw.length > 8192) throw new Error('Too long');
        query = periodQuerySchema.parse(JSON.parse(raw));
      } catch {
        throw new AccessError(
          400,
          'REPORT_QUERY_INVALID',
          'Check the period dates and selected families.',
        );
      }
    }
    return json(await readReporting(ctx, query, params.get('id') ?? undefined));
  } catch (error) {
    return errorResponse(error);
  }
}
async function handlePOST(request: Request) {
  try {
    return json(
      await saveReporting(
        await requireWorkspace(request, 'write'),
        await parseJson(request, reportingRequestSchema),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = lifecycleRoute(handleGET);
export const POST = lifecycleRoute(handlePOST);
