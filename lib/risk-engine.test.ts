import { describe, expect, it } from 'vitest';
import { holdings as sampleHoldings } from '../data/portfolio';
import { createDemoRiskData } from '../data/risk-demo';
import type { Holding } from '../data/types';
import {
  emptyRiskData,
  riskDataSchema,
  riskScenarioSchema,
  type RiskData,
  type RiskNode,
  type RiskScenario,
} from './risk-contract';
import {
  buildTotalExposure,
  RISK_PRESETS,
  runStressScenario,
} from './risk-engine';

const holding = (
  id: string,
  valueEUR: number,
  overrides: Partial<Holding> = {},
): Holding => ({
  ...sampleHoldings[0],
  id,
  name: id,
  valueEUR,
  unfundedCommitmentEUR: 0,
  valuationDate: '2026-09-07',
  ...overrides,
});
const node = (
  id: string,
  kind: RiskNode['kind'] = 'asset',
  extra: Partial<RiskNode> = {},
): RiskNode => ({
  id,
  name: id,
  kind,
  sourceId: `source:${id}`,
  asOfDate: '2026-09-07',
  ...extra,
});
const scenario = (overrides: Partial<RiskScenario> = {}): RiskScenario => ({
  id: 'test',
  name: 'Test',
  description: 'Hypothetical test',
  assetClassShocks: {},
  capitalCallRate: 0,
  ...overrides,
});
const directData = (nodes: RiskNode[]): RiskData => ({
  version: 1,
  nodes,
  links: [],
  positions: nodes.map((node) => ({ holdingId: node.id, nodeId: node.id })),
});
const nested = (): RiskData => ({
  version: 1,
  nodes: [
    node('fund', 'fund'),
    node('sleeve', 'fund', {
      managerId: 'inner-manager',
      managerName: 'Inner manager',
    }),
    node('a', 'asset', {
      issuerId: 'shared',
      sector: 'Technology',
      currency: 'USD',
    }),
    node('b', 'asset', { issuerId: 'other', currency: 'EUR' }),
  ],
  links: [
    { id: 'f-s', parentId: 'fund', childId: 'sleeve', weight: 0.6 },
    { id: 'f-a', parentId: 'fund', childId: 'a', weight: 0.2 },
    { id: 's-a', parentId: 'sleeve', childId: 'a', weight: 0.5 },
    { id: 's-b', parentId: 'sleeve', childId: 'b', weight: 0.25 },
  ],
  positions: [
    { holdingId: 'h1', nodeId: 'fund' },
    { holdingId: 'h2', nodeId: 'a' },
  ],
});
const sum = (rows: { valueEUR: number }[]) =>
  Math.round(rows.reduce((total, row) => total + row.valueEUR, 0) * 100) / 100;

