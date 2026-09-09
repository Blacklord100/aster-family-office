import type { Holding } from '@/data/types';
import type { PortfolioRecords } from './workspace';
import {
  cashflowCoverageCurrent,
  hasReconciledCashflowCoverage,
  LedgerError,
  transactionStatus,
} from './ledger';
import { emptyFinanceState, type FinanceState } from './ledger-contract';
import {
  periodQuerySchema,
  type PeriodQuery,
  type PeriodReport,
  type ReportingScope,
  type SourcedMark,
  type LiquidityGroup,
} from './reporting-contract';
import { emptyRiskData, type RiskData } from './risk-contract';

export const RETURN_METHODOLOGY_URL =
  'https://www.gipsstandards.org/standards/gips-standards-for-asset-owners/gips-standards-handbook-for-asset-owners/';
const cents = (n: number) => Math.round(n * 100) / 100;
const sum = (values: number[]) => cents(values.reduce((a, b) => a + b, 0));
const day = (date: string) => Date.parse(date + 'T00:00:00Z') / 86_400_000;
const fail = (code: string, message: string): never => {
  throw new LedgerError(code, message);
};

export function reportingHoldings(
  portfolio: PortfolioRecords,
  scope: ReportingScope,
): Holding[] {
  if (
    scope.familyIds.some(
      (id) => !portfolio.families.some((family) => family.id === id),
    )
  )
    fail('SCOPE_INVALID', 'Choose families available in this workspace.');
  if (
    scope.entityIds?.some(
      (id) =>
        !portfolio.entities.some(
          (entity) =>
            entity.id === id && scope.familyIds.includes(entity.familyId),
        ),
    )
  )
    fail(
      'SCOPE_INVALID',
      'Choose entities belonging to the selected families.',
    );
  return portfolio.holdings.filter(
    (holding) =>
      scope.familyIds.includes(holding.familyId) &&
      (!scope.entityIds || scope.entityIds.includes(holding.entityId)),
  );
}

/** Uses exact dated source records, never interpolated history or assumed zero opening value. */
export function sourcedMark(
  portfolio: PortfolioRecords,
  finance: FinanceState,
  holding: Holding,
  date: string,
): SourcedMark | null {
  const accepted = (sourceId: string) =>
    portfolio.evidence.find(
      (source) =>
        source.id === sourceId &&
        source.holdingId === holding.id &&
        source.status === 'Accepted' &&
        !source.synthetic,
    );
  const valuation = finance.valuations
    .filter(
      (mark) => mark.holdingId === holding.id && mark.effectiveDate === date,
    )
    .at(-1);
  if (valuation) {
    const evidence = accepted(valuation.sourceId);
    if (
      evidence &&
      !valuation.valuationMethod.startsWith('Synthetic') &&
      (valuation.currency === 'EUR' || valuation.fx)
    )
      return {
        holdingId: holding.id,
        date,
        valueEUR: valuation.valueEUR,
        amount: Number(valuation.amount),
        currency: valuation.currency,
        sourceId: valuation.sourceId,
        source: {
          reference: evidence.filename,
          date,
          sourceId: valuation.sourceId,
        },
        basis: valuation.valuationMethod,
      };
    return null;
  }
  if (holding.assetClass === 'Cash') {
    const period = finance.coverage
      .filter(
        (c) =>
          c.to === date &&
          c.cashHoldingIds.includes(holding.id) &&
          cashflowCoverageCurrent(finance, portfolio, c),
      )
      .at(-1);
    const balance = period?.closingBalances.find(
      (row) => row.holdingId === holding.id,
    );
    if (period && balance)
      return {
        holdingId: holding.id,
        date,
        valueEUR: Number(balance.valueEUR),
        amount: Number(balance.amount),
        currency: holding.currency,
        sourceId: period.source.sourceId,
        source: period.source,
        basis: 'Reconciled statement closing balance',
      };
  }
  const evidence = accepted(holding.sourceId);
  if (
    holding.valuationStatus !== 'unknown' &&
    holding.valuationDate === date &&
    evidence &&
    !holding.valuationMethod.startsWith('Synthetic') &&
    holding.valuationMethod !== 'Reported mark plus settled capital' &&
    holding.currency === 'EUR'
  )
    return {
      holdingId: holding.id,
      date,
      valueEUR: holding.valueEUR,
      amount: holding.originalValue,
      currency: holding.currency,
      sourceId: holding.sourceId,
      source: {
        reference: evidence.filename,
        date,
        sourceId: holding.sourceId,
      },
      basis: holding.valuationMethod,
    };
  return null;
}

