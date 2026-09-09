import { describe, it, expect } from 'vitest';
import {
  acceptConstituent,
  constituentProposals,
  issuerKey,
  resolveIssuer,
  validateAliases,
  validateCitation,
  searchDocuments,
  recordedCalculations,
} from './intelligence';
import {
  emptyIntelligence,
  type IndexedDocument,
} from './intelligence-contract';
import { emptyRiskData } from './risk-contract';
import type { Holding } from '../data/types';
import { holdings as recordedHoldings } from '../data/portfolio';
const document: IndexedDocument = {
  documentId: '85b40b73-f0d4-49ba-966c-09b746522539',
  filename: 'synthetic.txt',
  contentHash: 'a'.repeat(64),
  indexedAt: '2026-09-08',
  pages: [
    {
      number: 1,
      source: 'document',
      text: 'SYNTHETIC TEST DATA\nPortfolio companies as of 2026-06-30\nAsteria Solar Ltd | 12.5%\nBoreal Robotics SA | undisclosed\n',
    },
  ],
  warnings: [],
};
const holdings = [
  { id: 'fund-a', name: 'Synthetic Fund A' },
  { id: 'fund-b', name: 'Synthetic Fund B' },
];
const proposals = () => constituentProposals(document, 'fund-a', []);
describe('sourced issuer proposals and graph review', () => {
  it('normalizes punctuation without merging legal entities or share classes', () => {
    expect(issuerKey(' ASTERIA, Solar Ltd ')).toBe('asteria solar ltd');
    expect(issuerKey('Asteria Solar Ltd')).not.toBe(
      issuerKey('Asteria Solar SA'),
    );
    expect(
      resolveIssuer('Asteria Solar SA', [
        { id: 'one', name: 'Asteria Solar Ltd', aliases: [] },
      ]),
    ).toBeNull();
  });
  it('requires explicit nonconflicting issuer aliases', () => {
    expect(() =>
      validateAliases([
        { id: 'a', name: 'Alpha Ltd', aliases: ['ALPHA CO'] },
        { id: 'b', name: 'Other', aliases: ['alpha co'] },
      ]),
    ).toThrow('different issuer');
    expect(
      resolveIssuer('Alpha Co', [
        { id: 'a', name: 'Alpha Ltd', aliases: ['Alpha Co'] },
      ])?.id,
    ).toBe('a');
  });
  it('preserves reported weights, unknowns, dates and exact page quotations', () => {
    const result = proposals();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      issuerName: 'Asteria Solar Ltd',
      weight: 0.125,
      asOfDate: '2026-06-30',
    });
    expect(result[1].weight).toBeNull();
    for (const p of result) {
      expect(document.pages[0].text).toContain(p.citation.quote);
      expect(() => validateCitation(p, document)).not.toThrow();
    }
  });
  it('retains an explicitly dated section across a generic table header', () => {
    const pages = [
      {
        number: 1,
        source: 'document',
        text: 'SYNTHETIC TEST DATA\nPortfolio companies as of 2026-06-30\nCompany | Weight\nNew Synthetic Issuer | 12.5%',
      },
    ];
    const result = constituentProposals({ ...document, pages }, 'fund-a', []);
    expect(result[0].asOfDate).toBe('2026-06-30');
    expect(result[0].citation.quote).toBe(
      'Portfolio companies as of 2026-06-30\nCompany | Weight\nNew Synthetic Issuer | 12.5%',
    );
  });
  it('does not extract from illustrative, withdrawn or unrelated narrative rows', () => {
    for (const text of [
      'Illustrative portfolio companies\nInvented Ltd | 99%',
      'Portfolio companies\nWithdrawn\nInvented Ltd | 99%',
      'An email says a company grew 20%.',
    ])
      expect(
        constituentProposals(
          { ...document, pages: [{ number: 1, source: 'document', text }] },
          'fund-a',
          [],
        ),
      ).toEqual([]);
  });
  it('does not let a table header reactivate an excluded disclosure', () => {
    for (const marker of [
      'Illustrative schedule',
      'Withdrawn holdings',
      'Hypothetical example',
    ]) {
      const pages = [
        {
          number: 1,
          source: 'document',
          text:
            marker +
            '\nCompany | Weight\nFictional Issuer | 99%\nPortfolio companies\nAnother Fictional Issuer | 50%',
        },
      ];
      expect(
        constituentProposals({ ...document, pages }, 'fund-a', []),
      ).toEqual([]);
    }
    const pages = [
      {
        number: 1,
        source: 'document',
        text: 'Illustrative schedule\nCompany | Weight\nFictional Issuer | 99%\nActual portfolio companies as of 2026-06-30\nReal Reported Issuer | 10%',
      },
    ];
    expect(
      constituentProposals({ ...document, pages }, 'fund-a', []).map(
        (p) => p.issuerName,
      ),
    ).toEqual(['Real Reported Issuer']);
  });
  it('does not repair impossible percentages or infer equal weights', () => {
    expect(
      constituentProposals(
        {
          ...document,
          pages: [
            {
              number: 1,
              source: 'document',
              text: 'Constituents\nOversized Co | 101%\nUnknown Co | unknown',
            },
          ],
        },
        'fund-a',
        [],
      ).map((p) => p.weight),
    ).toEqual([null]);
  });
  it('refuses citations from a replaced source or different page', () => {
    const p = proposals()[0];
    expect(() =>
      validateCitation(p, { ...document, contentHash: 'b'.repeat(64) }),
    ).toThrow('citation');
    expect(() =>
      validateCitation(
        { ...p, citation: { ...p.citation, page: 2 } },
        document,
      ),
    ).toThrow('citation');
  });
  it('keeps unknown-weight links unresolved and performs no valuation mutation', () => {
    const state = emptyIntelligence();
    state.proposals = [proposals()[1]];
    const accepted = acceptConstituent(
      state,
      undefined,
      state.proposals[0].id,
      holdings,
    );
    expect(accepted.riskData.links[0].weight).toBeUndefined();
    expect(accepted.intelligence.proposals[0].status).toBe('accepted');
    expect(state.proposals[0].status).toBe('pending');
    expect(accepted.riskData.positions).toHaveLength(1);
  });
  it('uses one reviewed canonical issuer across separate parent funds', () => {
    const state = emptyIntelligence();
    state.aliases = [
      { id: 'solar', name: 'Asteria Solar Ltd', aliases: ['Asteria Solar'] },
    ];
    const first = { ...proposals()[0], issuerId: 'solar' };
    state.proposals = [
      first,
      {
        ...first,
        id: 'second-proposal',
        holdingId: 'fund-b',
        issuerName: 'Asteria Solar',
      },
    ];
    const one = acceptConstituent(state, undefined, first.id, holdings);
    const two = acceptConstituent(
      one.intelligence,
      one.riskData,
      'second-proposal',
      holdings,
      'solar',
    );
    expect(two.riskData.nodes.filter((n) => n.kind === 'asset')).toHaveLength(
      1,
    );
    expect(two.riskData.links).toHaveLength(2);
  });
  it('rejects overallocated or incompatible graphs before acceptance', () => {
    const state = emptyIntelligence();
    state.proposals = [{ ...proposals()[0], weight: 0.3 }];
    const risk = emptyRiskData();
    risk.nodes = [
      { id: 'root', name: 'Fund', kind: 'fund' },
      { id: 'old', name: 'Old company', kind: 'asset' },
    ];
    risk.positions = [{ holdingId: 'fund-a', nodeId: 'root' }];
    risk.links = [
      { id: 'old-link', parentId: 'root', childId: 'old', weight: 0.8 },
    ];
    expect(() =>
      acceptConstituent(state, risk, state.proposals[0].id, holdings),
    ).toThrow('invalid graph');
    risk.nodes[0].kind = 'asset';
    expect(() =>
      acceptConstituent(state, risk, state.proposals[0].id, holdings),
    ).toThrow('direct asset');
  });
  it('refuses unavailable holdings, duplicate acceptance and silent weight replacement', () => {
    const state = emptyIntelligence();
    state.proposals = [proposals()[0]];
    expect(() =>
      acceptConstituent(state, undefined, state.proposals[0].id, []),
    ).toThrow('accessible');
    const one = acceptConstituent(
      state,
      undefined,
      state.proposals[0].id,
      holdings,
    );
    expect(() =>
      acceptConstituent(
        one.intelligence,
        one.riskData,
        state.proposals[0].id,
        holdings,
      ),
    ).toThrow('no longer pending');
    one.intelligence.proposals.push({
      ...one.intelligence.proposals[0],
      id: 'correction',
      status: 'pending',
      weight: 0.2,
    });
    expect(() =>
      acceptConstituent(one.intelligence, one.riskData, 'correction', holdings),
    ).toThrow('already has a mapping');
  });
  it('finds later-page passages and retains their page/source identity', () => {
    const docs = [
      {
        ...document,
        pages: [
          ...document.pages,
          {
            number: 2,
            source: 'attachment 1; PDF page 1',
            text: 'Boreal Robotics mandate: provide a dated ownership schedule.',
          },
        ],
      },
    ];
    const found = searchDocuments(docs, 'ownership schedule');
    expect(found[0]).toMatchObject({
      page: 2,
      source: 'attachment 1; PDF page 1',
    });
    expect(found[0].quote).toContain('ownership schedule');
  });
  it('calculates cents from the supplied records only', () => {
    const rows = [
      {
        id: 'one',
        name: 'One',
        valueEUR: 0.1,
        assetClass: 'Cash',
        unfundedCommitmentEUR: 2.21,
        valuationDate: '2026-06-30',
      },
      {
        id: 'two',
        name: 'Two',
        valueEUR: 0.2,
        assetClass: 'Public equities',
        unfundedCommitmentEUR: 0,
        valuationDate: '2026-07-31',
      },
    ] as Holding[];
    const result = recordedCalculations(rows);
    expect(result[0].valueEUR).toBe(0.3);
    expect(result[1].valueEUR).toBe(0.1);
    expect(result[2].valueEUR).toBe(2.21);
    expect(result[0].holdingIds).toEqual(['one', 'two']);
  });
});