describe('look-through NAV accounting', () => {
  it('replaces nested fund slices, sums duplicate issuer paths and preserves every unknown remainder', () => {
    const result = buildTotalExposure(
      [holding('h1', 1_000), holding('h2', 200)],
      nested(),
    );
    expect(result.totalValueEUR).toBe(1_200);
    expect(sum(result.lots)).toBe(1_200);
    expect(
      result.issuerExposure.find((row) => row.id === 'shared'),
    ).toMatchObject({
      valueEUR: 700,
      holdingCount: 2,
      pathCount: 3,
      holdingIds: ['h1', 'h2'],
    });
    expect(
      result.issuerExposure.find((row) => row.id === 'other')?.valueEUR,
    ).toBe(150);
    expect(result.coverage.issuerUnknownEUR).toBe(350);
    expect(result.coverage.lookThroughUnresolvedEUR).toBe(350);
    expect(
      result.lots
        .filter((lot) => lot.unresolved)
        .map((lot) => lot.valueEUR)
        .sort((a, b) => a - b),
    ).toEqual([150, 200]);
    for (const groups of [
      result.issuerExposure,
      result.managerExposure,
      result.assetClassExposure,
      result.sectorExposure,
      result.countryExposure,
      result.currencyExposure,
    ])
      expect(sum(groups)).toBe(1_200);
    expect(
      result.managerExposure.find((row) => row.id === 'inner-manager')
        ?.valueEUR,
    ).toBe(600);
    expect(result.issuerExposure.some((row) => row.id === 'fund')).toBe(false);
  });

  it('does not equal-weight undisclosed links or assign them the full residual', () => {
    const data = nested();
    data.links[0].weight = undefined;
    const result = buildTotalExposure([holding('h1', 1_000)], data);
    expect(result.coverage.lookThroughUnresolvedEUR).toBe(800);
    expect(result.coverage.issuerKnownEUR).toBe(200);
    expect(
      result.warnings.some((warning) => warning.code === 'missing-weight'),
    ).toBe(true);
    expect(result.lots.some((lot) => lot.nodeId === 'sleeve')).toBe(false);
  });

  it('does not treat an unmapped real-world name or fund denomination as disclosed exposure', () => {
    const result = buildTotalExposure([
      holding('live', 100, {
        name: 'Microsoft',
        currency: 'USD',
        manager: 'Unspecified',
      }),
    ]);
    expect(result.coverage).toMatchObject({
      issuerUnknownEUR: 100,
      managerUnknownEUR: 100,
      currencyUnknownEUR: 100,
      lookThroughUnresolvedEUR: 100,
    });
    expect(result.lots[0].issuerId).toBeUndefined();
    expect(result.lots[0].assetClass).toBe('Public equities');
    expect(
      result.warnings.some((warning) => warning.code === 'unmapped-holding'),
    ).toBe(true);
    for (const manager of ['', '  Unknown ', 'Undisclosed', 'N/A'])
      expect(
        buildTotalExposure([holding('h', 100, { manager })]).coverage
          .managerKnownEUR,
      ).toBe(0);
  });

  it('does not infer a fund currency for an underlying; explicit residual exposure stays separate', () => {
    const data = nested();
    data.nodes[0].currency = 'GBP';
    data.nodes[1].currency = 'CHF';
    data.nodes[2].currency = undefined;
    const result = buildTotalExposure([holding('h1', 1_000)], data);
    expect(
      result.currencyExposure.find((row) => row.id === '__unknown__')?.valueEUR,
    ).toBe(500);
    expect(
      result.currencyExposure.find((row) => row.id === 'GBP')?.valueEUR,
    ).toBe(200);
    expect(
      result.currencyExposure.find((row) => row.id === 'CHF')?.valueEUR,
    ).toBe(150);
  });

  it('reconciles odd-cent allocations without rounding up total fund NAV', () => {
    const data: RiskData = {
      version: 1,
      nodes: [node('f', 'fund'), node('a'), node('b'), node('c')],
      positions: [{ holdingId: 'h', nodeId: 'f' }],
      links: ['a', 'b', 'c'].map((childId) => ({
        id: childId,
        parentId: 'f',
        childId,
        weight: 1 / 3,
      })),
    };
    const result = buildTotalExposure([holding('h', 0.01)], data);
    expect(sum(result.lots)).toBe(0.01);
    expect(result.coverage.lookThroughUnresolvedEUR).toBe(0);
    expect(result.lots.every((lot) => lot.valueEUR >= 0)).toBe(true);
  });

  it('preserves sources, stale marks and missing child classifications', () => {
    const data = directData([
      node('a', 'asset', {
        issuerId: 'a',
        asOfDate: '2026-01-01',
        sourceId: undefined,
      }),
    ]);
    const result = buildTotalExposure([holding('a', 100)], data, '2026-09-08');
    expect(
      result.provenance.some((item) => item.asOfDate === '2026-01-01'),
    ).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        'stale-source',
        'missing-provenance',
        'inherited-asset-class',
        'missing-sector',
        'missing-effective-currency',
      ]),
    );
  });
});

