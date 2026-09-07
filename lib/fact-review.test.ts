import { describe, expect, it } from 'vitest';
import type { ExtractedFact } from './processing-contract';
import {
  canonicalAmount,
  factAcceptanceIssue,
  supersededValuationReplay,
} from './fact-review';

const fact: ExtractedFact = {
  kind: 'valuation',
  investmentName: 'Synthetic reviewed fund',
  effectiveDate: '2026-06-30',
  amount: '100.00',
  currency: 'EUR',
  dueDate: null,
  summary: 'Synthetic source fact',
  evidence: { page: 1, quote: 'Synthetic NAV EUR 100.00' },
};
describe('financial review boundaries', () => {
  it('normalizes decimals exactly without merging distinct source amounts', () => {
    expect(canonicalAmount('000123.45000000')).toBe('123.45');
    expect(canonicalAmount('-000.00000000')).toBe('0.00');
    expect(canonicalAmount('999999999999999999.12345678')).toBe(
      '999999999999999999.12345678',
    );
    expect(canonicalAmount('100.001')).not.toBe(canonicalAmount('100.002'));
    expect(canonicalAmount('999999999999999998')).not.toBe(
      canonicalAmount('999999999999999999'),
    );
  });
  it.each(['-1.00', '1.001', '1000000000000.01', '999999999999999999'])(
    'blocks unsafe financial amount %s',
    (amount) => {
      for (const kind of [
        'valuation',
        'capital_call',
        'distribution',
      ] as const) {
        expect(factAcceptanceIssue({ ...fact, kind, amount })).not.toBeNull();
      }
    },
  );
  it('accepts cent-precise boundaries and preserves amountless notices', () => {
    expect(factAcceptanceIssue({ ...fact, amount: '0.00' })).toBeNull();
    expect(
      factAcceptanceIssue({ ...fact, amount: '1000000000000.00' }),
    ).toBeNull();
    expect(
      factAcceptanceIssue({ ...fact, kind: 'capital_call', amount: null }),
    ).toBeNull();
    expect(factAcceptanceIssue({ ...fact, amount: null })).not.toBeNull();
    expect(factAcceptanceIssue({ ...fact, currency: 'USD' })).not.toBeNull();
    expect(
      factAcceptanceIssue({ ...fact, effectiveDate: null }),
    ).not.toBeNull();
  });
  it('detects same-period correction replays but allows unchanged and older-period duplicates', () => {
    const holding = {
      id: 'holding',
      valuationDate: '2026-09-30',
      valueEUR: 130,
    };
    expect(
      supersededValuationReplay(fact, holding, [
        { holdingId: holding.id, date: '2026-06-30', valueEUR: 120 },
      ]),
    ).toBe(true);
    expect(
      supersededValuationReplay(fact, holding, [
        { holdingId: holding.id, date: '2026-06-30', valueEUR: 100 },
      ]),
    ).toBe(false);
    expect(supersededValuationReplay(fact, holding, [])).toBe(false);
    expect(
      supersededValuationReplay(
        fact,
        { ...holding, valuationDate: fact.effectiveDate! },
        [],
      ),
    ).toBe(true);
  });
});