it('keeps an excluded disclosure excluded across page boundaries', () => {
  const pages = [
    {
      number: 1,
      source: 'document; PDF page 1',
      text: 'SYNTHETIC TEST DATA\nIllustrative holdings only',
    },
    {
      number: 2,
      source: 'document; PDF page 2',
      text: 'Company | Weight\nFictional Issuer | 99%',
    },
  ];
  expect(constituentProposals({ ...document, pages }, 'fund-a', [])).toEqual(
    [],
  );
});

it('distinguishes a recorded cash balance from unknown liquidity or inferred classification', () => {
  const cash = {
    ...recordedHoldings[0],
    id: 'cash',
    assetClass: 'Cash' as const,
    valueEUR: 100,
    liquidityStatus: 'unknown' as const,
    assetClassStatus: 'inferred' as const,
  };
  const calculation = recordedCalculations([cash]).find(
    (row) => row.id === 'cash',
  );
  expect(calculation).toMatchObject({
    valueEUR: 100,
    liquidityCoverage: {
      complete: false,
      knownHoldingCount: 0,
      totalHoldingCount: 1,
      unknownHoldingIds: ['cash'],
    },
  });
  expect(calculation?.basis).toContain(
    'neither available liquidity nor lockup',
  );
  expect(calculation?.basis).toContain('inferred, not source-confirmed');
});

it('omits unavailable recorded calculations and labels known partial subtotals', () => {
  const unknown = {
    ...recordedHoldings[0],
    id: 'unknown',
    valueEUR: 999,
    unfundedCommitmentEUR: 777,
    valuationStatus: 'unknown' as const,
    unfundedStatus: 'unknown' as const,
  };
  expect(recordedCalculations([unknown])).toEqual([]);
  expect(recordedCalculations([])).toEqual([]);
  const known = {
    ...recordedHoldings[0],
    id: 'known',
    valueEUR: 100,
    unfundedCommitmentEUR: 0,
  };
  const calculated = recordedCalculations([known, unknown]);
  expect(calculated.find((row) => row.id === 'nav')).toMatchObject({
    valueEUR: 100,
    coverage: {
      knownHoldingCount: 1,
      totalHoldingCount: 2,
      complete: false,
      unknownHoldingIds: ['unknown'],
    },
  });
  expect(calculated.find((row) => row.id === 'unfunded')).toMatchObject({
    valueEUR: 0,
    coverage: { complete: false },
  });
  expect(calculated.find((row) => row.id === 'unfunded')?.basis).toContain(
    'Missing values are excluded',
  );
});
