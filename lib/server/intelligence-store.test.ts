import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({}));
vi.mock('./db', () => ({ withTenant: vi.fn(), isOrganizationId: () => true }));
vi.mock('./audit', () => ({
  audit: vi.fn(),
  rateLimit: vi.fn(async () => true),
}));
vi.mock('./engine-store', () => ({
  activeEngine: vi.fn(),
  assertEngineEnabled: vi.fn(),
  processorEndpoint: vi.fn(() => new URL('http://processor:8000')),
}));
vi.mock('./data-scope', () => ({
  releasedDocumentIds: vi.fn(),
  assertDocumentAccess: vi.fn(async () => {}),
}));
vi.mock('../workspace-store', () => ({
  readWorkspaceInTransaction: vi.fn(),
  saveWorkspace: vi.fn(),
}));
import { withTenant } from './db';
import { activeEngine } from './engine-store';
import { readWorkspaceInTransaction } from '../workspace-store';
import { releasedDocumentIds, assertDocumentAccess } from './data-scope';
import { encrypt } from './crypto';
import {
  askIntelligence,
  requireUnscoped,
  searchIntelligence,
  INTELLIGENCE_DOCUMENT_LIMIT,
  INTELLIGENCE_ENCRYPTED_BYTE_LIMIT,
} from './intelligence-store';
import {
  emptyIntelligence,
  type IndexedDocument,
} from '../intelligence-contract';
import { initialWorkspace } from '../workspace';
import type { Holding } from '../../data/types';
import type { WorkspaceContext } from './access';
const org = randomUUID(),
  docId = randomUUID(),
  hiddenId = randomUUID();
const ctx: WorkspaceContext = {
  organizationId: org,
  user: {
    id: randomUUID(),
    name: 'Synthetic',
    email: 'synthetic@example.invalid',
  },
  role: 'viewer',
  sessionId: randomUUID(),
  scope: { familyIds: ['allowed'] },
};
const config = {
  name: 'Synthetic profile',
  provider: 'ollama' as const,
  model: 'synthetic:model',
};
const snapshot = {
  ...config,
  profileId: randomUUID(),
  revision: 2,
  execution: 'local' as const,
};
const page = 'SYNTHETIC TEST DATA. Boreal Robotics weight is 12.5%.';
const query = vi.fn();
const holding = (id: string, familyId: string, valueEUR: number) =>
  ({
    id,
    name: id,
    familyId,
    valueEUR,
    assetClass: 'Cash',
    unfundedCommitmentEUR: 0,
    valuationDate: '2026-06-30',
    entityId: familyId + '-entity',
    accountId: familyId + '-account',
    costBasisEUR: 0,
  }) as Holding;
