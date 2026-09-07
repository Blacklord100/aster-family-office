import { describe, it, expect } from 'vitest';
import { initialWorkspace, deriveWorkspace, scenario } from './workspace';
import { completeDemoRun, startDemoRun, cancelDemoRun } from './demo-engine';
describe('workspace integration', () => {
  it('restates the effective valuation period while preserving cash, commitments and prior dates', () => {
    const before = initialWorkspace(),
      base = deriveWorkspace(before);
    const engine = completeDemoRun(before.engine, {
      runId: 'integration',
      now: '2026-09-07T10:00:00Z',
      proposals: scenario.proposals,
    });
    const after = deriveWorkspace({ ...before, engine });
    const holding = after.holdings.find((h) => h.name.includes('Northstar'))!;
    expect(after.metrics.totalValueEUR).toBe(128120000);
    expect(after.metrics.cashEUR).toBe(base.metrics.cashEUR);
    expect(after.metrics.unfundedCommitmentEUR).toBe(
      base.metrics.unfundedCommitmentEUR,
    );
    for (const date of ['2026-06-29', '2026-06-30', '2026-09-07']) {
      const value = after.history.find(
        (r) => r.holdingId === holding.id && r.date === date,
      )!.valueEUR;
      const prior = base.history.find(
        (r) => r.holdingId === holding.id && r.date === date,
      )!.valueEUR;
      expect(Math.round(value - prior)).toBe(date < '2026-06-30' ? 0 : 120000);
    }
    expect(after.events.filter((e) => e.id === 'event-01')).toHaveLength(1);
    expect(
      after.evidence.find((e) => e.id === 'source-demo-northstar-revision')!
        .status,
    ).toBe('Accepted');
  });
  it('keeps correction evidence pending before completion and after cancellation', () => {
    const before = initialWorkspace();
    expect(
      deriveWorkspace(before).evidence.find(
        (e) => e.id === 'source-demo-northstar-revision',
      )!.status,
    ).toBe('Needs review');
    const run = startDemoRun(before.engine, {
      runId: 'cancel',
      now: '2026-09-07T10:00:00Z',
      proposals: scenario.proposals,
    });
    const engine = cancelDemoRun(run, {
      runId: 'cancel',
      now: '2026-09-07T10:00:01Z',
    });
    const after = deriveWorkspace({ ...before, engine });
    expect(after.metrics.totalValueEUR).toBe(128000000);
    expect(
      after.evidence.find((e) => e.id === 'source-demo-northstar-revision')!
        .status,
    ).toBe('Needs review');
  });
});
