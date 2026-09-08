import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { withTenant } from './db';
import { sha256 } from './crypto';
import { audit, rateLimit } from './audit';
import { AccessError, type WorkspaceContext } from './access';
import { authEnvironment } from './auth';
import {
  CreateIntegrationSchema,
  type IntegrationScope,
  type IntegrationTokenInfo,
} from '../integration-contract';
import type { z } from 'zod';

export type McpPrincipal = {
  organizationId: string;
  userId: string;
  tokenId: string;
  scopes: IntegrationScope[];
};
const invalidToken = () =>
  new AccessError(
    401,
    'INVALID_TOKEN',
    'Provide an active Aster access token.',
  );
export function parseIntegrationToken(value: string | null): {
  organizationId: string;
  hash: string;
} {
  const match = value?.match(
    /^Bearer (aster_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43})$/,
  );
  if (!match || match[0] !== value) throw invalidToken();
  return { organizationId: match[2], hash: sha256(match[1]) };
}
export function assertMcpOrigin(request: Request) {
  const canonical = new URL(authEnvironment().origin);
  const origin = request.headers.get('origin');
  if (
    request.headers.get('host') !== canonical.host ||
    (origin && origin !== canonical.origin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    throw new AccessError(
      403,
      'INVALID_ORIGIN',
      'Use the configured Aster endpoint.',
    );
  }
  if (new URL(request.url).search)
    throw new AccessError(
      400,
      'INVALID_REQUEST',
      'Access tokens belong in the Authorization header.',
    );
}
export async function requireMcpAccess(
  request: Request,
): Promise<McpPrincipal> {
  assertMcpOrigin(request);
  const { organizationId, hash } = parseIntegrationToken(
    request.headers.get('authorization'),
  );
  return withTenant(organizationId, async (client) => {
    const result = await client.query<{
      id: string;
      created_by: string;
      scopes: IntegrationScope[];
    }>(
      `SELECT t.id,t.created_by,t.scopes FROM app_integration_tokens t
       JOIN app_memberships m ON m.organization_id=t.organization_id AND m.user_id=t.created_by
       JOIN auth_user u ON u.id=t.created_by
       WHERE t.organization_id=$1 AND t.token_hash=$2 AND t.revoked_at IS NULL AND t.expires_at>now()
       AND m.revoked_at IS NULL AND m.role IN ('owner','admin') AND u."twoFactorEnabled"=true`,
      [organizationId, hash],
    );
    const token = result.rows[0];
    if (!token) throw invalidToken();
    if (!(await rateLimit(client, 'mcp:' + token.id, 120, 60)))
      throw new AccessError(
        429,
        'RATE_LIMIT',
        'Please wait before sending more requests.',
      );
    await client.query(
      'UPDATE app_integration_tokens SET last_used_at=now() WHERE id=$1',
      [token.id],
    );
    return {
      organizationId,
      userId: token.created_by,
      tokenId: token.id,
      scopes: token.scopes,
    };
  });
}
export async function listIntegrationTokens(
  context: WorkspaceContext,
): Promise<IntegrationTokenInfo[]> {
  return withTenant(
    context.organizationId,
    async (client) =>
      (
        await client.query<IntegrationTokenInfo>(
          `SELECT id,name,scopes,created_at AS "createdAt",expires_at AS "expiresAt",last_used_at AS "lastUsedAt",revoked_at AS "revokedAt"
     FROM app_integration_tokens WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100`,
          [context.organizationId],
        )
      ).rows,
  );
}
export async function createIntegrationToken(
  context: WorkspaceContext,
  input: z.infer<typeof CreateIntegrationSchema>,
) {
  return withTenant(context.organizationId, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      context.organizationId,
    ]);
    const mfa = await client.query(
      'SELECT 1 FROM auth_user WHERE id=$1 AND "twoFactorEnabled"=true',
      [context.user.id],
    );
    if (!mfa.rowCount)
      throw new AccessError(
        403,
        'MFA_REQUIRED',
        'Enroll your authenticator before creating access tokens.',
      );
    const count = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM app_integration_tokens WHERE organization_id=$1 AND revoked_at IS NULL AND expires_at>now()',
      [context.organizationId],
    );
    if (count.rows[0].count >= 10)
      throw new AccessError(
        409,
        'TOKEN_LIMIT',
        'Revoke an unused token before creating another.',
      );
    const id = randomUUID(),
      token =
        'aster_' +
        context.organizationId +
        '.' +
        randomBytes(32).toString('base64url');
    await client.query(
      "INSERT INTO app_integration_tokens(id,organization_id,created_by,name,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 day')",
      [
        id,
        context.organizationId,
        context.user.id,
        input.name,
        sha256(token),
        input.scopes,
        input.expiresInDays,
      ],
    );
    await audit(
      client,
      context.organizationId,
      context.user.id,
      'integration.token.create',
      id,
      {
        name: input.name,
        scopes: input.scopes.join(','),
        expiresInDays: input.expiresInDays,
      },
    );
    return { id, token };
  });
}
export async function revokeIntegrationToken(
  context: WorkspaceContext,
  id: string,
) {
  return withTenant(context.organizationId, async (client) => {
    const result = await client.query(
      'UPDATE app_integration_tokens SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL RETURNING id',
      [id, context.organizationId],
    );
    if (!result.rowCount)
      throw new AccessError(
        404,
        'NOT_FOUND',
        'This active token was not found.',
      );
    await audit(
      client,
      context.organizationId,
      context.user.id,
      'integration.token.revoke',
      id,
    );
  });
}
