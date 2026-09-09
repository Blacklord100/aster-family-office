import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { ExtractedFact } from '../processing-contract';
import type {
  ConstituentProposal,
  IndexedDocument,
} from '../intelligence-contract';
import type { RiskData } from '../risk-contract';
import type { DemoCatalog } from './demo-corpus';
import type { WorkspaceContext } from './access';
const mocks = vi.hoisted(() => ({ verified: vi.fn(), indexed: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./demo-review-policy', () => ({
  hasDemoSourceVerification: mocks.verified,
}));
vi.mock('./intelligence-store', () => ({ loadIndexedDocument: mocks.indexed }));
vi.mock('./crypto', () => ({
  decrypt: () => Buffer.from('source'),
  sha256: () => 'a'.repeat(64),
}));
import {
  resolveDemoNewsHolding,
  resolveDemoNewsHoldingInTransaction,
} from './demo-news-routing';

const DOCUMENT = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const fact: ExtractedFact = {
  kind: 'news',
  investmentName: 'Acme Tools Ltd',
  effectiveDate: '2026-07-03',
  amount: null,
  currency: null,
  dueDate: null,
  summary: 'Acme Tools Ltd appointed a chief operating officer.',
  evidence: {
    page: 1,
    quote: 'Acme Tools Ltd appointed a chief operating officer on 3 July 2026.',
  },
};
const holdings = [
  { id: 'holding-1', name: 'Example Ventures III', familyId: 'family-1' },
];
const proposal: ConstituentProposal = {
  id: 'proposal-1',
  holdingId: 'holding-1',
  issuerId: 'issuer-1',
  issuerName: 'Acme Tools Ltd',
  weight: 0.28,
  asOfDate: '2026-06-30',
  status: 'accepted',
  createdAt: '2026-09-09T10:00:00Z',
  reviewedAt: '2026-09-09T10:01:00Z',
  citation: {
    documentId: DOCUMENT,
    page: 2,
    quote: 'Acme Tools Ltd | 28%',
    source: 'attachment 1; PDF page 1',
    contentHash: HASH,
  },
};
const document: IndexedDocument = {
  documentId: DOCUMENT,
  filename: 'disclosure.eml',
  contentHash: HASH,
  indexedAt: '2026-09-09T10:00:00Z',
  warnings: [],
  pages: [
    {
      number: 2,
      text: 'Fund: Example Ventures III\nCurrent underlying investments as of 30 June 2026\nAcme Tools Ltd | 28%',
      source: 'attachment 1; PDF page 1',
    },
  ],
};
const risk: RiskData = {
  version: 1,
  nodes: [
    { id: 'fund-node', name: 'Example Ventures III', kind: 'fund' },
    {
      id: 'issuer-node',
      name: 'Acme Tools Ltd',
      kind: 'asset',
      issuerId: 'issuer-1',
      issuerName: 'Acme Tools Ltd',
    },
  ],
  positions: [{ holdingId: 'holding-1', nodeId: 'fund-node' }],
  links: [
    {
      id: 'link-1',
      parentId: 'fund-node',
      childId: 'issuer-node',
      sourceId: 'intelligence-proposal-1',
      asOfDate: '2026-06-30',
      weight: 0.28,
    },
  ],
};
const resolve = (
  patch: Partial<ConstituentProposal> = {},
  source = document,
  graph = risk,
  item = fact,
) =>
  resolveDemoNewsHolding(
    item,
    'family-1',
    holdings,
    [{ ...proposal, ...patch }],
    [source],
    graph,
  );

