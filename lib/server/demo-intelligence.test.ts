import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { holdings as sampleHoldings } from '@/data';
import { initialWorkspace, type WorkspaceState } from '../workspace';
import type { IndexedDocument } from '../intelligence-contract';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({}));
vi.mock('./db', () => ({ withTenant: vi.fn(), pool: { query: vi.fn() } }));
vi.mock('./audit', () => ({ audit: vi.fn() }));
vi.mock('./demo-corpus', () => ({
  demoActorId: (id: string) => 'demo-agent:' + id,
  loadDemoCatalog: vi.fn(),
}));
vi.mock('./demo-review-policy', () => ({ hasDemoSourceVerification: vi.fn() }));
vi.mock('./intelligence-store', () => ({
  indexDocument: vi.fn(),
  loadIndexedDocument: vi.fn(),
}));
vi.mock('../workspace-store', () => ({
  readWorkspaceInTransaction: vi.fn(),
  saveWorkspace: vi.fn(),
}));
import { withTenant } from './db';
import { audit } from './audit';
import { loadDemoCatalog } from './demo-corpus';
import { hasDemoSourceVerification } from './demo-review-policy';
import { indexDocument, loadIndexedDocument } from './intelligence-store';
import { readWorkspaceInTransaction, saveWorkspace } from '../workspace-store';
import { encrypt, sha256 } from './crypto';
import {
  demoConstituentProposals,
  indexDemoJobSources,
} from './demo-intelligence';

const org = randomUUID(),
  docId = randomUUID(),
  jobId = randomUUID();
const holding = {
  ...sampleHoldings[0],
  id: 'mistral',
  name: 'Mistral Grove Ventures III',
  familyId: 'alder-house',
};
const text =
  'FICTIONAL DEMO ONLY\nCurrent portfolio disclosure\nMistral Grove Ventures III: investor NAV as of 30 June 2026 is EUR 1,237,041.29.\nCurrent underlying investments as of 30 June 2026. These are percentages of fund NAV, not investor cash\namounts.\nUnderlying issuer\nShare of fund NAV\nAsterfoil Sensor Systems Ltd\n28.0%\nMossbridge Battery Systems Ltd\nNot disclosed\nOther holdings are not named. The unresolved 72.0% must remain unresolved; it is not all attributable to the\nsecond named company.\n';
const doc: IndexedDocument = {
  documentId: docId,
  filename: 'disclosure.eml',
  contentHash: sha256(text),
  indexedAt: '2026-09-10T00:00:00Z',
  warnings: [],
  pages: [
    { number: 2, source: 'attachment disclosure.pdf · PDF page 1', text },
  ],
};
const query = vi.fn();
let state: WorkspaceState;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ASTER_ENABLE_DEMO', 'true');
  vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 6).toString('base64'));
  vi.mocked(hasDemoSourceVerification).mockResolvedValue(true);
  vi.mocked(loadDemoCatalog).mockResolvedValue({
    offices: [],
    mailboxes: [],
    documents: [
      {
        path: 'fixtures/emails/source.eml',
        office_id: holding.familyId,
        mailbox_id: 'mail',
        sha256: doc.contentHash,
      },
    ],
  });
  vi.mocked(withTenant).mockImplementation(async (_org, callback) =>
    callback({ query } as unknown as PoolClient),
  );
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT d.id AS document_id'))
      return {
        rowCount: 1,
        rows: [
          {
            document_id: docId,
            content_hash: doc.contentHash,
            payload: encrypt(text, 'document:' + org + ':' + docId),
            created_at: new Date('2026-09-10T00:00:00Z'),
            indexed: true,
          },
        ],
      };
    return { rowCount: 0, rows: [] };
  });
  state = {
    ...initialWorkspace(false),
    portfolio: {
      holdings: [holding],
      history: [],
      events: [],
      evidence: [],
      families: [],
      entities: [],
      accounts: [],
      tasks: [],
    },
    demo: {
      runId: org,
      autoPublish: true,
      name: 'Synthetic',
      startedAt: '2026-09-10T00:00:00Z',
      sourceFiles: 100,
      fxPolicy: { source: 'Synthetic', ratesToEUR: { EUR: '1' } },
    },
  };
  vi.mocked(readWorkspaceInTransaction).mockImplementation(async () => ({
    state,
    revision: 1,
  }));
  vi.mocked(loadIndexedDocument).mockResolvedValue(doc);
});