describe('graph and numeric input validation', () => {
  it('rejects cycles, including undisclosed and zero-weight cycles', () => {
    for (const weight of [undefined, 0, 0.1]) {
      const data = nested();
      data.links.push({
        id: 'cycle',
        parentId: 'sleeve',
        childId: 'fund',
        weight,
      });
      expect(() => buildTotalExposure([holding('h1', 100)], data)).toThrow(
        /cycle/i,
      );
    }
  });
  it('rejects overweight, duplicate paths/roots/holdings and broken references', () => {
    const tooMuch = nested();
    tooMuch.links[0].weight = 0.9;
    expect(riskDataSchema.safeParse(tooMuch).success).toBe(false);
    const duplicate = nested();
    duplicate.links.push({ ...duplicate.links[0], id: 'duplicate' });
    expect(riskDataSchema.safeParse(duplicate).success).toBe(false);
    const roots = nested();
    roots.positions.push(roots.positions[0]);
    expect(riskDataSchema.safeParse(roots).success).toBe(false);
    const orphan = nested();
    orphan.links[0].childId = 'absent';
    expect(riskDataSchema.safeParse(orphan).success).toBe(false);
    expect(() =>
      buildTotalExposure([holding('h', 1), holding('h', 1)]),
    ).toThrow(/unique/);
  });
  it('bounds graph depth and exponential path expansion before traversal', () => {
    const deep: RiskData = {
      version: 1,
      nodes: Array.from({ length: 21 }, (_, i) => node(String(i), 'fund')),
      links: Array.from({ length: 20 }, (_, i) => ({
        id: String(i),
        parentId: String(i),
        childId: String(i + 1),
        weight: 1,
      })),
      positions: [{ holdingId: 'h', nodeId: '0' }],
    };
    expect(riskDataSchema.safeParse(deep).success).toBe(false);
    const wide = emptyRiskData();
    for (let level = 0; level < 17; level++)
      for (let column = 0; column < 2; column++) {
        const id = `${level}:${column}`;
        wide.nodes.push(node(id, 'fund'));
        if (level < 16)
          for (let next = 0; next < 2; next++)
            wide.links.push({
              id: `${id}:${next}`,
              parentId: id,
              childId: `${level + 1}:${next}`,
              weight: 0.5,
            });
      }
    wide.positions.push({ holdingId: 'h', nodeId: '0:0' });
    expect(() => riskDataSchema.parse(wide)).toThrow(/paths/);
  });
  it('rejects non-finite, negative and excessive amounts and invalid dates', () => {
    for (const value of [NaN, Infinity, -1, 1_000_000_000_001])
      expect(() => buildTotalExposure([holding('h', value)])).toThrow();
    expect(() =>
      buildTotalExposure([
        holding('a', 600_000_000_000),
        holding('b', 600_000_000_000),
      ]),
    ).toThrow(/bound/);
    expect(() =>
      buildTotalExposure([holding('h', 100)], emptyRiskData(), '2026-02-30'),
    ).toThrow(/as-of/);
    expect(
      riskDataSchema.safeParse(
        directData([node('h', 'asset', { asOfDate: '2026-02-30' })]),
      ).success,
    ).toBe(false);
  });
});

