import { describe, expect, it } from 'vitest';
import { AS_OF_DATE, holdings } from '../../../data/portfolio';
import { timelineEvents } from '../../../data/activity';
import {
  DEMO_STAGES,
  advanceDemoRun,
  cancelDemoRun,
  completeDemoRun,
  startDemoRun,
} from '../engine';
import { createWorkspaceDemoScenario } from '../fixture-adapter';
import type {
  CapitalCallProposal,
  DemoEngineState,
  StatementRevisionProposal,
} from '../types';

const data = { asOfDate: AS_OF_DATE, holdings, timelineEvents };
const now = '2026-09-07T10:00:00.000Z';
const at = (seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString();
const economic = (state: DemoEngineState) => ({
  cash: state.cashBalances,
  obligations: state.obligations,
  valuations: state.valuationVersions,
  timeline: state.timeline,
  applied: state.appliedProposalKeys,
});

describe('explicitly simulated pipeline', () => {
  it('publishes one expected obligation from three mailbox copies and retains each copy', () => {
    const fixture = createWorkspaceDemoScenario(data);
    const result = completeDemoRun(fixture.state, {
      runId: 'run-a',
      now,
      proposals: fixture.proposals,
    });
    expect(result.mode).toBe('simulation');
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0]).toMatchObject({
      businessEventId: 'event-01',
      amountMinor: 42_000_000,
      status: 'expected',
    });
    expect(result.obligations[0].mailboxCopyIds).toHaveLength(3);
    expect(result.obligations[0].evidenceCitationIds).toEqual([
      'source-event-01',
    ]);
    expect(result.runs[0]).toMatchObject({
      status: 'completed',
      inputCopyCount: 5,
      uniqueEventCount: 3,
      publishedEventCount: 3,
    });
    expect(result.runs[0].stages.map((stage) => stage.id)).toEqual(
      DEMO_STAGES.map((stage) => stage.id),
    );
    expect(
      result.runs[0].stages.every((stage) => stage.status === 'completed'),
    ).toBe(true);
  });

  it('keeps financial and timeline publication until the final stage; cancellation publishes nothing', () => {
    const fixture = createWorkspaceDemoScenario(data);
    let state = startDemoRun(fixture.state, {
      runId: 'cancelled',
      now,
      proposals: fixture.proposals,
    });
    for (let index = 1; index <= 4; index += 1)
      state = advanceDemoRun(state, { runId: 'cancelled', now: at(index) });
    expect(state.runs[0].currentStage).toBe('timeline_commit');
    expect(economic(state)).toEqual(economic(fixture.state));
    state = cancelDemoRun(state, { runId: 'cancelled', now: at(5) });
    expect(state.runs[0].status).toBe('cancelled');
    expect(advanceDemoRun(state, { runId: 'cancelled', now: at(6) })).toBe(
      state,
    );
    expect(economic(state)).toEqual(economic(fixture.state));
  });

  it('retains the original valuation and its date when accepting a correction', () => {
    const fixture = createWorkspaceDemoScenario(data);
    const before = structuredClone(fixture.state);
    const state = completeDemoRun(fixture.state, {
      runId: 'correction',
      now,
      proposals: fixture.proposals,
    });
    expect(fixture.state).toEqual(before);
    expect(state.valuationVersions).toHaveLength(2);
    expect(state.valuationVersions[0]).toMatchObject({
      revision: 1,
      valueMinor: 960_000_000,
      status: 'superseded',
      valuationDate: '2026-06-30',
    });
    expect(state.valuationVersions[1]).toMatchObject({
      revision: 2,
      valueMinor: 972_000_000,
      status: 'active',
      valuationDate: '2026-06-30',
      recordedAt: at(5),
      supersedesId: state.valuationVersions[0].id,
    });
    expect(
      state.timeline
        .filter((item) => item.businessEventId === 'northstar-nav-2026-06-30')
        .map((item) => item.status),
    ).toEqual(['superseded', 'active']);
  });

  it('does not manufacture settled cash from notices, newsletters, or valuation corrections', () => {
    const fixture = createWorkspaceDemoScenario(data);
    const state = completeDemoRun(fixture.state, {
      runId: 'cash',
      now,
      proposals: fixture.proposals,
    });
    expect(state.cashBalances).toEqual(fixture.state.cashBalances);
    expect(
      state.timeline.find((item) => item.kind === 'newsletter')?.summary,
    ).toContain('holdings and cash are unchanged');
    expect(state.obligations.every((item) => item.status === 'expected')).toBe(
      true,
    );
  });

  it('replays idempotently, including overlapping active runs', () => {
    const fixture = createWorkspaceDemoScenario(data);
    let state = startDemoRun(fixture.state, {
      runId: 'a',
      now,
      proposals: fixture.proposals,
    });
    state = startDemoRun(state, {
      runId: 'b',
      now,
      proposals: fixture.proposals,
    });
    for (let index = 1; index <= 5; index += 1)
      state = advanceDemoRun(state, { runId: 'a', now: at(index) });
    const firstEconomic = structuredClone(economic(state));
    for (let index = 1; index <= 5; index += 1)
      state = advanceDemoRun(state, { runId: 'b', now: at(index + 10) });
    expect(economic(state)).toEqual(firstEconomic);
    expect(state.runs[1]).toMatchObject({
      publishedEventCount: 0,
      replayedEventCount: 3,
    });
    expect(
      startDemoRun(state, {
        runId: 'a',
        now: at(20),
        proposals: fixture.proposals,
      }),
    ).toBe(state);
  });

  it('blocks conflicting copies instead of choosing one amount', () => {
    const fixture = createWorkspaceDemoScenario(data);
    const conflict: CapitalCallProposal = {
      ...(fixture.proposals[0] as CapitalCallProposal),
      id: 'bad-copy',
      amountMinor: 99_000_000,
    };
    const state = completeDemoRun(fixture.state, {
      runId: 'conflict',
      now,
      proposals: [...fixture.proposals, conflict],
    });
    expect(state.obligations).toHaveLength(0);
    expect(
      state.runs[0].issues.some((issue) =>
        issue.message.includes('Conflicting copies'),
      ),
    ).toBe(true);
  });

  it('rejects a correction that silently changes account ownership or valuation date', () => {
    const fixture = createWorkspaceDemoScenario(data);
    const correction = fixture.proposals.find(
      (proposal) => proposal.kind === 'statement_revision',
    ) as StatementRevisionProposal;
    const state = completeDemoRun(fixture.state, {
      runId: 'bad-correction',
      now,
      proposals: [{ ...correction, valuationDate: '2026-09-07' }],
    });
    expect(state.valuationVersions).toEqual(fixture.state.valuationVersions);
    expect(
      state.runs[0].issues.some((issue) =>
        issue.message.includes('preserve the same'),
      ),
    ).toBe(true);
  });

  it('cannot revise published content in place under the same business revision', () => {
    const fixture = createWorkspaceDemoScenario(data);
    const first = completeDemoRun(fixture.state, {
      runId: 'original',
      now,
      proposals: fixture.proposals,
    });
    const changed = fixture.proposals.map((proposal) =>
      proposal.kind === 'capital_call'
        ? { ...proposal, amountMinor: 99_000_000 }
        : proposal,
    );
    const second = completeDemoRun(first, {
      runId: 'changed',
      now: at(20),
      proposals: changed,
    });
    expect(second.obligations).toEqual(first.obligations);
    expect(
      second.runs[1].issues.some((issue) =>
        issue.message.includes('different content'),
      ),
    ).toBe(true);
  });

  it('is deterministic for the same input and refuses a backwards clock', () => {
    const fixture = createWorkspaceDemoScenario(data);
    const input = { runId: 'deterministic', now, proposals: fixture.proposals };
    expect(completeDemoRun(fixture.state, input)).toEqual(
      completeDemoRun(fixture.state, input),
    );
    const state = startDemoRun(fixture.state, input);
    expect(() =>
      advanceDemoRun(state, { runId: input.runId, now: at(-1) }),
    ).toThrow('backwards');
  });
});
