import { lifecycleRoute } from '@/lib/server/lifecycle';
import { errorResponse, requireWorkspace } from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { reportObligationsRequestSchema } from '@/lib/report-obligations-api';
import {
  readReportObligations,
  saveReportObligations,
} from '@/lib/server/report-obligations-store';
async function handleGET(request: Request) {
  try {
    return json(
      await readReportObligations(await requireWorkspace(request, 'read')),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
async function handlePOST(request: Request) {
  try {
    return json(
      await saveReportObligations(
        await requireWorkspace(request, 'write'),
        await parseJson(request, reportObligationsRequestSchema),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = lifecycleRoute(handleGET);
export const POST = lifecycleRoute(handlePOST);
