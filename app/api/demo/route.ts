import { z } from 'zod';
import { NextResponse } from 'next/server';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
  assertSameOrigin,
  clearStaleWorkspaceCookie,
} from '@/lib/server/access';
import { createDemoRun, listDemoRuns } from '@/lib/server/demo-workspace';
import { auth, authEnvironment } from '@/lib/server/auth';
import { parseJson } from '@/lib/server/http';
import { DEMO_DATASETS } from '@/lib/demo-contract';
const actionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      dataset: z.enum(DEMO_DATASETS).default('mailroom-v1'),
    })
    .strict(),
  z.object({ action: z.literal('leave') }).strict(),
  z.object({ action: z.literal('select'), organizationId: z.uuid() }).strict(),
]);
export async function GET(request: Request) {
  try {
    const context = await requireWorkspace(request);
    return clearStaleWorkspaceCookie(
      NextResponse.json(await listDemoRuns(context), {
        headers: { 'Cache-Control': 'private, no-store' },
      }),
      context,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = await parseJson(request, actionSchema);
    let organizationId = '';
    let result: Record<string, unknown> = { ok: true };
    if (input.action === 'leave') {
      // Clearing a stale selector must work after a demo membership is removed.
      const session = await auth.api.getSession({
        headers: request.headers,
        query: { disableCookieCache: true },
      });
      if (!session)
        throw new AccessError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    } else {
      const ctx = await requireWorkspace(request, 'admin');
      if (input.action === 'start') {
        result = await createDemoRun(ctx, input.dataset);
        organizationId = result.organizationId as string;
      } else {
        if (
          !(await listDemoRuns(ctx)).runs.some(
            (run) => run.organizationId === input.organizationId,
          )
        )
          throw new AccessError(404, 'NOT_FOUND', 'Demo workspace not found.');
        organizationId = input.organizationId;
      }
    }
    const response = NextResponse.json(result, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
    response.cookies.set('aster_workspace', organizationId, {
      httpOnly: true,
      sameSite: 'strict',
      secure: new URL(authEnvironment().origin).protocol === 'https:',
      path: '/',
      maxAge: organizationId ? 60 * 60 * 24 * 30 : 0,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
