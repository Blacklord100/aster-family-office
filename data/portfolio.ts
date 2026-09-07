import type {
  Account,
  AssetClass,
  Entity,
  Family,
  FamilyId,
  Holding,
  HoldingValuation,
  LiquidityBucket,
} from './types';

export const AS_OF_DATE = '2026-09-07';
export const OFFICE_NAME = 'Aster Family Office';
export const DATA_NOTICE =
  'Illustrative workspace · All people, accounts, holdings, prices, messages and returns are synthetic demo data. No live connections.';
export const PERFORMANCE_NOTICE =
  'Illustrative EUR time-weighted returns, linked daily with explicitly modeled end-of-day external flows. Private marks are carried forward between synthetic reports. Not actual investment performance.';
export const assetClassColors: Record<AssetClass, string> = {
  'Public equities': '#1d594f',
  'Private equity': '#679386',
  'Venture capital': '#bdc9a2',
  'Real estate': '#cda578',
  'Fixed income': '#8e9da8',
  Cash: '#d9d5ca',
};
export const families: Family[] = [
  {
    id: 'laurent',
    name: 'Laurent',
    initials: 'CL',
    principal: 'Camille Laurent',
    location: 'Paris, France',
    color: '#245e52',
  },
  {
    id: 'bergstrom',
    name: 'Bergström',
    initials: 'SB',
    principal: 'Sofia Bergström',
    location: 'Stockholm, Sweden',
    color: '#b6976d',
  },
  {
    id: 'chen',
    name: 'Chen',
    initials: 'DC',
    principal: 'Daniel Chen',
    location: 'Singapore',
    color: '#8699a9',
  },
];
export const entities: Entity[] = families.flatMap((family, i) => [
  {
    id: `${family.id}-holding`,
    familyId: family.id,
    name: `${family.name} Capital`,
    type: 'Holding company' as const,
    jurisdiction: ['France', 'Sweden', 'Singapore'][i],
    ownershipPercent: 100,
  },
  {
    id: `${family.id}-property`,
    familyId: family.id,
    name: `${family.name} Property Holdings`,
    type: 'Property SPV' as const,
    jurisdiction: ['France', 'Sweden', 'Portugal'][i],
    ownershipPercent: 100,
  },
]);
export const accounts: Account[] = families.flatMap((family, i) => [
  {
    id: `${family.id}-custody`,
    familyId: family.id,
    entityId: `${family.id}-holding`,
    name: `${family.name} investment account`,
    institution: ['UBS', 'SEB', 'J.P. Morgan'][i],
    maskedNumber: ['•• 4821', '•• 7306', '•• 2914'][i],
    type: 'Custody' as const,
  },
  {
    id: `${family.id}-private`,
    familyId: family.id,
    entityId: `${family.id}-holding`,
    name: `${family.name} private investments`,
    institution: 'Manager reported',
    maskedNumber: ['•• 1042', '•• 2064', '•• 3086'][i],
    type: 'Private investments' as const,
  },
  {
    id: `${family.id}-property`,
    familyId: family.id,
    entityId: `${family.id}-property`,
    name: `${family.name} property portfolio`,
    institution: 'Independent appraisal',
    maskedNumber: ['•• 6101', '•• 6202', '•• 6303'][i],
    type: 'Property' as const,
  },
]);

