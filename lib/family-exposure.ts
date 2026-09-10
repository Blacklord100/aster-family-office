import type { Family, Holding } from '../data/types';
import type { ExposureLot, StressResult, TotalExposure } from './risk-contract';
import type { HistoryLifecycleState } from './portfolio-history-lifecycle-contract';
import {
  effectiveLifecycleRecords,
  lifecycleFromRecords,
} from './portfolio-history-lifecycle';

const sumMoney = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;

/** Only sourced lifecycle records establish an exit or future acquisition. A first NAV never does. */
export function currentRiskHoldings(
  holdings: readonly Holding[],
  lifecycle: HistoryLifecycleState | undefined,
  date: string,
) {
  const records = effectiveLifecycleRecords(lifecycle);
  const excluded: Holding[] = [];
  const unknownOwnership: Holding[] = [];
  const current = holdings.filter((holding) => {
    const ownership = lifecycleFromRecords(
      records.filter((record) => record.holdingId === holding.id),
      date,
    ).ownership;
    if (ownership === 'closed' || ownership === 'not_yet_opened') {
      excluded.push(holding);
      return false;
    }
    if (ownership === 'unknown') unknownOwnership.push(holding);
    return true;
  });
  return { holdings: current, excluded, unknownOwnership };
}

type FamilyBasis = {
  familyId: string;
  name: string;
  knownValueEUR: number;
  holdingCount: number;
  missingValuationCount: number;
  oldestValuationDate: string | null;
  latestValuationDate: string | null;
  lots: ExposureLot[];
};

/** The supplied holdings are the authoritative visible scope. Never discover families from graph metadata. */
function familyBases(
  holdings: readonly Holding[],
  families: readonly Pick<Family, 'id' | 'name'>[],
  lots: readonly ExposureLot[],
): FamilyBasis[] {
  const familyNames = new Map(
    families.map((family) => [family.id, family.name]),
  );
  const allowed = new Map(
    holdings.map((holding) => [holding.id, holding.familyId]),
  );
  const groups = new Map<string, Holding[]>();
  for (const holding of holdings) {
    const group = groups.get(holding.familyId) ?? [];
    group.push(holding);
    groups.set(holding.familyId, group);
  }
  return [...groups].map(([familyId, members]) => {
    const valued = members.filter(
      (holding) => holding.valuationStatus !== 'unknown',
    );
    const dates = valued
      .map((holding) => holding.valuationDate)
      .filter(Boolean)
      .sort();
    return {
      familyId,
      name: familyNames.get(familyId) ?? 'Family',
      knownValueEUR: sumMoney(valued.map((holding) => holding.valueEUR)),
      holdingCount: members.length,
      missingValuationCount: members.length - valued.length,
      oldestValuationDate: dates[0] ?? null,
      latestValuationDate: dates.at(-1) ?? null,
      lots: lots.filter(
        (lot) =>
          lot.familyId === familyId && allowed.get(lot.holdingId) === familyId,
      ),
    };
  });
}

export type FamilyIssuerExposure = FamilyBasis & {
  directEUR: number;
  indirectEUR: number;
  exposureEUR: number;
  portfolioPercent: number | null;
  undisclosedIssuerEUR: number;
  matchedLots: ExposureLot[];
};

/** Terminal lots partition holding NAV; wrapper values never get added to their children. */
export function familyIssuerExposure(
  holdings: readonly Holding[],
  families: readonly Pick<Family, 'id' | 'name'>[],
  exposure: TotalExposure,
  issuerId: string,
): FamilyIssuerExposure[] {
  return familyBases(holdings, families, exposure.lots)
    .map((family) => {
      const matchedLots = family.lots.filter(
        (lot) => !lot.unresolved && lot.issuerId === issuerId,
      );
      const directEUR = sumMoney(
        matchedLots
          .filter((lot) => lot.path.length === 1)
          .map((lot) => lot.valueEUR),
      );
      const indirectEUR = sumMoney(
        matchedLots
          .filter((lot) => lot.path.length > 1)
          .map((lot) => lot.valueEUR),
      );
      const exposureEUR = sumMoney([directEUR, indirectEUR]);
      return {
        ...family,
        directEUR,
        indirectEUR,
        exposureEUR,
        matchedLots,
        portfolioPercent:
          family.missingValuationCount === 0 && family.knownValueEUR > 0
            ? (exposureEUR / family.knownValueEUR) * 100
            : null,
        undisclosedIssuerEUR: sumMoney(
          family.lots.filter((lot) => !lot.issuerId).map((lot) => lot.valueEUR),
        ),
      };
    })
    .sort(
      (a, b) => b.exposureEUR - a.exposureEUR || a.name.localeCompare(b.name),
    );
}