/** Daily weights assume external flows occur at day end; this is an estimate, not exact TWR. */
export function modifiedDietz(
  opening: number,
  closing: number,
  flows: { date: string; amountEUR: number }[],
  from: string,
  to: string,
): { valuePercent: number | null; denominatorEUR: number | null } {
  const days = day(to) - day(from);
  if (
    !Number.isFinite(days) ||
    days <= 0 ||
    ![opening, closing, ...flows.map((f) => f.amountEUR)].every(Number.isFinite)
  )
    return { valuePercent: null, denominatorEUR: null };
  if (flows.some((flow) => flow.date <= from || flow.date > to))
    return { valuePercent: null, denominatorEUR: null };
  const net = sum(flows.map((flow) => flow.amountEUR));
  const denominator =
    opening +
    flows.reduce(
      (n, flow) => n + (flow.amountEUR * (day(to) - day(flow.date))) / days,
      0,
    );
  return denominator > 0
    ? {
        valuePercent: ((closing - opening - net) / denominator) * 100,
        denominatorEUR: cents(denominator),
      }
    : { valuePercent: null, denominatorEUR: cents(denominator) };
}

function liquidity(
  portfolio: PortfolioRecords,
  finance: FinanceState,
  query: PeriodQuery,
  holdings: Holding[],
): LiquidityGroup[] {
  const groups = new Map<string, LiquidityGroup>(),
    holdingIds = new Set(holdings.map((h) => h.id));
  const availableMovements = new Map<string, number>();
  const ensure = (holding: Holding) => {
    if (
      query.liquidityCurrencies &&
      !query.liquidityCurrencies.includes(holding.currency)
    )
      return undefined;
    const key = holding.entityId + ':' + holding.currency;
    if (!groups.has(key))
      groups.set(key, {
        entityId: holding.entityId,
        entityName:
          portfolio.entities.find((e) => e.id === holding.entityId)?.name ??
          holding.entityId,
        currency: holding.currency,
        recordedCashNative: 0,
        restrictedCashNative: 0,
        restrictionUnknownCashNative: 0,
        restrictionUnknownAccountCount: 0,
        liquidityUnknownHoldingCount: 0,
        unavailableBalanceCount: 0,
        reviewedInflowsNative: 0,
        reviewedOutflowsNative: 0,
        overdueOutflowsNative: 0,
        blockedObligationCount: 0,
        projectedAvailableNative: null,
        obligations: [],
        cashAsOfDates: [],
      });
    return groups.get(key)!;
  };
  for (const cash of holdings.filter((h) => h.assetClass === 'Cash')) {
    const group = ensure(cash);
    if (!group) continue;
    if (cash.liquidityStatus === 'unknown')
      group.liquidityUnknownHoldingCount += 1;
    let amount: number | undefined, date: string | undefined;
    if (
      cash.valuationStatus !== 'unknown' &&
      /^\d{4}-\d{2}-\d{2}$/.test(cash.valuationDate) &&
      cash.valuationDate <= query.liquidityAsOf
    ) {
      amount = cash.originalValue;
      date = cash.valuationDate;
    } else {
      const mark = finance.valuations
        .filter(
          (v) =>
            v.holdingId === cash.id && v.effectiveDate <= query.liquidityAsOf,
        )
        .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
        .at(-1);
      if (mark && sourcedMark(portfolio, finance, cash, mark.effectiveDate)) {
        amount =
          Number(mark.amount) +
          sum(
            finance.events
              .filter(
                (e) =>
                  e.date > mark.effectiveDate && e.date <= query.liquidityAsOf,
              )
              .flatMap((e) =>
                e.postings
                  .filter((p) => p.holdingId === cash.id)
                  .map((p) => p.nativeDelta),
              ),
          );
        date = mark.effectiveDate;
      }
    }
    if (amount === undefined) {
      group.unavailableBalanceCount += 1;
      continue;
    }
    group.recordedCashNative = cents(group.recordedCashNative + amount);
    group.cashAsOfDates.push(date!);
    const details = finance.accounts[cash.accountId];
    if (!details) {
      group.restrictionUnknownAccountCount += 1;
      group.restrictionUnknownCashNative = cents(
        group.restrictionUnknownCashNative + amount,
      );
    } else if (details.restricted)
      group.restrictedCashNative = cents(group.restrictedCashNative + amount);
  }
  for (const tx of finance.transactions) {
    if (
      transactionStatus(finance, tx.id) !== 'reviewed' ||
      tx.dueDate > query.liquidityThrough ||
      !holdingIds.has(tx.cashHoldingId)
    )
      continue;
    const cash = holdings.find((h) => h.id === tx.cashHoldingId)!;
    const legs = [
      {
        holding: cash,
        amount:
          (['deposit', 'distribution', 'sale'].includes(tx.kind) ? 1 : -1) *
          Number(tx.amount),
      },
    ];
    if (tx.destinationCashHoldingId) {
      const destination = holdings.find(
        (h) => h.id === tx.destinationCashHoldingId,
      );
      if (destination)
        legs.push({ holding: destination, amount: Number(tx.amount) });
    }
    for (const leg of legs) {
      const group = ensure(leg.holding);
      if (!group) continue;
      const restriction = finance.accounts[leg.holding.accountId];
      const key = group.entityId + ':' + group.currency;
      if (
        restriction &&
        !restriction.restricted &&
        leg.holding.liquidityStatus !== 'unknown'
      )
        availableMovements.set(
          key,
          cents((availableMovements.get(key) ?? 0) + leg.amount),
        );
      if (leg.amount < 0 && restriction?.restricted)
        group.blockedObligationCount += 1;
      if (leg.amount > 0)
        group.reviewedInflowsNative = cents(
          group.reviewedInflowsNative + leg.amount,
        );
      else {
        group.reviewedOutflowsNative = cents(
          group.reviewedOutflowsNative - leg.amount,
        );
        if (tx.dueDate < query.liquidityAsOf)
          group.overdueOutflowsNative = cents(
            group.overdueOutflowsNative - leg.amount,
          );
      }
      group.obligations.push({
        transactionId: tx.id,
        name: tx.kind.replaceAll('_', ' '),
        date: tx.dueDate,
        nativeChange: leg.amount,
        source: tx.source,
      });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    cashAsOfDates: [...new Set(group.cashAsOfDates)].sort(),
    projectedAvailableNative:
      group.unavailableBalanceCount ||
      group.liquidityUnknownHoldingCount !== 0 ||
      group.restrictionUnknownAccountCount !== 0 ||
      group.blockedObligationCount > 0
        ? null
        : cents(
            group.recordedCashNative -
              group.restrictedCashNative +
              (availableMovements.get(group.entityId + ':' + group.currency) ??
                0),
          ),
    obligations: group.obligations.sort((a, b) => a.date.localeCompare(b.date)),
  }));
}

