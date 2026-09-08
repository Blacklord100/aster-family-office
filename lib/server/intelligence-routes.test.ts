import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({}));
vi.mock('./db', () => ({ pool: {}, isOrganizationId: () => true }));
vi.mock('./access', async (original) => ({
  ...(await original<typeof import('./access')>()),
  requireWorkspace: vi.fn(),
}));
vi.mock('./intelligence-store', () => ({ askIntelligence: vi.fn() }));
import { requireWorkspace } from './access';
import { askIntelligence } from './intelligence-store';
import { POST } from '../../app/api/intelligence/ask/route';
const context = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  user: { id: 'user', email: 'synthetic@example.invalid', name: 'Synthetic' },
  role: 'viewer' as const,
  sessionId: 'session',
  scope: null,
};
const request = () =>
  new Request('http://localhost:3000/api/intelligence/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Recorded NAV?', familyId: 'all' }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireWorkspace).mockResolvedValue(context);
  vi.mocked(askIntelligence).mockResolvedValue({
    status: 'answered',
    secretFixtureMarker: 'PRIVATE_SOURCE_MUST_NOT_LEAK',
  } as unknown as Awaited<ReturnType<typeof askIntelligence>>);
});
it('revalidates membership after inference before serializing source material', async () => {
  vi.mocked(requireWorkspace)
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce({ ...context, scope: { familyIds: ['narrowed'] } });
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('PRIVATE_SOURCE_MUST_NOT_LEAK');
});
it('refuses revoked sessions at the final authorization check', async () => {
  vi.mocked(requireWorkspace)
    .mockResolvedValueOnce(context)
    .mockRejectedValueOnce(new Error('Session revoked'));
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain('PRIVATE_SOURCE_MUST_NOT_LEAK');
});
it('forwards cancellation and returns answers only for an unchanged authorized scope', async () => {
  const input = request();
  const response = await POST(input);
  expect(response.status).toBe(200);
  expect(requireWorkspace).toHaveBeenCalledTimes(2);
  expect(askIntelligence).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ familyId: 'all' }),
    fetch,
    input.signal,
  );
});
