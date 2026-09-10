import { describe, expect, it } from 'vitest';
import type { Extraction, ProcessingJob } from './processing-contract';
import { initialReview } from './review-contract';
import {
  documentNextStep,
  durationLabel,
  factCounts,
  reportedAmountLabel,
} from './document-pipeline';

const extraction: Extraction = {
  schemaVersion: 1,
  documentId: '00000000-0000-4000-8000-000000000001',
  mode: 'workflow',
  execution: 'local',
  documentType: 'email',
  relevant: true,
  confidence: 0.9,
  model: 'fixture',
  facts: Array.from({ length: 4 }, () => ({
    kind: 'news' as const,
    investmentName: 'Test fund',
    effectiveDate: null,
    amount: null,
    currency: null,
    dueDate: null,
    summary: 'Synthetic update',
    evidence: { page: 1, quote: 'Synthetic update' },
  })),
  warnings: [],
  trace: [],
};
function job(overrides: Partial<ProcessingJob> = {}): ProcessingJob {
  return {
    id: 'job',
    documentId: extraction.documentId,
    filename: 'update.eml',
    mode: 'workflow',
    status: 'awaiting_review',
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-10T00:00:00Z',
    policyRevision: 1,
    errorCode: null,
    result: extraction,
    review: initialReview(extraction, 'hash', 'awaiting_review'),
    ...overrides,
  };
}

describe('document record decisions and next actions', () => {
  it('keeps deferred work visible after a partial review and follows fact IDs rather than array order', () => {
    const document = job();
    document.review!.facts.forEach((fact, index) => {
      fact.status = (['accepted', 'deferred', 'rejected', 'pending'] as const)[
        index
      ];
    });
    document.review!.facts.reverse();
    expect(factCounts(document)).toMatchObject({
      extractedCount: 4,
      acceptedCount: 1,
      deferredCount: 1,
      rejectedCount: 1,
      pendingCount: 1,
      remainingCount: 2,
    });
    expect(documentNextStep(document).detail).toBe('2 fact decisions remain.');
    document.review!.facts.find((fact) => fact.factIndex === 3)!.status =
      'accepted';
    expect(factCounts(document)).toMatchObject({
      acceptedCount: 2,
      remainingCount: 1,
    });
    expect(documentNextStep(document).detail).toBe('1 fact decision remains.');
  });

  it('does not present historical acceptance as individually recorded facts', () => {
    const document = job({ status: 'accepted', review: null });
    expect(factCounts(document)).toMatchObject({
      extractedCount: 4,
      acceptedCount: 0,
      legacyCount: 4,
      remainingCount: 0,
    });
    expect(documentNextStep(document).detail).toContain('not recorded');
  });

  it('distinguishes a completed empty extraction from a missing result or an active retry', () => {
    expect(factCounts(job({ result: null }))).toBeNull();
    expect(factCounts(job({ status: 'processing' }))).toBeNull();
    expect(
      factCounts(job({ result: { ...extraction, facts: [] } })),
    ).toMatchObject({
      extractedCount: 0,
      remainingCount: 0,
    });
  });

  it.each([
    ['failed', 'Resolve issue'],
    ['cancelled', 'Retry extraction'],
    ['queued', 'View activity'],
    ['processing', 'View activity'],
    ['rejected', 'View record'],
  ])('offers an actionable destination for %s', (status, label) => {
    expect(documentNextStep(job({ status })).label).toBe(label);
  });
});

describe('extraction duration display', () => {
  it('keeps missing timing unknown instead of treating it as zero', () => {
    for (const value of [null, undefined, NaN, Infinity, -1]) {
      expect(durationLabel(value)).toBe('Not recorded');
    }
  });
  it('renders measured short, minute and hour durations without rounding up', () => {
    expect(durationLabel(0)).toBe('<1s');
    expect(durationLabel(59_999)).toBe('59s');
    expect(durationLabel(72_000)).toBe('1m 12s');
    expect(durationLabel(3_661_999)).toBe('1h 1m');
  });
});

it('keeps reported precision and signs when grouping financial amounts', () => {
  expect(reportedAmountLabel('1460000.00')).toBe('1,460,000.00');
  expect(reportedAmountLabel('-999999999999999999.12345678')).toBe(
    '-999,999,999,999,999,999.12345678',
  );
  expect(reportedAmountLabel('0.00000001')).toBe('0.00000001');
});