export function evaluatePeriod(
  portfolio: PortfolioRecords,
  current: FinanceState | undefined,
  input: PeriodQuery,
  evaluatedAt: string,
): PeriodReport {
  const query = periodQuerySchema.parse(input),
    finance = current ?? emptyFinanceState();
  if (query.from >= query.to || query.to > evaluatedAt.slice(0, 10))
    fail(
      'PERIOD_INVALID',
      'Use two different dates ending on or before today.',
    );
  if (
    query.liquidityAsOf > evaluatedAt.slice(0, 10) ||
    query.liquidityThrough < query.liquidityAsOf ||
    day(query.liquidityThrough) - day(query.liquidityAsOf) > 3660
  )
    fail(
      'LIQUIDITY_DATE_INVALID',
      'Use a current or past cash date and a projection horizon of no more than ten years.',
    );
  const selected = reportingHoldings(portfolio, query),
    holdingIds = new Set(selected.map((h) => h.id)),
    gaps: string[] = [];
  if (!selected.length)
    gaps.push('No holdings are registered in this selection.');
  const rows = selected.map((holding) => {
    const opening = sourcedMark(portfolio, finance, holding, query.from),
      closing = sourcedMark(portfolio, finance, holding, query.to);
    if (!opening)
      gaps.push(
        holding.name + ': no accepted source mark for ' + query.from + '.',
      );
    if (!closing)
      gaps.push(
        holding.name + ': no accepted source mark for ' + query.to + '.',
      );
    return {
      holdingId: holding.id,
      name: holding.name,
      entityId: holding.entityId,
      assetClass: holding.assetClass,
      opening,
      closing,
      changeEUR:
        opening && closing ? cents(closing.valueEUR - opening.valueEUR) : null,
    };
  });
  const events = finance.events.filter(
    (e) => e.date > query.from && e.date <= query.to,
  );
  const flows = events
    .filter(
      (e) =>
        e.externalFlowEUR !== 0 &&
        e.postings.some((p) => holdingIds.has(p.holdingId)),
    )
    .map((event) => ({
      eventId: event.id,
      transactionId: event.transactionId,
      date: event.date,
      kind:
        finance.transactions.find((tx) => tx.id === event.transactionId)
          ?.kind ?? event.type,
      amountEUR: event.externalFlowEUR,
      source: event.source,
    }));
  const cashReconciliation = selected
    .filter((h) => h.assetClass === 'Cash')
    .map((holding) => {
      const marks = rows.find((row) => row.holdingId === holding.id)!;
      const period = finance.coverage
        .filter(
          (c) =>
            c.entityId === holding.entityId &&
            c.from <= query.from &&
            c.to >= query.to &&
            cashflowCoverageCurrent(finance, portfolio, c),
        )
        .at(-1);
      const movements = sum(
        events.flatMap((e) =>
          e.postings
            .filter((p) => p.holdingId === holding.id)
            .map((p) => p.nativeDelta),
        ),
      );
      const comparable =
        marks.opening &&
        marks.closing &&
        marks.opening.currency === marks.closing.currency;
      const residual = comparable
        ? cents(marks.closing!.amount - marks.opening!.amount - movements)
        : null;
      if (residual === null)
        gaps.push(
          holding.name +
            ': cash reconciliation lacks comparable original-currency opening and closing marks.',
        );
      else if (residual !== 0)
        gaps.push(
          holding.name +
            ': unexplained cash difference of ' +
            residual.toFixed(2) +
            ' ' +
            holding.currency +
            '.',
        );
      return {
        holdingId: holding.id,
        name: holding.name,
        entityId: holding.entityId,
        currency: holding.currency,
        openingNative: marks.opening?.amount ?? null,
        closingNative: marks.closing?.amount ?? null,
        recordedMovementsNative: movements,
        residualNative: residual,
        coverageId: period?.id ?? null,
      };
    });
  const covered = hasReconciledCashflowCoverage(
    finance,
    portfolio,
    [...holdingIds],
    query.from,
    query.to,
  );
  if (!covered)
    gaps.push(
      'Every selected legal entity needs a current reviewer attestation covering all cash accounts and external flows for this period.',
    );
  const knownOpeningValueEUR = sum(
      rows.map((row) => row.opening?.valueEUR ?? 0),
    ),
    knownClosingValueEUR = sum(rows.map((row) => row.closing?.valueEUR ?? 0));
  const openingValueEUR =
      selected.length && rows.every((row) => row.opening)
        ? knownOpeningValueEUR
        : null,
    closingValueEUR =
      selected.length && rows.every((row) => row.closing)
        ? knownClosingValueEUR
        : null;
  const knownExternalFlowEUR = sum(flows.map((f) => f.amountEUR));
  const reconciled =
    covered &&
    cashReconciliation.length > 0 &&
    cashReconciliation.every((row) => row.residualNative === 0);
  const netExternalFlowEUR = reconciled ? knownExternalFlowEUR : null;
  const eligible =
    openingValueEUR !== null && closingValueEUR !== null && reconciled;
  const estimate = eligible
    ? modifiedDietz(
        openingValueEUR,
        closingValueEUR,
        flows,
        query.from,
        query.to,
      )
    : { valuePercent: null, denominatorEUR: null };
  const reason = !eligible
    ? 'Unavailable until exact dated marks, complete cash-flow coverage and zero unexplained cash differences are present.'
    : estimate.valuePercent === null
      ? 'Unavailable because the weighted invested capital is nonpositive.'
      : 'Estimate using reviewed EUR marks and daily weighted external flows. It can be inaccurate with large flows or volatile values.';
  return {
    query,
    evaluatedAt,
    holdings: rows,
    holdingCount: selected.length,
    openingValueEUR,
    closingValueEUR,
    knownOpeningValueEUR,
    knownClosingValueEUR,
    valueChangeEUR:
      openingValueEUR !== null && closingValueEUR !== null
        ? cents(closingValueEUR - openingValueEUR)
        : null,
    knownExternalFlowEUR,
    netExternalFlowEUR,
    investmentResultEUR: eligible
      ? cents(closingValueEUR! - openingValueEUR! - knownExternalFlowEUR)
      : null,
    flows,
    cashReconciliation,
    returnEstimate: {
      method: 'Modified Dietz · end-of-day flows',
      ...estimate,
      reason,
      methodologyUrl: RETURN_METHODOLOGY_URL,
    },
    gaps,
    liquidity: liquidity(portfolio, finance, query, selected),
    assumptions: [
      'Opening and closing values require accepted sources on the exact requested dates. No interpolation, stale-value carry-forward or zero opening value is used for performance.',
      'External cash flows are deposits and withdrawals across the selected entities’ portfolio boundary. Calls, investment purchases, sales, distributions and internal cash transfers are internal; fees remain in investment results.',
      'The opening date is an end-of-day valuation. Flows after that date through the closing date are included and weighted as end-of-day flows. Returns are not annualized; this estimate is not exact TWR or a GIPS compliance claim.',
      'Reconciliation is a reviewer attestation against referenced statements, not a bank connection or independent verification. Native-currency cash residuals must be zero; FX remeasurement remains part of EUR performance.',
      'Liquidity uses recorded cash as of the chosen date and currently reviewed unsettled obligations, including overdue items. It does not reconstruct past knowledge of obligation status or forecast unrecorded calls, sales or income.',
      'Cash is grouped only within a legal entity and currency. Restricted balances are excluded from projected availability; unknown liquidity classifications, unknown restrictions or unavailable balances suppress that projection. Actual transfers between accounts are not modeled.',
      'Reviewed obligations use their entered payment amounts and dates. No payment, conversion, funding guarantee, borrowing capacity or assumption that a future inflow will arrive is implied.',
    ],
  };
}

