import type { Holding } from '@/data/types';
import type { PortfolioRecords } from './workspace';
import {
  emptyFinanceState,
  LEDGER_CURRENCIES,
  ledgerCommandSchema,
  ledgerDate,
  ledgerFxSchema,
  ledgerMoney,
  type FinanceState,
  type CashflowCoverage,
  type LedgerCommand,
  type LedgerEvent,
  type LedgerFx,
  type LedgerMeta,
  type LedgerSource,
  type LedgerTransaction,
  type ReviewedValuationInput,
  type ValuationRecord,
  type CashObligation,
  type CashObligationTerms,
  type ReviewedCashNoticeInput,
} from './ledger-contract';

export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}
function fail(code: string, message: string, status = 400): never {
  throw new LedgerError(code, message, status);
}
const round = (value: number) => Math.round(value * 100) / 100;
const MAX_MINOR = 100_000_000_000_000n;
export function moneyMinor(value: string): bigint {
  ledgerMoney.parse(value);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
const numberMoney = (value: bigint) => {
  if (value < 0n || value > MAX_MINOR)
    fail(
      'MONEY_BOUNDS',
      'The resulting balance must be nonnegative and at most one trillion.',
    );
  return Number(value) / 100;
};
/** Explicit source-currency conversion; round half up to EUR cents using integer arithmetic. */
export function convertToEUR(
  amount: string,
  currency: Holding['currency'],
  fx?: LedgerFx,
  effectiveDate?: string,
): number {
  if (!LEDGER_CURRENCIES.includes(currency))
    fail(
      'CURRENCY_UNSUPPORTED',
      'Use a supported source currency. No currency is inferred.',
    );
  const minor = moneyMinor(amount);
  if (currency === 'EUR') {
    if (fx && Number(fx.rateToEUR) !== 1)
      fail(
        'EUR_FX_INVALID',
        'An EUR amount has a conversion rate of exactly 1.',
      );
    return numberMoney(minor);
  }
  if (!fx)
    fail(
      'FX_REQUIRED',
      'Supply the dated EUR conversion rate and its source for a non-EUR amount.',
    );
  ledgerFxSchema.parse(fx);
  if (effectiveDate && fx.date > effectiveDate)
    fail(
      'FX_DATE_INVALID',
      'The FX date cannot be after the financial effective date.',
    );
  const [whole, fraction = ''] = fx.rateToEUR.split('.');
  const numerator = BigInt(whole + fraction),
    denominator = 10n ** BigInt(fraction.length);
  return numberMoney((minor * numerator + denominator / 2n) / denominator);
}
const findHolding = (portfolio: PortfolioRecords, id: string) =>
  portfolio.holdings.find((h) => h.id === id) ??
  fail('HOLDING_NOT_FOUND', 'Choose a holding in this workspace.', 404);
function validMeta(meta: LedgerMeta) {
  if (!meta.id || !meta.actorId || !Number.isFinite(Date.parse(meta.at)))
    fail('INVALID_ACTOR', 'A dated reviewer identity is required.');
}
function validateDate(date: string, meta: LedgerMeta) {
  ledgerDate.parse(date);
  if (date > meta.at.slice(0, 10))
    fail(
      'FUTURE_POSTING',
      'A financial posting cannot be dated in the future.',
    );
}
function validateSource(
  portfolio: PortfolioRecords,
  source: LedgerSource,
  holding?: Holding,
) {
  if (!source.sourceId) return;
  const evidence = portfolio.evidence.find(
    (item) => item.id === source.sourceId,
  );
  if (!evidence || (holding && evidence.familyId !== holding.familyId))
    fail(
      'SOURCE_NOT_FOUND',
      'The source reference must belong to the selected family in this workspace.',
    );
}
function recordEvidence(
  portfolio: PortfolioRecords,
  holding: Holding,
  source: LedgerSource,
  meta: LedgerMeta,
  subject: string,
): string {
  validateSource(portfolio, source, holding);
  const sourceId = meta.id + '-source';
  portfolio.evidence.push({
    id: sourceId,
    mailboxId: 'ledger',
    familyId: holding.familyId,
    holdingId: holding.id,
    subject,
    sender: meta.actorId,
    receivedAt: meta.at,
    effectiveDate: source.date,
    filename: source.reference,
    page: 1,
    excerpt: `Reviewer-supplied source reference: ${source.reference}. ${source.sourceId ? 'Linked workspace evidence: ' + source.sourceId + '. ' : ''}This reference is an attestation, not independent verification.`,
    status: 'Accepted',
    synthetic: false,
  });
  return sourceId;
}
function bump(finance: FinanceState) {
  finance.revision += 1;
}
function baseMethod(holding: Holding): Holding['valuationMethod'] {
  if (holding.assetClass === 'Cash') return 'Cash balance';
  if (holding.assetClass === 'Real estate')
    return 'Equity appraisal, net of debt';
  if (['Public equities', 'Fixed income'].includes(holding.assetClass))
    return 'Reported market mark';
  return 'Reported fund NAV';
}
export function transactionStatus(
  finance: FinanceState,
  id: string,
): 'reviewed' | 'settled' | 'reversed' | 'voided' {
  return (
    finance.events.filter((event) => event.transactionId === id).at(-1)?.type ??
    'reviewed'
  );
}
const minorString = (value: bigint) =>
  `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
const noticeTerms = (value: CashObligationTerms): CashObligationTerms => ({
  amount: value.amount,
  currency: value.currency,
  effectiveDate: value.effectiveDate,
  dueDate: value.dueDate,
});
/** Similar notices are review candidates, never automatically merged or settled. */
export function relatedCashObligations(
  finance: FinanceState,
  notice: CashObligation,
): CashObligation[] {
  return (finance.obligations ?? []).filter(
    (other) =>
      other.id !== notice.id &&
      !other.cancellation &&
      !notice.cancellation &&
      other.holdingId === notice.holdingId &&
      other.kind === notice.kind &&
      !notice.distinctFrom.some(
        (item) =>
          item.obligationId === other.id &&
          item.noticeRevision === notice.amendments.length &&
          item.otherRevision === other.amendments.length,
      ) &&
      !other.distinctFrom.some(
        (item) =>
          item.obligationId === notice.id &&
          item.noticeRevision === other.amendments.length &&
          item.otherRevision === notice.amendments.length,
      ) &&
      ((!!notice.effectiveDate &&
        notice.effectiveDate === other.effectiveDate) ||
        (!!notice.dueDate && notice.dueDate === other.dueDate) ||
        ((!notice.effectiveDate || !other.effectiveDate) &&
          (!notice.dueDate || !other.dueDate) &&
          notice.amount !== null &&
          other.amount !== null &&
          moneyMinor(notice.amount) === moneyMinor(other.amount) &&
          notice.currency === other.currency)),
  );
}
export type CashObligationSummary = {
  status:
    | 'needs_details'
    | 'expected'
    | 'ready'
    | 'partially_settled'
    | 'settled'
    | 'cancelled';
  settledAmount: string;
  reviewedAmount: string;
  remainingAmount: string | null;
  unallocatedAmount: string | null;
  missingDetails: string[];
  relatedObligationIds: string[];
  transactionIds: string[];
  matchingTransactionIds: string[];
};
/** Exact original-currency amounts. Reversed/voided allocations release the reservation. */
export function obligationSummary(
  finance: FinanceState,
  notice: CashObligation,
): CashObligationSummary {
  const transactions = finance.transactions.filter(
    (tx) => tx.obligationId === notice.id,
  );
  let settled = 0n,
    reviewed = 0n;
  for (const tx of transactions) {
    const status = transactionStatus(finance, tx.id);
    if (status === 'settled') settled += moneyMinor(tx.amount);
    if (status === 'reviewed') reviewed += moneyMinor(tx.amount);
  }
  const total = notice.amount === null ? null : moneyMinor(notice.amount);
  const missingDetails: string[] = [];
  if (total === null || total === 0n)
    missingDetails.push('Positive notice amount');
  if (!LEDGER_CURRENCIES.includes(notice.currency as Holding['currency']))
    missingDetails.push('Supported source currency');
  if (!notice.dueDate) missingDetails.push('Due / expected date');
  const relatedObligationIds = relatedCashObligations(finance, notice).map(
    (item) => item.id,
  );
  if (relatedObligationIds.length)
    missingDetails.push('Resolve similar notices');
  const matchingTransactionIds = finance.transactions
    .filter(
      (tx) =>
        !tx.obligationId &&
        tx.kind === notice.kind &&
        tx.holdingId === notice.holdingId &&
        tx.currency === notice.currency &&
        tx.dueDate === notice.dueDate &&
        ['reviewed', 'settled'].includes(transactionStatus(finance, tx.id)),
    )
    .map((tx) => tx.id);
  if (matchingTransactionIds.length)
    missingDetails.push('Match existing transactions');
  // Invalid historical allocations are unavailable, never a negative or silently clamped remaining balance.
  if (total !== null && settled + reviewed > total)
    missingDetails.push('Allocated amount exceeds this notice');
  const remaining = total !== null && total >= settled ? total - settled : null;
  const available =
    total !== null && total >= settled + reviewed
      ? total - settled - reviewed
      : null;
  return {
    status: notice.cancellation
      ? 'cancelled'
      : missingDetails.length
        ? 'needs_details'
        : remaining === 0n
          ? 'settled'
          : settled > 0n
            ? 'partially_settled'
            : reviewed > 0n
              ? 'ready'
              : 'expected',
    settledAmount: minorString(settled),
    reviewedAmount: minorString(reviewed),
    remainingAmount: remaining === null ? null : minorString(remaining),
    unallocatedAmount: available === null ? null : minorString(available),
    missingDetails,
    relatedObligationIds,
    matchingTransactionIds,
    transactionIds: transactions.map((tx) => tx.id),
  };
}
/** Only registers an accepted notice. This function cannot append postings or change portfolio balances. */
export function postReviewedCashNotice(
  portfolio: PortfolioRecords,
  current: FinanceState | undefined,
  input: ReviewedCashNoticeInput,
  meta: LedgerMeta,
): { finance: FinanceState; obligation: CashObligation; duplicate: boolean } {
  validMeta(meta);
  const finance = structuredClone(current ?? emptyFinanceState());
  finance.obligations ??= [];
  const holding = findHolding(portfolio, input.holdingId);
  const evidence = portfolio.evidence.find(
    (row) =>
      row.id === input.sourceId &&
      row.holdingId === holding.id &&
      row.familyId === holding.familyId &&
      row.status === 'Accepted',
  );
  if (!evidence)
    fail(
      'SOURCE_NOT_FOUND',
      'The accepted notice needs evidence linked to this holding.',
    );
  if (holding.assetClass === 'Cash')
    fail(
      'INVESTMENT_REQUIRED',
      'Cash notices must link to an investment position.',
    );
  if (input.amount !== null) ledgerMoney.parse(input.amount);
  if (input.effectiveDate) ledgerDate.parse(input.effectiveDate);
  if (input.dueDate) ledgerDate.parse(input.dueDate);
  if (input.currency !== null && !/^[A-Z]{3}$/.test(input.currency))
    fail(
      'CURRENCY_INVALID',
      'Retain a reported three-letter currency code or leave it unknown.',
    );
  const prior = finance.obligations.find(
    (row) =>
      row.fingerprint === input.fingerprint ||
      (row.sourceId === input.sourceId &&
        row.holdingId === input.holdingId &&
        row.kind === input.kind),
  );
  if (prior) return { finance, obligation: prior, duplicate: true };
  if (finance.obligations.length >= 2000)
    fail(
      'LEDGER_LIMIT',
      'This workspace has reached its bounded cash-notice limit.',
      409,
    );
  const obligation: CashObligation = {
    ...input,
    id: meta.id,
    acceptedAt: meta.at,
    acceptedBy: meta.actorId,
    original: noticeTerms(input),
    amendments: [],
    distinctFrom: [],
  };
  finance.obligations.push(obligation);
  bump(finance);
  return { finance, obligation, duplicate: false };
}
function findObligation(finance: FinanceState, id: string): CashObligation {
  return (
    (finance.obligations ?? []).find((row) => row.id === id) ??
    fail(
      'OBLIGATION_NOT_FOUND',
      'Choose a cash obligation in this workspace.',
      404,
    )
  );
}
function requireUnallocatedObligation(
  finance: FinanceState,
  notice: CashObligation,
) {
  if (notice.cancellation)
    fail(
      'OBLIGATION_CANCELLED',
      'This notice has been cancelled; its retained history cannot be overwritten.',
      409,
    );
  const summary = obligationSummary(finance, notice);
  if (
    moneyMinor(summary.reviewedAmount) > 0n ||
    moneyMinor(summary.settledAmount) > 0n
  )
    fail(
      'OBLIGATION_HAS_TRANSACTIONS',
      'Void reviewed transactions and explicitly reverse settled amounts before amending or cancelling this notice.',
      409,
    );
}
function validateObligationAllocation(
  finance: FinanceState,
  tx: LedgerTransaction,
  matchingExisting = false,
) {
  if (!tx.obligationId) {
    if (
      (finance.obligations ?? []).some(
        (notice) =>
          !notice.cancellation &&
          notice.holdingId === tx.holdingId &&
          notice.kind === tx.kind &&
          notice.currency === tx.currency &&
          notice.dueDate === tx.dueDate,
      )
    )
      fail(
        'OBLIGATION_LINK_REQUIRED',
        'An accepted notice matches this investment, kind, currency and due date. Prepare the transaction from that notice to prevent duplicate obligations.',
      );
    return;
  }
  const notice = findObligation(finance, tx.obligationId),
    summary = obligationSummary(finance, notice);
  if (notice.cancellation)
    fail(
      'OBLIGATION_CANCELLED',
      'A cancelled notice cannot receive transactions.',
      409,
    );
  const missing = summary.missingDetails.filter(
    (item) => !matchingExisting || item !== 'Match existing transactions',
  );
  if (missing.length)
    fail(
      'OBLIGATION_INCOMPLETE',
      missing.join('; ') + '. Resolve these details before allocating cash.',
    );
  if (
    notice.holdingId !== tx.holdingId ||
    notice.kind !== tx.kind ||
    notice.currency !== tx.currency ||
    notice.dueDate !== tx.dueDate
  )
    fail(
      'OBLIGATION_MISMATCH',
      'The transaction investment, kind, currency and due date must match its accepted notice. Amend the notice explicitly if needed.',
    );
  if (
    summary.unallocatedAmount === null ||
    moneyMinor(tx.amount) > moneyMinor(summary.unallocatedAmount)
  )
    fail(
      'OBLIGATION_OVERALLOCATED',
      'This transaction exceeds the unallocated amount. Existing reviewed and settled amounts are already reserved.',
      409,
    );
}
/** Called by document review after its accepted EvidenceSource is inserted. No I/O or mutation of the caller. */
export function postReviewedValuation(
  records: PortfolioRecords,
  current: FinanceState | undefined,
  input: ReviewedValuationInput,
  meta: LedgerMeta,
): {
  portfolio: PortfolioRecords;
  finance: FinanceState;
  valuation: ValuationRecord;
} {
  validMeta(meta);
  validateDate(input.effectiveDate, meta);
  const portfolio = structuredClone(records),
    finance = structuredClone(current ?? emptyFinanceState());
  const holding = findHolding(portfolio, input.holdingId);
  const evidence = portfolio.evidence.find(
    (item) =>
      item.id === input.sourceId &&
      item.holdingId === holding.id &&
      item.familyId === holding.familyId,
  );
  if (!evidence)
    fail(
      'SOURCE_NOT_FOUND',
      'The reviewed valuation needs evidence linked to this holding.',
    );
  if (
    holding.assetClass === 'Cash' &&
    finance.accounts[holding.accountId] &&
    finance.accounts[holding.accountId].currency !== input.currency
  )
    fail(
      'CURRENCY_MISMATCH',
      'A cash valuation must use the registered account currency.',
    );
  const valueEUR = convertToEUR(
    input.amount,
    input.currency,
    input.fx,
    input.effectiveDate,
  );
  const prior = finance.valuations
    .filter(
      (item) =>
        item.holdingId === holding.id &&
        item.effectiveDate === input.effectiveDate,
    )
    .at(-1);
  const oldValue =
    prior?.valueEUR ??
    portfolio.history.find(
      (row) => row.holdingId === holding.id && row.date === input.effectiveDate,
    )?.valueEUR ??
    (holding.valuationDate === input.effectiveDate
      ? holding.valueEUR
      : undefined);
  const sameDateHolding =
    holding.valuationDate === input.effectiveDate ? holding : undefined;
  const priorAmount =
    prior?.amount ?? sameDateHolding?.originalValue.toFixed(2);
  const priorCurrency = prior?.currency ?? sameDateHolding?.currency;
  const priorFX =
    prior?.fx ??
    (sameDateHolding ? finance.holdings[holding.id]?.fx : undefined);
  const nativeChanged =
    priorAmount !== undefined &&
    (moneyMinor(priorAmount) !== moneyMinor(input.amount) ||
      priorCurrency !== input.currency);
  const fxChanged =
    priorFX !== undefined &&
    (Number(priorFX.rateToEUR) !== Number(input.fx?.rateToEUR) ||
      priorFX.date !== input.fx?.date ||
      priorFX.source !== input.fx?.source);
  if (
    oldValue !== undefined &&
    (oldValue !== valueEUR || nativeChanged || fxChanged) &&
    (!input.correction ||
      input.correction.expectedValueEUR !== oldValue ||
      !input.correction.reason.trim())
  )
    fail(
      'CORRECTION_REQUIRED',
      'A changed value or native-currency/FX basis for the same date needs the current EUR value and an explicit correction reason.',
      409,
    );
  if (
    input.correction &&
    (oldValue === undefined || input.correction.expectedValueEUR !== oldValue)
  )
    fail(
      'VALUATION_CHANGED',
      'The value to correct has changed. Reload the record before posting.',
      409,
    );
  const newerPostings = finance.events.some(
    (event) =>
      event.type === 'settled' &&
      transactionStatus(finance, event.transactionId) === 'settled' &&
      event.date >= input.effectiveDate &&
      event.postings.some((post) => post.holdingId === holding.id),
  );
  if (newerPostings)
    fail(
      'POSTING_RESTATEMENT_REQUIRED',
      'This mark overlaps settled ledger activity. Reverse the affected posting before restating that date; automatic restatement is not supported.',
      409,
    );
  const valuationMethod =
    input.valuationMethod ??
    (holding.valuationMethod === 'Reported mark plus settled capital'
      ? baseMethod(holding)
      : holding.valuationMethod.startsWith('Synthetic')
        ? baseMethod(holding)
        : holding.valuationMethod);
  const valuation: ValuationRecord = {
    id: meta.id,
    holdingId: holding.id,
    amount: input.amount,
    currency: input.currency,
    valueEUR,
    effectiveDate: input.effectiveDate,
    sourceId: input.sourceId,
    fx: input.fx,
    actorId: meta.actorId,
    recordedAt: meta.at,
    valuationMethod,
    ...(input.correction
      ? {
          correctionOf:
            prior?.id ?? `legacy:${holding.id}:${input.effectiveDate}`,
          correctionReason: input.correction.reason,
          supersededValueEUR: oldValue,
        }
      : {}),
  };
  if (finance.valuations.length >= 4000)
    fail('LEDGER_LIMIT', 'The workspace valuation limit has been reached.');
  finance.valuations.push(valuation);
  if (input.effectiveDate >= holding.valuationDate) {
    holding.valueEUR = valueEUR;
    holding.originalValue = Number(input.amount);
    holding.currency = input.currency;
    holding.syntheticFXRateToEUR =
      input.currency === 'EUR' ? 1 : Number(input.fx!.rateToEUR);
    holding.valuationDate = input.effectiveDate;
    holding.valuationStatus = 'reported';
    holding.sourceId = input.sourceId;
    holding.valuationMethod = valuationMethod;
    const priorDetail = finance.holdings[holding.id];
    finance.holdings[holding.id] = {
      ...priorDetail,
      holdingId: holding.id,
      originalAmount: input.amount,
      fx: input.fx,
      source: {
        reference: evidence.filename,
        date: input.effectiveDate,
        sourceId: input.sourceId,
      },
      pendingCapitalEUR: 0,
      openingDate: priorDetail?.openingDate ?? input.effectiveDate,
    };
  }
  portfolio.history = portfolio.history.filter(
    (row) =>
      !(row.holdingId === holding.id && row.date === input.effectiveDate),
  );
  portfolio.history.push({
    holdingId: holding.id,
    date: input.effectiveDate,
    valueEUR,
    netExternalFlowEUR: 0,
    valuationBasis: 'Reported mark',
    flowCoverage: 'unknown',
  });
  bump(finance);
  return { portfolio, finance, valuation };
}
function ensureCurrencyAccount(
  portfolio: PortfolioRecords,
  finance: FinanceState,
  holding: Holding,
  currency: Holding['currency'],
) {
  const account = portfolio.accounts.find(
    (item) =>
      item.id === holding.accountId &&
      item.entityId === holding.entityId &&
      item.familyId === holding.familyId,
  );
  if (!account)
    fail(
      'ACCOUNT_LINK_INVALID',
      'The holding account and legal entity do not reconcile.',
    );
  if (
    holding.currency !== currency ||
    (finance.accounts[account.id] &&
      finance.accounts[account.id].currency !== currency)
  )
    fail(
      'CURRENCY_MISMATCH',
      'Use a cash balance and investment in the transaction currency. Cross-currency transfers need separately reviewed conversion records.',
    );
  if (finance.accounts[account.id]?.restricted)
    fail(
      'CASH_RESTRICTED',
      'This account is marked restricted; settlement is not permitted.',
    );
}
function validateTransaction(
  portfolio: PortfolioRecords,
  finance: FinanceState,
  tx: LedgerTransaction,
) {
  const cash = findHolding(portfolio, tx.cashHoldingId);
  if (cash.assetClass !== 'Cash')
    fail('CASH_REQUIRED', 'Select a holding classified as Cash.');
  ensureCurrencyAccount(portfolio, finance, cash, tx.currency);
  const investmentKinds = ['capital_call', 'distribution', 'purchase', 'sale'];
  if (investmentKinds.includes(tx.kind)) {
    if (!tx.holdingId)
      fail('INVESTMENT_REQUIRED', 'Link this transaction to its investment.');
    const investment = findHolding(portfolio, tx.holdingId);
    if (
      investment.assetClass === 'Cash' ||
      investment.entityId !== cash.entityId ||
      investment.familyId !== cash.familyId
    )
      fail(
        'ENTITY_MISMATCH',
        'Investment and funding cash must belong to the same legal entity and family.',
      );
    if (investment.currency !== tx.currency)
      fail(
        'CURRENCY_MISMATCH',
        'The investment and cash posting currencies must match; cross-currency funding is not modeled.',
      );
  } else if (tx.holdingId)
    fail(
      'UNEXPECTED_INVESTMENT',
      'This transaction kind does not use an investment holding.',
    );
  if (tx.kind === 'transfer') {
    if (!tx.destinationCashHoldingId || tx.destinationCashHoldingId === cash.id)
      fail(
        'TRANSFER_DESTINATION',
        'Choose another cash balance for the transfer.',
      );
    const destination = findHolding(portfolio, tx.destinationCashHoldingId);
    if (
      destination.assetClass !== 'Cash' ||
      destination.entityId !== cash.entityId ||
      destination.familyId !== cash.familyId
    )
      fail(
        'ENTITY_MISMATCH',
        'Transfers are supported only between cash balances in the same legal entity.',
      );
    ensureCurrencyAccount(portfolio, finance, destination, tx.currency);
  } else if (tx.destinationCashHoldingId)
    fail(
      'UNEXPECTED_DESTINATION',
      'Only transfers have a second cash balance.',
    );
  const expected =
    tx.kind === 'purchase' || tx.kind === 'capital_call'
      ? 'increase'
      : tx.kind === 'sale'
        ? 'reduce'
        : tx.kind === 'distribution'
          ? null
          : 'none';
  if (expected !== null && tx.investmentEffect !== expected)
    fail(
      'INVESTMENT_EFFECT',
      'The investment carrying-value effect does not match the transaction kind.',
    );
  if (
    tx.kind === 'distribution' &&
    !['none', 'reduce'].includes(tx.investmentEffect)
  )
    fail(
      'INVESTMENT_EFFECT',
      'A distribution is either income or a reduction of carrying value.',
    );
  if (tx.investmentEffect !== 'none') {
    if (
      tx.investmentAmount === undefined ||
      moneyMinor(tx.investmentAmount) === 0n
    )
      fail(
        'CARRYING_VALUE_REQUIRED',
        'Enter the explicit native-currency carrying-value movement.',
      );
    if (
      ['capital_call', 'purchase'].includes(tx.kind) &&
      moneyMinor(tx.investmentAmount) !== moneyMinor(tx.amount)
    )
      fail(
        'CARRYING_VALUE_REQUIRED',
        'New investment capital must equal the cash funded in this bounded ledger. Record fees separately.',
      );
  } else if (
    tx.investmentAmount !== undefined &&
    moneyMinor(tx.investmentAmount) !== 0n
  )
    fail('INVESTMENT_EFFECT', 'No carrying-value movement was selected.');
  if (tx.investmentEffect === 'none' && tx.investmentCostBasisEUR !== 0)
    fail(
      'COST_BASIS_EFFECT',
      'No investment cost-basis movement is permitted without a carrying-value movement.',
    );
  if (
    ['capital_call', 'purchase'].includes(tx.kind) &&
    tx.investmentCostBasisEUR !== tx.amountEUR
  )
    fail(
      'COST_BASIS_REQUIRED',
      'Record the funded EUR amount as investment book cost; record fees separately.',
    );
  if (
    tx.commitmentEffect !== 'none' &&
    !['capital_call', 'distribution'].includes(tx.kind)
  )
    fail(
      'COMMITMENT_EFFECT',
      'Only a capital call or a recallable distribution may change unfunded commitments.',
    );
  if (
    (tx.commitmentEffect === 'reduce' && tx.kind !== 'capital_call') ||
    (tx.commitmentEffect === 'increase' && tx.kind !== 'distribution')
  )
    fail(
      'COMMITMENT_EFFECT',
      'Calls may reduce commitments; explicitly recallable distributions may increase them.',
    );
  if (
    (tx.commitmentEffect === 'none' && tx.commitmentAmountEUR !== 0) ||
    (tx.commitmentEffect !== 'none' && tx.commitmentAmountEUR <= 0)
  )
    fail(
      'COMMITMENT_EFFECT',
      'Specify an explicit positive commitment movement or choose none with zero.',
    );
  if (tx.commitmentAmountEUR > tx.amountEUR)
    fail(
      'COMMITMENT_EFFECT',
      'A commitment movement cannot exceed the payment amount in this ledger.',
    );
  validateSource(portfolio, tx.source, cash);
}
function settlementPostings(
  portfolio: PortfolioRecords,
  finance: FinanceState,
  tx: LedgerTransaction,
): LedgerEvent['postings'] {
  validateTransaction(portfolio, finance, tx);
  const cash = findHolding(portfolio, tx.cashHoldingId);
  // Revalue a foreign-currency balance explicitly before using a different FX basis.
  const cashBalances = [
    cash,
    ...(tx.destinationCashHoldingId
      ? [findHolding(portfolio, tx.destinationCashHoldingId)]
      : []),
  ];
  for (const balance of cashBalances)
    if (
      convertToEUR(
        balance.originalValue.toFixed(2),
        tx.currency,
        tx.fx,
        tx.dueDate,
      ) !== round(balance.valueEUR)
    )
      fail(
        'CASH_FX_REVALUATION_REQUIRED',
        'Record an evidenced valuation of the full cash balance at the transaction FX rate before settlement.',
      );
  const sign = ['deposit', 'distribution', 'sale'].includes(tx.kind) ? 1 : -1;
  const cashCost =
    sign > 0
      ? tx.amountEUR
      : cash.originalValue > 0
        ? round((cash.costBasisEUR * Number(tx.amount)) / cash.originalValue)
        : 0;
  const postings: LedgerEvent['postings'] = [
    {
      holdingId: cash.id,
      nativeDelta: sign * Number(tx.amount),
      valueEURDelta: sign * tx.amountEUR,
      commitmentEURDelta: 0,
      costBasisEURDelta: sign * cashCost,
    },
  ];
  if (tx.destinationCashHoldingId)
    postings.push({
      holdingId: tx.destinationCashHoldingId,
      nativeDelta: Number(tx.amount),
      valueEURDelta: tx.amountEUR,
      commitmentEURDelta: 0,
      costBasisEURDelta: cashCost,
    });
  if (tx.holdingId) {
    const amount =
      tx.investmentEffect === 'none' ? 0 : Number(tx.investmentAmount);
    const direction = tx.investmentEffect === 'reduce' ? -1 : 1;
    postings.push({
      holdingId: tx.holdingId,
      nativeDelta: direction * amount,
      valueEURDelta:
        direction *
        convertToEUR(amount.toFixed(2), tx.currency, tx.fx, tx.dueDate),
      commitmentEURDelta:
        tx.commitmentEffect === 'reduce'
          ? -tx.commitmentAmountEUR
          : tx.commitmentEffect === 'increase'
            ? tx.commitmentAmountEUR
            : 0,
      costBasisEURDelta: direction * tx.investmentCostBasisEUR,
    });
  }
  return postings;
}
function applyPostings(
  portfolio: PortfolioRecords,
  finance: FinanceState,
  event: LedgerEvent,
  sourceId: string,
) {
  for (const post of event.postings) {
    const holding = findHolding(portfolio, post.holdingId);
    const latest = finance.events
      .filter((item) => item.postings.some((p) => p.holdingId === holding.id))
      .map((item) => item.date)
      .sort()
      .at(-1);
    if (event.date < holding.valuationDate || (latest && event.date < latest))
      fail(
        'BACKDATED_POSTING',
        'Posting before a later valuation or ledger event requires an explicit restatement; no automatic historical replay is performed.',
        409,
      );
    const value = round(holding.valueEUR + post.valueEURDelta),
      native = round(holding.originalValue + post.nativeDelta),
      commitment = round(
        holding.unfundedCommitmentEUR + post.commitmentEURDelta,
      );
    const cost = round(holding.costBasisEUR + post.costBasisEURDelta);
    for (const n of [value, native, commitment, cost])
      if (!Number.isFinite(n) || n < 0 || n > 1e12)
        fail(
          'INSUFFICIENT_BALANCE',
          'This posting would overdraw cash, investment carrying value or commitments, or exceed supported bounds.',
        );
    holding.valueEUR = value;
    holding.originalValue = native;
    holding.unfundedCommitmentEUR = commitment;
    holding.costBasisEUR = cost;
    const detail = finance.holdings[holding.id] ?? {
      holdingId: holding.id,
      originalAmount: holding.originalValue.toFixed(2),
      source: {
        reference: 'Existing recorded holding',
        date: holding.valuationDate,
        sourceId: holding.sourceId,
      },
      openingDate: holding.valuationDate,
      pendingCapitalEUR: 0,
    };
    if (holding.assetClass === 'Cash') {
      holding.valuationDate = event.date;
      holding.sourceId = sourceId;
      holding.valuationMethod = 'Cash balance';
    } else {
      detail.pendingCapitalEUR = round(
        detail.pendingCapitalEUR + post.valueEURDelta,
      );
      if (post.valueEURDelta !== 0)
        holding.valuationMethod =
          detail.pendingCapitalEUR === 0
            ? baseMethod(holding)
            : 'Reported mark plus settled capital';
    }
    finance.holdings[holding.id] = detail;
    const existing = portfolio.history.find(
      (row) => row.holdingId === holding.id && row.date === event.date,
    );
    const flow =
      holding.id === event.postings[0]?.holdingId ? event.externalFlowEUR : 0;
    portfolio.history = portfolio.history.filter(
      (row) => !(row.holdingId === holding.id && row.date === event.date),
    );
    portfolio.history.push({
      holdingId: holding.id,
      date: event.date,
      valueEUR: value,
      netExternalFlowEUR: round((existing?.netExternalFlowEUR ?? 0) + flow),
      valuationBasis: 'Reported mark',
      flowCoverage: 'unknown',
    });
  }
}
export function applyLedgerAction(
  records: PortfolioRecords,
  current: FinanceState | undefined,
  value: LedgerCommand,
  meta: LedgerMeta,
): { portfolio: PortfolioRecords; finance: FinanceState; resultId: string } {
  validMeta(meta);
  const command = ledgerCommandSchema.parse(value),
    portfolio = structuredClone(records),
    finance = structuredClone(current ?? emptyFinanceState());
  if (
    finance.transactions.length >= 2000 ||
    finance.events.length >= 4000 ||
    finance.coverage.length >= 500
  )
    fail(
      'LEDGER_LIMIT',
      'The bounded workspace ledger capacity has been reached.',
    );
  const resultId = meta.id;
  switch (command.type) {
    case 'linkTransactionObligation': {
      const transaction =
        finance.transactions.find((row) => row.id === command.transactionId) ??
        fail('TRANSACTION_NOT_FOUND', 'Choose an existing transaction.', 404);
      if (
        transaction.obligationId ||
        !['reviewed', 'settled'].includes(
          transactionStatus(finance, transaction.id),
        )
      )
        fail(
          'TRANSACTION_CHANGED',
          'Only an unlinked reviewed or settled transaction can be matched to a notice.',
          409,
        );
      const notice = findObligation(finance, command.obligationId);
      validateSource(
        portfolio,
        command.source,
        findHolding(portfolio, notice.holdingId),
      );
      validateDate(command.source.date, meta);
      validateObligationAllocation(
        finance,
        { ...transaction, obligationId: notice.id },
        true,
      );
      transaction.obligationId = notice.id;
      transaction.obligationLink = {
        source: command.source,
        actorId: meta.actorId,
        at: meta.at,
      };
      break;
    }
    case 'registerNoticeObligation': {
      const event = portfolio.events.find(
        (item) => item.id === command.eventId,
      );
      if (
        !event ||
        !['Capital call', 'Distribution'].includes(event.type) ||
        event.status !== 'Source reported' ||
        event.financialEffect !== 'None' ||
        event.holdingIds.length !== 1
      )
        fail(
          'NOTICE_NOT_FOUND',
          'Choose a retained source-reported cash notice with no financial effect.',
          404,
        );
      const posted = postReviewedCashNotice(
        portfolio,
        finance,
        {
          holdingId: event.holdingIds[0],
          kind: event.type === 'Capital call' ? 'capital_call' : 'distribution',
          sourceId: event.sourceId,
          fingerprint: 'legacy-event:' + event.id,
          documentId: portfolio.evidence.find(
            (row) => row.id === event.sourceId,
          )?.documentId,
          amount:
            event.reportedAmount &&
            ledgerMoney.safeParse(event.reportedAmount).success
              ? event.reportedAmount
              : null,
          currency: event.reportedCurrency ?? null,
          effectiveDate:
            event.dateBasis === 'Source reported' ? event.date : null,
          dueDate: null,
          importedAt: null,
          summary: event.summary,
          origin: 'legacy_notice',
        },
        meta,
      );
      return {
        portfolio,
        finance: posted.finance,
        resultId: posted.obligation.id,
      };
    }
    case 'amendObligation':
    case 'cancelObligation':
    case 'confirmDistinctObligation': {
      const notice = findObligation(finance, command.obligationId);
      const holding = findHolding(portfolio, notice.holdingId);
      validateSource(portfolio, command.source, holding);
      validateDate(command.source.date, meta);
      if (command.type === 'confirmDistinctObligation') {
        const other = findObligation(finance, command.otherObligationId);
        if (
          !relatedCashObligations(finance, notice).some(
            (row) => row.id === other.id,
          )
        )
          fail(
            'OBLIGATION_NOT_RELATED',
            'Choose an unresolved similar notice for the same investment and event kind.',
          );
        notice.distinctFrom.push({
          obligationId: other.id,
          noticeRevision: notice.amendments.length,
          otherRevision: other.amendments.length,
          source: command.source,
          reason: command.reason,
          at: meta.at,
          actorId: meta.actorId,
        });
      } else {
        requireUnallocatedObligation(finance, notice);
        if (command.type === 'cancelObligation') {
          if (command.duplicateOf) {
            const other = findObligation(finance, command.duplicateOf);
            if (
              other.id === notice.id ||
              other.cancellation ||
              other.holdingId !== notice.holdingId ||
              other.kind !== notice.kind
            )
              fail(
                'OBLIGATION_DUPLICATE_INVALID',
                'The retained obligation must be active and belong to the same investment and event kind.',
              );
          }
          notice.cancellation = {
            source: command.source,
            reason: command.reason,
            duplicateOf: command.duplicateOf,
            at: meta.at,
            actorId: meta.actorId,
          };
        } else {
          if (notice.amendments.length >= 100)
            fail(
              'LEDGER_LIMIT',
              'This notice has reached its amendment-history limit.',
              409,
            );
          const after = noticeTerms(command);
          notice.amendments.push({
            id: meta.id,
            before: noticeTerms(notice),
            after,
            source: command.source,
            reason: command.reason,
            at: meta.at,
            actorId: meta.actorId,
          });
          Object.assign(notice, after);
          // Distinct-notice attestations remain immutable; their recorded term revisions prevent stale reuse.
        }
      }
      break;
    }
    case 'reviewAccount': {
      const account =
        portfolio.accounts.find((item) => item.id === command.accountId) ??
        fail('ACCOUNT_NOT_FOUND', 'Choose an existing account.');
      const cash = portfolio.holdings.filter(
        (item) => item.accountId === account.id && item.assetClass === 'Cash',
      );
      if (cash.some((item) => item.currency !== command.currency))
        fail(
          'CURRENCY_MISMATCH',
          'The reviewed account currency must match its existing cash balance.',
        );
      validateSource(portfolio, command.source);
      if (
        command.source.sourceId &&
        portfolio.evidence.find((item) => item.id === command.source.sourceId)
          ?.familyId !== account.familyId
      )
        fail(
          'SOURCE_FAMILY_MISMATCH',
          'The account source must belong to the selected family.',
        );
      validateDate(command.source.date, meta);
      const prior = finance.accounts[account.id],
        reviews = prior?.reviews ?? [];
      if (reviews.length >= 100)
        fail(
          'LEDGER_LIMIT',
          'This account has reached the supported review-history limit.',
        );
      const review = {
        currency: command.currency,
        restricted: command.restricted,
        restrictionNote: command.restrictionNote,
        source: command.source,
        reviewedBy: meta.actorId,
        reviewedAt: meta.at,
      };
      finance.accounts[account.id] = {
        accountId: account.id,
        currency: command.currency,
        restricted: command.restricted,
        restrictionNote: command.restrictionNote,
        reviews: [...reviews, review],
      };
      break;
    }
    case 'createFamily': {
      if (
        portfolio.families.some(
          (item) => item.name.toLowerCase() === command.name.toLowerCase(),
        )
      )
        fail('FAMILY_EXISTS', 'Reuse the existing family.');
      portfolio.families.push({
        id: meta.id,
        name: command.name,
        initials: command.name.slice(0, 2).toUpperCase(),
        principal: command.principal,
        location: command.location,
        color: '#8064e5',
      });
      break;
    }
    case 'createEntity': {
      if (!portfolio.families.some((item) => item.id === command.familyId))
        fail('FAMILY_NOT_FOUND', 'Choose an existing family.');
      if (
        portfolio.entities.some(
          (item) =>
            item.familyId === command.familyId &&
            item.name.toLowerCase() === command.name.toLowerCase(),
        )
      )
        fail('ENTITY_EXISTS', 'Reuse the existing legal entity.');
      validateSource(portfolio, command.source);
      if (
        command.source.sourceId &&
        portfolio.evidence.find((item) => item.id === command.source.sourceId)
          ?.familyId !== command.familyId
      )
        fail(
          'SOURCE_FAMILY_MISMATCH',
          'The ownership source must belong to this family.',
        );
      portfolio.entities.push({
        id: meta.id,
        familyId: command.familyId,
        name: command.name,
        type: command.entityType,
        jurisdiction: command.jurisdiction,
        ownershipPercent: command.ownershipPercent,
      });
      finance.entities[meta.id] = {
        source: command.source,
        reviewedBy: meta.actorId,
        reviewedAt: meta.at,
      };
      break;
    }
    case 'createAccount': {
      const entity =
        portfolio.entities.find((item) => item.id === command.entityId) ??
        fail('ENTITY_NOT_FOUND', 'Choose an existing legal entity.');
      if (
        portfolio.accounts.some(
          (item) =>
            item.entityId === entity.id &&
            item.name.toLowerCase() === command.name.toLowerCase(),
        )
      )
        fail('ACCOUNT_EXISTS', 'Reuse the existing account.');
      portfolio.accounts.push({
        id: meta.id,
        familyId: entity.familyId,
        entityId: entity.id,
        name: command.name,
        institution: command.institution,
        maskedNumber: '',
        type: command.accountType,
      });
      finance.accounts[meta.id] = {
        accountId: meta.id,
        currency: command.currency,
        restricted: command.restricted,
        restrictionNote: command.restrictionNote,
      };
      break;
    }
    case 'createHolding': {
      if (portfolio.holdings.length >= 200)
        fail('HOLDING_LIMIT', 'At most 200 holdings are supported.');
      const account =
        portfolio.accounts.find((item) => item.id === command.accountId) ??
        fail('ACCOUNT_NOT_FOUND', 'Choose an existing account.');
      const entity =
        portfolio.entities.find(
          (item) =>
            item.id === account.entityId && item.familyId === account.familyId,
        ) ??
        fail('ENTITY_NOT_FOUND', 'The account needs an existing legal entity.');
      validateDate(command.valuationDate, meta);
      if (
        command.assetClass === 'Cash' &&
        portfolio.holdings.some(
          (item) =>
            item.accountId === account.id &&
            item.assetClass === 'Cash' &&
            item.currency === command.currency,
        )
      )
        fail(
          'CASH_EXISTS',
          'This account already has a balance in that currency; post a transaction or valuation.',
        );
      if (
        command.assetClass === 'Cash' &&
        finance.accounts[account.id]?.currency !== undefined &&
        finance.accounts[account.id].currency !== command.currency
      )
        fail(
          'CURRENCY_MISMATCH',
          'The cash balance currency must match the registered account.',
        );
      if (
        command.assetClass === 'Cash' &&
        moneyMinor(command.unfundedCommitmentEUR) !== 0n
      )
        fail(
          'CASH_COMMITMENT_INVALID',
          'A cash balance cannot carry an unfunded investment commitment.',
        );
      const valueEUR = convertToEUR(
        command.amount,
        command.currency,
        command.fx,
        command.valuationDate,
      );
      const holding: Holding = {
        id: meta.id,
        name: command.name,
        assetClass: command.assetClass,
        familyId: entity.familyId,
        entityId: entity.id,
        accountId: account.id,
        currency: command.currency,
        valueEUR,
        costBasisEUR: Number(command.costBasisEUR),
        originalValue: Number(command.amount),
        syntheticFXRateToEUR:
          command.currency === 'EUR' ? 1 : Number(command.fx!.rateToEUR),
        unfundedCommitmentEUR: Number(command.unfundedCommitmentEUR),
        liquidityBucket: command.liquidityBucket,
        valuationDate: command.valuationDate,
        sourceId: meta.id + '-source',
        geography: command.geography,
        manager: command.manager,
        description:
          'Reviewed opening position. Value is the investor’s economic share; ownership is not multiplied into it again.',
        color: '#8064e5',
        valuationMethod:
          command.assetClass === 'Cash'
            ? 'Cash balance'
            : command.assetClass === 'Real estate'
              ? 'Equity appraisal, net of debt'
              : ['Public equities', 'Fixed income'].includes(command.assetClass)
                ? 'Reported market mark'
                : 'Reported fund NAV',
      };
      portfolio.holdings.push(holding);
      recordEvidence(
        portfolio,
        holding,
        command.source,
        meta,
        'Reviewed opening position · ' + holding.name,
      );
      finance.holdings[holding.id] = {
        holdingId: holding.id,
        managerId: command.managerId,
        instrumentId: command.instrumentId,
        shareClassId: command.shareClassId,
        source: command.source,
        fx: command.fx,
        originalAmount: command.amount,
        pendingCapitalEUR: 0,
        openingDate: command.valuationDate,
      };
      finance.valuations.push({
        id: meta.id + '-mark',
        holdingId: holding.id,
        amount: command.amount,
        currency: command.currency,
        valueEUR,
        effectiveDate: command.valuationDate,
        sourceId: holding.sourceId,
        fx: command.fx,
        actorId: meta.actorId,
        recordedAt: meta.at,
        valuationMethod: holding.valuationMethod,
      });
      portfolio.history.push({
        holdingId: holding.id,
        date: command.valuationDate,
        valueEUR,
        netExternalFlowEUR: 0,
        valuationBasis: 'Reported mark',
        flowCoverage: 'unknown',
      });
      break;
    }
    case 'recordValuation': {
      const holding = findHolding(portfolio, command.holdingId);
      const sourceId = recordEvidence(
        portfolio,
        holding,
        command.source,
        meta,
        'Reviewed valuation · ' + holding.name,
      );
      const output = postReviewedValuation(
        portfolio,
        finance,
        {
          holdingId: holding.id,
          amount: command.amount,
          currency: command.currency,
          effectiveDate: command.effectiveDate,
          sourceId,
          fx: command.fx,
          correction: command.correction,
        },
        meta,
      );
      return { ...output, resultId: meta.id };
    }
    case 'recordTransaction': {
      if (moneyMinor(command.amount) === 0n)
        fail('POSITIVE_AMOUNT', 'Transactions require a positive amount.');
      const tx: LedgerTransaction = {
        id: meta.id,
        obligationId: command.obligationId,
        kind: command.kind,
        holdingId: command.holdingId,
        cashHoldingId: command.cashHoldingId,
        destinationCashHoldingId: command.destinationCashHoldingId,
        amount: command.amount,
        currency: command.currency,
        amountEUR: convertToEUR(
          command.amount,
          command.currency,
          command.fx,
          command.dueDate,
        ),
        fx: command.fx,
        dueDate: command.dueDate,
        source: command.source,
        investmentEffect: command.investmentEffect,
        investmentAmount: command.investmentAmount,
        investmentCostBasisEUR: Number(command.investmentCostBasisEUR),
        commitmentEffect: command.commitmentEffect,
        commitmentAmountEUR: Number(command.commitmentAmountEUR),
        reviewedBy: meta.actorId,
        reviewedAt: meta.at,
        memo: command.memo,
      };
      validateTransaction(portfolio, finance, tx);
      validateObligationAllocation(finance, tx);
      finance.transactions.push(tx);
      break;
    }
    case 'settleTransaction':
    case 'reverseTransaction':
    case 'voidTransaction': {
      const tx =
        finance.transactions.find(
          (item) => item.id === command.transactionId,
        ) ??
        fail(
          'TRANSACTION_NOT_FOUND',
          'Choose a transaction in this workspace.',
          404,
        );
      const status = transactionStatus(finance, tx.id);
      if (command.type === 'voidTransaction') {
        if (status !== 'reviewed')
          fail(
            'TRANSACTION_CHANGED',
            'Only an unsettled reviewed transaction can be voided.',
            409,
          );
        validateDate(command.source.date, meta);
        validateSource(
          portfolio,
          command.source,
          findHolding(portfolio, tx.cashHoldingId),
        );
        finance.events.push({
          id: meta.id,
          transactionId: tx.id,
          type: 'voided',
          date: command.source.date,
          at: meta.at,
          actorId: meta.actorId,
          source: command.source,
          reason: command.reason,
          postings: [],
          externalFlowEUR: 0,
        });
        break;
      }
      validateDate(command.date, meta);
      let postings: LedgerEvent['postings'],
        externalFlowEUR = 0,
        reversesEventId: string | undefined;
      if (command.type === 'settleTransaction') {
        if (status !== 'reviewed')
          fail(
            'TRANSACTION_CHANGED',
            'Only a reviewed, unsettled transaction can be settled.',
            409,
          );
        if (tx.fx && tx.fx.date > command.date)
          fail('FX_DATE_INVALID', 'The FX date cannot be after settlement.');
        // Newly accepted conflicting notices can arrive after transaction review.
        if (tx.obligationId) {
          const notice = findObligation(finance, tx.obligationId);
          if (
            notice.cancellation ||
            obligationSummary(finance, notice).missingDetails.length
          )
            fail(
              'OBLIGATION_INCOMPLETE',
              'Resolve the linked notice and similar-source conflicts before confirming settlement.',
              409,
            );
        } else validateObligationAllocation(finance, tx);
        postings = settlementPostings(portfolio, finance, tx);
        externalFlowEUR =
          tx.kind === 'deposit'
            ? tx.amountEUR
            : tx.kind === 'withdrawal'
              ? -tx.amountEUR
              : 0;
      } else {
        if (status !== 'settled')
          fail(
            'TRANSACTION_CHANGED',
            'Only a settled transaction can be reversed once.',
            409,
          );
        const prior = finance.events.find(
          (item) => item.transactionId === tx.id && item.type === 'settled',
        )!;
        if (command.date < prior.date)
          fail('REVERSAL_DATE', 'The reversal cannot predate settlement.');
        if (
          finance.valuations.some(
            (mark) =>
              prior.postings.some(
                (post) => post.holdingId === mark.holdingId,
              ) && mark.recordedAt > prior.at,
          )
        )
          fail(
            'REVERSAL_RESTATEMENT_REQUIRED',
            'A later reviewed valuation incorporates this settlement. Reversal with dependent marks requires a historical restatement workflow, which is not supported.',
            409,
          );
        postings = prior.postings.map((post) => ({
          ...post,
          nativeDelta: -post.nativeDelta,
          valueEURDelta: -post.valueEURDelta,
          commitmentEURDelta: -post.commitmentEURDelta,
          costBasisEURDelta: -post.costBasisEURDelta,
        }));
        externalFlowEUR = -prior.externalFlowEUR;
        reversesEventId = prior.id;
      }
      const cash = findHolding(portfolio, tx.cashHoldingId);
      validateSource(portfolio, command.source, cash);
      const event: LedgerEvent = {
        id: meta.id,
        transactionId: tx.id,
        type: command.type === 'settleTransaction' ? 'settled' : 'reversed',
        date: command.date,
        at: meta.at,
        actorId: meta.actorId,
        source: command.source,
        reason:
          command.type === 'reverseTransaction'
            ? command.reason
            : 'Reviewer confirmed bank settlement; no payment was initiated.',
        postings,
        externalFlowEUR,
        reversesEventId,
      };
      const sourceId = recordEvidence(
        portfolio,
        cash,
        command.source,
        meta,
        event.type + ' · ' + tx.kind,
      );
      applyPostings(portfolio, finance, event, sourceId);
      finance.events.push(event);
      break;
    }
    case 'reconcilePeriod': {
      validateDate(command.to, meta);
      if (command.from > command.to)
        fail(
          'COVERAGE_DATE',
          'The coverage start must be on or before its end.',
        );
      const entity =
        portfolio.entities.find((item) => item.id === command.entityId) ??
        fail('ENTITY_NOT_FOUND', 'Choose an existing legal entity.');
      const cash = portfolio.holdings.filter(
        (item) => item.entityId === entity.id && item.assetClass === 'Cash',
      );
      if (
        cash.length !== new Set(command.cashHoldingIds).size ||
        cash.some((item) => !command.cashHoldingIds.includes(item.id))
      )
        fail(
          'COVERAGE_INCOMPLETE',
          'Reconcile every cash balance in this legal entity together.',
        );
      if (
        command.closingBalances.length !== cash.length ||
        new Set(command.closingBalances.map((row) => row.holdingId)).size !==
          cash.length
      )
        fail(
          'COVERAGE_INCOMPLETE',
          'Provide one closing statement balance per cash holding.',
        );
      for (const holding of cash) {
        const statement = command.closingBalances.find(
          (item) => item.holdingId === holding.id,
        );
        if (
          !statement ||
          moneyMinor(statement.amount) !==
            moneyMinor(holding.originalValue.toFixed(2)) ||
          moneyMinor(statement.valueEUR) !==
            moneyMinor(holding.valueEUR.toFixed(2))
        )
          fail(
            'RECONCILIATION_DIFFERENCE',
            'The statement closing balance does not match the recorded ledger balance. Resolve the difference before reconciling.',
          );
        if (
          holding.valuationDate > command.to ||
          !portfolio.history.some(
            (row) => row.holdingId === holding.id && row.date <= command.from,
          )
        )
          fail(
            'COVERAGE_INCOMPLETE',
            'Opening and closing cash marks must cover this period.',
          );
      }
      validateSource(portfolio, command.source, cash[0]);
      finance.coverage.push({
        id: meta.id,
        familyId: entity.familyId,
        entityId: entity.id,
        from: command.from,
        to: command.to,
        cashHoldingIds: [...command.cashHoldingIds],
        source: command.source,
        reviewedBy: meta.actorId,
        reviewedAt: meta.at,
        ledgerRevision: finance.revision + 1,
        eventCount: finance.events.length,
        valuationCount: finance.valuations.length,
        closingBalances: structuredClone(command.closingBalances),
        status: 'reconciled',
      });
      break;
    }
  }
  bump(finance);
  return { portfolio, finance, resultId };
}
/** Reconciliation attests cash-flow coverage only; it does not supply comparable investment valuations. */
export function cashflowCoverageCurrent(
  finance: FinanceState,
  portfolio: PortfolioRecords,
  period: CashflowCoverage,
): boolean {
  if (
    !Number.isInteger(period.eventCount) ||
    !Number.isInteger(period.valuationCount) ||
    !period.closingBalances
  )
    return false;
  const covered = new Set(period.cashHoldingIds);
  const cash = portfolio.holdings.filter(
    (h) =>
      h.entityId === period.entityId &&
      h.assetClass === 'Cash' &&
      (finance.holdings[h.id]?.openingDate ?? h.valuationDate) <= period.to,
  );
  if (cash.length !== covered.size || cash.some((h) => !covered.has(h.id)))
    return false;
  return (
    !finance.events
      .slice(period.eventCount)
      .some(
        (event) =>
          event.date <= period.to &&
          event.postings.some((post) => covered.has(post.holdingId)),
      ) &&
    !finance.valuations
      .slice(period.valuationCount)
      .some(
        (mark) =>
          mark.effectiveDate <= period.to && covered.has(mark.holdingId),
      )
  );
}
export function hasReconciledCashflowCoverage(
  finance: FinanceState | undefined,
  portfolio: PortfolioRecords,
  holdingIds: readonly string[],
  from: string,
  to: string,
): boolean {
  if (!finance || !holdingIds.length || from > to) return false;
  const holdings = portfolio.holdings.filter((item) =>
    holdingIds.includes(item.id),
  );
  if (holdings.length !== new Set(holdingIds).size) return false;
  return [...new Set(holdings.map((item) => item.entityId))].every((entityId) =>
    finance.coverage.some(
      (period) =>
        period.entityId === entityId &&
        period.from <= from &&
        period.to >= to &&
        cashflowCoverageCurrent(finance, portfolio, period),
    ),
  );
}