describe('deterministic hypothetical stress', () => {
  it('applies issuer before sector before class, then compounds known FX exactly once', () => {
    const nodes = ['a', 'b', 'c'].map((id) =>
      node(id, 'asset', {
        issuerId: id,
        sector: id === 'c' ? 'Industrials' : 'Technology',
        currency: 'USD',
        assetClass: 'Public equities',
      }),
    );
    const exposure = buildTotalExposure(
      nodes.map((node) => holding(node.id, 100)),
      directData(nodes),
    );
    const result = runStressScenario(
      exposure,
      scenario({
        assetClassShocks: { 'Public equities': -0.1 },
        sectorShocks: { Technology: -0.2 },
        issuerShocks: { a: -0.3 },
        currencyShocks: { USD: -0.1 },
      }),
    );
    expect(result.lots.map((lot) => lot.afterEUR)).toEqual([63, 72, 81]);
    expect(result.lots.map((lot) => lot.shockSource)).toEqual([
      'issuer',
      'sector',
      'assetClass',
    ]);
    expect(result).toMatchObject({
      beforeEUR: 300,
      afterEUR: 216,
      lossEUR: 84,
    });
    expect(result.lossPercent).toBeCloseTo(28);
    expect(result.contributors.reduce((sum, row) => sum + row.lossEUR, 0)).toBe(
      84,
    );
  });
  it('keeps equity and credit class shocks distinct within one issuer unless explicitly overridden', () => {
    const nodes = [
      node('equity', 'asset', {
        issuerId: 'shared',
        assetClass: 'Public equities',
      }),
      node('credit', 'asset', {
        issuerId: 'shared',
        assetClass: 'Fixed income',
      }),
    ];
    const exposure = buildTotalExposure(
      nodes.map((node) => holding(node.id, 100)),
      directData(nodes),
    );
    const result = runStressScenario(
      exposure,
      scenario({
        assetClassShocks: { 'Public equities': -0.3, 'Fixed income': -0.05 },
      }),
    );
    expect(result.lossEUR).toBe(35);
    expect(result.issuerContributors).toHaveLength(1);
    expect(
      runStressScenario(
        exposure,
        scenario({ assetClassShocks: {}, issuerShocks: { shared: -0.2 } }),
      ).lossEUR,
    ).toBe(40);
  });
  it('respects an explicit zero override and ignores inherited object property names', () => {
    const nodes = [
      node('a', 'asset', { issuerId: 'a', sector: 'Technology' }),
      node('b', 'asset', { issuerId: 'toString', sector: 'constructor' }),
    ];
    const exposure = buildTotalExposure(
      nodes.map((node) => holding(node.id, 100)),
      directData(nodes),
    );
    const result = runStressScenario(
      exposure,
      scenario({
        assetClassShocks: { 'Public equities': -0.1 },
        issuerShocks: { a: 0 },
        sectorShocks: { Technology: -0.5 },
      }),
    );
    expect(result.lots.map((lot) => lot.afterEUR)).toEqual([100, 90]);
  });
  it('models favorable shocks as gains and bounds losses to current NAV', () => {
    const exposure = buildTotalExposure(
      [holding('a', 100)],
      directData([node('a', 'asset', { currency: 'USD' })]),
    );
    expect(
      runStressScenario(
        exposure,
        scenario({
          assetClassShocks: { 'Public equities': 0.2 },
          currencyShocks: { USD: 0.1 },
        }),
      ),
    ).toMatchObject({ afterEUR: 132, lossEUR: -32, lossPercent: -32 });
    expect(
      runStressScenario(
        exposure,
        scenario({
          assetClassShocks: { 'Public equities': -1 },
          currencyShocks: { USD: 3 },
        }),
      ),
    ).toMatchObject({ afterEUR: 0, lossEUR: 100 });
    expect(
      runStressScenario(
        exposure,
        scenario({
          assetClassShocks: { 'Public equities': 3 },
          currencyShocks: { USD: 3 },
        }),
      ).afterEUR,
    ).toBe(1_600);
    for (const value of [-1.01, 3.01, NaN, Infinity])
      expect(
        riskScenarioSchema.safeParse(
          scenario({ assetClassShocks: { 'Public equities': value } }),
        ).success,
      ).toBe(false);
    expect(
      riskScenarioSchema.safeParse(scenario({ currencyShocks: { EUR: -0.1 } }))
        .success,
    ).toBe(false);
  });
  it('leaves unknown FX unchanged while reporting incomplete coverage', () => {
    const exposure = buildTotalExposure([
      holding('h', 100, { currency: 'USD' }),
    ]);
    const result = runStressScenario(
      exposure,
      scenario({
        assetClassShocks: { 'Public equities': -0.2 },
        currencyShocks: { USD: -0.5 },
        sectorShocks: { Technology: -0.9 },
      }),
    );
    expect(result).toMatchObject({
      afterEUR: 80,
      unresolvedExposureEUR: 100,
      currencyUnresolvedEUR: 100,
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['partial-fx-stress', 'partial-sector-stress']),
    );
  });
  it('separates capital-call cash requirements from investment valuation loss and excludes cash inside funds', () => {
    const positions = [
      holding('private', 1_000, {
        assetClass: 'Private equity',
        unfundedCommitmentEUR: 400,
      }),
      holding('cash', 100, { assetClass: 'Cash', currency: 'USD' }),
    ];
    const exposure = buildTotalExposure(
      positions,
      directData([
        node('private', 'asset', { assetClass: 'Cash', currency: 'EUR' }),
        node('cash', 'asset', { assetClass: 'Cash', currency: 'USD' }),
      ]),
    );
    const base = runStressScenario(
      exposure,
      scenario({ currencyShocks: { USD: -0.1 } }),
    );
    const called = runStressScenario(
      exposure,
      scenario({ currencyShocks: { USD: -0.1 }, capitalCallRate: 0.5 }),
    );
    expect(called.lossEUR).toBe(10);
    expect(called.afterEUR).toBe(base.afterEUR);
    expect(called.liquidity).toMatchObject({
      cashBeforeEUR: 100,
      cashAfterStressEUR: 90,
      capitalCallsEUR: 200,
      cashAfterCallsEUR: -110,
      shortfallEUR: 110,
    });
    expect(
      riskScenarioSchema.safeParse(scenario({ capitalCallRate: 1.01 })).success,
    ).toBe(false);
  });
  it('handles empty and zero-value portfolios without invented returns or non-finite results', () => {
    for (const positions of [[], [holding('zero', 0)]]) {
      const exposure = buildTotalExposure(positions);
      const result = runStressScenario(exposure, RISK_PRESETS[0]);
      expect(result).toMatchObject({
        beforeEUR: 0,
        afterEUR: 0,
        lossEUR: 0,
        lossPercent: null,
      });
      expect(exposure.coverage.issuerCoveragePercent).toBe(0);
      expect(result.liquidity.shortfallEUR).toBe(0);
    }
  });
});

