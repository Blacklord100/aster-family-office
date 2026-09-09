import { z } from 'zod';
import type { AssetClass, Currency } from '../data/types';

export const RISK_LIMITS = {
  nodes: 400,
  links: 800,
  positions: 200,
  depth: 20,
  paths: 20_000,
  maxValueEUR: 1_000_000_000_000,
} as const;
export const RISK_ASSET_CLASSES = [
  'Public equities',
  'Private equity',
  'Venture capital',
  'Real estate',
  'Fixed income',
  'Cash',
] as const;
export const RISK_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'] as const;
const identifier = z.string().trim().min(1).max(160);
const label = z.string().trim().min(1).max(240);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, 'Use a valid calendar date.');

export const riskNodeSchema = z
  .object({
    id: identifier,
    name: label,
    kind: z.enum(['fund', 'asset']),
    assetClass: z.enum(RISK_ASSET_CLASSES).optional(),
    issuerId: identifier.optional(),
    issuerName: label.optional(),
    managerId: identifier.optional(),
    managerName: label.optional(),
    sector: label.optional(),
    country: label.optional(),
    /** Explicit effective currency exposure after known hedges; never inferred from a fund's denomination. */
    currency: z.enum(RISK_CURRENCIES).optional(),
    sourceId: identifier.optional(),
    asOfDate: date.optional(),
    synthetic: z.boolean().optional(),
  })
  .strict();
export const riskLinkSchema = z
  .object({
    id: identifier,
    parentId: identifier,
    childId: identifier,
    /** Decimal share of parent NAV, from 0 to 1. Omitted means undisclosed, never equal-weighted. */
    weight: z.number().min(0).max(1).optional(),
    sourceId: identifier.optional(),
    asOfDate: date.optional(),
    synthetic: z.boolean().optional(),
  })
  .strict();
const riskDataBaseSchema = z
  .object({
    version: z.literal(1),
    nodes: z.array(riskNodeSchema).max(RISK_LIMITS.nodes),
    links: z.array(riskLinkSchema).max(RISK_LIMITS.links),
    positions: z
      .array(z.object({ holdingId: identifier, nodeId: identifier }).strict())
      .max(RISK_LIMITS.positions),
  })
  .strict();

/** Validates persisted/imported mappings, including orphan references and every graph component. */
export const riskDataSchema = riskDataBaseSchema.superRefine((data, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: 'custom', message });
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  if (nodes.size !== data.nodes.length) error('Node IDs must be unique.');
  if (new Set(data.links.map((link) => link.id)).size !== data.links.length)
    error('Link IDs must be unique.');
  if (
    new Set(data.positions.map((position) => position.holdingId)).size !==
    data.positions.length
  )
    error('Each holding can have only one root mapping.');
  const children = new Map<string, typeof data.links>();
  const pairs = new Set<string>();
  for (const link of data.links) {
    if (!nodes.has(link.parentId) || !nodes.has(link.childId))
      error(`Link ${link.id} references a missing node.`);
    if (nodes.get(link.parentId)?.kind !== 'fund')
      error(`Only fund nodes can have children: ${link.parentId}.`);
    const pair = JSON.stringify([link.parentId, link.childId]);
    if (pairs.has(pair))
      error(`Duplicate parent/child link: ${link.parentId} → ${link.childId}.`);
    pairs.add(pair);
    const rows = children.get(link.parentId) ?? [];
    rows.push(link);
    children.set(link.parentId, rows);
  }
  for (const [id, rows] of children) {
    if (rows.reduce((sum, row) => sum + (row.weight ?? 0), 0) > 1 + 1e-10)
      error(`Disclosed weights exceed 100% at ${id}.`);
  }
  for (const position of data.positions)
    if (!nodes.has(position.nodeId))
      error(`Holding ${position.holdingId} references a missing root node.`);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  let cycle = false;
  function depth(id: string): number {
    if (visiting.has(id)) {
      cycle = true;
      return 0;
    }
    if (memo.has(id)) return memo.get(id)!;
    visiting.add(id);
    const value =
      1 +
      Math.max(
        0,
        ...(children.get(id) ?? []).map((link) => depth(link.childId)),
      );
    visiting.delete(id);
    memo.set(id, value);
    return value;
  }
  for (const node of data.nodes)
    if (depth(node.id) > RISK_LIMITS.depth) {
      error(`Graph exceeds ${RISK_LIMITS.depth} levels.`);
      break;
    }
  if (cycle) error('Look-through relationships must not contain a cycle.');
  if (!cycle) {
    const counts = new Map<string, number>();
    const countPaths = (id: string): number => {
      if (counts.has(id)) return counts.get(id)!;
      const count = Math.min(
        RISK_LIMITS.paths + 1,
        1 +
          (children.get(id) ?? [])
            .filter((link) => (link.weight ?? 0) > 0)
            .reduce((sum, link) => sum + countPaths(link.childId), 0),
      );
      counts.set(id, count);
      return count;
    };
    if (
      data.positions.reduce(
        (sum, position) => sum + countPaths(position.nodeId),
        0,
      ) > RISK_LIMITS.paths
    )
      error(
        `Expanded look-through exceeds ${RISK_LIMITS.paths} paths; simplify the graph.`,
      );
  }
});
export type RiskData = z.infer<typeof riskDataBaseSchema>;
export type RiskNode = z.infer<typeof riskNodeSchema>;
export type RiskLink = z.infer<typeof riskLinkSchema>;
export const emptyRiskData = (): RiskData => ({
  version: 1,
  nodes: [],
  links: [],
  positions: [],
});

