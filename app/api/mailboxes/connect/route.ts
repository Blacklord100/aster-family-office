import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { startMailboxAuthorization } from '@/lib/server/mailbox-store';
import { MailboxConnectSchema } from '@/lib/mailbox-contract';
import { MailboxError } from '@/lib/server/mailbox-provider';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const context = await requireWorkspace(request, 'write');
    return json(
      await startMailboxAuthorization(
        context,
        await parseJson(request, MailboxConnectSchema),
      ),
    );
  } catch (error) {
    return errorResponse(
      error instanceof MailboxError
        ? new AccessError(
            409,
            error.code,
            'Provider setup is required before this account can connect.',
          )
        : error,
    );
  }
}
