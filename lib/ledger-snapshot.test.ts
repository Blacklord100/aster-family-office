import { describe, expect, it } from 'vitest';
import { ledgerDraftNeedsReview, mergeLedgerSnapshot } from './ledger-snapshot';
import type { LedgerResponse } from './ledger-contract';
const response = (revision: number) => ({ revision }) as LedgerResponse;
describe('ledger refresh ordering and retained drafts', () => {
  it('does not roll back a post-commit refresh when an earlier POST response arrives late', () => {
    const refreshed = mergeLedgerSnapshot(
      null,
      response(12),
      'office-A',
      'office-A',
    );
    expect(
      mergeLedgerSnapshot(refreshed, response(11), 'office-A', 'office-A'),
    ).toBe(refreshed);
    expect(
      mergeLedgerSnapshot(refreshed, response(13), 'office-A', 'office-A')
        ?.response.revision,
    ).toBe(13);
  });
  it('rejects responses from a prior tenant or narrower/wider permission scope', () => {
    const scoped = mergeLedgerSnapshot(
      null,
      response(2),
      'office-B:scoped',
      'office-B:scoped',
    );
    expect(
      mergeLedgerSnapshot(scoped, response(900), 'office-A', 'office-B:scoped'),
    ).toBe(scoped);
    expect(
      mergeLedgerSnapshot(
        scoped,
        response(3),
        'office-B:all',
        'office-B:scoped',
      ),
    ).toBe(scoped);
  });
  it('requires explicit review after refresh without changing unsaved entries', () => {
    const draft = {
        revision: 4,
        contextKey: 'A',
        amount: '37.41',
        memo: 'Unsaved bank evidence',
      },
      before = structuredClone(draft);
    const current = mergeLedgerSnapshot(null, response(5), 'A', 'A');
    expect(ledgerDraftNeedsReview(draft, current, false)).toBe(true);
    expect(draft).toEqual(before);
    expect(
      ledgerDraftNeedsReview({ ...draft, revision: 5 }, current, false),
    ).toBe(false);
    expect(
      ledgerDraftNeedsReview({ ...draft, revision: 5 }, current, true),
    ).toBe(true);
    expect(
      ledgerDraftNeedsReview({ ...draft, revision: 5 }, current, false, 6),
    ).toBe(true);
    expect(
      ledgerDraftNeedsReview(
        { ...draft, contextKey: 'B', revision: 5 },
        current,
        false,
      ),
    ).toBe(true);
  });
});
