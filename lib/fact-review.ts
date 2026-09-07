import type { ExtractedFact } from './processing-contract';

/** Exact decimal normalization for deduplication; never round source amounts. */
export function canonicalAmount(amount: string): string {
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole, fraction = ''] = unsigned.split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const decimals = fraction.replace(/0+$/, '');
  const zero = integer === '0' && decimals === '';
  // Keep the existing two-decimal fingerprint for ordinary money, while
  // retaining every significant digit of higher-precision source candidates.
  return (
    (negative && !zero ? '-' : '') + integer + '.' + decimals.padEnd(2, '0')
  );
}

/** The numeric portfolio stores nonnegative money at cent precision up to 1e12. */
export function supportedMoney(amount: string | null): amount is string {
  return (
    amount !== null &&
    /^\d{1,13}(\.\d{1,2})?$/.test(amount) &&
    Number(amount) <= 1e12
  );
}

export function factAcceptanceIssue(fact: ExtractedFact): string | null {
  if (fact.kind === 'valuation') {
    if (!fact.effectiveDate)
      return 'This valuation needs a reported effective date before it can be accepted.';
    if (fact.currency !== 'EUR')
      return 'This valuation needs an explicit EUR conversion before it can be accepted.';
    if (!supportedMoney(fact.amount))
      return 'Valuations require a nonnegative amount of at most EUR 1 trillion, with no more than two decimal places.';
  }
  if (
    (fact.kind === 'capital_call' || fact.kind === 'distribution') &&
    fact.amount !== null &&
    !supportedMoney(fact.amount)
  ) {
    return 'Capital-call and distribution amounts must be nonnegative, no greater than 1 trillion, and have no more than two decimal places. Check the original source.';
  }
  return null;
}

/** Ordinary replays must not undo a subsequently accepted mark for the same date. */
export function supersededValuationReplay(
  fact: ExtractedFact,
  holding: { id: string; valuationDate: string; valueEUR: number },
  history: { holdingId: string; date: string; valueEUR: number }[],
): boolean {
  if (fact.kind !== 'valuation' || fact.amount === null || !fact.effectiveDate)
    return false;
  const prior = history.find(
    (row) => row.holdingId === holding.id && row.date === fact.effectiveDate,
  );
  const current =
    prior?.valueEUR ??
    (holding.valuationDate === fact.effectiveDate
      ? holding.valueEUR
      : undefined);
  return current !== undefined && current !== Number(fact.amount);
}
