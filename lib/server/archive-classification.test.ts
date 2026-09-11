import { describe, expect, it } from 'vitest';
import { archiveClassification } from './archive-classification';
import type { PortfolioRecords } from '../workspace';
const portfolio = {
  holdings: [
    { id: 'holding-a', familyId: 'family-a', name: 'Fund A' },
    { id: 'holding-b', familyId: 'family-b', name: 'Fund B' },
  ],
  families: [
    { id: 'family-a', name: 'Family A' },
    { id: 'family-b', name: 'Family B' },
  ],
  evidence: [
    {
      id: 'one',
      documentId: 'doc',
      status: 'Accepted',
      holdingId: 'holding-a',
      familyId: 'family-a',
    },
  ],
} as PortfolioRecords;
describe('immutable archive-time classification', () => {
  it('uses only accepted source associations and resolves unique identifiers', () => {
    expect(archiveClassification('doc', portfolio)).toMatchObject({
      family: { id: 'family-a', name: 'Family A' },
      investment: { id: 'holding-a', name: 'Fund A' },
    });
    expect(archiveClassification('different', portfolio)).not.toHaveProperty(
      'family',
    );
  });
  it('never classifies from a pending proposal, missing holding or inconsistent family association', () => {
    for (const evidence of [
      [{ ...portfolio.evidence[0], status: 'Needs review' }],
      [{ ...portfolio.evidence[0], holdingId: 'missing' }],
      [{ ...portfolio.evidence[0], familyId: 'family-b' }],
    ])
      expect(
        archiveClassification('doc', {
          ...portfolio,
          evidence,
        } as PortfolioRecords),
      ).not.toHaveProperty('investment');
  });
  it('keeps consolidated multi-family sources unassigned and does not merge identical investment names', () => {
    const shared = {
      ...portfolio,
      holdings: portfolio.holdings.map((h) => ({
        ...h,
        name: 'Same fund label',
      })),
      evidence: [
        ...portfolio.evidence,
        {
          ...portfolio.evidence[0],
          id: 'two',
          holdingId: 'holding-b',
          familyId: 'family-b',
        },
      ],
    };
    const classification = archiveClassification('doc', shared);
    expect(classification).not.toHaveProperty('family');
    expect(classification).not.toHaveProperty('investment');
  });
});