type Seed = [
  string,
  string,
  AssetClass,
  FamilyId,
  number,
  number,
  Holding['currency'],
  string,
  string,
  number,
  string?,
];
// Values/cost/unfunded are in EUR millions. These are invented positions, not live quotes.
const seeds: Seed[] = [
  [
    'global-equity',
    'Vanguard FTSE All-World',
    'Public equities',
    'laurent',
    12.4,
    9.5,
    'EUR',
    'Global',
    'Vanguard',
    0,
    'VWCE',
  ],
  [
    'microsoft',
    'Microsoft',
    'Public equities',
    'laurent',
    6.8,
    4.9,
    'USD',
    'North America',
    'UBS',
    0,
    'MSFT',
  ],
  [
    'northstar',
    'Northstar Buyout Fund III',
    'Private equity',
    'laurent',
    9.6,
    8.2,
    'EUR',
    'Europe',
    'Northstar Partners',
    3.4,
  ],
  [
    'meridian',
    'Meridian Ventures IV',
    'Venture capital',
    'laurent',
    4.8,
    3.9,
    'USD',
    'North America',
    'Meridian Ventures',
    2.1,
  ],
  [
    'paris-property',
    'Avenue Foch Residences',
    'Real estate',
    'laurent',
    11.2,
    9.4,
    'EUR',
    'France',
    'Lumière Real Estate',
    0,
  ],
  [
    'german-bund',
    'German Bund · 2031',
    'Fixed income',
    'laurent',
    5.3,
    5.4,
    'EUR',
    'Germany',
    'UBS',
    0,
    'DE 2031',
  ],
  [
    'ubs-cash',
    'UBS EUR liquidity',
    'Cash',
    'laurent',
    4.5,
    4.5,
    'EUR',
    'Europe',
    'UBS',
    0,
  ],
  [
    'nordic-equity',
    'Nordic Quality Equity',
    'Public equities',
    'bergstrom',
    8.2,
    6.7,
    'EUR',
    'Nordics',
    'SEB',
    0,
    'NORDIC',
  ],
  [
    'asml',
    'ASML Holding',
    'Public equities',
    'bergstrom',
    4.6,
    3.6,
    'EUR',
    'Netherlands',
    'SEB',
    0,
    'ASML',
  ],
  [
    'nordic-buyout',
    'Nordic Enterprise Fund XI',
    'Private equity',
    'bergstrom',
    8.4,
    7.1,
    'EUR',
    'Europe',
    'Nordic Enterprise',
    2.6,
  ],
  [
    'fjord-climate',
    'Fjord Climate Fund II',
    'Venture capital',
    'bergstrom',
    3.2,
    2.8,
    'EUR',
    'Nordics',
    'Fjord Climate',
    1.8,
  ],
  [
    'stockholm-property',
    'Stockholm Logistics Park',
    'Real estate',
    'bergstrom',
    9.5,
    8.2,
    'EUR',
    'Sweden',
    'Baltic Property Partners',
    0,
  ],
  [
    'euro-bonds',
    'iShares Euro Corporate Bond',
    'Fixed income',
    'bergstrom',
    4.7,
    4.75,
    'EUR',
    'Europe',
    'BlackRock',
    0,
    'IEAC',
  ],
  [
    'seb-cash',
    'SEB treasury reserve',
    'Cash',
    'bergstrom',
    2.8,
    2.8,
    'CHF',
    'Switzerland',
    'SEB',
    0,
  ],
  [
    'sp500',
    'iShares Core S&P 500',
    'Public equities',
    'chen',
    6.5,
    5.1,
    'USD',
    'North America',
    'BlackRock',
    0,
    'CSPX',
  ],
  [
    'nvidia',
    'NVIDIA',
    'Public equities',
    'chen',
    3.5,
    2.2,
    'USD',
    'North America',
    'J.P. Morgan',
    0,
    'NVDA',
  ],
  [
    'harbor-growth',
    'Harbor Growth Fund II',
    'Private equity',
    'chen',
    6.3,
    5.4,
    'GBP',
    'Global',
    'Harbor Growth',
    2.4,
  ],
  [
    'pacific-ventures',
    'Pacific Ventures III',
    'Venture capital',
    'chen',
    4.2,
    3.5,
    'USD',
    'Asia Pacific',
    'Pacific Ventures',
    1.7,
  ],
  [
    'lisbon-property',
    'Lisbon Hospitality Collection',
    'Real estate',
    'chen',
    5.6,
    5.0,
    'EUR',
    'Portugal',
    'Atlantic Hospitality',
    0,
  ],
  [
    'treasury',
    'US Treasury · EUR hedged',
    'Fixed income',
    'chen',
    3.1,
    3.05,
    'EUR',
    'North America',
    'J.P. Morgan',
    0,
    'UST EUR-H',
  ],
  [
    'jpm-cash',
    'J.P. Morgan operating cash',
    'Cash',
    'chen',
    2.8,
    2.8,
    'USD',
    'North America',
    'J.P. Morgan',
    0,
  ],
];
const syntheticFX: Record<Holding['currency'], number> = {
  EUR: 1,
  USD: 0.92,
  GBP: 1.17,
  CHF: 1.04,
};
export const holdings: Holding[] = seeds.map(
  ([
    id,
    name,
    assetClass,
    familyId,
    value,
    cost,
    currency,
    geography,
    manager,
    unfunded,
    ticker,
  ]) => {
    const privateAsset = ['Private equity', 'Venture capital'].includes(
      assetClass,
    );
    const property = assetClass === 'Real estate';
    const liquidityBucket: LiquidityBucket = privateAsset
      ? '3+ years'
      : property
        ? '1–3 years'
        : assetClass === 'Fixed income'
          ? 'Within 30 days'
          : 'Daily';
    return {
      id,
      name,
      ticker,
      assetClass,
      familyId,
      entityId: `${familyId}-${property ? 'property' : 'holding'}`,
      accountId: `${familyId}-${property ? 'property' : privateAsset ? 'private' : 'custody'}`,
      currency,
      valueEUR: Math.round(value * 1_000_000),
      costBasisEUR: Math.round(cost * 1_000_000),
      originalValue:
        Math.round(((value * 1_000_000) / syntheticFX[currency]) * 100) / 100,
      syntheticFXRateToEUR: syntheticFX[currency],
      unfundedCommitmentEUR: Math.round(unfunded * 1_000_000),
      liquidityBucket,
      valuationDate:
        id === 'fjord-climate'
          ? '2026-03-31'
          : privateAsset || property
            ? '2026-06-30'
            : AS_OF_DATE,
      sourceId: `source-${id}`,
      geography,
      manager,
      color: assetClassColors[assetClass],
      valuationMethod: property
        ? 'Equity appraisal, net of debt'
        : privateAsset
          ? 'Reported fund NAV'
          : assetClass === 'Cash'
            ? 'Cash balance'
            : 'Synthetic market mark',
      description: property
        ? 'Synthetic family-owned SPV equity value, after property-level debt; underlying buildings are not added again.'
        : privateAsset
          ? 'Synthetic investor-level NAV. Unfunded commitments are future obligations and are excluded from current portfolio value.'
          : 'Synthetic position for product demonstration. EUR value includes illustrative currency translation.',
    };
  },
);

