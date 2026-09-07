import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { hashPassword } from 'better-auth/crypto';
import { AccessError, type WorkspaceContext } from './access';
import { authEnvironment, passwordPolicyError } from './auth';
import { assertDatabaseRole, pool, withTenant } from './db';
import { audit } from './audit';

export type InvitationRole = 'admin' | 'analyst' | 'viewer';
export interface InvitationInput {
  email: string;
  name: string;
  role: InvitationRole;
}
export interface CreatedInvitation extends InvitationInput {
  id: string;
  expiresAt: string;
  url: string;
}

export function normalizeInvitation(input: InvitationInput): InvitationInput {
  const email =
    typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254 ||
    !name ||
    name.length > 100 ||
    !['admin', 'analyst', 'viewer'].includes(input.role)
  ) {
    throw new AccessError(
      400,
      'INVALID_INVITATION',
      'Provide a valid email, name, and workspace role.',
    );
  }
  return { email, name, role: input.role };
}

const tokenDigest = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** New accounts only. The raw URL is returned once to the authenticated admin. */
export async function createInvitation(
  context: WorkspaceContext,
  input: InvitationInput,
): Promise<CreatedInvitation> {
  const normalized = normalizeInvitation(input);
  const env = authEnvironment();
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await withTenant(context.organizationId, async (client) => {
    await client.query(
      'SELECT id FROM app_organizations WHERE id = $1 FOR KEY SHARE',
      [context.organizationId],
    );
    // Recheck membership at the write, including removal/demotion after access.
    const membership = await client.query<{ role: string }>(
      'SELECT role FROM app_memberships WHERE user_id = $1 AND organization_id = $2 AND revoked_at IS NULL FOR SHARE',
      [context.user.id, context.organizationId],
    );
    const role = membership.rows[0]?.role;
    if (
      !['owner', 'admin'].includes(role ?? '') ||
      (normalized.role === 'admin' && role !== 'owner')
    ) {
      throw new AccessError(
        403,
        'FORBIDDEN',
        'Only an owner may invite administrators. Owners and administrators may invite analysts and viewers.',
      );
    }
    const existing = await client.query(
      'SELECT id FROM auth_user WHERE lower(email) = $1',
      [normalized.email],
    );
    if (existing.rowCount)
      throw new AccessError(
        409,
        'INVITATION_EXISTING_USER',
        'This email already has an account. Linking existing accounts is not available yet.',
      );
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `invite:${context.organizationId}:${normalized.email}`,
    ]);
    // Revocation means an older invitation cannot surprise a later recipient.
    const revoked = await client.query<{ id: string }>(
      'UPDATE auth_invitation SET revoked_at = now() WHERE organization_id = $1 AND email = $2 AND consumed_at IS NULL AND revoked_at IS NULL RETURNING id',
      [context.organizationId, normalized.email],
    );
    for (const prior of revoked.rows)
      await audit(
        client,
        context.organizationId,
        context.user.id,
        'invitation.revoked',
        prior.id,
        { reason: 'reissued' },
      );
    await client.query(
      'INSERT INTO auth_invitation (id, organization_id, email, name, role, token_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        context.organizationId,
        normalized.email,
        normalized.name,
        normalized.role,
        tokenDigest(token),
        context.user.id,
        expiresAt,
      ],
    );
    await audit(
      client,
      context.organizationId,
      context.user.id,
      'invitation.created',
      id,
      { role: normalized.role },
    );
  });
  const url = new URL('/invite', env.origin);
  // Fragments never travel in HTTP request targets or Referer headers.
  url.hash = new URLSearchParams({ token }).toString();
  return { id, ...normalized, expiresAt, url: url.toString() };
}