export type FamilyStress = FamilyBasis & {
  afterEUR: number;
  lossEUR: number;
  lossPercent: number | null;
  unresolvedEUR: number;
  unknownCurrencyEUR: number;
  noValuationShockEUR: number;
  inferredAssetClassCount: number;
};

/** Reaggregate the same scenario's already-rounded terminal results, without rerunning a different scenario per family. */
export function familyStressExposure(
  holdings: readonly Holding[],
  families: readonly Pick<Family, 'id' | 'name'>[],
  stress: StressResult,
): FamilyStress[] {
  const stressedLots = new Map(stress.lots.map((lot) => [lot.id, lot]));
  return familyBases(holdings, families, stress.lots)
    .map((family) => {
      const lots = family.lots.map((lot) => stressedLots.get(lot.id)!);
      const afterEUR = sumMoney(lots.map((lot) => lot.afterEUR));
      const lossEUR = sumMoney(lots.map((lot) => lot.lossEUR));
      return {
        ...family,
        afterEUR,
        lossEUR,
        lossPercent:
          family.missingValuationCount === 0 && family.knownValueEUR > 0
            ? (lossEUR / family.knownValueEUR) * 100
            : null,
        unresolvedEUR: sumMoney(
          lots.filter((lot) => lot.unresolved).map((lot) => lot.valueEUR),
        ),
        unknownCurrencyEUR: sumMoney(
          lots.filter((lot) => !lot.currency).map((lot) => lot.valueEUR),
        ),
        noValuationShockEUR: sumMoney(
          lots
            .filter((lot) => lot.shockSource === 'none')
            .map((lot) => lot.valueEUR),
        ),
        inferredAssetClassCount: holdings.filter(
          (holding) =>
            holding.familyId === family.familyId &&
            holding.assetClassStatus === 'inferred',
        ).length,
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.lossEUR) - Math.abs(a.lossEUR) ||
        a.name.localeCompare(b.name),
    );
}

export type ManagerIssuerMatrix = {
  issuers: {
    id: string;
    name: string;
    valueEUR: number;
    managerCount: number;
  }[];
  managers: {
    id: string;
    name: string;
    cells: { issuerId: string; valueEUR: number; lots: ExposureLot[] }[];
  }[];
  omittedEUR: number;
};

/** A monetary cell needs both explicit issuer and attributed manager; missing data is not a zero-exposure claim. */
export function managerIssuerMatrix(
  holdings: readonly Holding[],
  exposure: TotalExposure,
): ManagerIssuerMatrix {
  const allowed = new Map(
    holdings.map((holding) => [holding.id, holding.familyId]),
  );
  const lots = exposure.lots.filter(
    (lot) => allowed.get(lot.holdingId) === lot.familyId,
  );
  const managers = new Map<
    string,
    { id: string; name: string; cells: Map<string, ExposureLot[]> }
  >();
  const issuers = new Map<
    string,
    { id: string; name: string; lots: ExposureLot[]; managerIds: Set<string> }
  >();
  for (const lot of lots) {
    if (!lot.issuerId || !lot.managerId || lot.unresolved) continue;
    const manager = managers.get(lot.managerId) ?? {
      id: lot.managerId,
      name: lot.managerName ?? 'Undisclosed manager',
      cells: new Map<string, ExposureLot[]>(),
    };
    const cell = manager.cells.get(lot.issuerId) ?? [];
    cell.push(lot);
    manager.cells.set(lot.issuerId, cell);
    managers.set(lot.managerId, manager);
    const issuer = issuers.get(lot.issuerId) ?? {
      id: lot.issuerId,
      name: lot.issuerName ?? 'Disclosed issuer',
      lots: [],
      managerIds: new Set<string>(),
    };
    issuer.lots.push(lot);
    issuer.managerIds.add(lot.managerId);
    issuers.set(lot.issuerId, issuer);
  }
  return {
    issuers: [...issuers.values()]
      .map((issuer) => ({
        id: issuer.id,
        name: issuer.name,
        valueEUR: sumMoney(issuer.lots.map((lot) => lot.valueEUR)),
        managerCount: issuer.managerIds.size,
      }))
      .sort(
        (a, b) =>
          b.managerCount - a.managerCount ||
          b.valueEUR - a.valueEUR ||
          a.id.localeCompare(b.id),
      ),
    managers: [...managers.values()]
      .map((manager) => ({
        id: manager.id,
        name: manager.name,
        cells: [...manager.cells].map(([issuerId, lots]) => ({
          issuerId,
          lots,
          valueEUR: sumMoney(lots.map((lot) => lot.valueEUR)),
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    omittedEUR: sumMoney(
      lots
        .filter((lot) => !lot.issuerId || !lot.managerId || lot.unresolved)
        .map((lot) => lot.valueEUR),
    ),
  };
}
