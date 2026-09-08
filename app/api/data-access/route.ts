import { z } from 'zod';
import { DataScopeSchema } from '@/lib/data-scope';
import {
  requireWorkspace,
  AccessError,
  errorResponse,
} from '@/lib/server/access';
import { withTenant } from '@/lib/server/db';
import { readWorkspaceInTransaction } from '@/lib/workspace-store';
import { deriveWorkspace } from '@/lib/workspace';
import { audit } from '@/lib/server/audit';
import { parseJson, json } from '@/lib/server/http';
const command = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('member'),
      userId: z.string().min(1).max(200),
      scope: DataScopeSchema.nullable(),
      expectedScope: DataScopeSchema.nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('document'),
      documentId: z.uuid(),
      scope: DataScopeSchema.nullable(),
      evidenceVerified: z.literal(true),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin');
    return await withTenant(ctx.organizationId, async (c) => {
      const { state } = await readWorkspaceInTransaction(c, ctx.organizationId);
      const data = deriveWorkspace(state);
      const members = await c.query(
        'SELECT u.id,u.name,m.role,m.data_scope AS scope FROM app_memberships m JOIN auth_user u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.revoked_at IS NULL ORDER BY u.name',
        [ctx.organizationId],
      );
      const documents = await c.query(
        'SELECT d.id,d.filename,a.family_ids AS "familyIds",a.entity_ids AS "entityIds",a.reviewed_at AS "reviewedAt" FROM app_documents d LEFT JOIN app_document_access a ON a.document_id=d.id AND a.organization_id=d.organization_id WHERE d.organization_id=$1 ORDER BY d.created_at DESC LIMIT 100',
        [ctx.organizationId],
      );
      return json({
        members: members.rows,
        families: data.families.map(({ id, name }) => ({ id, name })),
        entities: data.entities.map(({ id, name, familyId }) => ({
          id,
          name,
          familyId,
        })),
        documents: documents.rows,
        documentLimit: 100,
      });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const ctx = await requireWorkspace(request, 'admin'),
      input = await parseJson(request, command);
    return await withTenant(ctx.organizationId, async (c) => {
      const { state } = await readWorkspaceInTransaction(
          c,
          ctx.organizationId,
          true,
        ),
        data = deriveWorkspace(state);
      if (input.scope) {
        if (
          !input.scope.familyIds.every((id) =>
            data.families.some((f) => f.id === id),
          ) ||
          (input.scope.entityIds ?? []).some(
            (id) =>
              !data.entities.some(
                (e) =>
                  e.id === id && input.scope!.familyIds.includes(e.familyId),
              ),
          )
        )
          throw new AccessError(
            400,
            'INVALID_SCOPE',
            'Select families and entities in this workspace.',
          );
      }
      if (input.action === 'member') {
        const row = (
          await c.query(
            'SELECT role,data_scope FROM app_memberships WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE',
            [ctx.organizationId, input.userId],
          )
        ).rows[0];
        if (!row || row.role !== 'viewer' || input.userId === ctx.user.id)
          throw new AccessError(
            400,
            'VIEWER_REQUIRED',
            'Set a read-only viewer role before assigning client access.',
          );
        const updated = await c.query(
          'UPDATE app_memberships SET data_scope=$3::jsonb WHERE organization_id=$1 AND user_id=$2 AND data_scope IS NOT DISTINCT FROM $4::jsonb RETURNING user_id',
          [
            ctx.organizationId,
            input.userId,
            input.scope ? JSON.stringify(input.scope) : null,
            input.expectedScope ? JSON.stringify(input.expectedScope) : null,
          ],
        );
        if (!updated.rowCount)
          throw new AccessError(
            409,
            'SCOPE_CHANGED',
            'This access rule changed. Reload and review it.',
          );
        await c.query('DELETE FROM auth_session WHERE "userId"=$1', [
          input.userId,
        ]);
        await audit(
          c,
          ctx.organizationId,
          ctx.user.id,
          'access.scope.changed',
          input.userId,
          {
            restricted: !!input.scope,
            families: input.scope?.familyIds.length ?? 0,
            entities: input.scope?.entityIds?.length ?? 0,
          },
        );
      } else {
        if (
          !(
            await c.query(
              'SELECT 1 FROM app_documents WHERE id=$1 AND organization_id=$2',
              [input.documentId, ctx.organizationId],
            )
          ).rowCount
        )
          throw new AccessError(404, 'NOT_FOUND', 'Document not found.');
        if (input.scope) {
          const inspected = await c.query(
            "SELECT 1 FROM app_audit WHERE organization_id=$1 AND actor_id=$2 AND resource_id=$3 AND action IN ('document.downloaded','document.previewed') LIMIT 1",
            [ctx.organizationId, ctx.user.id, input.documentId],
          );
          if (!inspected.rowCount)
            throw new AccessError(
              409,
              'REVIEW_ORIGINAL',
              'Open the entire original document before releasing it to client viewers.',
            );
          await c.query(
            'INSERT INTO app_document_access(organization_id,document_id,family_ids,entity_ids,reviewed_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,document_id) DO UPDATE SET family_ids=EXCLUDED.family_ids,entity_ids=EXCLUDED.entity_ids,reviewed_by=EXCLUDED.reviewed_by,reviewed_at=now()',
            [
              ctx.organizationId,
              input.documentId,
              input.scope.familyIds,
              input.scope.entityIds ?? [],
              ctx.user.id,
            ],
          );
        } else
          await c.query(
            'DELETE FROM app_document_access WHERE organization_id=$1 AND document_id=$2',
            [ctx.organizationId, input.documentId],
          );
        await audit(
          c,
          ctx.organizationId,
          ctx.user.id,
          'access.document.reviewed',
          input.documentId,
          {
            released: !!input.scope,
            families: input.scope?.familyIds.length ?? 0,
          },
        );
      }
      return json({ ok: true });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