const DAY = 86_400_000;
const firstDay = Date.parse('2024-09-01T00:00:00Z');
const finalDay = Date.parse(`${AS_OF_DATE}T00:00:00Z`);
const dates = Array.from(
  { length: Math.round((finalDay - firstDay) / DAY) + 1 },
  (_, i) => new Date(firstDay + i * DAY).toISOString().slice(0, 10),
);
const externalFlows: Record<string, Record<string, number>> = {
  'ubs-cash': { '2025-02-14': 1_200_000, '2026-06-19': -450_000 },
  'seb-cash': { '2025-09-18': 600_000 },
  'jpm-cash': { '2026-02-12': 800_000 },
};
const isQuarterEnd = (date: string) =>
  ['03-31', '06-30', '09-30', '12-31'].includes(date.slice(5));
/** Generate backward from the exact accepted current values. Public marks vary on
 * weekdays; private/appraisal marks change only at quarter-end through their source date. */
export const valuationHistory: HoldingValuation[] = holdings.flatMap(
  (holding, holdingIndex) => {
    let value = holding.valueEUR;
    const rows: HoldingValuation[] = [];
    for (let i = dates.length - 1; i >= 0; i -= 1) {
      const date = dates[i];
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      const isPrivate = [
        'Private equity',
        'Venture capital',
        'Real estate',
      ].includes(holding.assetClass);
      const activeMark = isPrivate
        ? isQuarterEnd(date) && date <= holding.valuationDate
        : day !== 0 && day !== 6;
      const flow = externalFlows[holding.id]?.[date] ?? 0;
      rows.push({
        holdingId: holding.id,
        date,
        valueEUR: Math.round(value * 100) / 100,
        netExternalFlowEUR: flow,
        valuationBasis: !activeMark
          ? 'Carried forward'
          : isPrivate
            ? 'Synthetic reported mark'
            : 'Synthetic market mark',
      });
      let rate = 0;
      if (activeMark) {
        const wave = Math.sin(i * 0.071 + holdingIndex * 0.41);
        if (holding.assetClass === 'Public equities')
          rate =
            0.00031 +
            0.0018 * wave +
            0.00085 * Math.sin(i * 0.67 + holdingIndex);
        else if (holding.assetClass === 'Fixed income')
          rate = 0.000105 + 0.00035 * wave;
        else if (holding.assetClass === 'Cash') rate = 0.00006;
        else if (holding.assetClass === 'Venture capital')
          rate = 0.026 + 0.021 * wave;
        else if (holding.assetClass === 'Private equity')
          rate = 0.021 + 0.01 * wave;
        else rate = 0.012 + 0.006 * wave;
      }
      value = (value - flow) / (1 + rate);
    }
    return rows.reverse();
  },
);