describe('exact source-backed demo issuer news routing', () => {
  it('links unchanged issuer news to one same-family parent without changing facts or holdings', () => {
    const before = JSON.stringify({ fact, holdings, proposal, document, risk });
    expect(resolve()).toEqual({
      holdingId: 'holding-1',
      proposalId: 'proposal-1',
      disclosureDocumentId: DOCUMENT,
      disclosureAsOfDate: '2026-06-30',
    });
    expect(JSON.stringify({ fact, holdings, proposal, document, risk })).toBe(
      before,
    );
  });
  it.each(['pending', 'rejected'] as const)(
    'requires accepted mapping, not %s',
    (status) => expect(resolve({ status })).toBeNull(),
  );
  it('requires an actual review date and dated disclosure', () => {
    expect(resolve({ reviewedAt: null })).toBeNull();
    expect(resolve({ reviewedAt: 'invalid' })).toBeNull();
    expect(resolve({ asOfDate: null })).toBeNull();
    expect(resolve({ asOfDate: '2026-02-30' })).toBeNull();
  });
  it('does not use a later disclosure for earlier news; undated news may use a dated disclosure', () => {
    expect(resolve({ asOfDate: '2026-07-04' })).toBeNull();
    expect(
      resolve({}, document, risk, { ...fact, effectiveDate: null }),
    ).not.toBeNull();
  });
  it('does not match abbreviations or fuzzy issuer names', () =>
    expect(resolve({ issuerName: 'Acme Tools' })).toBeNull());
  it('never routes a financial fact through an underlying-company relationship', () => {
    for (const kind of ['valuation', 'capital_call', 'distribution'] as const)
      expect(resolve({}, document, risk, { ...fact, kind })).toBeNull();
  });
  it('requires a retained valid citation and exact original quote/page/hash', () => {
    expect(
      resolve({
        citation: undefined,
      } as unknown as Partial<ConstituentProposal>),
    ).toBeNull();
    expect(
      resolve({ citation: { ...proposal.citation, quote: '' } }),
    ).toBeNull();
    expect(resolve({ citation: { ...proposal.citation, page: 1 } })).toBeNull();
    expect(
      resolve({
        citation: { ...proposal.citation, contentHash: 'b'.repeat(64) },
      }),
    ).toBeNull();
    expect(
      resolve(
        {},
        {
          ...document,
          pages: [{ ...document.pages[0], text: 'Unrelated source' }],
        },
      ),
    ).toBeNull();
    expect(
      resolve({}, { ...document, warnings: ['Unreadable attachment'] }),
    ).toBeNull();
  });
  it('cannot route across families', () =>
    expect(
      resolveDemoNewsHolding(
        fact,
        'family-2',
        holdings,
        [proposal],
        [document],
        risk,
      ),
    ).toBeNull());
  it('holds multiple same-family parents even if the second citation is incomplete', () => {
    const other = {
      id: 'holding-2',
      name: 'Another Fund',
      familyId: 'family-1',
    };
    expect(
      resolveDemoNewsHolding(
        fact,
        'family-1',
        [...holdings, other],
        [
          proposal,
          {
            ...proposal,
            id: 'proposal-2',
            holdingId: other.id,
            citation: { ...proposal.citation, quote: '' },
          },
        ],
        [document],
        risk,
      ),
    ).toBeNull();
  });
  it('requires the accepted relationship to remain in the current risk graph', () => {
    expect(resolve({}, document, { ...risk, links: [] })).toBeNull();
    expect(resolve({}, document, { ...risk, positions: [] })).toBeNull();
    expect(
      resolve({}, document, {
        ...risk,
        links: [{ ...risk.links[0], asOfDate: '2026-07-01' }],
      }),
    ).toBeNull();
  });
  it('does not infer a constituent weight in order to route qualitative news', () => {
    const { weight: _weight, ...link } = risk.links[0];
    expect(
      resolve({ weight: null }, document, { ...risk, links: [link] }),
    ).not.toBeNull();
  });
});

describe('demo news disclosure loading boundary', () => {
  const ctx = {
    organizationId: 'demo-org',
    sessionId: 'demo-system',
    user: { id: 'demo-agent:demo-org' },
  } as WorkspaceContext;
  const catalog = {
    documents: [{ sha256: HASH, office_id: 'family-1' }],
  } as DemoCatalog;
  const query = vi.fn();
  const client = { query } as unknown as PoolClient;
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.verified.mockResolvedValue(true);
    mocks.indexed.mockResolvedValue(document);
    query.mockResolvedValue({
      rows: [{ content_hash: HASH, payload: Buffer.from('ciphertext') }],
    });
  });
  const run = (sourceCatalog = catalog) =>
    resolveDemoNewsHoldingInTransaction(
      client,
      ctx,
      fact,
      'family-1',
      holdings,
      [proposal],
      risk,
      sourceCatalog,
    );
  it('verifies the source audit, original bytes and encrypted index in the same tenant', async () => {
    expect(await run()).not.toBeNull();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('organization_id=$1'),
      ['demo-org', DOCUMENT],
    );
    expect(mocks.verified).toHaveBeenCalledWith(client, ctx, DOCUMENT);
  });
  it('rejects an unverified disclosure before loading bytes', async () => {
    mocks.verified.mockResolvedValue(false);
    expect(await run()).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects a different-family or unknown corpus disclosure', async () => {
    expect(
      await run({
        documents: [{ sha256: HASH, office_id: 'family-2' }],
      } as DemoCatalog),
    ).toBeNull();
    expect(await run({ documents: [] } as unknown as DemoCatalog)).toBeNull();
    expect(mocks.indexed).not.toHaveBeenCalled();
  });
  it('fails closed if the retained encrypted index no longer names the original bytes', async () => {
    mocks.indexed.mockResolvedValue({
      ...document,
      contentHash: 'b'.repeat(64),
    });
    await expect(run()).rejects.toThrow('DEMO_NEWS_DISCLOSURE_INDEX_CHANGED');
  });
});