function body(overrides: Record<string, unknown> = {}) {
  return {
    status: 'answered',
    quotes: [{ sourceId: docId + ':1:0', quote: page }],
    calculationIds: ['nav'],
    model: config.model,
    mode: 'workflow',
    execution: 'local',
    modelCalls: 1,
    warnings: [],
    trace: [],
    ...overrides,
  };
}
const fetcher = (value = body()) =>
  vi.fn<typeof fetch>(async () => Response.json(value));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PROCESSOR_TOKEN', 'synthetic-processor-auth-secret');
  vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 5).toString('base64'));
  vi.mocked(activeEngine).mockResolvedValue({ config, snapshot });
  vi.mocked(releasedDocumentIds).mockResolvedValue(new Set([docId]));
  vi.mocked(assertDocumentAccess).mockResolvedValue();
  const state = {
    ...initialWorkspace(false),
    intelligence: emptyIntelligence(),
    portfolio: {
      holdings: [
        holding('Visible', 'allowed', 0.3),
        holding('Hidden', 'denied', 9000000),
      ],
      history: [],
      events: [],
      evidence: [],
      tasks: [],
      families: [
        { id: 'allowed', name: 'Visible' },
        { id: 'denied', name: 'Hidden' },
      ],
      entities: [],
      accounts: [],
    },
  };
  vi.mocked(readWorkspaceInTransaction).mockResolvedValue({
    state: state as unknown as Awaited<
      ReturnType<typeof readWorkspaceInTransaction>
    >['state'],
    revision: 1,
  });
  query.mockImplementation(async (sql: string, args: unknown[]) => {
    expect(args[0]).toBe(org);
    if (sql.includes('app_intelligence_documents')) {
      expect(args[1]).toEqual([docId]);
      const doc: IndexedDocument = {
        documentId: docId,
        filename: 'synthetic.txt',
        contentHash: 'a'.repeat(64),
        indexedAt: '2026-09-08',
        pages: [{ number: 1, text: page, source: 'document' }],
        warnings: [],
      };
      return {
        rows: [
          {
            document_id: docId,
            payload: encrypt(
              JSON.stringify(doc),
              'intelligence-index:' + org + ':' + docId,
            ),
          },
        ],
      };
    }
    if (sql.includes('processing_mode'))
      return { rows: [{ processing_mode: 'workflow' }] };
    throw new Error('Unexpected fixture SQL');
  });
  vi.mocked(withTenant).mockImplementation(async (_org, fn) => {
    expect(_org).toBe(org);
    return fn({ query } as unknown as PoolClient);
  });
});
describe('knowledge tenant and source boundary', () => {
  it('denies scoped library management while allowing read-only Ask', () => {
    expect(() => requireUnscoped(ctx)).toThrow('office-wide');
    expect(() => requireUnscoped({ ...ctx, scope: null })).not.toThrow();
  });
  it('sends only released text and scoped deterministic totals, then validates the quoted answer', async () => {
    const send = fetcher();
    const result = await askIntelligence(
      ctx,
      { question: 'Boreal Robotics weight and NAV', familyId: 'all' },
      send,
    );
    const outbound = JSON.parse(send.mock.calls[0][1]!.body as string);
    expect(outbound.passages).toHaveLength(1);
    expect(outbound.calculations[0].valueEUR).toBe(0.3);
    expect(JSON.stringify(outbound)).not.toContain('Hidden');
    expect(JSON.stringify(outbound)).not.toContain(hiddenId);
    expect(result.calculations[0].holdingIds).toEqual(['Visible']);
    expect(result.citations[0].documentId).toBe(docId);
    expect(vi.mocked(assertDocumentAccess)).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(
      'synthetic-processor-auth-secret',
    );
    expect(send.mock.calls[0][1]?.redirect).toBe('error');
  });
  it('refuses unauthorized family selection before any provider request', async () => {
    const send = fetcher();
    await expect(
      askIntelligence(ctx, { question: 'Boreal', familyId: 'denied' }, send),
    ).rejects.toThrow('Family not found');
    expect(send).not.toHaveBeenCalled();
  });
  it('checks document access before decryption or inference', async () => {
    vi.mocked(assertDocumentAccess).mockRejectedValue(
      new Error('Document access denied'),
    );
    const send = fetcher();
    await expect(
      askIntelligence(ctx, { question: 'Boreal', familyId: 'all' }, send),
    ).rejects.toThrow('Document access denied');
    expect(send).not.toHaveBeenCalled();
  });
  it('rechecks source grants after a long model request', async () => {
    vi.mocked(assertDocumentAccess)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('Grant revoked'));
    await expect(
      askIntelligence(ctx, { question: 'Boreal', familyId: 'all' }, fetcher()),
    ).rejects.toThrow('Grant revoked');
  });
  it('blocks scoped cloud requests even when a cloud profile is active', async () => {
    vi.mocked(activeEngine).mockResolvedValue({
      config: {
        ...config,
        provider: 'openai',
        apiKey: 'synthetic-never-real-provider-key',
      },
      snapshot: { ...snapshot, provider: 'openai', execution: 'cloud' },
    });
    const send = fetcher();
    await expect(
      askIntelligence(ctx, { question: 'Boreal', familyId: 'all' }, send),
    ).rejects.toThrow('local engine');
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { quotes: [{ sourceId: hiddenId, quote: page }] },
    { quotes: [{ sourceId: docId + ':1:0', quote: 'Fabricated weight 99%' }] },
  ])(
    'rejects unsupported or foreign processor quotations',
    async (overrides) => {
      await expect(
        askIntelligence(
          ctx,
          { question: 'Boreal', familyId: 'all' },
          fetcher(body(overrides)),
        ),
      ).rejects.toThrow('unsupported source');
    },
  );
  it.each([
    { execution: 'cloud' },
    { mode: 'agentic' },
    { model: 'different:model' },
  ])('rejects model/mode/execution substitution', async (overrides) => {
    await expect(
      askIntelligence(
        ctx,
        { question: 'Boreal', familyId: 'all' },
        fetcher(body(overrides)),
      ),
    ).rejects.toThrow('selected engine');
  });
  it('suppresses provider error contents and refuses redirects', async () => {
    const send = vi.fn<typeof fetch>(
      async () =>
        new Response('sensitive provider credential', {
          status: 302,
          headers: { location: 'https://untrusted.invalid' },
        }),
    );
    await expect(
      askIntelligence(ctx, { question: 'Boreal', familyId: 'all' }, send),
    ).rejects.toThrow('could not complete');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

it('accepted constituents preserve valuations and create Risk-resolvable original evidence', async () => {
  const { changeIntelligence } = await import('./intelligence-store');
  const { constituentProposals } = await import('../intelligence');
  const { saveWorkspace } = await import('../workspace-store');
  const doc: IndexedDocument = {
    documentId: docId,
    filename: 'synthetic.txt',
    contentHash: 'a'.repeat(64),
    indexedAt: '2026-09-08',
    pages: [
      {
        number: 1,
        source: 'document',
        text: 'SYNTHETIC TEST DATA\nPortfolio companies as of 2026-06-30\nBoreal Robotics | 12.5%',
      },
    ],
    warnings: [],
  };
  const state = initialWorkspace(false);
  state.portfolio = {
    holdings: [holding('Visible', 'allowed', 100)],
    history: [],
    events: [],
    evidence: [],
    tasks: [],
    families: [],
    entities: [],
    accounts: [],
  };
  state.intelligence = {
    ...emptyIntelligence(),
    proposals: constituentProposals(doc, 'Visible', []),
  };
  const originalHoldings = structuredClone(state.portfolio.holdings);
  vi.mocked(readWorkspaceInTransaction).mockResolvedValue({
    state,
    revision: 1,
  });
  query.mockImplementation(async (sql: string, args: unknown[]) => {
    expect(args).toEqual([org, docId]);
    if (sql.includes('app_intelligence_documents'))
      return {
        rows: [
          {
            payload: encrypt(
              JSON.stringify(doc),
              'intelligence-index:' + org + ':' + docId,
            ),
          },
        ],
      };
    if (sql.includes('created_at FROM app_documents'))
      return { rows: [{ created_at: new Date('2026-09-01T12:00:00Z') }] };
    throw new Error('Unexpected fixture SQL');
  });
  await changeIntelligence(
    { ...ctx, role: 'admin', scope: null },
    {
      action: 'review',
      proposalId: state.intelligence.proposals[0].id,
      decision: 'accept',
    },
  );
  const saved = vi.mocked(saveWorkspace).mock.calls[0][2];
  expect(saved.portfolio?.holdings).toEqual(originalHoldings);
  expect(saved.portfolio?.events).toEqual([]);
  expect(saved.portfolio?.evidence[0]).toMatchObject({
    documentId: docId,
    page: 1,
    effectiveDate: '2026-06-30',
    reportedEffectiveDate: '2026-06-30',
    effectiveDateBasis: 'Source reported',
    receivedAt: '2026-09-01T12:00:00.000Z',
    status: 'Accepted',
  });
  expect(saved.riskData?.links[0].sourceId).toBe(
    saved.portfolio?.evidence[0].id,
  );
  expect(saved.riskData?.links[0].weight).toBe(0.125);
});

it('withholds all coverage metadata when an uncited indexed source is revoked during inference', async () => {
  vi.mocked(releasedDocumentIds).mockResolvedValue(new Set([docId, hiddenId]));
  query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes('processing_mode'))
      return { rows: [{ processing_mode: 'workflow' }] };
    expect(args).toEqual([org, [docId, hiddenId], 501, 500, 32 * 1024 * 1024]);
    return {
      rows: [docId, hiddenId].map((id) => ({
        document_id: id,
        payload: encrypt(
          JSON.stringify({
            documentId: id,
            filename:
              id === hiddenId
                ? 'PRIVATE_REVOKED_FILENAME.txt'
                : 'synthetic.txt',
            contentHash: 'a'.repeat(64),
            indexedAt: '2026-09-08',
            pages: [{ number: 1, source: 'document', text: page }],
            warnings:
              id === hiddenId ? ['Decode warning for private source'] : [],
          }),
          'intelligence-index:' + org + ':' + id,
        ),
      })),
    };
  });
  let modelFinished = false;
  vi.mocked(assertDocumentAccess).mockImplementation(async (_c, _ctx, id) => {
    if (modelFinished && id === hiddenId)
      throw new Error('Source grant revoked');
  });
  const send = vi.fn<typeof fetch>(async () => {
    modelFinished = true;
    return Response.json(body({ quotes: [], calculationIds: ['nav'] }));
  });
  await expect(
    askIntelligence(ctx, { question: 'Recorded NAV?', familyId: 'all' }, send),
  ).rejects.toThrow('Source grant revoked');
  expect(send).toHaveBeenCalledTimes(1);
});

