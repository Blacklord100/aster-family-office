import type { Holding } from '../data/types';
import {
  RISK_LIMITS,
  emptyRiskData,
  riskDataSchema,
  riskScenarioSchema,
  type ExposureGroup,
  type ExposureLot,
  type RiskData,
  type RiskLink,
  type RiskNode,
  type RiskScenario,
  type RiskSource,
  type RiskWarning,
  type StressContributor,
  type StressResult,
  type StressedLot,
  type TotalExposure,
} from './risk-contract';

export const RISK_MODEL_LIMITATIONS = [
  'Deterministic, hypothetical shocks to existing EUR NAV or equity values. Long-only, unleveraged valuation model; losses cannot exceed current modeled value.',
  'Fund NAV and property equity are already net values. Underlying allocations replace parent value; they are never added on top. No gross property assets, debt, derivatives, leverage amplification, tax or trading costs are modeled.',
  'Issuer overrides replace sector shocks; sector overrides replace asset-class shocks. A known effective-currency shock then compounds multiplicatively. Missing shocks mean zero change, not safety.',
  'Undisclosed underlying weights remain unresolved. Residual NAV uses its nearest disclosed asset class (or the holding class); unknown issuer, sector, country and currency are never inferred from names or a fund denomination.',
  'Manager attribution uses the nearest disclosed manager on each path, falling back to the holding’s reported manager field, which may describe a custodian. Manager rows are a partition of NAV, not an additive count of every manager in the chain.',
  'An issuer can group equity and credit issued by the same company. Grouping does not imply identical sensitivity; only an explicit issuer override applies the same valuation shock to both.',
  'Liquidity totals sum the selected holdings’ cash and commitments. They do not establish that cash can legally or operationally move between families, entities, accounts or currencies; inspect narrower scopes and actual funding restrictions separately.',
  'No historical replay, VaR, probability, correlation, time horizon, market forecast or liquidity-price model is implied. Stale and missing source information remains visible.',
];

export const RISK_PRESETS: RiskScenario[] = [
  {
    id: 'broad-drawdown',
    name: 'Broad market drawdown',
    description:
      'Hypothetical valuation markdown across risk assets, with 25% of unfunded commitments called.',
    assetClassShocks: {
      'Public equities': -0.25,
      'Private equity': -0.2,
      'Venture capital': -0.35,
      'Real estate': -0.15,
      'Fixed income': -0.06,
      Cash: 0,
    },
    capitalCallRate: 0.25,
  },
  {
    id: 'private-capital',
    name: 'Private capital squeeze',
    description:
      'Hypothetical private-market markdowns and 60% of remaining commitments called. Calls affect available cash separately.',
    assetClassShocks: {
      'Public equities': -0.1,
      'Private equity': -0.3,
      'Venture capital': -0.45,
      'Real estate': -0.2,
      'Fixed income': -0.03,
      Cash: 0,
    },
    capitalCallRate: 0.6,
  },
  {
    id: 'currency-headwind',
    name: 'EUR currency headwind',
    description:
      'Foreign currencies lose 15% of their EUR value where effective currency exposure is disclosed. Asset values are otherwise unchanged.',
    assetClassShocks: {},
    currencyShocks: { USD: -0.15, GBP: -0.15, CHF: -0.15 },
    capitalCallRate: 0,
  },
  {
    id: 'technology-reset',
    name: 'Technology sector reset',
    description:
      'A hypothetical 40% technology-sector markdown overrides asset-class assumptions on classified positions; other equities lose 10%.',
    assetClassShocks: {
      'Public equities': -0.1,
      'Private equity': -0.1,
      'Venture capital': -0.15,
    },
    sectorShocks: { Technology: -0.4 },
    capitalCallRate: 0.25,
  },
];

const money = (value: number) => Math.round(value * 100) / 100;
const total = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
const percent = (value: number, denominator: number) =>
  denominator > 0 ? (value / denominator) * 100 : 0;
