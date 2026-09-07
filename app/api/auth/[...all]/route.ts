import { auth } from '@/lib/server/auth';
import { errorResponse } from '@/lib/server/access';
import { assertDatabaseRole } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  try {
    await assertDatabaseRole();
    const response = await auth.handler(request);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const POST = handle;
