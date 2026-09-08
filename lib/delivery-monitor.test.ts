import { describe, expect, it } from 'vitest';
import {
  classifyDeliveryQueue,
  DELIVERY_PENDING_MAX_AGE_MS,
} from './delivery-monitor';

const now = Date.parse('2026-09-08T12:00:00.000Z');
const empty = {
  pending: 0,
  failed: 0,
  expired_unprocessed: 0,
  oldest_pending_at: null,
  latest_pending_at: null,
};
const pending = (age: number) => ({
  ...empty,
  pending: 1,
  oldest_pending_at: new Date(now - age),
  latest_pending_at: new Date(now - age),
});
const codes = (evidence: unknown) =>
  classifyDeliveryQueue(evidence, now).alerts.map((alert) => alert.code);

describe('delivery backlog monitoring', () => {
  it('passes an empty queue and a fresh pending message', () => {
    expect(classifyDeliveryQueue(empty, now).result).toBe('passed');
    expect(
      classifyDeliveryQueue(pending(DELIVERY_PENDING_MAX_AGE_MS - 1), now)
        .result,
    ).toBe('passed');
    expect(classifyDeliveryQueue(pending(0), now).oldestPendingAgeSeconds).toBe(
      0,
    );
  });

  it('alerts at the five-minute boundary and beyond even with no failed attempts', () => {
    for (const age of [DELIVERY_PENDING_MAX_AGE_MS, 31 * 60 * 1000]) {
      expect(codes(pending(age))).toEqual(['DELIVERY_PENDING_STALE']);
      expect(classifyDeliveryQueue(pending(age), now).result).toBe('attention');
    }
  });

  it('alerts on failed and expired unprocessed messages independently of pending age', () => {
    expect(codes({ ...empty, failed: 1 })).toEqual(['DELIVERY_FAILED']);
    expect(codes({ ...pending(1000), expired_unprocessed: 1 })).toEqual([
      'DELIVERY_EXPIRED_UNPROCESSED',
    ]);
    // Expired failed rows are no longer counted as live failed/pending messages.
    expect(codes({ ...empty, expired_unprocessed: 1 })).toEqual([
      'DELIVERY_EXPIRED_UNPROCESSED',
    ]);
    expect(
      codes({
        ...pending(DELIVERY_PENDING_MAX_AGE_MS),
        failed: 2,
        expired_unprocessed: 1,
      }),
    ).toEqual([
      'DELIVERY_FAILED',
      'DELIVERY_PENDING_STALE',
      'DELIVERY_EXPIRED_UNPROCESSED',
    ]);
  });

  it('accepts serialized UTC evidence without changing the age calculation', () => {
    const evidence = JSON.parse(
      JSON.stringify(pending(DELIVERY_PENDING_MAX_AGE_MS)),
    );
    expect(classifyDeliveryQueue(evidence, now).oldestPendingAgeSeconds).toBe(
      300,
    );
    expect(codes(evidence)).toEqual(['DELIVERY_PENDING_STALE']);
  });

  it('refuses future timestamps including a newer future item behind an older valid one', () => {
    expect(codes(pending(-1))).toEqual(['DELIVERY_EVIDENCE_INVALID']);
    expect(
      codes({
        ...pending(1000),
        pending: 2,
        latest_pending_at: new Date(now + 1),
      }),
    ).toEqual(['DELIVERY_EVIDENCE_INVALID']);
  });

  it('refuses missing, malformed and inconsistent evidence without echoing it', () => {
    const privateText = 'private transport error must never enter output';
    for (const evidence of [
      undefined,
      null,
      {},
      { ...empty, pending: -1 },
      { ...empty, failed: 0.5 },
      { ...empty, expired_unprocessed: Infinity },
      { ...empty, pending: '1' },
      { ...empty, pending: 1 },
      { ...pending(0), pending: 0 },
      { ...pending(1000), latest_pending_at: new Date(now - 2000) },
      { ...pending(0), oldest_pending_at: privateText },
      { ...empty, payload: privateText },
    ]) {
      const result = classifyDeliveryQueue(evidence, now);
      expect(result.result).toBe('attention');
      expect(result.alerts.map((alert) => alert.code)).toEqual([
        'DELIVERY_EVIDENCE_INVALID',
      ]);
      expect(JSON.stringify(result)).not.toContain(privateText);
    }
  });

  it('does not report healthy when the monitoring clock is invalid', () => {
    expect(classifyDeliveryQueue(empty, Number.NaN).result).toBe('attention');
    expect(classifyDeliveryQueue(empty, Infinity).result).toBe('attention');
  });
});
