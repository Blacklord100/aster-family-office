import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({
  session: vi.fn(),
  workspace: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  auth: { api: { getSession: mocked.session } },
  authEnvironment: () => ({ origin: 'https://aster.example.com' }),
}));
vi.mock('./access', async (original) => ({
  ...(await original<typeof import('./access')>()),
  requireWorkspace: mocked.workspace,
}));
vi.mock('./demo-workspace', () => ({
  createDemoRun: mocked.create,
  listDemoRuns: mocked.list,
}));
import { POST } from '../../app/api/demo/route';
const ORG = '11111111-1111-4111-8111-111111111111';
const request = (
  body: string,
  type = 'application/json',
  origin = 'https://aster.example.com',
) =>
  new Request('https://aster.example.com/api/demo', {
    method: 'POST',
    headers: { origin, 'content-type': type, cookie: 'aster_workspace=stale' },
    body,
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocked.session.mockResolvedValue({ user: { id: 'u' } });
  mocked.workspace.mockResolvedValue({
    organizationId: ORG,
    user: { id: 'u' },
    role: 'owner',
  });
  mocked.create.mockResolvedValue({ organizationId: ORG });
});
describe('demo action authorization and bounds', () => {
  it('clears a stale selector for an authenticated user without needing the revoked membership', async () => {
    const response = await POST(request(JSON.stringify({ action: 'leave' })));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(mocked.workspace).not.toHaveBeenCalled();
    expect(mocked.create).not.toHaveBeenCalled();
  });
  it('requires sign-in and same origin even when leaving', async () => {
    mocked.session.mockResolvedValueOnce(null);
    expect((await POST(request('{"action":"leave"}'))).status).toBe(401);
    expect(
      (
        await POST(
          request(
            '{"action":"leave"}',
            'application/json',
            'https://other.example',
          ),
        )
      ).status,
    ).toBe(403);
  });
  it('bounds and validates JSON before any demo creation', async () => {
    expect(
      (await POST(request('{"action":"start"}', 'text/plain'))).status,
    ).toBe(415);
    expect((await POST(request('{'))).status).toBe(400);
    expect(
      (
        await POST(
          request(
            JSON.stringify({ action: 'start', padding: 'x'.repeat(65536) }),
          ),
        )
      ).status,
    ).toBe(413);
    expect(mocked.create).not.toHaveBeenCalled();
  });
  it('starts only after workspace administrator authorization and sets a secure HttpOnly selector', async () => {
    const response = await POST(request('{"action":"start"}'));
    expect(response.status).toBe(200);
    expect(mocked.workspace).toHaveBeenCalledWith(expect.any(Request), 'admin');
    expect(response.headers.get('set-cookie')).toContain(ORG);
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(mocked.create).toHaveBeenCalledWith(
      expect.anything(),
      'mailroom-v1',
    );
  });
  it('accepts only an enumerated dataset and passes it through the guarded creation path', async () => {
    expect(
      (await POST(request('{"action":"start","dataset":"../private"}'))).status,
    ).toBe(400);
    expect(mocked.create).not.toHaveBeenCalled();
    expect(
      (await POST(request('{"action":"start","dataset":"history-v1"}'))).status,
    ).toBe(200);
    expect(mocked.create).toHaveBeenCalledWith(expect.anything(), 'history-v1');
  });
});

// Admission and writer fencing are exercised in lifecycle.integration.test.ts.
vi.mock('./lifecycle', async (original) => ({
  ...(await original<typeof import('./lifecycle')>()),
  lifecycleRoute: (handler: (...args: unknown[]) => unknown) => handler,
}));
