import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  query: vi.fn(),
  role: vi.fn(),
  auth: vi.fn(),
  encrypt: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({
  pool: { query: fixture.query },
  assertDatabaseRole: fixture.role,
}));
vi.mock('./auth', () => ({ authEnvironment: fixture.auth }));
vi.mock('./crypto', () => ({ encrypt: fixture.encrypt }));
vi.mock('../lifecycle-contract', async (original) => ({
  ...(await original<typeof import('../lifecycle-contract')>()),
  runtimeIdentity: () => ({
    release: 'release-2',
    generation: 3,
    min: 16,
    max: 16,
  }),
}));

import { GET } from '../../app/api/health/route';

describe('public readiness contract through real lifecycle handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.query.mockResolvedValue({
      rows: [
        {
          mode: 'maintenance',
          generation: '3',
          active_release: 'release-2',
          schema_version: 16,
          resumed_at: null,
          updated_at: new Date('2026-09-12T00:00:00Z'),
        },
      ],
    });
  });
  it('returns the stable unavailable response when lifecycle cannot reach the database', async () => {
    fixture.query.mockRejectedValue(
      new Error('private database connection detail'),
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(fixture.auth).not.toHaveBeenCalled();
  });
  it('allows a sealed compatible candidate to report its identity before writes resume', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-aster-maintenance')).toBe('maintenance');
    expect(await response.json()).toMatchObject({
      status: 'ok',
      release: 'release-2',
      writerGeneration: 3,
      lifecycle: {
        mode: 'maintenance',
        activeRelease: 'release-2',
        generation: 3,
        schemaVersion: 16,
      },
    });
    expect(fixture.role).toHaveBeenCalledOnce();
  });
  it('fails readiness on a database schema outside the installed binary range', async () => {
    fixture.query.mockResolvedValue({ rows: [{ schema_version: 17 }] });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
  });
  it('fails readiness when application secrets are invalid after lifecycle succeeds', async () => {
    fixture.encrypt.mockImplementation(() => {
      throw new Error('private key details');
    });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'unavailable' });
  });
});