/** Global fallback bucket is conservative when no trusted proxy supplies IP. */
export async function limitInvitationAttempts(request: Request): Promise<void> {
  await assertDatabaseRole();
  const rawIP =
    request.headers.get(process.env.AUTH_CLIENT_IP_HEADER || 'x-real-ip') || '';
  const address = isIP(rawIP) ? rawIP : 'unknown';
  const key = `invite:${createHash('sha256').update(address).digest('hex')}`;
  const now = Date.now();
  const result = await pool.query<{ count: number }>(
    `INSERT INTO auth_rate_limit (id, key, count, "lastRequest") VALUES ($1,$2,1,$3)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN auth_rate_limit."lastRequest" < $3 - 60000 THEN 1 ELSE auth_rate_limit.count + 1 END,
       "lastRequest" = CASE WHEN auth_rate_limit."lastRequest" < $3 - 60000 THEN $3 ELSE auth_rate_limit."lastRequest" END
     RETURNING count`,
    [randomUUID(), key, now],
  );
  if (result.rows[0].count > 5)
    throw new AccessError(
      429,
      'RATE_LIMITED',
      'Too many attempts. Wait a minute and try again.',
    );
}

export async function acceptInvitation(input: {
  token: string;
  password: string;
}): Promise<{ email: string; name: string; organizationId: string }> {
  if (
    typeof input.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.token)
  )
    throw invalidInvite();
  const policy = passwordPolicyError(input.password);
  if (policy) throw new AccessError(400, 'WEAK_PASSWORD', policy);
  await assertDatabaseRole();
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      id: string;
      organization_id: string;
      email: string;
      name: string;
      role: InvitationRole;
      created_by: string;
    }>(
      `SELECT id, organization_id, email, name, role, created_by FROM auth_invitation
       WHERE token_hash = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
      [tokenDigest(input.token)],
    );
    const invite = result.rows[0];
    if (!invite) throw invalidInvite();
    await client.query("SELECT set_config('app.organization_id', $1, true)", [
      invite.organization_id,
    ]);
    await client.query(
      'SELECT id FROM app_organizations WHERE id = $1 FOR KEY SHARE',
      [invite.organization_id],
    );
    const issuer = await client.query<{ role: string }>(
      'SELECT role FROM app_memberships WHERE user_id = $1 AND organization_id = $2 AND revoked_at IS NULL FOR SHARE',
      [invite.created_by, invite.organization_id],
    );
    const issuerRole = issuer.rows[0]?.role;
    if (
      !['owner', 'admin'].includes(issuerRole ?? '') ||
      (invite.role === 'admin' && issuerRole !== 'owner')
    )
      throw invalidInvite();
    const exists = await client.query(
      'SELECT id FROM auth_user WHERE lower(email) = $1',
      [invite.email],
    );
    // Never overwrite or reset an existing user's credential, even if a user
    // was created between invitation issue and redemption.
    if (exists.rowCount)
      throw new AccessError(
        409,
        'INVITATION_EXISTING_USER',
        'This email already has an account. Ask the owner to link your existing account.',
      );
    const password = await hashPassword(input.password);
    const userId = randomUUID();
    // Possession of the privately delivered link is the enrollment proof;
    // emailVerified does not claim that SMTP delivery was configured.
    await client.query(
      'INSERT INTO auth_user (id, name, email, "emailVerified") VALUES ($1,$2,$3,true)',
      [userId, invite.name, invite.email],
    );
    await client.query(
      'INSERT INTO auth_account (id, "accountId", "providerId", "userId", password) VALUES ($1,$2,\'credential\',$2,$3)',
      [randomUUID(), userId, password],
    );
    await client.query(
      'INSERT INTO app_memberships (user_id, organization_id, role) VALUES ($1,$2,$3)',
      [userId, invite.organization_id, invite.role],
    );
    const consumed = await client.query(
      'UPDATE auth_invitation SET consumed_at = clock_timestamp() WHERE id = $1 AND expires_at > clock_timestamp() RETURNING id',
      [invite.id],
    );
    if (consumed.rowCount !== 1) throw invalidInvite();
    await audit(
      client,
      invite.organization_id,
      userId,
      'invitation.consumed',
      invite.id,
      { role: invite.role },
    );
    await client.query('COMMIT');
    return {
      email: invite.email,
      name: invite.name,
      organizationId: invite.organization_id,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new AccessError(
        409,
        'INVITATION_EXISTING_USER',
        'This email already has an account. Ask the owner to link your existing account.',
      );
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

function invalidInvite() {
  return new AccessError(
    400,
    'INVALID_INVITATION',
    'This invitation is invalid, expired, revoked, or already used. Ask the owner for a new link.',
  );
}
