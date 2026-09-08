import { z } from 'zod';
import {
  requireWorkspace,
  errorResponse,
  AccessError,
} from '@/lib/server/access';
import { json, parseJson } from '@/lib/server/http';
import { updateMailbox } from '@/lib/server/mailbox-store';
import { MailboxActionSchema } from '@/lib/mailbox-contract';
export const runtime = 'nodejs';
export async function PATCH(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    const context = await requireWorkspace(request, 'write');
    const { id } = await route.params;
    if (!z.uuid().safeParse(id).success)
      throw new AccessError(400, 'INVALID_ID', 'Choose a valid mailbox.');
    return json(
      await updateMailbox(
        context,
        id,
        (await parseJson(request, MailboxActionSchema)).action,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
