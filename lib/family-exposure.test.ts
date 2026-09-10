import { describe, expect, it } from 'vitest';
import { holdings as sampleHoldings } from '../data/portfolio';
import type { Holding } from '../data/types';
import type { RiskData, RiskNode, RiskScenario } from './risk-contract';
import {
  emptyHistoryLifecycle,
  type HistoryLifecycleRecord,
} from './portfolio-history-lifecycle-contract';
import { historyPositionDetails } from './portfolio-history-lifecycle';
import { buildTotalExposure, runStressScenario } from './risk-engine';
import {
  currentRiskHoldings,
  familyIssuerExposure,
  familyStressExposure,
  managerIssuerMatrix,
} from './family-exposure';

const families = [
  { id: 'a', name: 'Family A' },
  { id: 'b', name: 'Family B' },
];
const holding = (
  id: string,
  familyId: string,
  valueEUR: number,
  overrides: Partial<Holding> = {},
): Holding => ({
  ...sampleHoldings[0],
  id,
  name: id,
  familyId,
  valueEUR,
  unfundedCommitmentEUR: 0,
  valuationDate: '2026-09-01',
  sourceId: `source:${id}`,
  ...overrides,
});
const node = (
  id: string,
  kind: RiskNode['kind'],
  overrides: Partial<RiskNode> = {},
): RiskNode => ({
  id,
  name: id,
  kind,
  sourceId: `source:${id}`,
  asOfDate: '2026-09-01',
  assetClass: 'Public equities',
  currency: 'EUR',
  ...overrides,
});
const scenario: RiskScenario = {
  id: 'test',
  name: 'Shared shock',
  description: 'Hypothetical known-answer fixture',
  assetClassShocks: { 'Public equities': -0.2 },
  capitalCallRate: 0,
};

function fixture() {
  const holdings = [
    holding('direct-a', 'a', 100),
    holding('fund-a', 'a', 200),
    holding('fund-b', 'b', 400),
  ];
  const data: RiskData = {
    version: 1,
    nodes: [
      node('direct', 'asset', {
        issuerId: 'company',
        issuerName: 'Shared Company',
        managerId: 'manager-1',
        managerName: 'Manager One',
      }),
      node('fund-one', 'fund', {
        managerId: 'manager-1',
        managerName: 'Manager One',
      }),
      node('fund-two', 'fund', {
        managerId: 'manager-2',
        managerName: 'Manager Two',
      }),
      node('company', 'asset', {
        issuerId: 'company',
        issuerName: 'Shared Company',
      }),
      node('other', 'asset', {
        issuerId: 'other',
        issuerName: 'Other Company',
      }),
    ],
    positions: [
      { holdingId: 'direct-a', nodeId: 'direct' },
      { holdingId: 'fund-a', nodeId: 'fund-one' },
      { holdingId: 'fund-b', nodeId: 'fund-two' },
    ],
    links: [
      {
        id: 'one-company',
        parentId: 'fund-one',
        childId: 'company',
        weight: 0.25,
      },
      {
        id: 'two-company',
        parentId: 'fund-two',
        childId: 'company',
        weight: 0.5,
      },
      { id: 'two-other', parentId: 'fund-two', childId: 'other' },
    ],
  };
  const exposure = buildTotalExposure(holdings, data, '2026-09-10');
  return { holdings, data, exposure };
}

