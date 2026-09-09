import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'http://localhost:3000' }),
}));
import {
  demoFactIssue,
  demoAssetClass,
  demoConflictingFacts,
  demoActionableWarnings,
} from './demo-publish';
import type { Extraction, ExtractedFact } from '../processing-contract';
const fact: ExtractedFact = {
  kind: 'valuation',
  investmentName: 'Example Fund',
  effectiveDate: '2026-06-30',
  amount: '500',
  currency: 'EUR',
  dueDate: null,
  summary: 'Example Fund NAV EUR 500 as of 2026-06-30.',
  evidence: { page: 1, quote: 'Example Fund NAV EUR 500 as of 2026-06-30.' },
};
const result: Extraction = {
  schemaVersion: 1,
  documentId: 'ff553759-5322-4c25-ae9a-a573a80fcf6e',
  mode: 'agentic',
  execution: 'local',
  documentType: 'valuation',
  relevant: true,
  confidence: 0.1,
  facts: [fact],
  warnings: [],
  trace: [
    { stage: 'validate', status: 'ok', detail: 'Source-validated candidate' },
  ],
  model: 'gemma4:e4b-m3',
};
describe('synthetic demo publication evidence policy', () => {
  it('keeps actual warnings actionable without making generic method notes block every demo document', () => {
    expect(
      demoActionableWarnings({
        warnings: [
          'Candidate facts only: review against the original before any financial posting.',
          'Confidence is synthetic relevance-classifier probability, not financial correctness or calibrated confidence.',
          'Unreadable attachment',
        ],
      }),
    ).toEqual(['Unreadable attachment']);
  });
  it('holds every competing mark without letting source order choose a value', () => {
    expect([
      ...demoConflictingFacts([
        fact,
        { ...fact, amount: '600' },
        { ...fact, effectiveDate: '2026-05-31' },
      ]),
    ]).toEqual([0, 1]);
    expect([
      ...demoConflictingFacts([fact, { ...fact, amount: '500.00' }]),
    ]).toEqual([]);
    expect([
      ...demoConflictingFacts([fact, { ...fact, currency: 'CHF' }]),
    ]).toEqual([0, 1]);
  });
  it('uses evidence completeness rather than the relevance classifier probability', () =>
    expect(demoFactIssue(result, fact)).toBeNull());
  it.each(['effectiveDate', 'amount', 'currency'] as const)(
    'keeps missing %s in human review',
    (field) =>
      expect(demoFactIssue(result, { ...fact, [field]: null })).not.toBeNull(),
  );
  it('requires locally executed independent source validation', () => {
    expect(
      demoFactIssue({ ...result, execution: 'cloud' }, fact),
    ).not.toBeNull();
    expect(demoFactIssue({ ...result, trace: [] }, fact)).not.toBeNull();
  });
  it.each([
    'PDF page used local OCR; evidence requires visual review.',
    'Image-only source needs manual review.',
    'Agent stopped before an explicit finish.',
    'Manual source review is required.',
  ])('retains reading exceptions: %s', (warning) =>
    expect(
      demoFactIssue({ ...result, warnings: [warning] }, fact),
    ).not.toBeNull(),
  );
  it('does not associate an unsupported investment name with a source quote', () =>
    expect(
      demoFactIssue(result, { ...fact, investmentName: 'Another fund' }),
    ).not.toBeNull());
  it('permits supported non-EUR facts only with an explicit scenario FX basis', () => {
    expect(demoFactIssue(result, { ...fact, currency: 'CHF' })).toBeNull();
    expect(demoFactIssue(result, { ...fact, currency: 'JPY' })).not.toBeNull();
    expect(demoFactIssue(result, { ...fact, kind: 'capital_call', currency: 'JPY' })).not.toBeNull();
    expect(demoFactIssue(result, { ...fact, kind: 'distribution', currency: 'JPY' })).not.toBeNull();
  });
  it('requires dates, amount and currency on call notices without treating a notice as payment', () =>
    expect(
      demoFactIssue(result, { ...fact, kind: 'capital_call', amount: null }),
    ).not.toBeNull());
  it('keeps dated news optional and uses descriptive class suggestions only', () => {
    expect(
      demoFactIssue(result, {
        ...fact,
        kind: 'news',
        effectiveDate: null,
        amount: null,
        currency: null,
      }),
    ).toBeNull();
    expect(demoAssetClass('Example Credit II')).toBe('Fixed income');
    expect(demoAssetClass('Example Ventures IV')).toBe('Venture capital');
  });
});
