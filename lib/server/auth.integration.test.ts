import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { assertDisposableDatabase } from '../test-support/disposable-database';

vi.mock('server-only', () => ({}));

// Explicit opt-in: use a migrated disposable database and restricted runtime
// role. No live accounts, inboxes, or outgoing email are used by these tests.
const databaseURL = process.env.AUTH_TEST_DATABASE_URL;
const adminURL = process.env.AUTH_TEST_ADMIN_URL;
const suite = databaseURL && adminURL ? describe : describe.skip;
const origin = 'https://auth-test.aster.invalid';
const prefix = `auth-test-${randomUUID()}`;
const email = `${prefix}@example.invalid`;
const password = `Test fixture passphrase ${randomUUID()}`;
const ownerId = randomUUID();
const organizationId = randomUUID();
let auth: typeof import('./auth').auth;
let pool: typeof import('./db').pool;
let admin: Pool;
let access: typeof import('./access');
let invitations: typeof import('./invitations');
let requestIndex = 0;
const createdEmails: string[] = [email];

class BrowserSession {
  cookies = new Map<string, string>();
  headers() {
    return new Headers({
      origin,
      cookie: [...this.cookies]
        .map(([key, value]) => `${key}=${value}`)
        .join('; '),
    });
  }
  async call(path: string, body?: unknown) {
    const headers = this.headers();
    headers.set('x-real-ip', `192.0.2.${(++requestIndex % 240) + 1}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const setCookies = response.headers.getSetCookie();
    for (const cookie of setCookies) {
      const first = cookie.split(';')[0];
      const equal = first.indexOf('=');
      const name = first.slice(0, equal);
      if (/max-age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, first.slice(equal + 1));
    }
    return { response, body: await response.json(), setCookies };
  }
  workspaceRequest() {
    return new Request(`${origin}/api/workspace`, { headers: this.headers() });
  }
}

suite('real PostgreSQL Better Auth integration', () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', databaseURL!);
    vi.stubEnv('MIGRATION_DATABASE_URL', adminURL!);
    assertDisposableDatabase();
    vi.stubEnv('BETTER_AUTH_URL', origin);
    vi.stubEnv(
      'BETTER_AUTH_SECRET',
      `Only-a-local-integration-test-secret-${randomUUID()}`,
    );
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_CLIENT_IP_HEADER', 'x-real-ip');
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    admin = new Pool({ connectionString: adminURL!, max: 1 });
    ({ pool } = await import('./db'));
    ({ auth } = await import('./auth'));
    access = await import('./access');
    invitations = await import('./invitations');
    await pool.query(
      'INSERT INTO auth_user (id,name,email,"emailVerified") VALUES ($1,\'Integration Owner\',$2,true)',
      [ownerId, email],
    );
    await pool.query(
      'INSERT INTO auth_account (id,"accountId","providerId","userId",password) VALUES ($1,$2,\'credential\',$2,$3)',
      [randomUUID(), ownerId, await hashPassword(password)],
    );
    await pool.query(
      "INSERT INTO app_organizations (id,name) VALUES ($1,'Disposable authentication integration')",
      [organizationId],
    );
    await pool.query(
      "INSERT INTO app_memberships (user_id,organization_id,role) VALUES ($1,$2,'owner')",
      [ownerId, organizationId],
    );
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM app_audit WHERE organization_id = $1', [
        organizationId,
      ]);
      await admin.query(
        'DELETE FROM auth_invitation WHERE organization_id = $1',
        [organizationId],
      );
      await admin.query(
        'DELETE FROM app_memberships WHERE organization_id = $1',
        [organizationId],
      );
      await admin.query('DELETE FROM app_organizations WHERE id = $1', [
        organizationId,
      ]);
      await admin.query('DELETE FROM auth_user WHERE email = ANY($1::text[])', [
        createdEmails,
      ]);
      await admin.end();
    }
    if (pool) await pool.end();
    vi.unstubAllEnvs();
  });

  it('keeps authenticated and expired-session GETs read-only during sealed maintenance', async () => {
    const browser = new BrowserSession();
    const signed = await browser.call('/sign-in/email', { email, password });
    expect(signed.response.status).toBe(200);
    const { controlLifecycle } = await import('./lifecycle-control');
    const { GET } = await import('../../app/api/auth/[...all]/route');
    const c = await admin.connect();
    try {
      await controlLifecycle(c, { action: 'drain', expectedGeneration: 1 });
      await controlLifecycle(c, { action: 'seal', expectedGeneration: 1 });
      const before = (
        await c.query('SELECT count(*)::int AS count FROM auth_rate_limit')
      ).rows[0].count;
      const valid = await GET(
        new Request(origin + '/api/auth/get-session', {
          headers: browser.headers(),
        }),
      );
      expect(valid.status).toBe(200);
      expect((await valid.json()).user.id).toBe(ownerId);
      await c.query(
        `UPDATE auth_session SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE "userId"=$1`,
        [ownerId],
      );
      const sessions = (
        await c.query(
          'SELECT count(*)::int AS count FROM auth_session WHERE "userId"=$1',
          [ownerId],
        )
      ).rows[0].count;
      const expired = await GET(
        new Request(origin + '/api/auth/get-session', {
          headers: browser.headers(),
        }),
      );
      expect(expired.status).toBe(200);
      expect(await expired.json()).toBeNull();
      expect(
        (
          await c.query(
            'SELECT count(*)::int AS count FROM auth_session WHERE "userId"=$1',
            [ownerId],
          )
        ).rows[0].count,
      ).toBe(sessions);
      expect(
        (await c.query('SELECT count(*)::int AS count FROM auth_rate_limit'))
          .rows[0].count,
      ).toBe(before);
    } finally {
      await controlLifecycle(c, {
        action: 'resume',
        release: 'legacy',
        expectedGeneration: 1,
      });
      c.release();
    }
  });

  it('keeps public signup closed and rejects cross-origin login', async () => {
    const response = await new BrowserSession().call('/sign-up/email', {
      email: `new-${email}`,
      name: 'New User',
      password,
    });
    expect(response.response.status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await pool.query('SELECT id FROM auth_user WHERE email = $1', [
          `new-${email}`,
        ])
      ).rowCount,
    ).toBe(0);
    const crossOrigin = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.invalid',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
  });

  it('enforces MFA per session, verifies TOTP and backup code, expires and revokes sessions', async () => {
    const browser = new BrowserSession();
    const signIn = await browser.call('/sign-in/email', { email, password });
    expect(signIn.response.status).toBe(200);
    const sessionCookie = signIn.setCookies.find((cookie) =>
      cookie.includes('session_token='),
    );
    expect(sessionCookie).toMatch(/httponly/i);
    expect(sessionCookie).toMatch(/secure/i);
    expect(sessionCookie).toMatch(/samesite=lax/i);
    await expect(
      access.requireWorkspace(browser.workspaceRequest()),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    const before = await auth.api.getSession({ headers: browser.headers() });
    expect(before?.session.mfaVerifiedAt).toBeFalsy();
    expect(
      before!.session.expiresAt.getTime() - before!.session.createdAt.getTime(),
    ).toBeLessThanOrEqual(8 * 60 * 60 * 1000 + 1000);

    const enrollment = await browser.call('/two-factor/enable', {
      password,
      method: 'totp',
    });
    expect(enrollment.response.status).toBe(200);
    expect(enrollment.body.backupCodes).toHaveLength(10);
    const secret = new URL(enrollment.body.totpURI).searchParams.get('secret')!;
    const { base32 } = await import('@better-auth/utils/base32');
    const decoded = new TextDecoder().decode(base32.decode(secret));
    const code = await createOTP(decoded).totp();
    const verified = await browser.call('/two-factor/verify-totp', { code });
    expect(verified.response.status).toBe(200);
    const context = await access.requireWorkspace(browser.workspaceRequest());
    expect(context.organizationId).toBe(organizationId);
    expect(
      (await auth.api.getSession({ headers: browser.headers() }))!.session
        .mfaVerifiedAt,
    ).toBeTruthy();

    await pool.query(
      'UPDATE app_memberships SET revoked_at = now() WHERE user_id = $1 AND organization_id = $2',
      [ownerId, organizationId],
    );
    try {
      // Membership revocation is effective without depending on cookie or
      // session cleanup, including an explicit workspace selection.
      expect(
        await auth.api.getSession({ headers: browser.headers() }),
      ).not.toBeNull();
      await expect(
        access.requireWorkspace(browser.workspaceRequest()),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const selectedRequest = browser.workspaceRequest();
      selectedRequest.headers.set('x-aster-organization', organizationId);
      await expect(
        access.requireWorkspace(selectedRequest),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await pool.query(
        'UPDATE app_memberships SET revoked_at = NULL WHERE user_id = $1 AND organization_id = $2',
        [ownerId, organizationId],
      );
    }
    expect(
      (await access.requireWorkspace(browser.workspaceRequest())).user.id,
    ).toBe(ownerId);

    const second = new BrowserSession();
    const challenge = await second.call('/sign-in/email', { email, password });
    expect(challenge.body.twoFactorRedirect).toBe(true);
    expect(await auth.api.getSession({ headers: second.headers() })).toBeNull();
    const denied = await second.call('/two-factor/verify-totp', {
      code: 'not-a-code',
    });
    expect(denied.response.status).toBeGreaterThanOrEqual(400);
    expect(await auth.api.getSession({ headers: second.headers() })).toBeNull();
    const recovery = await second.call('/two-factor/verify-backup-code', {
      code: enrollment.body.backupCodes[0],
    });
    expect(recovery.response.status).toBe(200);
    expect(
      (await access.requireWorkspace(second.workspaceRequest())).user.id,
    ).toBe(ownerId);
    const trust = await second.call('/two-factor/verify-totp', {
      code,
      trustDevice: true,
    });
    expect(trust.body.code).toBe('MFA_TRUST_DISABLED');

    const current = await auth.api.getSession({ headers: browser.headers() });
    await pool.query(
      'UPDATE auth_session SET "expiresAt" = now() - interval \'1 second\' WHERE id = $1',
      [current!.session.id],
    );
    expect(
      await auth.api.getSession({ headers: browser.headers() }),
    ).toBeNull();
    const other = new BrowserSession();
    await other.call('/sign-in/email', { email, password });
    await other.call('/two-factor/verify-totp', { code });
    expect(
      await auth.api.getSession({ headers: other.headers() }),
    ).not.toBeNull();
    const changed = await second.call('/change-password', {
      currentPassword: password,
      newPassword: `${password} renewed`,
      revokeOtherSessions: false,
    });
    expect(changed.response.status).toBe(200);
    // Server enforcement overrides a caller attempting to retain old sessions.
    expect(await auth.api.getSession({ headers: other.headers() })).toBeNull();
    await expect(
      access.requireWorkspace(second.workspaceRequest()),
    ).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    expect(
      (await second.call('/two-factor/verify-totp', { code })).response.status,
    ).toBe(200);
    expect(
      (await access.requireWorkspace(second.workspaceRequest())).user.id,
    ).toBe(ownerId);
    const token = (await auth.api.getSession({ headers: second.headers() }))!
      .session.token;
    const revoked = await second.call('/revoke-session', { token });
    expect(revoked.response.status).toBe(200);
    expect(await auth.api.getSession({ headers: second.headers() })).toBeNull();
  }, 30_000);

  it('consumes an invitation atomically and never changes an existing account', async () => {
    const invitedEmail = `invite-${prefix}@example.invalid`;
    createdEmails.push(invitedEmail);
    const context = {
      user: { id: ownerId, email, name: 'Owner' },
      organizationId,
      role: 'owner' as const,
      sessionId: 'server-context-fixture',
    };
    const previous = await invitations.createInvitation(context, {
      email: invitedEmail,
      name: 'Invited Analyst',
      role: 'analyst',
    });
    const invitation = await invitations.createInvitation(context, {
      email: invitedEmail,
      name: 'Invited Analyst',
      role: 'analyst',
    });
    const token = new URLSearchParams(
      new URL(invitation.url).hash.slice(1),
    ).get('token')!;
    const stored = await pool.query(
      'SELECT token_hash FROM auth_invitation WHERE id = $1',
      [invitation.id],
    );
    expect(stored.rows[0].token_hash).not.toBe(token);
    await pool.query(
      'UPDATE app_memberships SET revoked_at = now() WHERE user_id = $1 AND organization_id = $2',
      [ownerId, organizationId],
    );
    try {
      await expect(
        invitations.createInvitation(context, {
          email: `revoked-${prefix}@example.invalid`,
          name: 'Not Created',
          role: 'viewer',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        invitations.acceptInvitation({ token, password }),
      ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    } finally {
      await pool.query(
        'UPDATE app_memberships SET revoked_at = NULL WHERE user_id = $1 AND organization_id = $2',
        [ownerId, organizationId],
      );
    }
    await expect(
      invitations.acceptInvitation({
        token: new URLSearchParams(new URL(previous.url).hash.slice(1)).get(
          'token',
        )!,
        password,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    const results = await Promise.allSettled([
      invitations.acceptInvitation({ token, password }),
      invitations.acceptInvitation({ token, password }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const membership = await pool.query(
      'SELECT role FROM app_memberships m JOIN auth_user u ON u.id = m.user_id WHERE u.email = $1 AND organization_id = $2',
      [invitedEmail, organizationId],
    );
    expect(membership.rows).toEqual([{ role: 'analyst' }]);
    const auditRows = await admin.query(
      'SELECT action, details FROM app_audit WHERE organization_id = $1 ORDER BY sequence',
      [organizationId],
    );
    expect(auditRows.rows.map((row) => row.action)).toEqual([
      'invitation.created',
      'invitation.revoked',
      'invitation.created',
      'invitation.consumed',
    ]);
    expect(JSON.stringify(auditRows.rows)).not.toContain(token);
    await expect(
      invitations.createInvitation(context, {
        email: invitedEmail,
        name: 'Other',
        role: 'viewer',
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_EXISTING_USER' });
    const login = await new BrowserSession().call('/sign-in/email', {
      email: invitedEmail,
      password,
    });
    expect(login.response.status).toBe(200);
  }, 30_000);

  it('uses database-backed limits on repeated HTTP sign-in attempts', async () => {
    const statuses: number[] = [];
    const rateIP = `2001:db8:${randomUUID().slice(0, 4)}::1`;
    for (let i = 0; i < 6; i++) {
      const response = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-real-ip': rateIP,
          },
          body: JSON.stringify({
            email: `missing-${prefix}@example.invalid`,
            password,
          }),
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM auth_rate_limit'))
        .rows[0].count,
    ).toBeGreaterThan(0);
  }, 30_000);
});
