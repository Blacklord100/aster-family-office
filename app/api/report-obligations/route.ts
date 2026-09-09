import { errorResponse, requireWorkspace } from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { reportObligationsRequestSchema } from '@/lib/report-obligations-api';
import {
  readReportObligations,
  saveReportObligations,
} from '@/lib/server/report-obligations-store';
export async function GET(request: Request) {
  try {
    return json(
      await readReportObligations(await requireWorkspace(request, 'read')),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
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
