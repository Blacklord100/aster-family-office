import { lifecycleRoute } from '@/lib/server/lifecycle';
import { requireWorkspace } from '@/lib/server/access';
import { authEnvironment } from '@/lib/server/auth';
import { finishMailboxAuthorization } from '@/lib/server/mailbox-store';
import { MailProviderSchema } from '@/lib/mailbox-contract';
export const runtime = 'nodejs';
async function handleGET(
  request: Request,
  route: { params: Promise<{ provider: string }> },
) {
  let success = false;
  try {
    const provider = MailProviderSchema.parse((await route.params).provider),
      url = new URL(request.url),
      state = url.searchParams.get('state') ?? '',
      code = url.searchParams.get('code') ?? '';
    const match = state.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/,
    );
    if (!match || !code || code.length > 8192 || url.searchParams.has('error'))
      throw new Error('Invalid callback');
    const headers = new Headers(request.headers);
    headers.set('x-aster-organization', match[1]);
    const context = await requireWorkspace(
      new Request(request.url, { headers }),
      'write',
    );
    await finishMailboxAuthorization(context, provider, state, code);
    success = true;
  } catch {
    /* Never log OAuth query strings, provider responses or credentials. */
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location:
        authEnvironment().origin +
        '/?view=connections&mailbox=' +
        (success ? 'connected' : 'error'),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

export const GET = lifecycleRoute(handleGET);