describe('family exposure projections', () => {
  it('excludes only sourced exits and future acquisitions while honoring corrections', () => {
    const holdings = [
      holding('exited', 'a', 100),
      holding('future', 'a', 200),
      holding('unknown', 'b', 300),
    ];
    const lifecycle = emptyHistoryLifecycle();
    const record = (
      id: string,
      holding: Holding,
      kind: HistoryLifecycleRecord['kind'],
      date: string,
    ): HistoryLifecycleRecord => ({
      id,
      holdingId: holding.id,
      kind,
      effectiveDate: date,
      recordedAt: '2026-09-01T00:00:00Z',
      actorId: 'qa',
      registeredDetails: historyPositionDetails(holding),
      details: kind === 'opened' ? historyPositionDetails(holding) : null,
      sourceId: 'qa-source',
      documentId: 'qa-doc',
      sourceSha256: 'qa-hash',
      page: 1,
      quote: 'Explicit synthetic lifecycle evidence',
      reason: 'Synthetic known-answer regression',
      correctionOf: null,
    });
    lifecycle.records = [
      record('exit', holdings[0], 'closed', '2026-08-01'),
      record('entry', holdings[1], 'opened', '2027-01-01'),
    ];
    const first = currentRiskHoldings(holdings, lifecycle, '2026-09-10');
    expect(first.holdings.map((holding) => holding.id)).toEqual(['unknown']);
    expect(first.excluded).toHaveLength(2);
    expect(first.unknownOwnership.map((holding) => holding.id)).toEqual([
      'unknown',
    ]);
    lifecycle.records.push({
      ...record('correct-exit', holdings[0], 'closed', '2027-02-01'),
      correctionOf: 'exit',
    });
    expect(
      currentRiskHoldings(holdings, lifecycle, '2026-09-10').holdings.map(
        (holding) => holding.id,
      ),
    ).toEqual(['exited', 'unknown']);
  });

  it('partitions direct and indirect terminal paths without adding fund wrappers', () => {
    const { holdings, exposure } = fixture();
    const rows = familyIssuerExposure(holdings, families, exposure, 'company');
    expect(rows.find((row) => row.familyId === 'a')).toMatchObject({
      directEUR: 100,
      indirectEUR: 50,
      exposureEUR: 150,
      portfolioPercent: 50,
      undisclosedIssuerEUR: 150,
    });
    expect(rows.find((row) => row.familyId === 'b')).toMatchObject({
      directEUR: 0,
      indirectEUR: 200,
      exposureEUR: 200,
      portfolioPercent: 50,
      undisclosedIssuerEUR: 200,
    });
    expect(
      rows
        .flatMap((row) => row.matchedLots)
        .map((lot) => lot.sources[0].sourceId),
    ).toContain('source:fund-a');
    expect(rows.reduce((sum, row) => sum + row.exposureEUR, 0)).toBe(350);
    expect(exposure.totalValueEUR).toBe(700);
  });

  it('does not allocate unknown weights to a named company or interpret missing NAV as zero', () => {
    const { holdings, data } = fixture();
    holdings.push(
      holding('missing-a', 'a', 999, { valuationStatus: 'unknown' }),
    );
    const exposure = buildTotalExposure(holdings, data, '2026-09-10');
    const other = familyIssuerExposure(holdings, families, exposure, 'other');
    expect(other.every((row) => row.exposureEUR === 0)).toBe(true);
    expect(other.find((row) => row.familyId === 'a')).toMatchObject({
      missingValuationCount: 1,
      portfolioPercent: null,
      knownValueEUR: 300,
    });
    expect(
      other.find((row) => row.familyId === 'b')?.undisclosedIssuerEUR,
    ).toBe(200);
  });

  it('aggregates the same scenario results and uses each family denominator', () => {
    const { holdings, exposure } = fixture();
    const stress = runStressScenario(exposure, scenario);
    const rows = familyStressExposure(holdings, families, stress);
    expect(rows.find((row) => row.familyId === 'a')).toMatchObject({
      knownValueEUR: 300,
      afterEUR: 240,
      lossEUR: 60,
      lossPercent: 20,
    });
    expect(rows.find((row) => row.familyId === 'b')).toMatchObject({
      knownValueEUR: 400,
      afterEUR: 320,
      lossEUR: 80,
      lossPercent: 20,
    });
    expect(rows.reduce((sum, row) => sum + row.lossEUR, 0)).toBe(
      stress.lossEUR,
    );
    expect(rows.reduce((sum, row) => sum + row.afterEUR, 0)).toBe(
      stress.afterEUR,
    );
  });

  it('suppresses percentage for missing family NAV and exposes unapplied currency coverage', () => {
    const { holdings, data } = fixture();
    holdings.push(
      holding('missing-a', 'a', 999, { valuationStatus: 'unknown' }),
    );
    data.nodes.forEach((node) => {
      delete node.currency;
    });
    const stress = runStressScenario(buildTotalExposure(holdings, data), {
      ...scenario,
      currencyShocks: { USD: -0.15 },
    });
    const rows = familyStressExposure(holdings, families, stress);
    expect(rows.find((row) => row.familyId === 'a')).toMatchObject({
      lossPercent: null,
      missingValuationCount: 1,
      lossEUR: 60,
      unknownCurrencyEUR: 300,
    });
    expect(rows.find((row) => row.familyId === 'b')?.lossPercent).toBe(20);
  });

  it('never discovers hidden family names or paths from an unfiltered graph', () => {
    const { holdings, exposure } = fixture();
    const visible = holdings.filter((holding) => holding.familyId === 'a');
    const rows = familyIssuerExposure(visible, families, exposure, 'company');
    expect(rows).toHaveLength(1);
    expect(rows[0].familyId).toBe('a');
    expect(JSON.stringify(rows)).not.toContain('Family B');
    const matrix = managerIssuerMatrix(visible, exposure);
    expect(matrix.managers.map((manager) => manager.name)).toEqual([
      'Manager One',
    ]);
    expect(matrix.issuers[0].valueEUR).toBe(150);
    expect(
      familyStressExposure(
        visible,
        families,
        runStressScenario(exposure, scenario),
      ).map((row) => row.familyId),
    ).toEqual(['a']);
  });

  it('shows quantified manager overlaps while retaining unknown combinations separately', () => {
    const { holdings, exposure } = fixture();
    const matrix = managerIssuerMatrix(holdings, exposure);
    expect(matrix.issuers).toEqual([
      { id: 'company', name: 'Shared Company', valueEUR: 350, managerCount: 2 },
    ]);
    expect(matrix.managers.map((manager) => manager.cells[0].valueEUR)).toEqual(
      [150, 200],
    );
    expect(matrix.omittedEUR).toBe(350);
  });

  it('keeps unreported manager names out of quantified manager coverage', () => {
    const holdings = [
      holding('unknown-manager', 'a', 100, { manager: 'Not reported' }),
    ];
    const data: RiskData = {
      version: 1,
      nodes: [node('asset', 'asset', { issuerId: 'company' })],
      positions: [{ holdingId: 'unknown-manager', nodeId: 'asset' }],
      links: [],
    };
    const exposure = buildTotalExposure(holdings, data);
    expect(exposure.coverage.managerKnownEUR).toBe(0);
    expect(exposure.coverage.managerUnknownEUR).toBe(100);
    expect(managerIssuerMatrix(holdings, exposure)).toEqual({
      issuers: [],
      managers: [],
      omittedEUR: 100,
    });
  });

  it('retains gain signs and reconciles rounded cents rather than floating sums', () => {
    const holdings = [
      holding('small-a', 'a', 0.03),
      holding('small-b', 'a', 0.03),
      holding('small-c', 'b', 0),
    ];
    const data: RiskData = {
      version: 1,
      nodes: [node('small', 'asset', { issuerId: 'company' })],
      positions: holdings.map((holding) => ({
        holdingId: holding.id,
        nodeId: 'small',
      })),
      links: [],
    };
    const exposure = buildTotalExposure(holdings, data);
    const stress = runStressScenario(exposure, {
      ...scenario,
      assetClassShocks: { 'Public equities': 0.2 },
    });
    const rows = familyStressExposure(holdings, families, stress);
    expect(rows.find((row) => row.familyId === 'a')).toMatchObject({
      knownValueEUR: 0.06,
      afterEUR: 0.08,
      lossEUR: -0.02,
    });
    expect(rows.find((row) => row.familyId === 'b')?.lossPercent).toBeNull();
    expect(
      familyIssuerExposure(holdings, families, exposure, 'company').find(
        (row) => row.familyId === 'a',
      )?.exposureEUR,
    ).toBe(0.06);
  });
});
