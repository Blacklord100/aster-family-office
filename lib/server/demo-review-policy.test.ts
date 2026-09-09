import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { WorkspaceContext } from './access';
vi.mock('server-only', () => ({}));
import { hasDemoSourceVerification } from './demo-review-policy';
import { demoActorId } from './demo-corpus';
const ORG = '11111111-1111-4111-8111-111111111111';
const context: WorkspaceContext = {
  organizationId: ORG,
  user: {
    id: demoActorId(ORG),
    email: 'fixture@example.invalid',
    name: 'Demo actor',
  },
  role: 'analyst',
  sessionId: 'demo-system',
};
const query = vi.fn();
const client = { query } as unknown as PoolClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ASTER_ENABLE_DEMO', 'true');
  query.mockResolvedValue({ rowCount: 1 });
});
afterEach(() => vi.unstubAllEnvs());
describe('system-only demo source verification', () => {
  it('does not let a browser owner, mismatched actor or ordinary session bypass original review', async () => {
    for (const ctx of [
      {
        ...context,
        user: { ...context.user, id: 'browser-owner' },
        role: 'owner' as const,
      },
      { ...context, sessionId: 'real-browser-session' },
      { ...context, organizationId: '22222222-2222-4222-8222-222222222222' },
    ])
      expect(await hasDemoSourceVerification(client, ctx, 'document')).toBe(
        false,
      );
    expect(query).not.toHaveBeenCalled();
  });
  it('requires deployment opt-in and a persisted verified-source marker for that isolated demo', async () => {
    vi.stubEnv('ASTER_ENABLE_DEMO', 'false');
    expect(await hasDemoSourceVerification(client, context, 'document')).toBe(
      false,
    );
    expect(query).not.toHaveBeenCalled();
    vi.stubEnv('ASTER_ENABLE_DEMO', 'true');
    query.mockResolvedValueOnce({ rowCount: 0 });
    expect(await hasDemoSourceVerification(client, context, 'document')).toBe(
      false,
    );
    expect(await hasDemoSourceVerification(client, context, 'document')).toBe(
      true,
    );
    expect(query.mock.calls[0][1]).toEqual([ORG, demoActorId(ORG), 'document']);
    expect(query.mock.calls[0][0]).toContain('demo_owner_user_id IS NOT NULL');
    expect(query.mock.calls[0][0]).toContain("a.action='demo.source_verified'");
  });
});
