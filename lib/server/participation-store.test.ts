import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initialWorkspace,
  type PortfolioRecords,
  type WorkspaceState,
} from '../workspace';
import { emptyFinanceState } from '../ledger-contract';
import { appendParticipation } from '../participation';
import type {
  ParticipationCommand,
  ParticipationRequest,
} from '../participation-contract';
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
vi.mock('./crypto', () => ({
  decrypt: mocks.decrypt,
  sha256: (input: string) => input,
}));
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
import { readParticipation, writeParticipation } from './participation-store';
import { GET, POST } from '@/app/api/participation/route';
const baseContext: WorkspaceContext = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'session',
  role: 'owner',
  user: { id: 'user', name: 'Owner', email: 'owner@example.test' },
};
const identity = {
  name: 'Shared fund',
  manager: 'Manager',
  vehicle: 'Fund LP',
  shareClass: 'Class A',
  round: 'Fund I',
};
function command(holdingId = 'h1'): ParticipationCommand {
  return {
    kind: 'link',
    holdingId,
    sourceId: 's-' + holdingId,
    effectiveDate: '2026-01-01',
    evidenceVerified: true,
    page: 1,
    quote: 'Investor units in Fund LP Class A',
    reason: 'Reviewed retained source for this exact vehicle.',
    newInvestment: identity,
  };
}
function fixture(): WorkspaceState {
  const portfolio: PortfolioRecords = {
    holdings: [1, 2, 3].map((i) => ({
      id: 'h' + i,
      name: 'Holding ' + i,
      familyId: i === 3 ? 'f2' : 'f1',
      entityId: i === 3 ? 'e2' : 'e1',
      accountId: 'a' + i,
      assetClass: 'Private equity',
      currency: 'EUR',
      valueEUR: i * 100,
      originalValue: i * 100,
      syntheticFXRateToEUR: 1,
      costBasisEUR: 0,
      unfundedCommitmentEUR: 0,
      liquidityBucket: '3+ years',
      valuationDate: '2026-06-30',
      sourceId: 's-h' + i,
      geography: '',
      manager: 'Manager',
      description: '',
      color: '',
      valuationMethod: 'Reported fund NAV',
    })),
    history: [],
    events: [],
    tasks: [],
    evidence: [1, 2, 3].map((i) => ({
      id: 's-h' + i,
      holdingId: 'h' + i,
      familyId: i === 3 ? 'f2' : 'f1',
      documentId: '00000000-0000-4000-8000-00000000001' + i,
      mailboxId: '',
      subject: 'Source ' + i,
      sender: '',
      receivedAt: '2026-07-01T10:00:00Z',
      effectiveDate: '2026-06-30',
      filename: i + '.pdf',
      page: 1,
      excerpt: 'Class A units',
      status: 'Accepted',
      synthetic: false,
    })),
    families: ['f1', 'f2'].map((id) => ({
      id,
      name: id === 'f1' ? 'Visible family' : 'Hidden family',
      initials: '',
      principal: '',
      location: '',
      color: '#aaa',
    })),
    entities: ['1', '2'].map((id) => ({
      id: 'e' + id,
      familyId: 'f' + id,
      name: 'Entity ' + id,
      type: 'Trust',
      jurisdiction: '',
      ownershipPercent: 100,
    })),
    accounts: [],
  };
  const finance = emptyFinanceState();
  finance.valuations = portfolio.holdings.map((h) => ({
    id: 'v-' + h.id,
    sourceId: h.sourceId,
    holdingId: h.id,
    amount: h.valueEUR.toFixed(2),
    valueEUR: h.valueEUR,
    currency: 'EUR',
    effectiveDate: '2026-06-30',
    actorId: 'reviewer',
    recordedAt: '2026-07-02T10:00:00Z',
    valuationMethod: 'Reported fund NAV',
  }));
  let participation = appendParticipation(portfolio, undefined, command(), {
    id: 'r1',
    investmentId: 'i1',
    actorId: 'reviewer',
    at: '2026-07-03T00:00:00Z',
    sourceSha256: 'a'.repeat(64),
  }).state;
  const second = {
    ...command('h3'),
    newInvestment: undefined,
    investmentId: 'i1',
  } as ParticipationCommand;
  participation = appendParticipation(portfolio, participation, second, {
    id: 'r3',
    investmentId: 'unused',
    actorId: 'reviewer',
    at: '2026-07-03T00:00:00Z',
    sourceSha256: 'a'.repeat(64),
  }).state;
  return { ...initialWorkspace(false), portfolio, finance, participation };
}
let ctx: WorkspaceContext;
let state: WorkspaceState;
let revision: number;
let unavailable: Set<string>;
let hashes: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  ctx = { ...baseContext };
  state = fixture();
  revision = 7;
  unavailable = new Set();
  hashes = new Map();
  mocks.requireWorkspace.mockImplementation(async () => ctx);
  mocks.transaction.mockImplementation(async (_org, fn) =>
    fn({ query: mocks.query }),
  );
  mocks.decrypt.mockImplementation(() => Buffer.from(JSON.stringify(state)));
  mocks.save.mockImplementation(async (_client, _org, next) => {
    state = next;
    revision++;
  });
  mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
    if (sql.includes('FROM app_memberships'))
      return { rows: [{ role: ctx.role, data_scope: ctx.scope ?? null }] };
    if (sql.includes('FROM app_workspace'))
      return {
        rows: [{ payload: Buffer.from('ciphertext'), bytes: 1000, revision }],
      };
    if (sql.includes('FROM app_documents d')) {
      const selected = Array.isArray(values[1]) ? values[1] : [values[1]];
      return {
        rows: state
          .portfolio!.evidence.filter((e) => selected.includes(e.documentId))
          .map((e) => ({
            id: e.documentId,
            sha256: hashes.get(e.documentId!) ?? 'a'.repeat(64),
            content_hash: hashes.get(e.documentId!) ?? 'a'.repeat(64),
            created_at: new Date('2026-07-01T00:00:00Z'),
            family_ids: unavailable.has(e.documentId!) ? null : [e.familyId],
            entity_ids: unavailable.has(e.documentId!)
              ? null
              : [e.familyId === 'f1' ? 'e1' : 'e2'],
          })),
      };
    }
    return { rows: [] };
  });
});
describe('tenant-bound participation API', () => {
  it('scopes before aggregating, with one consistent read-only transaction and no hidden-family denominator', async () => {
    ctx = { ...ctx, role: 'viewer', scope: { familyIds: ['f1'] } };
    const result = await readParticipation(ctx, {
      asOf: '2026-08-01',
      cohort: 'historical',
    });
    expect(result.investments[0].familyCount).toBe(1);
    expect(result.investments[0].knownNAV).toBe('100.00');
    expect(result.investments[0].families[0].shareOfKnownNAV).toBe(100);
    expect(result.investments[0].families[0].portfolioNAV).toBe('300.00');
    expect(result.canWrite).toBe(false);
    expect(JSON.stringify(result)).not.toContain('Hidden family');
    expect(JSON.stringify(result)).not.toContain('s-h3');
    expect(JSON.stringify(result)).not.toContain('r3');
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledWith(
      ctx.organizationId,
      expect.any(Function),
      { readOnlySnapshot: true },
    );
  });
  it('a holding filter never shrinks its family portfolio denominator', async () => {
    const result = await readParticipation(ctx, {
      asOf: '2026-08-01',
      holdingIds: ['h1'],
    });
    expect(result.investments[0].positions.map((p) => p.holdingId)).toEqual([
      'h1',
    ]);
    expect(result.investments[0].families[0].portfolioNAV).toBe('300.00');
    expect(result.investments[0].families[0].portfolioWeight).toBeCloseTo(
      33.333333,
    );
  });
  it('source content mismatches suppress the full affected mapping chain', async () => {
    hashes.set(state.portfolio!.evidence[0].documentId!, 'b'.repeat(64));
    const result = await readParticipation(ctx, { asOf: '2026-08-01' });
    expect(result.investments[0].positions.map((p) => p.holdingId)).toEqual([
      'h3',
    ]);
    expect(result.unlinked.map((p) => p.holdingId)).toContain('h1');
    expect(result.records.map((r) => r.id)).not.toContain('r1');
  });
  it('a family-only reader cannot use withheld mapping sources or discover the global catalog', async () => {
    ctx = { ...ctx, role: 'viewer', scope: { familyIds: ['f1'] } };
    unavailable.add(state.portfolio!.evidence[0].documentId!);
    const result = await readParticipation(ctx, { asOf: '2026-08-01' });
    expect(result.catalog).toEqual([]);
    expect(result.investments).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.unlinked.map((p) => p.holdingId)).not.toContain('h3');
  });
  it('revalidates revoked membership before decrypting the workspace', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(readParticipation(ctx)).rejects.toMatchObject({
      status: 403,
      code: 'ACCESS_CHANGED',
    });
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it('denies writes from read-only and family-scoped accounts', async () => {
    await expect(
      writeParticipation({ ...ctx, role: 'viewer' }, {} as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      writeParticipation({ ...ctx, scope: { familyIds: ['f1'] } }, {} as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects stale revisions without changing holdings or finance', async () => {
    await expect(
      writeParticipation(ctx, {
        expectedRevision: 6,
        idempotencyKey: crypto.randomUUID(),
        command: command('h2'),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'PARTICIPATION_CHANGED' });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('requires an explicit source release grant for a reviewed identity mutation', async () => {
    unavailable.add(state.portfolio!.evidence[1].documentId!);
    await expect(
      writeParticipation(ctx, {
        expectedRevision: 7,
        idempotencyKey: crypto.randomUUID(),
        command: command('h2'),
      }),
    ).rejects.toMatchObject({ code: 'PARTICIPATION_SOURCE_REQUIRED' });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('atomically records an audited link with idempotent retries and leaves all financial facts untouched', async () => {
    const originalFinance = structuredClone(state.finance);
    const originalPortfolio = structuredClone(state.portfolio);
    const request: ParticipationRequest = {
      expectedRevision: 7,
      idempotencyKey: crypto.randomUUID(),
      command: command('h2'),
    };
    const created = await writeParticipation(ctx, request);
    const duplicate = await writeParticipation(ctx, request);
    expect(created.revision).toBe(8);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.resultId).toBe(created.resultId);
    expect(state.participation!.records).toHaveLength(3);
    expect(state.finance).toEqual(originalFinance);
    expect(state.portfolio).toEqual(originalPortfolio);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0][3]).toBe('participation.link');
    await expect(
      writeParticipation(ctx, {
        ...request,
        command: {
          ...request.command,
          reason: 'A different instruction with this same key.',
        },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('validates actual route query bounds, private cache policy and authenticated POST dispatch', async () => {
    expect(
      (
        await GET(
          new Request(
            'https://aster.test/api/participation?query=' +
              encodeURIComponent('{"limit":101}'),
          ),
        )
      ).status,
    ).toBe(400);
    const response = await GET(
      new Request('https://aster.test/api/participation'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const saved = await POST(
      new Request('https://aster.test/api/participation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: 7,
          idempotencyKey: crypto.randomUUID(),
          command: command('h2'),
        }),
      }),
    );
    expect(saved.status).toBe(200);
    expect(mocks.requireWorkspace).toHaveBeenLastCalledWith(
      expect.any(Request),
      'write',
    );
  });
});

// Admission and writer fencing are exercised in lifecycle.integration.test.ts.
vi.mock('./lifecycle', async (original) => ({
  ...(await original<typeof import('./lifecycle')>()),
  lifecycleRoute: (handler: (...args: unknown[]) => unknown) => handler,
}));
