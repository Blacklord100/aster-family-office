import {
  AccessError,
  assertSameOrigin,
  errorResponse,
} from '@/lib/server/access';
import {
  acceptInvitation,
  limitInvitationAttempts,
} from '@/lib/server/invitations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public, token-authorized redemption. Creation belongs to the admin API. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    if (
      request.headers
        .get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase() !== 'application/json'
    ) {
      throw new AccessError(
        415,
        'JSON_REQUIRED',
        'Send this request as application/json.',
      );
    }
    await limitInvitationAttempts(request);
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2048) {
            await reader.cancel();
            throw new AccessError(
              413,
              'BODY_TOO_LARGE',
              'The request is too large.',
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new AccessError(400, 'INVALID_JSON', 'Send a valid JSON request.');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      !('token' in body) ||
      !('password' in body) ||
      typeof body.token !== 'string' ||
      typeof body.password !== 'string'
    ) {
      throw new AccessError(
        400,
        'INVALID_INVITATION',
        'Provide the invitation token and a new password.',
      );
    }
    const result = await acceptInvitation({
      token: body.token,
      password: body.password,
    });
    return Response.json(
      { ok: true, email: result.email },
      { status: 201, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
