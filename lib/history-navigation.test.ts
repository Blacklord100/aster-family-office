import { describe, expect, it } from 'vitest';
import { copyHistoryNavigation } from './history-navigation';

describe('participation navigation keeps the dated financial comparison', () => {
  const source = new URLSearchParams(
    'historyAsOf=2026-06-30&historyTo=2026-06-30&historyCurrency=USD&historyKnownAt=2026-07-01T00%3A00%3A00Z&historyCohort=historical&historyOffset=40&historyVersions=true&historyEntity=old&historyComparison=comparable&observation=old&investmentList=positions',
  );
  it('retains dates, knowledge and currency while clearing position-specific selection', () => {
    const out = new URLSearchParams();
    copyHistoryNavigation(
      source,
      out,
      { view: 'investments', holding: 'a', family: 'all' },
      { view: 'investments', holding: 'b', family: 'all' },
    );
    expect(out.get('historyAsOf')).toBe('2026-06-30');
    expect(out.get('historyCurrency')).toBe('USD');
    expect(out.get('historyKnownAt')).toBe('2026-07-01T00:00:00Z');
    expect(out.get('historyCohort')).toBe('historical');
    expect(out.get('investmentList')).toBe('positions');
    for (const key of [
      'historyOffset',
      'historyVersions',
      'historyEntity',
      'historyComparison',
      'observation',
    ])
      expect(out.has(key)).toBe(false);
  });
  it('follows a portfolio cell into the investment at the same date', () => {
    const out = new URLSearchParams();
    copyHistoryNavigation(
      source,
      out,
      { view: 'portfolio', holding: null, family: 'all' },
      { view: 'investments', holding: 'b', family: 'all' },
    );
    expect(out.get('historyAsOf')).toBe('2026-06-30');
    expect(out.has('observation')).toBe(false);
  });
  it('keeps same-position state and clears history on unrelated navigation', () => {
    const before = { view: 'investments', holding: 'a', family: 'all' };
    const same = new URLSearchParams();
    copyHistoryNavigation(source, same, before, before);
    expect(Object.fromEntries(same)).toEqual(Object.fromEntries(source));
    const other = new URLSearchParams();
    copyHistoryNavigation(source, other, before, {
      view: 'risk',
      holding: null,
      family: 'all',
    });
    expect(other.size).toBe(0);
  });
});