const shock = z.number().min(-1).max(3);
export const riskScenarioSchema = z
  .object({
    id: identifier,
    name: label,
    description: z.string().max(2000),
    assetClassShocks: z.partialRecord(z.enum(RISK_ASSET_CLASSES), shock),
    issuerShocks: z.record(identifier, shock).optional(),
    sectorShocks: z.record(label, shock).optional(),
    currencyShocks: z.partialRecord(z.enum(RISK_CURRENCIES), shock).optional(),
    /** Portion of current unfunded commitments called, separate from valuation changes. */
    capitalCallRate: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    if (
      scenario.currencyShocks?.EUR !== undefined &&
      scenario.currencyShocks.EUR !== 0
    )
      ctx.addIssue({
        code: 'custom',
        path: ['currencyShocks', 'EUR'],
        message:
          'EUR is the reporting currency; its EUR FX shock must be zero.',
      });
    if (
      Object.keys(scenario.issuerShocks ?? {}).length > RISK_LIMITS.nodes ||
      Object.keys(scenario.sectorShocks ?? {}).length > RISK_LIMITS.nodes
    )
      ctx.addIssue({
        code: 'custom',
        message: `At most ${RISK_LIMITS.nodes} issuer or sector overrides are supported.`,
      });
  });
export type RiskScenario = z.infer<typeof riskScenarioSchema>;
export type RiskSource = {
  sourceId?: string;
  asOfDate?: string;
  synthetic: boolean;
  label: string;
};
export type RiskWarning = {
  code: string;
  message: string;
  holdingId?: string;
  nodeId?: string;
};
export type ExposureLot = {
  id: string;
  holdingId: string;
  holdingName: string;
  familyId: string;
  nodeId?: string;
  name: string;
  valueEUR: number;
  path: string[];
  pathNames: string[];
  issuerId?: string;
  issuerName?: string;
  managerId?: string;
  managerName?: string;
  assetClass?: AssetClass;
  sector?: string;
  country?: string;
  currency?: Currency;
  unresolved: boolean;
  unresolvedReason?: string;
  sources: RiskSource[];
};
export type ExposureGroup = {
  id: string;
  name: string;
  valueEUR: number;
  percentage: number;
  holdingIds: string[];
  holdingCount: number;
  pathCount: number;
};
export type ExposureCoverage = {
  valuationKnownCount: number;
  valuationUnknownCount: number;
  unfundedKnownCount: number;
  unfundedUnknownCount: number;
  liquidityKnownCount: number;
  liquidityUnknownCount: number;
  assetClassInferredCount: number;
  issuerKnownEUR: number;
  issuerUnknownEUR: number;
  issuerCoveragePercent: number;
  lookThroughResolvedEUR: number;
  lookThroughUnresolvedEUR: number;
  lookThroughCoveragePercent: number;
  managerKnownEUR: number;
  managerUnknownEUR: number;
  sectorKnownEUR: number;
  sectorUnknownEUR: number;
  countryKnownEUR: number;
  countryUnknownEUR: number;
  currencyKnownEUR: number;
  currencyUnknownEUR: number;
  assetClassKnownEUR: number;
  assetClassUnknownEUR: number;
};
export type TotalExposure = {
  totalValueEUR: number;
  lots: ExposureLot[];
  issuerExposure: ExposureGroup[];
  managerExposure: ExposureGroup[];
  assetClassExposure: ExposureGroup[];
  sectorExposure: ExposureGroup[];
  countryExposure: ExposureGroup[];
  currencyExposure: ExposureGroup[];
  holdingExposure: ExposureGroup[];
  coverage: ExposureCoverage;
  warnings: RiskWarning[];
  provenance: RiskSource[];
  asOfDate: string;
  cashEUR: number;
  cashHoldingIds: string[];
  unfundedCommitmentEUR: number;
  limitations: string[];
};
export type StressContributor = {
  id: string;
  name: string;
  beforeEUR: number;
  afterEUR: number;
  lossEUR: number;
  returnPercent: number | null;
  holdingIds: string[];
};
export type StressedLot = ExposureLot & {
  afterEUR: number;
  lossEUR: number;
  valuationShock: number;
  currencyShock: number;
  shockSource: 'issuer' | 'sector' | 'assetClass' | 'none';
};
export type StressResult = {
  scenario: RiskScenario;
  beforeEUR: number;
  afterEUR: number;
  lossEUR: number;
  lossPercent: number | null;
  contributors: StressContributor[];
  issuerContributors: StressContributor[];
  lots: StressedLot[];
  unresolvedExposureEUR: number;
  currencyUnresolvedEUR: number;
  unclassifiedExposureEUR: number;
  warnings: RiskWarning[];
  liquidity: {
    cashBeforeEUR: number;
    cashAfterStressEUR: number;
    coverageComplete: boolean;
    unfundedCommitmentEUR: number;
    capitalCallRate: number;
    capitalCallsEUR: number;
    cashAfterCallsEUR: number;
    shortfallEUR: number;
    assumptions: string[];
  };
  limitations: string[];
};