describe('full bounded-library retrieval before model context selection', () => {
  function library(
    count: number,
    oldestText = 'Quartz Halcyon Memorandum: reported investment committee update.',
  ) {
    return Array.from({ length: count }, (_, index) => {
      const id = randomUUID();
      const doc: IndexedDocument = {
        documentId: id,
        filename:
          index === count - 1
            ? 'oldest-report.txt'
            : 'recent-' + index + '.txt',
        contentHash: 'c'.repeat(64),
        indexedAt: new Date(Date.UTC(2026, 8, 10, 0, 0, -index)).toISOString(),
        warnings: [],
        pages: [
          {
            number: 1,
            source: 'document',
            text:
              index === count - 1
                ? oldestText
                : 'Ordinary newer quarterly statement with no matching project.',
          },
        ],
      };
      return {
        document_id: id,
        page_count: 1,
        payload: encrypt(
          JSON.stringify(doc),
          'intelligence-index:' + org + ':' + id,
        ),
      };
    });
  }
  it('retrieves a matching original older than the previous 40-source window', async () => {
    const rows = library(95);
    query.mockResolvedValue({ rows });
    const result = await searchIntelligence(
      { ...ctx, scope: null },
      'Quartz Halcyon Memorandum',
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].documentId).toBe(rows[94].document_id);
    expect(result.coverage).toMatchObject({
      indexedDocuments: 95,
      searchedDocuments: 95,
      documentLimit: 500,
      characterLimit: 8_000_000,
      encryptedByteLimit: 32 * 1024 * 1024,
      truncated: false,
    });
    expect(query.mock.calls[0][1]).toEqual([
      org,
      null,
      501,
      500,
      32 * 1024 * 1024,
    ]);
  });
  it('passes the older relevant original to Ask while keeping model evidence bounded', async () => {
    const quote =
      'Quartz Halcyon Memorandum: reported investment committee update.';
    const rows = library(95, quote),
      oldest = rows[94].document_id;
    query.mockImplementation(async (sql: string) =>
      sql.includes('processing_mode')
        ? { rows: [{ processing_mode: 'workflow' }] }
        : { rows },
    );
    const send = fetcher(
      body({
        quotes: [{ sourceId: oldest + ':1:0', quote }],
        calculationIds: [],
      }),
    );
    const result = await askIntelligence(
      { ...ctx, scope: null },
      { question: 'Quartz Halcyon Memorandum', familyId: 'all' },
      send,
    );
    const outbound = JSON.parse(send.mock.calls[0][1]!.body as string);
    expect(outbound.passages).toHaveLength(1);
    expect(outbound.passages[0].id).toBe(oldest + ':1:0');
    expect(result.citations[0].documentId).toBe(oldest);
    expect(result.coverage.truncated).toBe(false);
  });
  it('ranks the whole allowed library then sends no more than twelve passages', async () => {
    const rows = library(
      95,
      'Ordinary newer quarterly statement with no matching project.',
    );
    query.mockImplementation(async (sql: string) =>
      sql.includes('processing_mode')
        ? { rows: [{ processing_mode: 'workflow' }] }
        : { rows },
    );
    const send = fetcher(body({ quotes: [], calculationIds: [] }));
    await askIntelligence(
      { ...ctx, scope: null },
      { question: 'Ordinary quarterly statement', familyId: 'all' },
      send,
    );
    const passages = JSON.parse(send.mock.calls[0][1]!.body as string).passages;
    expect(passages).toHaveLength(12);
    expect(
      passages.every(
        (passage: { text: string }) => passage.text.length <= 1800,
      ),
    ).toBe(true);
  });
  it('reports a real cap overflow without falsely marking an exactly full library truncated', async () => {
    const rows = library(INTELLIGENCE_DOCUMENT_LIMIT + 1);
    query.mockResolvedValue({
      rows: rows.slice(0, INTELLIGENCE_DOCUMENT_LIMIT),
    });
    expect(
      (await searchIntelligence({ ...ctx, scope: null }, 'Ordinary')).coverage
        .truncated,
    ).toBe(false);
    query.mockResolvedValue({ rows });
    const capped = await searchIntelligence(
      { ...ctx, scope: null },
      'Ordinary',
    );
    expect(capped.coverage).toMatchObject({
      searchedDocuments: 500,
      indexedDocuments: 500,
      truncated: true,
    });
    expect(capped.coverage.warnings.join(' ')).toContain(
      '500 accessible indexed documents',
    );
  });
  it('honors the SQL encrypted-byte bound and reports omitted source coverage', async () => {
    const rows = library(2);
    query.mockResolvedValue({ rows: [rows[0], { ...rows[1], payload: null }] });
    const result = await searchIntelligence(
      { ...ctx, scope: null },
      'Ordinary',
    );
    expect(result.coverage).toMatchObject({
      indexedDocuments: 2,
      searchedDocuments: 1,
      indexedPages: 2,
      searchedPages: 1,
      encryptedByteLimit: INTELLIGENCE_ENCRYPTED_BYTE_LIMIT,
      scannedEncryptedBytes: rows[0].payload.length,
      truncated: true,
    });
    expect(query.mock.calls[0][0]).toContain(
      'CASE WHEN b.ordinal<=$4 AND b.running_bytes<=$5 THEN i.payload ELSE NULL END',
    );
  });
});
