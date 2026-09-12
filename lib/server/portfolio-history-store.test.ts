import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialWorkspace, type WorkspaceState } from '../workspace';
import type { WorkspaceContext } from './access';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  decrypt: vi.fn(),
  requireWorkspace: vi.fn(),
  save: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./db', () => ({ withTenant: mocks.transaction }));
vi.mock('./crypto', () => ({ decrypt: mocks.decrypt, sha256: () => 'digest' }));
vi.mock('../workspace-store', () => ({ saveWorkspace: mocks.save }));
vi.mock('./audit', () => ({ audit: mocks.audit }));
vi.mock('./access', () => {
  class AccessError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessError,
    roleAllows: (role: string, permission: string) =>
      permission === 'read' || ['owner', 'admin', 'analyst'].includes(role),
    requireWorkspace: mocks.requireWorkspace,
    errorResponse: (error: InstanceType<typeof AccessError>) =>
      Response.json({ error: error.code }, { status: error.status ?? 500 }),
  };
});
import { readPortfolioHistory } from './portfolio-history-store';
import { writeHistoryLifecycle } from './portfolio-history-lifecycle-store';
import { GET } from '@/app/api/portfolio-history/route';
const ctx: WorkspaceContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session',
  role: 'viewer',
  user: { id: 'user', name: 'Viewer', email: 'viewer@example.test' },
  scope: { familyIds: ['f1'] },
};
function stateFixture(): WorkspaceState {
  const holding = (id: string, familyId: string) => ({
    id,
    name: id,
    familyId,
    entityId: 'e-' + familyId,
    accountId: 'a',
    assetClass: 'Private equity' as const,
    currency: 'EUR' as const,
    valueEUR: 100,
    originalValue: 100,
    syntheticFXRateToEUR: 1,
    costBasisEUR: 0,
    unfundedCommitmentEUR: 0,
    liquidityBucket: '3+ years' as const,
    valuationDate: '2026-06-30',
    sourceId: '',
    geography: '',
    manager: 'Manager',
    description: '',
    color: '',
    valuationMethod: 'Reported fund NAV' as const,
  });
  const source = (
    id: string,
    holdingId: string,
    familyId: string,
    documentId: string,
  ) => ({
    id,
    holdingId,
    familyId,
    documentId,
    mailboxId: '',
    subject: id,
    sender: '',
    receivedAt: '2026-09-09T00:00:00Z',
    effectiveDate: '2026-06-30',
    filename: `${id}.pdf`,
    page: 1,
    excerpt: id + ' value',
    status: 'Accepted' as const,
    synthetic: false,
  });
  const evidence = [
    source('allowed', 'h1', 'f1', '00000000-0000-4000-8000-000000000011'),
    source('unreleased', 'h1', 'f1', '00000000-0000-4000-8000-000000000012'),
    source('other-family', 'h2', 'f2', '00000000-0000-4000-8000-000000000013'),
  ];
  return {
    ...initialWorkspace(false),
    portfolio: {
      holdings: [holding('h1', 'f1'), holding('h2', 'f2')],
      history: [],
      events: [],
      tasks: [],
      evidence,
      families: ['f1', 'f2'].map((id) => ({
        id,
        name: id,
        initials: '',
        principal: '',
        location: '',
        color: '',
      })),
      entities: ['f1', 'f2'].map((id) => ({
        id: 'e-' + id,
        familyId: id,
        name: id,
        type: 'Trust' as const,
        jurisdiction: '',
        ownershipPercent: 100,
      })),
      accounts: [],
    },
    finance: {
      version: 1,
      revision: 3,
      accounts: {},
      entities: {},
      holdings: {},
      transactions: [],
      events: [],
      coverage: [],
      receipts: [],
      valuations: evidence.map((s, i) => ({
        id: 'v-' + s.id,
        sourceId: s.id,
        holdingId: s.holdingId,
        amount: String((i + 1) * 100),
        valueEUR: (i + 1) * 100,
        currency: 'EUR' as const,
        effectiveDate: `2026-0${i + 4}-30`,
        actorId: 'reviewer',
        recordedAt: '2026-09-09T10:00:00Z',
        valuationMethod: 'Reported fund NAV' as const,
      })),
    },
  };
}
let state: WorkspaceState;
beforeEach(() => {
  vi.clearAllMocks();
  state = stateFixture();
  mocks.requireWorkspace.mockResolvedValue(ctx);
  mocks.transaction.mockImplementation(async (_org, fn) =>
    fn({ query: mocks.query }),
  );
  mocks.decrypt.mockImplementation(() => Buffer.from(JSON.stringify(state)));
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM app_memberships'))
      return { rows: [{ role: ctx.role, data_scope: ctx.scope }] };
    if (sql.includes('FROM app_workspace'))
      return {
        rows: [{ payload: Buffer.from('encrypted'), bytes: 1000, revision: 7 }],
      };
    if (sql.includes('FROM app_documents d'))
      return {
        rows: state.portfolio!.evidence.map((e) => ({
          id: e.documentId,
          content_hash: 'a'.repeat(64),
          created_at: new Date('2026-09-08T09:00:00Z'),
          family_ids: e.id === 'unreleased' ? null : [e.familyId],
          entity_ids: e.id === 'unreleased' ? null : ['e-' + e.familyId],
        })),
      };
    return { rows: [] };
  });
});
describe('bounded tenant history API', () => {
  it('uses one read-only snapshot, scoped original grants and one batched metadata lookup', async () => {
    const result = await readPortfolioHistory(ctx, { asOf: '2026-09-10' });
    expect(result.observations.map((r) => r.sourceId)).toEqual(['allowed']);
    expect(result.observations[0].importedAt).toBe('2026-09-08T09:00:00.000Z');
    expect(result.positions.map((r) => r.holdingId)).toEqual(['h1']);
    expect(JSON.stringify(result)).not.toContain('unreleased');
    expect(JSON.stringify(result)).not.toContain('other-family');
    expect(mocks.transaction).toHaveBeenCalledWith(
      ctx.organizationId,
      expect.any(Function),
      { readOnlySnapshot: true },
    );
    expect(
      mocks.query.mock.calls.filter(([sql]) =>
        sql.includes('FROM app_documents d'),
      ),
    ).toHaveLength(1);
    expect(
      mocks.query.mock.calls.every(
        ([sql, values]) =>
          !sql.includes('FROM app_') || values[0] === ctx.organizationId,
      ),
    ).toBe(true);
  });
  it('rejects a stale authorization context before decrypting anything', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(readPortfolioHistory(ctx)).rejects.toMatchObject({
      status: 403,
      code: 'ACCESS_CHANGED',
    });
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it('enforces the SQL ciphertext limit before decrypting an oversized workspace', async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ role: ctx.role, data_scope: ctx.scope }],
      })
      .mockResolvedValueOnce({
        rows: [{ payload: null, bytes: 40 * 1024 * 1024, revision: 7 }],
      });
    await expect(readPortfolioHistory(ctx)).rejects.toMatchObject({
      status: 413,
      code: 'HISTORY_CAPACITY',
    });
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it('never substitutes demonstration fixtures for an uninitialized portfolio', async () => {
    state = initialWorkspace(true);
    mocks.query.mockResolvedValueOnce({
      rows: [{ role: ctx.role, data_scope: null }],
    });
    const result = await readPortfolioHistory({ ...ctx, scope: undefined });
    expect(result.positions).toHaveLength(0);
    expect(result.summary.amount).toBeNull();
  });
  it('validates the actual GET boundary and returns private uncacheable JSON', async () => {
    const invalid = await GET(
      new Request(
        'https://aster.test/api/portfolio-history?query=' +
          encodeURIComponent('{"limit":101}'),
      ),
    );
    expect(invalid.status).toBe(400);
    const response = await GET(
      new Request('https://aster.test/api/portfolio-history'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).revision).toBe(7);
  });
  it('denies lifecycle mutations for viewers and scoped accounts', async () => {
    await expect(writeHistoryLifecycle(ctx, {} as never)).rejects.toMatchObject(
      { status: 403 },
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

// Admission and writer fencing are exercised in lifecycle.integration.test.ts.
vi.mock('./lifecycle', async (original) => ({
  ...(await original<typeof import('./lifecycle')>()),
  lifecycleRoute: (handler: (...args: unknown[]) => unknown) => handler,
}));