describe('sample look-through fixtures', () => {
  it('reconciles all sample funds and produces repeatable hypothetical presets', () => {
    const data = createDemoRiskData(sampleHoldings);
    expect(riskDataSchema.safeParse(data).success).toBe(true);
    const result = buildTotalExposure(sampleHoldings, data);
    expect(result.totalValueEUR).toBe(128_000_000);
    expect(sum(result.lots)).toBe(128_000_000);
    expect(result.coverage.lookThroughUnresolvedEUR).toBeGreaterThan(0);
    expect(
      result.issuerExposure.some(
        (row) => row.id === 'example-atlas' && row.holdingCount > 1,
      ),
    ).toBe(true);
    expect(data.nodes.every((node) => node.synthetic === true)).toBe(true);
    for (const preset of RISK_PRESETS)
      expect(runStressScenario(result, preset)).toEqual(
        runStressScenario(result, preset),
      );
  });
  it('returns no invented mappings for empty or live portfolio names', () => {
    expect(createDemoRiskData([])).toEqual(emptyRiskData());
    expect(
      createDemoRiskData([
        holding('live-microsoft', 1_000, { name: 'Microsoft' }),
      ]),
    ).toEqual(emptyRiskData());
    expect(
      createDemoRiskData([{ ...sampleHoldings[0], accountId: 'live-account' }]),
    ).toEqual(emptyRiskData());
  });
});

it('does not fund stress calls from unreported cash liquidity classifications', () => {
  const cash = holding('known-cash', 100, { assetClass: 'Cash' });
  const unknown = holding('unreported-cash', 900, {
    assetClass: 'Cash',
    liquidityStatus: 'unknown',
    assetClassStatus: 'inferred',
  });
  const exposure = buildTotalExposure([cash, unknown]);
  expect(exposure.cashEUR).toBe(100);
  expect(exposure.cashHoldingIds).toEqual(['known-cash']);
  expect(exposure.coverage).toMatchObject({
    liquidityKnownCount: 1,
    liquidityUnknownCount: 1,
    assetClassInferredCount: 1,
  });
  expect(exposure.warnings.map((warning) => warning.code)).toContain(
    'LIQUIDITY_COVERAGE_INCOMPLETE',
  );
  expect(exposure.warnings.map((warning) => warning.code)).toContain(
    'ASSET_CLASS_INFERRED',
  );
  const result = runStressScenario(exposure, RISK_PRESETS[0]);
  expect(result.liquidity.cashBeforeEUR).toBe(100);
  expect(result.liquidity.coverageComplete).toBe(false);
  expect(
    runStressScenario(buildTotalExposure([cash]), RISK_PRESETS[0]).liquidity
      .coverageComplete,
  ).toBe(true);
  const inferredOnly = buildTotalExposure([
    { ...cash, assetClassStatus: 'inferred' },
  ]);
  expect(inferredOnly.cashEUR).toBe(0);
  expect(
    runStressScenario(inferredOnly, RISK_PRESETS[0]).liquidity.coverageComplete,
  ).toBe(false);
});

it('excludes unknown NAV and commitment placeholders and marks stress liquidity as partial', () => {
  const known = holding('known', 100, { unfundedCommitmentEUR: 20 });
  const unknown = holding('unknown', 9000, {
    valuationStatus: 'unknown',
    unfundedStatus: 'unknown',
    unfundedCommitmentEUR: 8000,
    valuationDate: '',
  });
  const exposure = buildTotalExposure([known, unknown]);
  expect(exposure.totalValueEUR).toBe(100);
  expect(exposure.unfundedCommitmentEUR).toBe(20);
  expect(exposure.coverage).toMatchObject({
    valuationKnownCount: 1,
    valuationUnknownCount: 1,
    unfundedKnownCount: 1,
    unfundedUnknownCount: 1,
  });
  expect(exposure.lots.every((lot) => lot.holdingId === 'known')).toBe(true);
  expect(exposure.warnings.map((warning) => warning.code)).toContain(
    'COMMITMENT_COVERAGE_INCOMPLETE',
  );
  expect(exposure.asOfDate).toBe(new Date().toISOString().slice(0, 10));
  const stress = runStressScenario(exposure, RISK_PRESETS[0]);
  expect(stress.liquidity.coverageComplete).toBe(false);
  expect(stress.liquidity.capitalCallsEUR).toBe(
    20 * RISK_PRESETS[0].capitalCallRate,
  );
  const unknownOnly = buildTotalExposure([unknown]);
  expect(unknownOnly.totalValueEUR).toBe(0);
  expect(unknownOnly.coverage.valuationUnknownCount).toBe(1);
});
