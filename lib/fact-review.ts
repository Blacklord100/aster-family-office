import type { ExtractedFact } from './processing-contract';
import { ledgerFxSchema, type LedgerFx } from './ledger-contract';
import type { Holding } from '@/data/types';

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

export function factAcceptanceIssue(
  fact: ExtractedFact,
  fx?: LedgerFx,
): string | null {
  if (fact.kind === 'valuation') {
    if (!fact.effectiveDate)
      return 'This valuation needs a reported effective date before it can be accepted.';
    if (!fact.currency || !['EUR', 'USD', 'GBP', 'CHF'].includes(fact.currency))
      return 'Choose the reported currency. Supported valuation currencies are EUR, USD, GBP and CHF.';
    if (fact.currency !== 'EUR' && !ledgerFxSchema.safeParse(fx).success)
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

/** Name similarity suggests candidates only; no automatic association or financial write. */
export function suggestHoldings(
  fact: Pick<ExtractedFact, 'investmentName'>,
  holdings: Holding[],
) {
  const normalize = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const needle = normalize(fact.investmentName);
  const tokens = new Set(needle.split(' ').filter((word) => word.length > 2));
  return holdings
    .map((holding) => {
      const name = normalize(holding.name);
      const words = new Set(name.split(' ').filter((word) => word.length > 2));
      const shared = [...tokens].filter((word) => words.has(word)).length;
      const score =
        name === needle && needle.length > 0
          ? 1
          : shared / Math.max(tokens.size, words.size, 1);
      return {
        holding,
        score,
        reason: score === 1 ? 'Name matches' : 'Similar name',
      };
    })
    .filter((candidate) => candidate.score >= 0.5)
    .sort(
      (a, b) =>
        b.score - a.score || a.holding.name.localeCompare(b.holding.name),
    )
    .slice(0, 3);
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
