import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), query: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  auth: { api: { getSession: mocks.session } },
  authEnvironment: () => ({ origin: 'https://aster.example.invalid' }),
  mfaRequired: () => true,
}));
vi.mock('./db', () => ({
  pool: { query: mocks.query },
  isOrganizationId: (value: string) => /^[a-f0-9-]{36}$/.test(value),
}));
import { requireWorkspace } from './access';
const org = 'ce728c6f-ae73-48cc-955e-ad1c917b5657';
const request = (
  path: string,
  method = 'GET',
  origin = 'https://aster.example.invalid',
) =>
  new Request('https://aster.example.invalid' + path, {
    method,
    headers: { Origin: origin },
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({
    user: {
      id: 'synthetic',
      name: 'Synthetic',
      email: 'synthetic@example.invalid',
      twoFactorEnabled: true,
    },
    session: { id: 'test-session', mfaVerifiedAt: new Date() },
  });
  mocks.query.mockResolvedValue({
    rows: [
      {
        organization_id: org,
        role: 'viewer',
        data_scope: { familyIds: ['own'], entityIds: ['own-entity'] },
      },
    ],
  });
});
describe('independent scoped route allowlist audit', () => {
  it.each([
    '/api/intelligence',
    '/api/intelligence/search',
    '/api/processing',
    '/api/engines',
    '/api/data-access',
  ])('denies office-wide GET %s', async (path) => {
    await expect(requireWorkspace(request(path), 'read')).rejects.toMatchObject(
      { status: 403, code: 'SCOPED_ACCESS' },
    );
  });
  it('permits only read-only Ask with a same-origin request and retains the DB scope', async () => {
    const ctx = await requireWorkspace(
      request('/api/intelligence/ask', 'POST'),
      'read',
    );
    expect(ctx.scope).toEqual({
      familyIds: ['own'],
      entityIds: ['own-entity'],
    });
    expect(mocks.session).toHaveBeenCalledWith(
      expect.objectContaining({ query: { disableCookieCache: true } }),
    );
  });
  it('denies a write permission even when it targets the Ask route', async () => {
    await expect(
      requireWorkspace(request('/api/intelligence/ask', 'POST'), 'write'),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('rejects cross-origin Ask before authenticating', async () => {
    await expect(
      requireWorkspace(
        request(
          '/api/intelligence/ask',
          'POST',
          'https://foreign.example.invalid',
        ),
        'read',
      ),
    ).rejects.toMatchObject({ status: 403, code: 'INVALID_ORIGIN' });
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it('allows original download/preview routing without implying document authorization', async () => {
    const id = 'b46c77db-cfd6-47ef-8b4a-4020e14f63b1';
    for (const suffix of ['', '/preview'])
      expect(
        (
          await requireWorkspace(
            request('/api/documents/' + id + suffix),
            'read',
          )
        ).scope,
      ).not.toBeNull();
  });
  it('fails closed for contradictory elevated-role scope or malformed scope', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          organization_id: org,
          role: 'admin',
          data_scope: { familyIds: ['own'] },
        },
      ],
    });
    await expect(
      requireWorkspace(request('/api/workspace'), 'read'),
    ).rejects.toMatchObject({ status: 403 });
    mocks.query.mockResolvedValueOnce({
      rows: [
        { organization_id: org, role: 'viewer', data_scope: { familyIds: [] } },
      ],
    });
    await expect(
      requireWorkspace(request('/api/workspace'), 'read'),
    ).rejects.toThrow();
  });
});
