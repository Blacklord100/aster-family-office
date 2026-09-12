import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { WorkspaceState } from '../workspace';
import type { WorkspaceContext } from './access';
import { initialWorkspace, deriveWorkspace } from '../workspace';
import { postReviewedCashNotice } from '../ledger';
import { emptyFinanceState, type LedgerRequest } from '../ledger-contract';
import { scopeWorkspace } from '../data-scope';

const f = vi.hoisted(() => ({
  signedIn: true,
  role: 'analyst',
  scope: null as { familyIds: string[] } | null,
  memberships: ['00000000-0000-4000-8000-000000000001'],
  rows: new Map<string, { state: WorkspaceState; revision: number }>(),
  saves: vi.fn(),
  reads: vi.fn(),
  audit: vi.fn(),
  tail: Promise.resolve(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
  mfaRequired: () => false,
  auth: {
    api: {
      getSession: async () =>
        f.signedIn
          ? {
              user: {
                id: 'reviewer',
                name: 'Synthetic reviewer',
                email: 'reviewer@example.test',
              },
              session: { id: 'session' },
            }
          : null,
    },
  },
}));
vi.mock('./db', () => ({
  isOrganizationId: (value: string) => /^[a-f0-9-]{36}$/.test(value),
  pool: {
    query: async (_sql: string, values: string[]) => ({
      rows: f.memberships
        .filter((id) => !values[1] || id === values[1])
        .map((id) => ({
          organization_id: id,
          role: f.role,
          data_scope: f.scope,
        })),
    }),
  },
  withTenant: async (
    organizationId: string,
    run: (client: { organizationId: string }) => Promise<unknown>,
  ) => {
    const before = f.tail;
    let release!: () => void;
    f.tail = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await run({ organizationId });
    } finally {
      release();
    }
  },
}));
vi.mock('../workspace-store', () => ({
  readWorkspace: async (ctx: WorkspaceContext) => {
    f.reads(ctx.organizationId);
    const row = f.rows.get(ctx.organizationId)!;
    return {
      state: scopeWorkspace(structuredClone(row.state), ctx.scope),
      revision: row.revision,
    };
  },
  readWorkspaceInTransaction: async (
    client: { organizationId: string },
    organizationId: string,
    locked: boolean,
  ) => {
    expect(client.organizationId).toBe(organizationId);
    expect(locked).toBe(true);
    return structuredClone(f.rows.get(organizationId)!);
  },
  saveWorkspace: async (
    client: { organizationId: string },
    organizationId: string,
    state: WorkspaceState,
  ) => {
    expect(client.organizationId).toBe(organizationId);
    f.saves(organizationId, state);
    f.rows.set(organizationId, {
      state: structuredClone(state),
      revision: f.rows.get(organizationId)!.revision + 1,
    });
  },
}));
vi.mock('./audit', () => ({ audit: f.audit }));

import { GET, POST } from '../../app/api/ledger/route';
import { writeLedger } from './ledger-store';
const org = '00000000-0000-4000-8000-000000000001',
  other = '00000000-0000-4000-8000-000000000002';
