import { z } from 'zod';
import { requireWorkspace, errorResponse } from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { CreateIntegrationSchema } from '@/lib/integration-contract';
import {
  createIntegrationToken,
  listIntegrationTokens,
  revokeIntegrationToken,
} from '@/lib/server/mcp-access';
import { authEnvironment } from '@/lib/server/auth';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const context = await requireWorkspace(request, 'admin');
    return json({
      tokens: await listIntegrationTokens(context),
      endpoint: authEnvironment().origin + '/api/mcp',
    });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const context = await requireWorkspace(request, 'admin');
    const input = await parseJson(request, CreateIntegrationSchema);
    return json(await createIntegrationToken(context, input), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const context = await requireWorkspace(request, 'admin');
    const { id } = await parseJson(
      request,
      z.object({ id: z.uuid() }).strict(),
    );
    await revokeIntegrationToken(context, id);
    return json({ revoked: true });
  } catch (error) {
    return errorResponse(error);
  }
}
