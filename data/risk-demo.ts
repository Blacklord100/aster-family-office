import type { Holding } from './types';
import { holdings as sampleHoldings } from './portfolio';
import {
  emptyRiskData,
  type RiskData,
  type RiskNode,
} from '../lib/risk-contract';

export const RISK_DEMO_NOTICE =
  'Synthetic demonstration allocations. The example underlying businesses and weights are invented and are not the actual constituents of any named fund.';

/** Explicit sample-only fixtures. This function never classifies a live holding by its name. */
export function createDemoRiskData(
  holdings: readonly Holding[] = sampleHoldings,
): RiskData {
  const data = emptyRiskData();
  const samples = new Map(
    sampleHoldings.map((holding) => [holding.id, holding]),
  );
  const source = {
    sourceId: 'synthetic-risk-allocation-2026-06',
    asOfDate: '2026-06-30',
    synthetic: true,
  };
  const add = (node: Omit<RiskNode, 'sourceId' | 'asOfDate' | 'synthetic'>) => {
    if (!data.nodes.some((existing) => existing.id === node.id))
      data.nodes.push({ ...node, ...source });
  };
  const company = (
    id: string,
    name: string,
    assetClass: RiskNode['assetClass'],
    sector: string,
    country: string,
    currency: RiskNode['currency'],
  ) => {
    add({
      id,
      name,
      kind: 'asset',
      issuerId: id,
      issuerName: name,
      assetClass,
      sector,
      country,
      currency,
    });
  };
  company(
    'example-atlas',
    'Example Atlas Software',
    'Public equities',
    'Technology',
    'United States',
    'USD',
  );
  company(
    'example-cedar',
    'Example Cedar Semiconductors',
    'Public equities',
    'Technology',
    'Netherlands',
    'EUR',
  );
  company(
    'example-boreal',
    'Example Boreal Health',
    'Public equities',
    'Healthcare',
    'Sweden',
    'EUR',
  );
  company(
    'example-orbit',
    'Example Orbit Industries',
    'Public equities',
    'Industrials',
    'Germany',
    'EUR',
  );
  company(
    'example-harbor',
    'Example Harbor Services',
    'Private equity',
    'Business services',
    'United Kingdom',
    'GBP',
  );
  company(
    'example-lumen',
    'Example Lumen Energy',
    'Venture capital',
    'Energy',
    'United States',
    'USD',
  );
  company(
    'example-cobalt',
    'Example Cobalt Robotics',
    'Venture capital',
    'Technology',
    'Singapore',
    'USD',
  );
  company(
    'example-credit',
    'Example Alder Credit Issuer',
    'Fixed income',
    'Financials',
    'France',
    'EUR',
  );
  const edge = (parentId: string, childId: string, weight?: number) =>
    data.links.push({
      id: `${parentId}:${childId}`,
      parentId,
      childId,
      weight,
      ...source,
    });
  add({
    id: 'example-technology-sleeve',
    name: 'Example technology sleeve',
    kind: 'fund',
    assetClass: 'Public equities',
    managerId: 'example-manager',
    managerName: 'Example Meridian Advisory',
  });
  edge('example-technology-sleeve', 'example-atlas', 0.65);
  edge('example-technology-sleeve', 'example-cedar', 0.25);
  const fundAllocations: Record<string, [string, number | undefined][]> = {
    'global-equity': [
      ['example-technology-sleeve', 0.35],
      ['example-boreal', 0.15],
      ['example-orbit', 0.2],
    ],
    'nordic-equity': [
      ['example-cedar', 0.25],
      ['example-boreal', 0.3],
      ['example-orbit', 0.3],
    ],
    sp500: [
      ['example-atlas', 0.35],
      ['example-boreal', 0.25],
      ['example-orbit', 0.2],
    ],
    northstar: [['example-harbor', 0.5]],
    'nordic-buyout': [['example-harbor', 0.4]],
    'harbor-growth': [['example-harbor', 0.3]],
    meridian: [
      ['example-lumen', 0.3],
      ['example-cobalt', 0.25],
    ],
    'fjord-climate': [['example-lumen', 0.45]],
    'pacific-ventures': [
      ['example-cobalt', 0.35],
      ['example-lumen', undefined],
    ],
    'euro-bonds': [['example-credit', 0.6]],
  };
  const direct: Record<string, Partial<RiskNode>> = {
    microsoft: {
      issuerId: 'sample-microsoft',
      issuerName: 'Microsoft',
      sector: 'Technology',
      country: 'United States',
      currency: 'USD',
    },
    asml: {
      issuerId: 'sample-asml',
      issuerName: 'ASML Holding',
      sector: 'Technology',
      country: 'Netherlands',
      currency: 'EUR',
    },
    nvidia: {
      issuerId: 'sample-nvidia',
      issuerName: 'NVIDIA',
      sector: 'Technology',
      country: 'United States',
      currency: 'USD',
    },
    'german-bund': {
      issuerId: 'sample-germany',
      issuerName: 'Federal Republic of Germany',
      sector: 'Sovereign',
      country: 'Germany',
      currency: 'EUR',
    },
    treasury: {
      issuerId: 'sample-us-treasury',
      issuerName: 'United States Treasury',
      sector: 'Sovereign',
      country: 'United States',
      currency: 'EUR',
    },
    'paris-property': {
      issuerId: 'sample-paris-property',
      issuerName: 'Avenue Foch property SPV',
      sector: 'Real estate',
      country: 'France',
      currency: 'EUR',
    },
    'stockholm-property': {
      issuerId: 'sample-stockholm-property',
      issuerName: 'Stockholm Logistics property SPV',
      sector: 'Real estate',
      country: 'Sweden',
      currency: 'EUR',
    },
    'lisbon-property': {
      issuerId: 'sample-lisbon-property',
      issuerName: 'Lisbon Hospitality property SPV',
      sector: 'Real estate',
      country: 'Portugal',
      currency: 'EUR',
    },
    'ubs-cash': {
      issuerId: 'sample-ubs',
      issuerName: 'UBS cash counterparty',
      sector: 'Financials',
      country: 'Switzerland',
      currency: 'EUR',
    },
    'seb-cash': {
      issuerId: 'sample-seb',
      issuerName: 'SEB cash counterparty',
      sector: 'Financials',
      country: 'Sweden',
      currency: 'CHF',
    },
    'jpm-cash': {
      issuerId: 'sample-jpm',
      issuerName: 'J.P. Morgan cash counterparty',
      sector: 'Financials',
      country: 'United States',
      currency: 'USD',
    },
  };
  for (const holding of holdings) {
    const sample = samples.get(holding.id);
    // Require the explicit sample identity, not just a familiar real-world name or ticker.
    if (
      !sample ||
      sample.name !== holding.name ||
      sample.familyId !== holding.familyId ||
      sample.accountId !== holding.accountId
    )
      continue;
    const nodeId = `sample-root:${holding.id}`;
    const allocations = fundAllocations[holding.id];
    add({
      id: nodeId,
      name: holding.name,
      kind: allocations ? 'fund' : 'asset',
      assetClass: holding.assetClass,
      managerId: `sample-manager:${holding.manager.toLowerCase()}`,
      managerName: holding.manager,
      ...direct[holding.id],
    });
    data.positions.push({ holdingId: holding.id, nodeId });
    if (allocations)
      for (const [childId, weight] of allocations)
        edge(nodeId, childId, weight);
  }
  // Persist only reachable fixtures, so an empty/live portfolio gets no fictional nodes.
  const reachable = new Set<string>();
  function visit(id: string) {
    if (reachable.has(id)) return;
    reachable.add(id);
    data.links
      .filter((link) => link.parentId === id)
      .forEach((link) => visit(link.childId));
  }
  data.positions.forEach((position) => visit(position.nodeId));
  data.nodes = data.nodes.filter((node) => reachable.has(node.id));
  data.links = data.links.filter((link) => reachable.has(link.parentId));
  return data;
}
