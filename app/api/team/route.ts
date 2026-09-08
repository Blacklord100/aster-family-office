import { z } from 'zod';
import {
  requireWorkspace,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { createInvitation } from '@/lib/server/invitations';
import { audit } from '@/lib/server/audit';
import { parseJson, json } from '@/lib/server/http';
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    return await withTenant(ctx.organizationId, async (c) => {
      const members = await c.query(
        'SELECT u.id,u.name,u.email,u."twoFactorEnabled" AS "mfaEnabled",m.role,m.revoked_at AS "revokedAt",m.created_at AS "joinedAt" FROM app_memberships m JOIN auth_user u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.created_at',
        [ctx.organizationId],
      );
      const invites = await c.query(
        'SELECT id,email,name,role,expires_at AS "expiresAt",consumed_at AS "acceptedAt",revoked_at AS "revokedAt" FROM auth_invitation WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100',
        [ctx.organizationId],
      );
      return json({
        members: members.rows,
        invitations: invites.rows,
        role: ctx.role,
        userId: ctx.user.id,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin'),
      input = await parseJson(
        request,
        z
          .object({
            email: z.email().max(254),
            name: z.string().trim().min(2).max(100),
            role: z.enum(['admin', 'analyst', 'viewer']),
          })
          .strict(),
      );
    const invitation = await createInvitation(ctx, input);
    return json({ invitation }, 201);
  } catch (e) {
    return errorResponse(e);
  }
}
export async function PATCH(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin'),
      input = await parseJson(
        request,
        z
          .object({
            userId: z.string().min(1).max(200),
            action: z.enum(['role', 'remove', 'restore']),
            role: z.enum(['admin', 'analyst', 'viewer']).optional(),
          })
          .strict(),
      );
    return await withTenant(ctx.organizationId, async (c) => {
      await c.query('SELECT id FROM app_organizations WHERE id=$1 FOR UPDATE', [
        ctx.organizationId,
      ]);
      const member = (
        await c.query(
          'SELECT role FROM app_memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE',
          [ctx.organizationId, input.userId],
        )
      ).rows[0];
      if (!member)
        throw new AccessError(404, 'MEMBER_NOT_FOUND', 'Member not found.');
      if (
        input.userId === ctx.user.id ||
        member.role === 'owner' ||
        (ctx.role !== 'owner' &&
          (member.role === 'admin' || input.role === 'admin'))
      )
        throw new AccessError(
          403,
          'PROTECTED_ROLE',
          'Only an owner can manage administrators. Owners cannot be removed or demoted here.',
        );
      if (input.action === 'remove')
        await c.query(
          'UPDATE app_memberships SET revoked_at=now() WHERE organization_id=$1 AND user_id=$2',
          [ctx.organizationId, input.userId],
        );
      else if (input.action === 'restore')
        await c.query(
          'UPDATE app_memberships SET revoked_at=NULL WHERE organization_id=$1 AND user_id=$2',
          [ctx.organizationId, input.userId],
        );
      else {
        if (!input.role)
          throw new AccessError(400, 'ROLE_REQUIRED', 'Choose a role.');
        await c.query(
          "UPDATE app_memberships SET role=$3,data_scope=CASE WHEN $3='viewer' THEN data_scope ELSE NULL END WHERE organization_id=$1 AND user_id=$2",
          [ctx.organizationId, input.userId, input.role],
        );
      }
      await c.query('DELETE FROM auth_session WHERE "userId"=$1', [
        input.userId,
      ]);
      if (input.action !== 'restore') {
        await c.query(
          'UPDATE app_integration_tokens SET revoked_at=now() WHERE organization_id=$1 AND created_by=$2 AND revoked_at IS NULL',
          [ctx.organizationId, input.userId],
        );
      }
      if (input.action === 'remove' || input.role === 'viewer') {
        await c.query(
          "UPDATE app_mailboxes SET status='paused',generation=generation+1,updated_at=now() WHERE organization_id=$1 AND connected_by=$2 AND status<>'disconnected'",
          [ctx.organizationId, input.userId],
        );
        await c.query(
          'DELETE FROM app_mailbox_queue WHERE organization_id=$1 AND id IN (SELECT id FROM app_mailboxes WHERE organization_id=$1 AND connected_by=$2)',
          [ctx.organizationId, input.userId],
        );
      }
      await audit(
        c,
        ctx.organizationId,
        ctx.user.id,
        'team.' + input.action,
        input.userId,
        { role: input.role ?? member.role },
      );
      return json({ ok: true });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
