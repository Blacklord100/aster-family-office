import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from './access';
const mocked = vi.hoisted(() => ({
  query: vi.fn(),
  outsideQuery: vi.fn(),
  withTenant: vi.fn(),
  rate: vi.fn(),
  load: vi.fn(),
  read: vi.fn(),
  mkdir: vi.fn(),
  write: vi.fn(),
  rm: vi.fn(),
  connect: vi.fn(),
  saveEngine: vi.fn(),
  events: [] as string[],
}));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({}));
vi.mock('node:fs/promises', () => ({
  mkdir: mocked.mkdir,
  writeFile: mocked.write,
  rm: mocked.rm,
  realpath: async (path: string) => path,
}));
vi.mock('./db', () => ({
  pool: { query: mocked.outsideQuery },
  withTenant: mocked.withTenant,
}));
vi.mock('./audit', () => ({ audit: async () => {}, rateLimit: mocked.rate }));
vi.mock('./crypto', () => ({ encrypt: (text: string) => Buffer.from(text) }));
vi.mock('./folder-store', () => ({
  connectFolderInTransaction: mocked.connect,
}));
vi.mock('./engine-store', () => ({
  saveEngine: mocked.saveEngine,
  activateEngine: async () => {},
}));
vi.mock('./demo-corpus', () => ({
  loadDemoCatalog: mocked.load,
  readDemoSource: mocked.read,
  demoActorId: (org: string) => 'demo-agent:' + org,
  DEMO_FX_POLICY: { source: 'Synthetic', ratesToEUR: { EUR: '1' } },
}));
import { createDemoRun } from './demo-workspace';
const ctx: WorkspaceContext = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  role: 'owner',
  user: {
    id: 'fixture-user',
    email: 'fixture@example.invalid',
    name: 'Fixture',
  },
  sessionId: 'fixture-session',
};
const client = { query: mocked.query };
beforeEach(() => {
  vi.resetAllMocks();
  mocked.events.length = 0;
  vi.stubEnv('ASTER_ENABLE_DEMO', 'true');
  vi.stubEnv('ASTER_INTAKE_ROOT', '/tmp/aster-demo-lifecycle-fixture');
  mocked.withTenant.mockImplementation(async (org, callback) => {
    mocked.events.push('transaction:' + org);
    const result = await callback(client);
    mocked.events.push('commit:' + org);
    return result;
  });
  mocked.query.mockImplementation(async (sql: string) => {
    if (sql.includes('count(*)')) {
      mocked.events.push('quota');
      return { rowCount: 1, rows: [{ count: 0 }] };
    }
    return { rowCount: 1, rows: [{ id: 'fixture' }] };
  });
  mocked.outsideQuery.mockResolvedValue({ rowCount: 0, rows: [] });
  mocked.rate.mockImplementation(async () => {
    mocked.events.push('rate');
    return true;
  });
  mocked.load.mockImplementation(async () => {
    mocked.events.push('catalog');
    return {
      offices: ['a', 'b', 'c'].map((id) => ({
        id,
        name: 'Family ' + id,
        currency: 'EUR',
        names: ['Fund ' + id],
      })),
      mailboxes: [],
      documents: Array.from({ length: 100 }, (_, i) => ({
        path: `fixtures/emails/mail-${i}.eml`,
        office_id: 'a',
        mailbox_id: 'mailbox',
        sha256: 'a'.repeat(64),
      })),
    };
  });
  mocked.read.mockResolvedValue(Buffer.from('Synthetic source'));
  mocked.mkdir.mockImplementation(async () => {
    mocked.events.push('mkdir');
  });
  mocked.write.mockResolvedValue(undefined);
  mocked.rm.mockResolvedValue(undefined);
  mocked.saveEngine.mockResolvedValue({
    profileId: '22222222-2222-4222-8222-222222222222',
    revision: 1,
  });
  mocked.connect.mockResolvedValue({
    id: '33333333-3333-4333-8333-333333333333',
    duplicate: false,
  });
});
afterEach(() => vi.unstubAllEnvs());
describe('demo provisioning failure boundaries', () => {
  it('charges rate and checks quota before copying, then links the folder in the same transaction', async () => {
    const run = await createDemoRun(ctx);
    expect(mocked.events.indexOf('rate')).toBeLessThan(
      mocked.events.indexOf('catalog'),
    );
    expect(mocked.events.indexOf('quota')).toBeLessThan(
      mocked.events.indexOf('mkdir'),
    );
    expect(mocked.write).toHaveBeenCalledTimes(101);
    expect(mocked.connect).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        organizationId: run.organizationId,
        user: ctx.user,
      }),
      { directory: 'Demo mails', displayName: 'Demo mails' },
    );
    expect(mocked.withTenant).toHaveBeenCalledTimes(2); // committed attempt charge + atomic run
    expect(mocked.rm).not.toHaveBeenCalled();
  });
  it('rejects disabled, scoped and rate-limited starts before reading or copying any original', async () => {
    vi.stubEnv('ASTER_ENABLE_DEMO', 'false');
    await expect(createDemoRun(ctx)).rejects.toMatchObject({
      code: 'DEMO_DISABLED',
    });
    vi.stubEnv('ASTER_ENABLE_DEMO', 'true');
    await expect(
      createDemoRun({ ...ctx, scope: { familyIds: ['a'] } }),
    ).rejects.toMatchObject({ status: 403 });
    mocked.rate.mockResolvedValueOnce(false);
    await expect(createDemoRun(ctx)).rejects.toMatchObject({
      code: 'DEMO_LIMIT',
    });
    expect(mocked.load).not.toHaveBeenCalled();
    expect(mocked.mkdir).not.toHaveBeenCalled();
  });
  it('retains existing files when the per-user run quota is reached', async () => {
    mocked.query.mockImplementation(async (sql: string) =>
      sql.includes('count(*)')
        ? { rowCount: 1, rows: [{ count: 20 }] }
        : { rowCount: 1, rows: [{ id: 'fixture' }] },
    );
    await expect(createDemoRun(ctx)).rejects.toMatchObject({
      code: 'DEMO_LIMIT',
    });
    expect(mocked.mkdir).not.toHaveBeenCalled();
    expect(mocked.rm).not.toHaveBeenCalled();
  });
  it.each(['copy', 'connect'])(
    'removes only the freshly owned directory after a %s failure',
    async (step) => {
      if (step === 'copy')
        mocked.write.mockRejectedValueOnce(new Error('Copy failed'));
      else mocked.connect.mockRejectedValueOnce(new Error('Connect failed'));
      await expect(createDemoRun(ctx)).rejects.toThrow(
        step === 'copy' ? 'Copy failed' : 'Connect failed',
      );
      expect(mocked.rm).toHaveBeenCalledOnce();
      const removed = mocked.rm.mock.calls[0][0] as string;
      expect(removed).toMatch(
        /^\/tmp\/aster-demo-lifecycle-fixture\/[a-f0-9-]{36}$/,
      );
      expect(removed).not.toBe('/tmp/aster-demo-lifecycle-fixture');
    },
  );
  it('keeps source files when commit outcome cannot be established', async () => {
    mocked.connect.mockRejectedValueOnce(new Error('Database disconnected'));
    mocked.outsideQuery.mockRejectedValueOnce(
      new Error('Database disconnected'),
    );
    await expect(createDemoRun(ctx)).rejects.toThrow('Database disconnected');
    expect(mocked.rm).not.toHaveBeenCalled();
  });
  it('rechecks the active session before reading and before creation', async () => {
    mocked.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(createDemoRun(ctx)).rejects.toMatchObject({ status: 403 });
    expect(mocked.load).not.toHaveBeenCalled();
    expect(mocked.query.mock.calls[0][0]).toContain('auth_session');
    expect(mocked.query.mock.calls[0][1]).toEqual([
      ctx.organizationId,
      ctx.user.id,
      ctx.sessionId,
    ]);
  });
});
