import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({ withTenant: vi.fn(), pool: {} }));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'https://aster.synthetic.invalid' }),
}));
import { withTenant } from './db';
import { startMailboxAuthorization } from './mailbox-store';
import type { WorkspaceContext } from './access';
const context: WorkspaceContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  user: {
    id: 'synthetic',
    email: 'synthetic@example.invalid',
    name: 'Synthetic',
  },
  sessionId: 'synthetic-session',
  role: 'owner',
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('mailbox transport admission before OAuth state', () => {
  it.each(['disabled', 'direct', 'invalid'])(
    'does not create a state or authorize a provider when transport is %s',
    async (mode) => {
      vi.stubEnv('MAILBOX_OAUTH_TRANSPORT', mode);
      vi.stubEnv('GOOGLE_CLIENT_ID', 'synthetic');
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic');
      await expect(
        startMailboxAuthorization(context, {
          provider: 'gmail',
          historyDays: 'all',
        }),
      ).rejects.toThrow(
        mode === 'disabled'
          ? 'MAILBOX_CONNECTIONS_DISABLED'
          : 'BROKER_NOT_CONFIGURED',
      );
      expect(withTenant).not.toHaveBeenCalled();
    },
  );
  it('does not create state when broker is selected without its dedicated token', async () => {
    vi.stubEnv('MAILBOX_OAUTH_TRANSPORT', 'broker');
    vi.stubEnv('MAILBOX_BROKER_URL', 'http://mailbox-worker:8010');
    vi.stubEnv('MAILBOX_BROKER_TOKEN', undefined);
    await expect(
      startMailboxAuthorization(context, {
        provider: 'gmail',
        historyDays: 'all',
      }),
    ).rejects.toThrow('BROKER_NOT_CONFIGURED');
    expect(withTenant).not.toHaveBeenCalled();
  });
});
