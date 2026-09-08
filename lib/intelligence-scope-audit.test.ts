import { describe, it, expect } from 'vitest';
import { scopeWorkspace } from './data-scope';
import { initialWorkspace, deriveWorkspace } from './workspace';
import { emptyIntelligence } from './intelligence-contract';
import { buildTotalExposure } from './risk-engine';
import { acceptConstituent, constituentProposals } from './intelligence';
import type { IndexedDocument } from './intelligence-contract';
describe('independent intelligence and family scope audit', () => {
  it('removes global intelligence, inaccessible originals and foreign graph branches without mutating source state', () => {
    const state = initialWorkspace(true),
      data = deriveWorkspace(state),
      own = data.holdings[0],
      foreign = data.holdings.find((h) => h.familyId !== own.familyId)!;
    state.portfolio = {
      ...data,
      evidence: data.evidence.map((e) => ({
        ...e,
        documentId:
          e.holdingId === own.id
            ? 'unreleased-own-original'
            : 'foreign-original',
      })),
    };
    state.intelligence = {
      ...emptyIntelligence(),
      contacts: [
        {
          id: 'private',
          name: 'PRIVATE_OTHER_CONTACT',
          email: 'private@example.invalid',
          notes: 'PRIVATE_GLOBAL_NOTES',
          familyId: foreign.familyId,
          holdingId: foreign.id,
          managerId: null,
          updatedAt: '2026-09-08',
        },
      ],
    };
    state.riskData = {
      version: 1,
      nodes: [
        { id: 'own-fund', name: 'Own fund', kind: 'fund' },
        {
          id: 'own-company',
          name: 'Own company',
          issuerId: 'own-company',
          kind: 'asset',
          sourceId: 'unreleased-source',
        },
        { id: 'foreign-private', name: 'PRIVATE_FOREIGN_GRAPH', kind: 'asset' },
      ],
      links: [
        {
          id: 'own-link',
          parentId: 'own-fund',
          childId: 'own-company',
          weight: 0.25,
          sourceId: 'unreleased-source',
        },
      ],
      positions: [
        { holdingId: own.id, nodeId: 'own-fund' },
        { holdingId: foreign.id, nodeId: 'foreign-private' },
      ],
    };
    const view = scopeWorkspace(state, {
      familyIds: [own.familyId],
      entityIds: [own.entityId],
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('PRIVATE_OTHER_CONTACT');
    expect(serialized).not.toContain('PRIVATE_GLOBAL_NOTES');
    expect(serialized).not.toContain('PRIVATE_FOREIGN_GRAPH');
    expect(serialized).not.toContain('unreleased-source');
    expect(serialized).not.toContain('foreign-original');
    expect(view.intelligence).toBeUndefined();
    expect(state.intelligence.contacts).toHaveLength(1);
    expect(view.riskData?.positions).toHaveLength(1);
  });
  it('aggregates one canonical issuer across two funds without adding child NAV to parent NAV', () => {
    const source = deriveWorkspace(initialWorkspace(true)).holdings;
    const holdings = [
      { ...source[0], id: 'fund-one', name: 'Synthetic One', valueEUR: 100 },
      { ...source[1], id: 'fund-two', name: 'Synthetic Two', valueEUR: 200 },
    ];
    const doc: IndexedDocument = {
      documentId: '654e354d-d24f-4a8f-b9cb-00eec4baf512',
      filename: 'synthetic.txt',
      contentHash: 'a'.repeat(64),
      indexedAt: '2026-09-08',
      pages: [
        {
          number: 1,
          source: 'document',
          text: 'SYNTHETIC TEST DATA\nPortfolio companies\nShared Issuer | 25%',
        },
      ],
      warnings: [],
    };
    const state = emptyIntelligence();
    state.aliases = [{ id: 'shared', name: 'Shared Issuer', aliases: [] }];
    state.proposals = [
      ...constituentProposals(doc, 'fund-one', state.aliases),
      ...constituentProposals(doc, 'fund-two', state.aliases),
    ];
    const one = acceptConstituent(
      state,
      undefined,
      state.proposals[0].id,
      holdings,
    );
    const two = acceptConstituent(
      one.intelligence,
      one.riskData,
      state.proposals[1].id,
      holdings,
    );
    const result = buildTotalExposure(holdings, two.riskData);
    expect(result.totalValueEUR).toBe(300);
    expect(result.lots.reduce((n, l) => n + l.valueEUR, 0)).toBe(300);
    expect(result.issuerExposure.find((e) => e.id === 'shared')).toMatchObject({
      valueEUR: 75,
      holdingCount: 2,
    });
    expect(result.coverage.issuerUnknownEUR).toBe(225);
  });
});