describe('source-backed synthetic constituent attribution', () => {
  it('extracts verbatim vertical disclosure rows and preserves unknown residuals', () => {
    const rows = demoConstituentProposals(doc, holding.familyId, [holding], []);
    expect(
      rows.map((row) => [row.issuerName, row.weight, row.asOfDate]),
    ).toEqual([
      ['Asterfoil Sensor Systems Ltd', 0.28, '2026-06-30'],
      ['Mossbridge Battery Systems Ltd', null, '2026-06-30'],
    ]);
    for (const row of rows) {
      expect(text).toContain(row.citation.quote);
      expect(row.citation.page).toBe(2);
      expect(row.citation.contentHash).toBe(doc.contentHash);
    }
    expect(rows.some((row) => row.weight === 0.72)).toBe(false);
  });
  it('requires the exact parent on the same page and in the routed family', () => {
    expect(
      demoConstituentProposals(doc, 'another-family', [holding], []),
    ).toEqual([]);
    expect(
      demoConstituentProposals(
        {
          ...doc,
          pages: [
            {
              ...doc.pages[0],
              text: text.replace(holding.name, 'Unrelated fund'),
            },
          ],
        },
        holding.familyId,
        [holding],
        [],
      ),
    ).toEqual([]);
    expect(
      demoConstituentProposals(
        {
          ...doc,
          pages: [
            {
              number: 1,
              source: 'Email',
              text: holding.name + ': disclosure attached.',
            },
            {
              ...doc.pages[0],
              text: text.replace(holding.name, 'Unrelated fund'),
            },
          ],
        },
        holding.familyId,
        [holding],
        [],
      ),
    ).toEqual([]);
    expect(
      demoConstituentProposals(
        doc,
        holding.familyId,
        [
          holding,
          { ...holding, id: 'second-family-position', familyId: 'foreign' },
        ],
        [],
      ),
    ).toEqual([]);
  });
  it('preserves conflicting same-page rows for review instead of choosing the first weight', () => {
    const conflicting = {
      ...doc,
      pages: [
        {
          ...doc.pages[0],
          text: text.replace(
            'Mossbridge Battery Systems Ltd\nNot disclosed',
            'Asterfoil Sensor Systems Ltd\n35.0%',
          ),
        },
      ],
    };
    const rows = demoConstituentProposals(
      conflicting,
      holding.familyId,
      [holding],
      [],
    );
    expect(rows.map((row) => row.weight)).toEqual([0.28, 0.35]);
  });
  it('requires an explicit valid date and rejects invalid/negative rows', () => {
    for (const changed of [
      text.replace(
        'Current underlying investments as of 30 June 2026',
        'Current underlying investments',
      ),
      text.replace(
        'Current underlying investments as of 30 June 2026',
        'Current underlying investments as of 31 February 2026',
      ),
    ])
      expect(
        demoConstituentProposals(
          { ...doc, pages: [{ ...doc.pages[0], text: changed }] },
          holding.familyId,
          [holding],
          [],
        ),
      ).toEqual([]);
    expect(
      demoConstituentProposals(
        {
          ...doc,
          pages: [
            {
              ...doc.pages[0],
              text: text.replace(
                'Asterfoil Sensor Systems Ltd',
                'Prospective Asterfoil Sensor Systems Ltd',
              ),
            },
          ],
        },
        holding.familyId,
        [holding],
        [],
      ),
    ).toEqual([]);
  });
  it('keeps the established pipe-delimited parser for standard disclosures', () => {
    const standard = {
      ...doc,
      pages: [
        {
          ...doc.pages[0],
          text:
            holding.name +
            ': disclosure\nCurrent underlying investments as of 2026-06-30\nCompany | Weight\nAcorn Labs Ltd | 12.5%\nUnnamed Company Ltd | Not disclosed',
        },
      ],
    };
    expect(
      demoConstituentProposals(standard, holding.familyId, [holding], []).map(
        (row) => row.weight,
      ),
    ).toEqual([0.125, null]);
  });
});

describe('autonomous demo indexing boundary', () => {
  it('does nothing when demo automation is disabled or the system source verification is missing', async () => {
    vi.stubEnv('ASTER_ENABLE_DEMO', 'false');
    expect(await indexDemoJobSources(org, jobId)).toMatchObject({
      indexed: false,
    });
    expect(withTenant).not.toHaveBeenCalled();
    vi.stubEnv('ASTER_ENABLE_DEMO', 'true');
    vi.mocked(hasDemoSourceVerification).mockResolvedValue(false);
    await indexDemoJobSources(org, jobId);
    expect(indexDocument).not.toHaveBeenCalled();
    expect(saveWorkspace).not.toHaveBeenCalled();
  });
  it('rejects originals outside the immutable synthetic corpus even with a matching audit', async () => {
    vi.mocked(loadDemoCatalog).mockResolvedValue({
      offices: [],
      mailboxes: [],
      documents: [],
    });
    await indexDemoJobSources(org, jobId);
    expect(indexDocument).not.toHaveBeenCalled();
    expect(saveWorkspace).not.toHaveBeenCalled();
  });
  it('creates risk links from disclosed amounts only and retains clickable demo originals', async () => {
    const result = await indexDemoJobSources(org, jobId);
    expect(result).toEqual({ indexed: true, proposed: 2, accepted: 2 });
    const saved = vi.mocked(saveWorkspace).mock.calls[0][2];
    expect(saved.riskData?.links.map((link) => link.weight)).toEqual([
      0.28,
      undefined,
    ]);
    expect(saved.portfolio?.evidence).toHaveLength(2);
    expect(saved.portfolio?.evidence[0]).toMatchObject({
      documentId: docId,
      synthetic: false,
      demoSource: true,
      page: 2,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.anything(),
      org,
      'demo-agent:' + org,
      'demo.intelligence_complete',
      docId,
      expect.objectContaining({ humanReview: false, accepted: 2 }),
    );
  });
  it('keeps proposals pending when OCR/decoding warnings need source review', async () => {
    vi.mocked(loadIndexedDocument).mockResolvedValue({
      ...doc,
      warnings: ['Local OCR was used; visual review required.'],
    });
    const result = await indexDemoJobSources(org, jobId);
    expect(result).toEqual({ indexed: true, proposed: 2, accepted: 0 });
    const saved = vi.mocked(saveWorkspace).mock.calls[0][2];
    expect(
      saved.intelligence?.proposals.every(
        (proposal) => proposal.status === 'pending',
      ),
    ).toBe(true);
    expect(saved.riskData).toBeUndefined();
  });
  it('does not duplicate a previously proposed/accepted relationship', async () => {
    await indexDemoJobSources(org, jobId);
    state = vi.mocked(saveWorkspace).mock.calls[0][2];
    vi.mocked(saveWorkspace).mockClear();
    expect(await indexDemoJobSources(org, jobId)).toEqual({
      indexed: true,
      proposed: 0,
      accepted: 0,
    });
    expect(saveWorkspace).not.toHaveBeenCalled();
  });
});
