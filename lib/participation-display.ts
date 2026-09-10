import type { ParticipationResponse } from './participation-contract';
import { csvCell } from './history-display';

/** Export the complete authorized selection, independent of grid pagination. */
export function participationCSV(data: ParticipationResponse): string {
  const rows: (string | number | null | undefined)[][] = [
    [
      'Aster family participation',
      'As of',
      data.asOf,
      'Currency',
      data.currency,
      'Workspace revision',
      data.revision,
    ],
    ['Query', JSON.stringify(data.query)],
    [
      'Basis',
      'Share of visible known deal NAV is not legal ownership. Portfolio percentages use the selected family/entity scope; incomplete denominators are blank.',
    ],
    [
      'Deal',
      'Vehicle',
      'Share class',
      'Round',
      'Family',
      'Entity',
      'Account',
      'Holding ID',
      'Position NAV',
      'Valuation date',
      'Valuation source',
      'Family deal NAV',
      'Family share of known deal NAV (%)',
      'Deal weight in selected family NAV (%)',
      'Selected family portfolio NAV',
      'Family valued positions',
      'Family total positions',
      'Link source',
      'Link effective date',
      'Actual ownership (%)',
      'Ownership denominator',
      'Ownership effective date',
      'Ownership source',
    ],
  ];
  for (const deal of data.investments)
    for (const family of deal.families)
      for (const p of family.positions) {
        rows.push([
          deal.identity.name,
          deal.identity.vehicle,
          deal.identity.shareClass,
          deal.identity.round,
          family.name,
          p.entityName,
          p.accountName,
          p.holdingId,
          p.nav,
          p.valuationDate,
          p.valuationSourceId,
          family.nav,
          family.shareOfKnownNAV,
          family.portfolioWeight,
          family.portfolioNAV,
          family.coverage.knownCount,
          family.coverage.totalCount,
          p.sourceId,
          p.effectiveDate,
          p.actualOwnershipPercent,
          p.ownershipBasis,
          p.ownershipEffectiveDate,
          p.ownershipSourceId,
        ]);
      }
  for (const p of data.unlinked)
    rows.push([
      'Unlinked position',
      '',
      '',
      '',
      p.familyName,
      p.entityName,
      p.accountName,
      p.holdingId,
      p.nav,
      p.valuationDate,
      p.valuationSourceId,
    ]);
  return '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}