export function scopedReportingInputs(
  portfolio: PortfolioRecords,
  finance: FinanceState | undefined,
  scope: ReportingScope,
): { portfolio: PortfolioRecords; finance: FinanceState } {
  const holdings = reportingHoldings(portfolio, scope),
    ids = new Set(holdings.map((h) => h.id)),
    entities = new Set(holdings.map((h) => h.entityId)),
    accounts = new Set(holdings.map((h) => h.accountId)),
    current = finance ?? emptyFinanceState();
  const transactions = current.transactions.filter(
      (t) =>
        ids.has(t.cashHoldingId) &&
        (!t.holdingId || ids.has(t.holdingId)) &&
        (!t.destinationCashHoldingId || ids.has(t.destinationCashHoldingId)),
    ),
    txIds = new Set(transactions.map((t) => t.id));
  return structuredClone({
    portfolio: {
      holdings,
      history: portfolio.history.filter((row) => ids.has(row.holdingId)),
      evidence: portfolio.evidence.filter((e) => ids.has(e.holdingId)),
      events: [],
      tasks: [],
      families: portfolio.families.filter((f) =>
        scope.familyIds.includes(f.id),
      ),
      entities: portfolio.entities.filter((e) => entities.has(e.id)),
      accounts: portfolio.accounts.filter((a) => accounts.has(a.id)),
    },
    finance: {
      ...current,
      entities: Object.fromEntries(
        Object.entries(current.entities).filter(([id]) => entities.has(id)),
      ),
      holdings: Object.fromEntries(
        Object.entries(current.holdings).filter(([id]) => ids.has(id)),
      ),
      accounts: Object.fromEntries(
        Object.entries(current.accounts).filter(([id]) => accounts.has(id)),
      ),
      transactions,
      events: current.events.filter(
        (e) =>
          txIds.has(e.transactionId) &&
          e.postings.every((p) => ids.has(p.holdingId)),
      ),
      valuations: current.valuations.filter((v) => ids.has(v.holdingId)),
      coverage: current.coverage
        .filter(
          (c) =>
            entities.has(c.entityId) &&
            c.cashHoldingIds.every((id) => ids.has(id)),
        )
        .map((c) => ({
          ...c,
          eventCount: current.events
            .slice(0, c.eventCount)
            .filter(
              (e) =>
                txIds.has(e.transactionId) &&
                e.postings.every((p) => ids.has(p.holdingId)),
            ).length,
          valuationCount: current.valuations
            .slice(0, c.valuationCount)
            .filter((v) => ids.has(v.holdingId)).length,
        })),
      receipts: [],
    },
  });
}
export function scopedRiskData(
  input: RiskData | undefined,
  holdings: readonly Holding[],
): RiskData {
  const data = input ?? emptyRiskData(),
    ids = new Set(holdings.map((h) => h.id)),
    positions = data.positions.filter((p) => ids.has(p.holdingId)),
    nodes = new Set(positions.map((p) => p.nodeId));
  for (let changed = true; changed;) {
    changed = false;
    for (const link of data.links)
      if (nodes.has(link.parentId) && !nodes.has(link.childId)) {
        nodes.add(link.childId);
        changed = true;
      }
  }
  return structuredClone({
    version: 1,
    positions,
    nodes: data.nodes.filter((n) => nodes.has(n.id)),
    links: data.links.filter(
      (l) => nodes.has(l.parentId) && nodes.has(l.childId),
    ),
  });
}
