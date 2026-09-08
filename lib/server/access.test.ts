import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  getSession: vi.fn(),
  query: vi.fn(),
  mfaRequired: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  auth: { api: { getSession: mocked.getSession } },
  authEnvironment: () => ({ origin: 'https://aster.example.com' }),
  mfaRequired: mocked.mfaRequired,
}));
vi.mock('./db', () => ({
  pool: { query: mocked.query },
  isOrganizationId: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
}));

import {
  AccessError,
  assertSameOrigin,
  errorResponse,
  requireWorkspace,
  roleAllows,
} from './access';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const session = () => ({
  user: {
    id: 'user-1',
    email: 'owner@example.com',
    name: 'Owner',
    twoFactorEnabled: true,
  },
  session: { id: 'session-1', mfaVerifiedAt: new Date() },
});
const request = (headers?: HeadersInit) =>
  new Request('https://aster.example.com/api/workspace', { headers });

beforeEach(() => {
  vi.resetAllMocks();
  mocked.getSession.mockResolvedValue(session());
  mocked.query.mockResolvedValue({
    rows: [{ organization_id: ORG, role: 'owner' }],
  });
  mocked.mfaRequired.mockReturnValue(true);
});

describe('workspace boundary', () => {
  it('requires a server-validated session and disables cookie caching', async () => {
    mocked.getSession.mockResolvedValue(null);
    await expect(requireWorkspace(request())).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    expect(mocked.query).not.toHaveBeenCalled();
    expect(mocked.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableCookieCache: true },
    });
  });
  it('accepts only a membership-scoped organization', async () => {
    const context = await requireWorkspace(
      request({ 'x-aster-organization': OTHER }),
    );
    expect(mocked.query.mock.calls[0][1]).toEqual(['user-1', OTHER]);
    expect(context.organizationId).toBe(ORG); // Always use DB result, not caller header.
  });
  it('rejects cross-organization membership without leaking existence', async () => {
    mocked.query.mockResolvedValue({ rows: [] });
    await expect(
      requireWorkspace(request({ 'x-aster-organization': OTHER })),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });
  it('rejects malformed organization before querying memberships', async () => {
    await expect(
      requireWorkspace(request({ 'x-aster-organization': "' OR true--" })),
    ).rejects.toMatchObject({ status: 400 });
    expect(mocked.query).not.toHaveBeenCalled();
  });
  it('defaults deterministically to a membership from the database', async () => {
    expect(await requireWorkspace(request())).toEqual({
      user: { id: 'user-1', email: 'owner@example.com', name: 'Owner' },
      sessionId: 'session-1',
      organizationId: ORG,
      role: 'owner',
      scope: null,
    });
    expect(mocked.query.mock.calls[0][0]).toContain('ORDER BY organization_id');
  });
  it.each(['viewer', 'invalid', 'OWNER'])(
    'rejects write from %s',
    async (role) => {
      mocked.query.mockResolvedValue({
        rows: [{ organization_id: ORG, role }],
      });
      await expect(requireWorkspace(request(), 'write')).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it.each(['analyst', 'viewer', 'invalid'])(
    'rejects administrative action from %s',
    async (role) => {
      mocked.query.mockResolvedValue({
        rows: [{ organization_id: ORG, role }],
      });
      await expect(requireWorkspace(request(), 'admin')).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it('does not treat user MFA enrollment as proof for an earlier session', async () => {
    const value = session();
    mocked.getSession.mockResolvedValue({
      ...value,
      session: { ...value.session, mfaVerifiedAt: null },
    });
    await expect(requireWorkspace(request())).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
  });
  it('rejects a previously verified session after MFA is disabled', async () => {
    const value = session();
    value.user.twoFactorEnabled = false;
    mocked.getSession.mockResolvedValue(value);
    await expect(requireWorkspace(request())).rejects.toMatchObject({
      code: 'MFA_REQUIRED',
    });
  });
  it('supports deliberate MFA opt-out only when the environment policy allows it', async () => {
    mocked.mfaRequired.mockReturnValue(false);
    mocked.getSession.mockResolvedValue({
      ...session(),
      session: { id: 's', mfaVerifiedAt: null },
    });
    expect((await requireWorkspace(request())).sessionId).toBe('s');
  });
  it('does not grant unknown roles read permission', () => {
    expect(roleAllows('superadmin', 'read')).toBe(false);
    expect(roleAllows('viewer', 'read')).toBe(true);
    expect(roleAllows('analyst', 'write')).toBe(true);
  });
  it('limits client viewers to reviewed read endpoints and rejects mixed queues', async () => {
    mocked.query.mockResolvedValue({
      rows: [
        {
          organization_id: ORG,
          role: 'viewer',
          data_scope: { familyIds: ['family-a'] },
        },
      ],
    });
    expect((await requireWorkspace(request())).scope).toEqual({
      familyIds: ['family-a'],
    });
    await expect(
      requireWorkspace(new Request('https://aster.example.com/api/processing')),
    ).rejects.toMatchObject({ code: 'SCOPED_ACCESS' });
    await expect(
      requireWorkspace(
        new Request(
          'https://aster.example.com/api/intelligence/search?q=private',
        ),
      ),
    ).rejects.toMatchObject({ code: 'SCOPED_ACCESS' });
    await expect(requireWorkspace(request(), 'write')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('request integrity and errors', () => {
  const write = (headers: HeadersInit) =>
    new Request('https://aster.example.com/api/workspace', {
      method: 'POST',
      headers,
      body: '{}',
    });
  it.each([
    '',
    'https://evil.example.com',
    'null',
    'https://aster.example.com.evil.test',
  ])('rejects untrusted write origin %j', (origin) => {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (origin) headers.set('origin', origin);
    expect(() => assertSameOrigin(write(headers))).toThrow(AccessError);
  });
  it('rejects a cross-site fetch', () => {
    expect(() =>
      assertSameOrigin(
        write({
          origin: 'https://aster.example.com',
          'content-type': 'application/json',
          'sec-fetch-site': 'cross-site',
        }),
      ),
    ).toThrow();
  });
  it('permits same-origin multipart uploads; routes own content validation', () => {
    expect(() =>
      assertSameOrigin(
        write({
          origin: 'https://aster.example.com',
          'content-type': 'multipart/form-data; boundary=test',
        }),
      ),
    ).not.toThrow();
  });
  it('accepts same-origin JSON and permits read requests without Origin', () => {
    expect(() =>
      assertSameOrigin(
        write({
          origin: 'https://aster.example.com',
          'content-type': 'application/json; charset=utf-8',
        }),
      ),
    ).not.toThrow();
    expect(() => assertSameOrigin(request())).not.toThrow();
  });
  it('redacts unexpected errors and marks responses non-cacheable', async () => {
    const response = errorResponse(
      new Error('postgresql://user:secret@private-host/database'),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