const key = '00000000-0000-4000-8000-000000000011';
function request(body?: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/ledger', {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
      'x-aster-organization': org,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const command = (name = 'New family', idempotencyKey = key): LedgerRequest => ({
  expectedRevision: 0,
  idempotencyKey,
  command: { type: 'createFamily', name, principal: '', location: '' },
});
describe('ledger HTTP authorization, tenant persistence and revisions', () => {
  beforeEach(() => {
    f.signedIn = true;
    f.role = 'analyst';
    f.scope = null;
    f.memberships = [org];
    f.tail = Promise.resolve();
    f.saves.mockReset();
    f.reads.mockReset();
    f.audit.mockReset();
    f.rows.clear();
    for (const id of [org, other])
      f.rows.set(id, {
        state: { ...initialWorkspace(false), officeName: id },
        revision: 0,
      });
  });
  it('authenticates reads and rejects missing or cross-site mutation origin before any ledger work', async () => {
    f.signedIn = false;
    expect((await GET(request())).status).toBe(401);
    expect(f.reads).not.toHaveBeenCalled();
    f.signedIn = true;
    const invalidHeaders: Record<string, string>[] = [
      { Origin: '' },
      { Origin: 'https://untrusted.example.test' },
      { 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of invalidHeaders)
      expect((await POST(request(command(), headers))).status).toBe(403);
    expect(f.saves).not.toHaveBeenCalled();
  });
  it('permits viewer reads with private no-store headers but forbids mutation, including direct scoped context', async () => {
    f.role = 'viewer';
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect((await response.json()).canWrite).toBe(false);
    expect((await POST(request(command()))).status).toBe(403);
    await expect(
      writeLedger(
        {
          organizationId: org,
          user: { id: 'reviewer', name: '', email: '' },
          sessionId: 'session',
          role: 'owner',
          scope: { familyIds: ['allowed'] },
        },
        command(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.saves).not.toHaveBeenCalled();
  });
  it('requires tenant membership and keeps an authorized mutation inside its organization', async () => {
    expect(
      (await GET(request(undefined, { 'x-aster-organization': other }))).status,
    ).toBe(403);
    expect((await POST(request(command()))).status).toBe(200);
    expect(
      f.rows.get(org)?.state.portfolio?.families.map((row) => row.name),
    ).toEqual(['New family']);
    expect(f.rows.get(other)?.state.portfolio).toBeUndefined();
    expect(f.audit.mock.calls[0].slice(1, 4)).toEqual([
      org,
      'reviewer',
      'ledger.createFamily',
    ]);
  });
  it('serializes concurrent revisions and rejects stale financial instructions without overwriting state', async () => {
    const results = await Promise.all([
      POST(request(command('First'))),
      POST(request(command('Second', '00000000-0000-4000-8000-000000000012'))),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 409]);
    expect((await results[1].json()).error).toBe('LEDGER_CHANGED');
    expect(f.saves).toHaveBeenCalledTimes(1);
  });
  it('returns the original result for exact retries and rejects reused keys with different commands', async () => {
    const responses = await Promise.all([
      POST(request(command())),
      POST(request(command())),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(responses.map((r) => r.json()));
    expect(second.resultId).toBe(first.resultId);
    expect(second.duplicate).toBe(true);
    expect(f.saves).toHaveBeenCalledTimes(1);
    expect(f.audit).toHaveBeenCalledTimes(1);
    const conflict = await POST(request(command('Changed instruction')));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('maps domain errors and validates request fields without committing state', async () => {
    const missing = await POST(
      request({
        ...command(),
        command: {
          type: 'createAccount',
          entityId: 'foreign-entity',
          name: 'Account',
          institution: 'Bank',
          accountType: 'Custody',
          currency: 'EUR',
          restricted: false,
          restrictionNote: '',
        },
      }),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe('ENTITY_NOT_FOUND');
    expect(
      (await POST(request({ ...command(), expectedRevision: -1 }))).status,
    ).toBe(400);
    expect(f.saves).not.toHaveBeenCalled();
  });
  it('preserves unrelated workspace records and strips receipts from scoped reads', async () => {
    const row = f.rows.get(org)!;
    row.state.taskStatus = { kept: 'Done' };
    row.state.finance = emptyFinanceState();
    await POST(request(command('Allowed')));
    const state = f.rows.get(org)!.state;
    expect(state.taskStatus).toEqual({ kept: 'Done' });
    expect(state.finance?.receipts).toHaveLength(1);
    const allowed = state.portfolio!.families[0].id;
    state.portfolio!.families.push({
      id: 'hidden',
      name: 'Hidden family',
      initials: 'HF',
      principal: '',
      location: '',
      color: '#000',
    });
    f.role = 'viewer';
    f.scope = { familyIds: [allowed] };
    const output = await (await GET(request())).json();
    expect(
      output.portfolio.families.map((row: { id: string }) => row.id),
    ).toEqual([allowed]);
    expect(output.finance.receipts).toEqual([]);
    expect(output.canWrite).toBe(false);
  });
  it('saves a sourced draft amendment exactly once with tenant-local revision and audit linkage', async () => {
    const state = initialWorkspace(true),
      data = deriveWorkspace(state),
      holding = data.holdings.find((row) => row.assetClass !== 'Cash')!;
    const portfolio = {
      ...data,
      evidence: [
        {
          ...data.evidence[0],
          id: 'notice-source',
          holdingId: holding.id,
          familyId: holding.familyId,
          status: 'Accepted' as const,
        },
      ],
    };
    state.portfolio = portfolio;
    state.finance = postReviewedCashNotice(
      portfolio,
      undefined,
      {
        holdingId: holding.id,
        sourceId: 'notice-source',
        fingerprint: 'notice',
        kind: 'capital_call',
        amount: null,
        currency: null,
        effectiveDate: null,
        dueDate: null,
        importedAt: null,
        summary: 'Notice missing details',
        origin: 'accepted_fact',
      },
      { id: 'notice', actorId: 'reviewer', at: '2026-09-10T12:00:00Z' },
    ).finance;
    f.rows.set(org, { state, revision: 4 });
    const body: LedgerRequest = {
      expectedRevision: 4,
      idempotencyKey: key,
      command: {
        type: 'amendObligation',
        obligationId: 'notice',
        amount: '125.43',
        currency: 'EUR',
        effectiveDate: '2026-09-01',
        dueDate: '2026-09-15',
        reason: 'Manager supplied the missing notice details',
        source: {
          sourceId: 'notice-source',
          reference: 'Reviewed notice',
          date: '2026-09-01',
        },
        evidenceVerified: true,
      },
    };
    const responses = await Promise.all([
      POST(request(body)),
      POST(request(body)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const values = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(values[1]).toMatchObject({ duplicate: true, revision: 5 });
    expect(f.rows.get(org)?.state.finance?.obligations?.[0]).toMatchObject({
      amount: '125.43',
      original: { amount: null },
      amendments: [{ after: { amount: '125.43' } }],
    });
    expect(f.rows.get(org)?.state.finance?.events).toEqual([]);
    expect(f.rows.get(org)?.state.portfolio?.holdings).toEqual(
      portfolio.holdings,
    );
    expect(f.rows.get(other)?.state.finance).toBeUndefined();
    expect(f.audit).toHaveBeenCalledTimes(1);
    expect(f.audit.mock.calls[0]).toEqual(
      expect.arrayContaining([
        'ledger.amendObligation',
        expect.objectContaining({ obligationId: 'notice' }),
      ]),
    );
    const stale = await POST(
      request({
        ...body,
        idempotencyKey: '00000000-0000-4000-8000-000000000013',
      }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('LEDGER_CHANGED');
    expect(f.saves).toHaveBeenCalledTimes(1);
  });
});

// Admission and writer fencing are exercised in lifecycle.integration.test.ts.
vi.mock('./lifecycle', async (original) => ({
  ...(await original<typeof import('./lifecycle')>()),
  lifecycleRoute: (handler: (...args: unknown[]) => unknown) => handler,
}));