const source = (
  record: { sourceId?: string; asOfDate?: string; synthetic?: boolean },
  label: string,
): RiskSource => ({
  sourceId: record.sourceId,
  asOfDate: record.asOfDate,
  synthetic: record.synthetic === true,
  label,
});
const uniqueSources = (sources: RiskSource[]) => [
  ...new Map(sources.map((item) => [JSON.stringify(item), item])).values(),
];

/** Aggregate disjoint terminal NAV slices; duplicate issuer paths combine without losing their origin. */
function groupLots(
  lots: ExposureLot[],
  portfolioValue: number,
  select: (lot: ExposureLot) => { id?: string; name?: string },
): ExposureGroup[] {
  const groups = new Map<string, { name: string; lots: ExposureLot[] }>();
  for (const lot of lots) {
    const item = select(lot);
    const id = item.id ?? '__unknown__';
    const group = groups.get(id) ?? {
      name: item.name ?? item.id ?? 'Unknown / undisclosed',
      lots: [],
    };
    group.lots.push(lot);
    groups.set(id, group);
  }
  return [...groups]
    .map(([id, group]) => {
      const valueEUR = total(group.lots.map((lot) => lot.valueEUR));
      const holdingIds = [
        ...new Set(group.lots.map((lot) => lot.holdingId)),
      ].sort();
      return {
        id,
        name: group.name,
        valueEUR,
        percentage: percent(valueEUR, portfolioValue),
        holdingIds,
        holdingCount: holdingIds.length,
        pathCount: group.lots.length,
      };
    })
    .sort((a, b) => b.valueEUR - a.valueEUR || a.id.localeCompare(b.id));
}

