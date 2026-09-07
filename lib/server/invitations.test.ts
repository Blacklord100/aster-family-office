import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  hashPassword: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./audit', () => ({ audit: vi.fn() }));
vi.mock('better-auth/crypto', () => ({ hashPassword: mocked.hashPassword }));
vi.mock('./db', () => ({
  pool: { query: mocked.query, connect: mocked.connect },
  assertDatabaseRole: vi.fn(),
  withTenant: async (_org: string, fn: (client: unknown) => unknown) =>
    fn({ query: mocked.query }),
  isOrganizationId: () => true,
}));
import {
  acceptInvitation,
  createInvitation,
  normalizeInvitation,
} from './invitations';

const context = {
  user: { id: 'owner-1', email: 'owner@example.com', name: 'Owner' },
  organizationId: '11111111-1111-4111-8111-111111111111',
  role: 'owner' as const,
  sessionId: 'session-1',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('BETTER_AUTH_URL', 'https://aster.example.com');
  vi.stubEnv(
    'BETTER_AUTH_SECRET',
    'Test-only-invitation-environment-secret-3821964',
  );
  mocked.connect.mockResolvedValue({
    query: mocked.query,
    release: mocked.release,
  });
  mocked.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mocked.hashPassword.mockResolvedValue('library-password-hash');
});

describe('invitation authorization', () => {
  it('normalizes email and rejects unsupported owner elevation', () => {
    expect(
      normalizeInvitation({
        email: ' Analyst@Example.com ',
        name: ' Analyst ',
        role: 'analyst',
      }),
    ).toEqual({
      email: 'analyst@example.com',
      name: 'Analyst',
      role: 'analyst',
    });
    expect(() =>
      normalizeInvitation({
        email: 'a@example.com',
        name: 'A',
        role: 'owner' as 'admin',
      }),
    ).toThrow();
  });
  it('rechecks administrator rights rather than trusting an old context', async () => {
    mocked.query.mockResolvedValue({ rows: [{ role: 'viewer' }] });
    await expect(
      createInvitation(context, {
        email: 'a@example.com',
        name: 'A',
        role: 'analyst',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(
      mocked.query.mock.calls.some(([sql]) => sql.startsWith('INSERT')),
    ).toBe(false);
  });
  it('prevents an admin from granting admin even if caller input requests it', async () => {
    mocked.query.mockResolvedValue({ rows: [{ role: 'admin' }] });
    await expect(
      createInvitation(context, {
        email: 'a@example.com',
        name: 'A',
        role: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('does not offer a replacement credential to an existing user', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM app_memberships'))
        return { rows: [{ role: 'owner' }] };
      if (sql.includes('FROM auth_user'))
        return { rows: [{ id: 'existing' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(
      createInvitation(context, {
        email: 'a@example.com',
        name: 'A',
        role: 'analyst',
      }),
    ).rejects.toMatchObject({ code: 'INVITATION_EXISTING_USER' });
    expect(
      mocked.query.mock.calls.some(([sql]) => sql.startsWith('INSERT')),
    ).toBe(false);
  });
  it('does no password hashing or account writes for an invalid/expired token', async () => {
    await expect(
      acceptInvitation({
        token: 'a'.repeat(43),
        password: 'Fifteen or more unpredictable characters',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    expect(mocked.hashPassword).not.toHaveBeenCalled();
    expect(
      mocked.query.mock.calls.some(([sql]) => sql.startsWith('INSERT')),
    ).toBe(false);
    expect(mocked.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    expect(mocked.release).toHaveBeenCalledWith(false);
  });
  it('rejects weak passwords before acquiring a database connection', async () => {
    await expect(
      acceptInvitation({ token: 'a'.repeat(43), password: 'password' }),
    ).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(mocked.connect).not.toHaveBeenCalled();
  });
  it('rolls back if issuer rights were revoked after invitation issue', async () => {
    mocked.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM auth_invitation'))
        return {
          rows: [
            {
              id: 'invite-1',
              organization_id: context.organizationId,
              email: 'a@example.com',
              name: 'A',
              role: 'analyst',
              created_by: 'owner-1',
            },
          ],
        };
      if (sql.includes('FROM app_memberships'))
        return { rows: [{ role: 'viewer' }] };
      return { rows: [], rowCount: 0 };
    });
    await expect(
      acceptInvitation({
        token: 'a'.repeat(43),
        password: 'Fifteen or more unpredictable characters',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INVITATION' });
    expect(mocked.hashPassword).not.toHaveBeenCalled();
    expect(mocked.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
  });
});
