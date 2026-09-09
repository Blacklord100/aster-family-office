import { describe, expect, it } from 'vitest';
import { retryDecision } from './worker-retry';

describe('document worker retry classification', () => {
  it.each([400, 413, 415, 422])(
    'fails permanently rejected HTTP %s on the first attempt',
    (status) => {
      expect(retryDecision(false, `PROCESSOR_HTTP_${status}`, 1, 0)).toBe(
        'fail',
      );
    },
  );

  it.each([408, 425, 429, 499, 500, 502, 504])(
    'keeps HTTP %s transient failures within the three-attempt limit',
    (status) => {
      const code = `PROCESSOR_HTTP_${status}`;
      expect(retryDecision(false, code, 1, 0)).toBe('retry');
      expect(retryDecision(false, code, 2, 0)).toBe('retry');
      expect(retryDecision(false, code, 3, 0)).toBe('fail');
    },
  );

  it('keeps network failures retryable without treating arbitrary text as an HTTP status', () => {
    expect(retryDecision(false, 'PROCESSING_FAILED', 1, 0)).toBe('retry');
    expect(retryDecision(false, 'PROCESSING_FAILED', 3, 0)).toBe('fail');
    expect(retryDecision(false, 'prefix_PROCESSOR_HTTP_422', 1, 0)).toBe(
      'retry',
    );
  });

  it('defers capacity independently of extraction attempts and caps deferrals', () => {
    expect(retryDecision(false, 'PROCESSOR_HTTP_503', 3, 29)).toBe('capacity');
    expect(retryDecision(false, 'PROCESSOR_HTTP_503', 1, 30)).toBe('fail');
  });

  it.each(['PROCESSOR_HTTP_422', 'PROCESSOR_HTTP_503', 'PROCESSING_FAILED'])(
    'prioritizes graceful shutdown over %s without charging an attempt',
    (code) => {
      expect(retryDecision(true, code, 3, 30)).toBe('shutdown');
    },
  );
});