/** Allocate integer cents using largest remainders. Missing weight is not allocated. */
function allocate(
  cents: number,
  links: RiskLink[],
): { allocations: number[]; residual: number } {
  const sum = links.reduce((value, link) => value + (link.weight ?? 0), 0);
  const divisor = sum > 1 ? sum : 1; // Validation permits only floating-point tolerance above 1.
  const exact = links.map((link) => (cents * (link.weight ?? 0)) / divisor);
  const allocations = exact.map(Math.floor);
  const target = Math.min(cents, Math.round(cents * Math.min(1, sum)));
  let remainder =
    target - allocations.reduce((value, amount) => value + amount, 0);
  const order = exact
    .map((amount, index) => ({ index, remainder: amount - allocations[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const item of order) {
    if (remainder <= 0) break;
    allocations[item.index] += 1;
    remainder -= 1;
  }
  return { allocations, residual: cents - target };
}

export function buildTotalExposure(
  holdings: readonly Holding[],
  input: RiskData = emptyRiskData(),
  asOfDate?: string,
): TotalExposure {
  const data = riskDataSchema.parse(input);
  if (holdings.length > RISK_LIMITS.positions)
    throw new Error(
      `At most ${RISK_LIMITS.positions} holdings can be modeled.`,
    );
  if (new Set(holdings.map((holding) => holding.id)).size !== holdings.length)
    throw new Error(
      'Holding IDs must be unique; duplicate holdings would double-count NAV.',
    );
  for (const holding of holdings) {
    if (
      ![holding.valueEUR, holding.unfundedCommitmentEUR].every(
        (value) =>
          Number.isFinite(value) &&
          value >= 0 &&
          value <= RISK_LIMITS.maxValueEUR,
      )
    ) {
      throw new Error(
        `Holding ${holding.id} has invalid NAV or unfunded commitment. Values must be finite, nonnegative and within model bounds.`,
      );
    }
  }
  const allHoldings = holdings;
  const valuationUnknownCount = holdings.filter(
    (holding) => holding.valuationStatus === 'unknown',
  ).length;
  const unfundedUnknownCount = holdings.filter(
    (holding) => holding.unfundedStatus === 'unknown',
  ).length;
  const liquidityUnknownCount = holdings.filter(
    (holding) => holding.liquidityStatus === 'unknown',
  ).length;
  const assetClassInferredCount = holdings.filter(
    (holding) => holding.assetClassStatus === 'inferred',
  ).length;
  // Unreported fields are storage placeholders, not zero-valued economic positions.
  holdings = holdings.filter(
    (holding) => holding.valuationStatus !== 'unknown',
  );
  const totalValueEUR = total(holdings.map((holding) => holding.valueEUR));
  const unfundedCommitmentEUR = total(
    allHoldings
      .filter((holding) => holding.unfundedStatus !== 'unknown')
      .map((holding) => holding.unfundedCommitmentEUR),
  );
  if (
    totalValueEUR > RISK_LIMITS.maxValueEUR ||
    unfundedCommitmentEUR > RISK_LIMITS.maxValueEUR
  )
    throw new Error(
      'Portfolio value or commitments exceed the model’s EUR 1 trillion bound.',
    );
  const date = asOfDate ?? new Date().toISOString().slice(0, 10);
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  )
    throw new Error('Invalid analysis as-of date.');
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const positions = new Map(
    data.positions.map((position) => [position.holdingId, position.nodeId]),
  );
  const linksByParent = new Map<string, RiskLink[]>();
  for (const link of data.links) {
    const rows = linksByParent.get(link.parentId) ?? [];
    rows.push(link);
    linksByParent.set(link.parentId, rows);
  }
  const lots: ExposureLot[] = [];
  const warnings: RiskWarning[] = [];
  if (valuationUnknownCount)
    warnings.push({
      code: 'VALUATION_COVERAGE_INCOMPLETE',
      message: `${valuationUnknownCount} holdings have no reported NAV and are excluded from numeric exposure and stress totals. Their economic exposure is unknown, not zero.`,
    });
  if (unfundedUnknownCount)
    warnings.push({
      code: 'COMMITMENT_COVERAGE_INCOMPLETE',
      message: `${unfundedUnknownCount} holdings have no reported unfunded commitment. Capital-call simulations cover only recorded commitments; missing commitments are not zero.`,
    });
  if (liquidityUnknownCount)
    warnings.push({
      code: 'LIQUIDITY_COVERAGE_INCOMPLETE',
      message: `${liquidityUnknownCount} holdings have no reported liquidity classification. They are excluded from funding cash; their availability or lockup is unknown, not zero.`,
    });
  if (assetClassInferredCount)
    warnings.push({
      code: 'ASSET_CLASS_INFERRED',
      message: `${assetClassInferredCount} holdings use inferred asset classes. Allocation and asset-class stress assumptions using these categories are provisional, not source-confirmed classifications.`,
    });
  const warningKeys = new Set<string>();
  const warn = (warning: RiskWarning) => {
    const key = JSON.stringify(warning);
    if (!warningKeys.has(key)) {
      warnings.push(warning);
      warningKeys.add(key);
    }
  };
  let visits = 0;
  function inspectSource(item: RiskSource, holdingId: string) {
    if (!item.sourceId || !item.asOfDate)
      warn({
        code: 'missing-provenance',
        holdingId,
        message: `${item.label}: source or as-of date is missing; this allocation is an unverified assumption.`,
      });
    if (
      item.asOfDate &&
      Date.parse(`${date}T00:00:00Z`) -
        Date.parse(`${item.asOfDate}T00:00:00Z`) >
        90 * 86_400_000
    )
      warn({
        code: 'stale-source',
        holdingId,
        message: `${item.label}: source date ${item.asOfDate} is more than 90 days before the analysis date.`,
      });
    if (item.asOfDate && item.asOfDate > date)
      warn({
        code: 'future-source',
        holdingId,
        message: `${item.label}: source date ${item.asOfDate} is after the analysis date.`,
      });
  }
  for (const holding of holdings) {
    const root = nodes.get(positions.get(holding.id) ?? '');
    const rootSource = source(
      {
        sourceId: holding.sourceId,
        asOfDate: holding.valuationDate,
        synthetic: root?.synthetic,
      },
      `${holding.name} · holding valuation`,
    );
    inspectSource(rootSource, holding.id);
    const reportedManager = holding.manager.trim();
    const holdingManager =
      /^(?:unspecified|unknown|undisclosed|n\/?a|none|not specified|not disclosed)$/i.test(
        reportedManager,
      )
        ? ''
        : reportedManager;
    const manager = holdingManager
      ? { id: `reported:${holdingManager.toLowerCase()}`, name: holdingManager }
      : undefined;
    function emit(
      cents: number,
      node: RiskNode | undefined,
      path: string[],
      pathNames: string[],
      sources: RiskSource[],
      assetClass: ExposureLot['assetClass'],
      effectiveManager: typeof manager,
      unresolvedReason?: string,
    ) {
      if (cents === 0) return;
      const unresolved = unresolvedReason !== undefined;
      // A fund wrapper is never interpreted as its own underlying issuer.
      const issuerId =
        !unresolved && node?.kind === 'asset' ? node.issuerId : undefined;
      lots.push({
        id: JSON.stringify([
          holding.id,
          path,
          unresolved ? 'residual' : 'asset',
        ]),
        holdingId: holding.id,
        holdingName: holding.name,
        familyId: holding.familyId,
        nodeId: node?.id,
        name: unresolved
          ? `${node?.name ?? holding.name} · undisclosed allocation`
          : (node?.name ?? holding.name),
        valueEUR: cents / 100,
        path,
        pathNames,
        issuerId,
        issuerName: issuerId ? (node?.issuerName ?? issuerId) : undefined,
        managerId: effectiveManager?.id,
        managerName: effectiveManager?.name,
        assetClass,
        sector: node?.sector,
        country: node?.country,
        currency:
          node?.currency ??
          (!node && holding.assetClass === 'Cash'
            ? holding.currency
            : undefined),
        unresolved,
        unresolvedReason,
        sources,
      });
    }
    function visit(
      node: RiskNode,
      cents: number,
      path: string[],
      pathNames: string[],
      sources: RiskSource[],
      inheritedClass: ExposureLot['assetClass'],
      inheritedManager: typeof manager,
    ) {
      visits += 1;
      if (visits > RISK_LIMITS.paths)
        throw new Error(
          `Expanded look-through exceeds ${RISK_LIMITS.paths} paths; simplify the graph.`,
        );
      const nodeSource = source(node, node.name);
      inspectSource(nodeSource, holding.id);
      const nextSources = [...sources, nodeSource];
      const nextPath = [...path, node.id],
        nextPathNames = [...pathNames, node.name];
      const assetClass = node.assetClass ?? inheritedClass;
      if (!node.assetClass && cents > 0)
        warn({
          code: 'inherited-asset-class',
          holdingId: holding.id,
          nodeId: node.id,
          message: `${node.name}: asset class is missing; the nearest disclosed parent or holding class is used as a scenario assumption.`,
        });
      const effectiveManager = node.managerId
        ? { id: node.managerId, name: node.managerName ?? node.managerId }
        : inheritedManager;
      if (node.kind === 'asset') {
        emit(
          cents,
          node,
          nextPath,
          nextPathNames,
          nextSources,
          assetClass,
          effectiveManager,
        );
        return;
      }
      const children = linksByParent.get(node.id) ?? [];
      const allocation = allocate(cents, children);
      children.forEach((link, index) => {
        const linkSource = source(
          link,
          `${node.name} → ${nodes.get(link.childId)!.name}`,
        );
        inspectSource(linkSource, holding.id);
        if (link.weight === undefined)
          warn({
            code: 'missing-weight',
            holdingId: holding.id,
            nodeId: node.id,
            message: `${node.name} → ${nodes.get(link.childId)!.name}: weight is undisclosed; no equal-weight or residual allocation is assumed.`,
          });
        if (allocation.allocations[index] > 0)
          visit(
            nodes.get(link.childId)!,
            allocation.allocations[index],
            nextPath,
            nextPathNames,
            [...nextSources, linkSource],
            assetClass,
            effectiveManager,
          );
      });
      if (allocation.residual > 0)
        emit(
          allocation.residual,
          node,
          nextPath,
          nextPathNames,
          [
            ...nextSources,
            ...children
              .filter((link) => link.weight === undefined)
              .map((link) =>
                source(
                  link,
                  `Undisclosed weight: ${nodes.get(link.childId)!.name}`,
                ),
              ),
          ],
          assetClass,
          effectiveManager,
          children.length
            ? 'Underlying weights cover less than 100% of this fund’s NAV.'
            : 'No underlying allocation is disclosed.',
        );
    }
    if (root)
      visit(
        root,
        Math.round(holding.valueEUR * 100),
        [],
        [],
        [rootSource],
        holding.assetClass,
        manager,
      );
    else {
      warn({
        code: 'unmapped-holding',
        holdingId: holding.id,
        message: `${holding.name}: no verified direct-asset or look-through mapping; underlying issuer and effective currency have not been inferred.`,
      });
      emit(
        Math.round(holding.valueEUR * 100),
        undefined,
        [],
        [holding.name],
        [rootSource],
        holding.assetClass,
        manager,
        'No direct-asset or look-through mapping.',
      );
    }
  }
  const known = (
    key:
      | 'issuerId'
      | 'managerId'
      | 'assetClass'
      | 'sector'
      | 'country'
      | 'currency',
  ) =>
    total(
      lots.filter((lot) => lot[key] !== undefined).map((lot) => lot.valueEUR),
    );
  const issuerKnownEUR = known('issuerId'),
    managerKnownEUR = known('managerId');
  const sectorKnownEUR = known('sector'),
    countryKnownEUR = known('country');
  const currencyKnownEUR = known('currency'),
    assetClassKnownEUR = known('assetClass');
  const lookThroughResolvedEUR = total(
    lots.filter((lot) => !lot.unresolved).map((lot) => lot.valueEUR),
  );
  for (const [key, amount] of [
    ['issuer', issuerKnownEUR],
    ['sector', sectorKnownEUR],
    ['country', countryKnownEUR],
    ['effective currency', currencyKnownEUR],
    ['asset class', assetClassKnownEUR],
  ] as const) {
    if (amount < totalValueEUR)
      warn({
        code: `missing-${key.replace(' ', '-')}`,
        message: `${money(totalValueEUR - amount).toFixed(2)} EUR has no disclosed ${key} classification.`,
      });
  }
  if (total(lots.map((lot) => lot.valueEUR)) !== totalValueEUR)
    throw new Error('Exposure allocation failed to reconcile to holding NAV.');
  return {
    totalValueEUR,
    lots,
    issuerExposure: groupLots(lots, totalValueEUR, (lot) => ({
      id: lot.issuerId,
      name: lot.issuerName,
    })),
    managerExposure: groupLots(lots, totalValueEUR, (lot) => ({
      id: lot.managerId,
      name: lot.managerName,
    })),
    assetClassExposure: groupLots(lots, totalValueEUR, (lot) => ({
      id: lot.assetClass,
    })),
    sectorExposure: groupLots(lots, totalValueEUR, (lot) => ({
      id: lot.sector,
    })),
    countryExposure: groupLots(lots, totalValueEUR, (lot) => ({
      id: lot.country,
    })),
    currencyExposure: groupLots(lots, totalValueEUR, (lot) => ({
      id: lot.currency,
    })),
    holdingExposure: groupLots(lots, totalValueEUR, (lot) => ({
      id: lot.holdingId,
      name: lot.holdingName,
    })),
    coverage: {
      valuationKnownCount: holdings.length,
      valuationUnknownCount,
      unfundedKnownCount: allHoldings.length - unfundedUnknownCount,
      unfundedUnknownCount,
      liquidityKnownCount: allHoldings.length - liquidityUnknownCount,
      liquidityUnknownCount,
      assetClassInferredCount,
      issuerKnownEUR,
      issuerUnknownEUR: money(totalValueEUR - issuerKnownEUR),
      issuerCoveragePercent: percent(issuerKnownEUR, totalValueEUR),
      lookThroughResolvedEUR,
      lookThroughUnresolvedEUR: money(totalValueEUR - lookThroughResolvedEUR),
      lookThroughCoveragePercent: percent(
        lookThroughResolvedEUR,
        totalValueEUR,
      ),
      managerKnownEUR,
      managerUnknownEUR: money(totalValueEUR - managerKnownEUR),
      sectorKnownEUR,
      sectorUnknownEUR: money(totalValueEUR - sectorKnownEUR),
      countryKnownEUR,
      countryUnknownEUR: money(totalValueEUR - countryKnownEUR),
      currencyKnownEUR,
      currencyUnknownEUR: money(totalValueEUR - currencyKnownEUR),
      assetClassKnownEUR,
      assetClassUnknownEUR: money(totalValueEUR - assetClassKnownEUR),
    },
    warnings,
    provenance: uniqueSources(lots.flatMap((lot) => lot.sources)),
    asOfDate: date,
    cashEUR: total(
      holdings
        .filter(
          (holding) =>
            holding.assetClass === 'Cash' &&
            holding.liquidityStatus !== 'unknown' &&
            holding.assetClassStatus !== 'inferred',
        )
        .map((holding) => holding.valueEUR),
    ),
    cashHoldingIds: holdings
      .filter(
        (holding) =>
          holding.assetClass === 'Cash' &&
          holding.liquidityStatus !== 'unknown' &&
          holding.assetClassStatus !== 'inferred',
      )
      .map((holding) => holding.id),
    unfundedCommitmentEUR,
    limitations: RISK_MODEL_LIMITATIONS,
  };
}

function stressGroups(
  lots: StressedLot[],
  select: (lot: StressedLot) => { id: string; name: string },
): StressContributor[] {
  const groups = new Map<string, { name: string; lots: StressedLot[] }>();
  for (const lot of lots) {
    const { id, name } = select(lot),
      group = groups.get(id) ?? { name, lots: [] };
    group.lots.push(lot);
    groups.set(id, group);
  }
  return [...groups]
    .map(([id, group]) => {
      const beforeEUR = total(group.lots.map((lot) => lot.valueEUR)),
        afterEUR = total(group.lots.map((lot) => lot.afterEUR));
      return {
        id,
        name: group.name,
        beforeEUR,
        afterEUR,
        lossEUR: money(beforeEUR - afterEUR),
        returnPercent: beforeEUR > 0 ? (afterEUR / beforeEUR - 1) * 100 : null,
        holdingIds: [...new Set(group.lots.map((lot) => lot.holdingId))].sort(),
      };
    })
    .sort((a, b) => b.lossEUR - a.lossEUR || a.id.localeCompare(b.id));
}

export function runStressScenario(
  exposure: TotalExposure,
  input: RiskScenario,
): StressResult {
  const scenario = riskScenarioSchema.parse(input);
  const lots: StressedLot[] = exposure.lots.map((lot) => {
    let valuationShock = 0;
    let shockSource: StressedLot['shockSource'] = 'none';
    if (
      lot.issuerId &&
      scenario.issuerShocks &&
      Object.hasOwn(scenario.issuerShocks, lot.issuerId)
    ) {
      valuationShock = scenario.issuerShocks[lot.issuerId];
      shockSource = 'issuer';
    } else if (
      lot.sector &&
      scenario.sectorShocks &&
      Object.hasOwn(scenario.sectorShocks, lot.sector)
    ) {
      valuationShock = scenario.sectorShocks[lot.sector];
      shockSource = 'sector';
    } else if (
      lot.assetClass &&
      Object.hasOwn(scenario.assetClassShocks, lot.assetClass)
    ) {
      valuationShock = scenario.assetClassShocks[lot.assetClass]!;
      shockSource = 'assetClass';
    }
    const currencyShock =
      lot.currency && lot.currency !== 'EUR'
        ? (scenario.currencyShocks?.[lot.currency] ?? 0)
        : 0;
    const afterEUR = money(
      lot.valueEUR * (1 + valuationShock) * (1 + currencyShock),
    );
    return {
      ...lot,
      afterEUR,
      lossEUR: money(lot.valueEUR - afterEUR),
      valuationShock,
      currencyShock,
      shockSource,
    };
  });
  if (scenario.currencyShocks?.EUR && scenario.currencyShocks.EUR !== 0)
    throw new Error(
      'EUR is the reporting currency; its EUR FX shock must be zero.',
    );
  const beforeEUR = exposure.totalValueEUR,
    afterEUR = total(lots.map((lot) => lot.afterEUR)),
    lossEUR = money(beforeEUR - afterEUR);
  const cashIds = new Set(exposure.cashHoldingIds);
  const cashAfterStressEUR = total(
    lots.filter((lot) => cashIds.has(lot.holdingId)).map((lot) => lot.afterEUR),
  );
  const capitalCallsEUR = money(
    exposure.unfundedCommitmentEUR * scenario.capitalCallRate,
  );
  const cashAfterCallsEUR = money(cashAfterStressEUR - capitalCallsEUR);
  const warnings = [...exposure.warnings];
  const hasCurrencyShock = Object.values(scenario.currencyShocks ?? {}).some(
    (value) => value !== 0,
  );
  if (hasCurrencyShock && exposure.coverage.currencyUnknownEUR > 0)
    warnings.push({
      code: 'partial-fx-stress',
      message:
        'Currency shocks are applied only to disclosed effective currency exposures. Unknown-currency amounts receive no FX adjustment and are not assumed hedged.',
    });
  if (
    Object.keys(scenario.issuerShocks ?? {}).length > 0 &&
    exposure.coverage.issuerUnknownEUR > 0
  )
    warnings.push({
      code: 'partial-issuer-stress',
      message:
        'Issuer overrides cannot be applied to undisclosed issuers; their disclosed asset-class or sector assumptions still apply.',
    });
  if (
    Object.keys(scenario.sectorShocks ?? {}).length > 0 &&
    exposure.coverage.sectorUnknownEUR > 0
  )
    warnings.push({
      code: 'partial-sector-stress',
      message:
        'Sector overrides cannot be applied to undisclosed sectors; their disclosed asset-class assumptions still apply.',
    });
  return {
    scenario,
    beforeEUR,
    afterEUR,
    lossEUR,
    lossPercent: beforeEUR > 0 ? (lossEUR / beforeEUR) * 100 : null,
    contributors: stressGroups(lots, (lot) => ({
      id: lot.holdingId,
      name: lot.holdingName,
    })),
    issuerContributors: stressGroups(lots, (lot) => ({
      id: lot.issuerId ?? '__unknown__',
      name: lot.issuerName ?? lot.issuerId ?? 'Unknown / undisclosed',
    })),
    lots,
    unresolvedExposureEUR: exposure.coverage.lookThroughUnresolvedEUR,
    currencyUnresolvedEUR: exposure.coverage.currencyUnknownEUR,
    unclassifiedExposureEUR: exposure.coverage.assetClassUnknownEUR,
    warnings,
    liquidity: {
      cashBeforeEUR: exposure.cashEUR,
      cashAfterStressEUR,
      coverageComplete:
        exposure.coverage.valuationUnknownCount === 0 &&
        exposure.coverage.unfundedUnknownCount === 0 &&
        exposure.coverage.liquidityUnknownCount === 0 &&
        exposure.coverage.assetClassInferredCount === 0,
      unfundedCommitmentEUR: exposure.unfundedCommitmentEUR,
      capitalCallRate: scenario.capitalCallRate,
      capitalCallsEUR,
      cashAfterCallsEUR,
      shortfallEUR: Math.max(0, -cashAfterCallsEUR),
      assumptions: [
        'Numeric liquidity results use only known recorded values, commitments and liquidity classifications. Unknown liquidity establishes neither availability nor lockup. When coverageComplete is false, these are partial subtotals and cannot establish actual funding headroom, a confirmed shortfall or the absence of capital calls.',
        'The selected portion of current unfunded commitments is assumed called immediately after valuation shocks. Calls use EUR commitments without forecasting FX or call schedules.',
        'Only holdings with confirmed Cash and known liquidity classifications fund calls; inferred asset classifications do not establish funding availability. No asset sales, incoming distributions, credit facilities, taxes, fees or minimum cash reserve are assumed. Fund look-through cash is not treated as directly available cash.',
        'Selected families’ and entities’ balances are aggregated for indicative headroom only. Cash availability, account restrictions and the legal or operational ability to fund another entity’s calls are not established, and no transfers are executed.',
        'Capital calls are a liquidity requirement, not an investment loss. Before/after portfolio values show valuation shocks only; the call cash flow is shown separately without assuming an immediate NAV mark for the funded investment.',
      ],
    },
    limitations: RISK_MODEL_LIMITATIONS,
  };
}
