import { describe, expect, it } from 'vitest';
import { initialReview } from '../review-contract';
import type { Extraction } from '../processing-contract';
import {
  processingTiming,
  summarizeProcessing,
  summaryPayloadIds,
  processingFamilyContext,
  type ProcessingAuditEvent,
} from './processing-metadata';
const result: Extraction = {
  schemaVersion: 1,
  documentId: '00000000-0000-4000-8000-000000000001',
  mode: 'workflow',
  execution: 'local',
  documentType: 'email',
  relevant: true,
  confidence: 0.8,
  model: 'fixture',
  facts: [],
  warnings: [],
  trace: [],
};
const event = (
  sequence: number,
  action: string,
  at: string,
  attemptId: string | null = null,
  duration: number | null = null,
): ProcessingAuditEvent => ({
  resource_id: 'job',
  sequence,
  action: 'processing.' + action,
  created_at: at,
  attempt_id: attemptId,
  duration_ms: duration,
  attempt_count: 2,
});
const start = '2026-09-08T00:00:00Z',
  end = '2026-09-08T00:00:10Z';
describe('processing metadata semantics', () => {
  it('distinguishes an empty completed extraction from an unprocessed source', () => {
    expect(
      summarizeProcessing(
        result,
        initialReview(result, 'hash', 'awaiting_review'),
      ),
    ).toMatchObject({
      availability: 'available',
      extractedCount: 0,
      remainingCount: 0,
    });
  });
  it('counts each decision once, with deferred still remaining and legacy separately reported', () => {
    const source = {
      ...result,
      facts: Array.from({ length: 5 }, () => ({
        kind: 'news' as const,
        investmentName: 'Fund',
        effectiveDate: null,
        amount: null,
        currency: null,
        dueDate: null,
        summary: 'private',
        evidence: { page: 1, quote: 'private quote' },
      })),
    };
    const review = initialReview(source, 'hash', 'awaiting_review');
    review.facts.forEach((fact, index) => {
      fact.status = (
        ['pending', 'accepted', 'deferred', 'rejected', 'legacy'] as const
      )[index];
    });
    expect(summarizeProcessing(source, review)).toMatchObject({
      extractedCount: 5,
      acceptedCount: 1,
      pendingCount: 1,
      deferredCount: 1,
      rejectedCount: 1,
      legacyCount: 1,
      remainingCount: 2,
    });
    review.facts[1].factIndex = 0;
    expect(() => summarizeProcessing(source, review)).toThrow(
      'INVALID_REVIEW_SUMMARY',
    );
  });
  it('caps warnings honestly and reserves the selected ciphertext before other summaries', () => {
    const source = { ...result, warnings: ['a'.repeat(3000), 'b', 'c', 'd'] };
    expect(
      summarizeProcessing(source, initialReview(source, 'hash', 'accepted')),
    ).toMatchObject({ warningCount: 4, warningsTruncated: true });
    expect(
      summaryPayloadIds(
        [
          { id: 'a', has_result: true, payload_bytes: 8 },
          { id: 'b', has_result: true, payload_bytes: 8 },
        ],
        'b',
        10,
      ),
    ).toEqual(['b']);
  });
  it('reflects recorded review amendments without modifying the retained extraction', () => {
    const source: Extraction = {
      ...result,
      facts: [
        {
          kind: 'news',
          investmentName: 'Original Fund',
          effectiveDate: null,
          amount: null,
          currency: null,
          dueDate: null,
          summary: '',
          evidence: { page: 1, quote: 'original' },
        },
      ],
    };
    const review = initialReview(source, 'hash', 'awaiting_review');
    review.facts[0].amendedFact = {
      ...source.facts[0],
      investmentName: 'Correct Fund',
      kind: 'distribution',
    };
    expect(summarizeProcessing(source, review)).toMatchObject({
      investmentNames: ['Correct Fund'],
      factTypes: ['distribution'],
    });
    expect(source.facts[0]).toMatchObject({
      investmentName: 'Original Fund',
      kind: 'news',
    });
    review.facts[0].status = 'constructor' as never;
    expect(() => summarizeProcessing(source, review)).toThrow(
      'INVALID_REVIEW_SUMMARY',
    );
  });
  it('uses monotonic durations from matching attempt receipts and ignores later review events', () => {
    expect(
      processingTiming('accepted', [
        event(1, 'started', start, 'attempt'),
        event(2, 'completed', end, 'attempt', 9876),
        event(3, 'review', '2026-09-09T00:00:00Z'),
      ]),
    ).toMatchObject({
      startedAt: '2026-09-08T00:00:00.000Z',
      completedAt: '2026-09-08T00:00:10.000Z',
      processingDurationMs: 9876,
      elapsedProcessingMs: null,
    });
  });
  it('does not join a previous failed attempt to a new start and resets at manual retry', () => {
    const events = [
      event(1, 'started', start, 'first'),
      event(2, 'failed', end, 'first', 10000),
      event(3, 'retry', end),
      event(4, 'started', end, 'second'),
    ];
    expect(
      processingTiming('processing', events, Date.parse(end) + 7000),
    ).toMatchObject({
      startedAt: '2026-09-08T00:00:10.000Z',
      failedAt: null,
      processingDurationMs: null,
      elapsedProcessingMs: 7000,
    });
    expect(processingTiming('queued', events.slice(0, 3))).toMatchObject({
      startedAt: null,
      failedAt: null,
      processingDurationMs: null,
    });
  });
  it('records a capacity wait as a completed attempt, with no guessed current substep or ETA', () => {
    expect(
      processingTiming('queued', [
        event(1, 'started', start, 'attempt'),
        event(2, 'requeued', end, 'attempt', 10000),
      ]),
    ).toMatchObject({
      processingDurationMs: 10000,
      completedAt: null,
      failedAt: null,
      elapsedProcessingMs: null,
    });
  });
  it('never invents duration without start, with mismatched attempts, or negative duration', () => {
    expect(
      processingTiming('accepted', [event(2, 'completed', end, null, 100)]),
    ).toMatchObject({ startedAt: null, processingDurationMs: null });
    expect(
      processingTiming('accepted', [
        event(1, 'started', start, 'a'),
        event(2, 'completed', end, 'b', 100),
      ]),
    ).toMatchObject({ completedAt: null, processingDurationMs: null });
    expect(
      processingTiming('accepted', [
        event(1, 'started', start, 'a'),
        event(2, 'completed', end, 'a', -1),
      ]),
    ).toMatchObject({ processingDurationMs: null });
  });
  it('uses accepted holding identity for family labels; directory matches remain untrusted hints', () => {
    const families = [
      { id: 'alder', name: 'Alder' },
      { id: 'birch', name: 'Birch' },
    ];
    expect(
      processingFamilyContext(null, 'alder/mailbox/source.eml', families, []),
    ).toEqual({ familyNames: ['Alder'], familyContext: 'source_path' });
    expect(
      processingFamilyContext(null, 'misc/Alder investment.eml', families, []),
    ).toEqual({ familyNames: [], familyContext: 'unknown' });
    const review = {
      revision: 1,
      extractionHash: 'hash',
      history: [],
      facts: [{ status: 'accepted', holdingId: 'h' }],
    } as unknown as ReturnType<typeof initialReview>;
    expect(
      processingFamilyContext(review, 'alder/source.eml', families, [
        { id: 'h', familyId: 'birch' },
      ]),
    ).toEqual({ familyNames: ['Birch'], familyContext: 'reviewed' });
  });
});
