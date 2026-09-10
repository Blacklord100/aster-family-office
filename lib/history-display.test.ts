import { describe, expect, it } from 'vitest';
import { historyAmount, csvCell, portfolioHistoryCSV } from './history-display';
import { projectPortfolioHistory } from './portfolio-history';
import { deriveWorkspace, initialWorkspace } from './workspace';
describe('history exports and precise display', () => {
  it('retains decimal digits and identifies unavailable values', () => {
    expect(historyAmount('1000000000000.01')).toBe('€1,000,000,000,000.01');
    expect(historyAmount('-12.30', 'GBP')).toBe('−£12.30');
    expect(historyAmount(null)).toBe('Unavailable');
  });
  it('quotes cells and neutralizes spreadsheet formulas in imported names', () => {
    expect(csvCell('=HYPERLINK("example")')).toBe(
      '"\'=HYPERLINK(""example"")"',
    );
    expect(csvCell('Q1, Q2')).toBe('"Q1, Q2"');
  });
  it('pins scope, valuation basis and revision in the exported projection', () => {
    const result = projectPortfolioHistory(
      deriveWorkspace(initialWorkspace(false)),
      undefined,
      { currency: 'EUR' },
      { revision: 42, now: '2026-09-10T12:00:00Z' },
    );
    const csv = portfolioHistoryCSV(result);
    expect(csv).toContain('"Workspace revision","42"');
    expect(csv).toContain(result.basis);
    expect(csv).toContain('"Source ID","Source file","Observation ID"');
    expect(csv).toContain('"Holdings valued","Holdings in scope"');
  });
});
