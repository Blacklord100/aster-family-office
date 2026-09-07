import { describe, expect, it } from 'vitest';
import { AS_OF_DATE, holdings } from '../../../data/portfolio';
import { evidenceSources, timelineEvents } from '../../../data/activity';
import { completeDemoRun } from '../engine';
import {
  answerWorkspaceQuestion,
  buildDemoQueryData,
  createWorkspaceDemoScenario,
} from '../fixture-adapter';
import { answerDemoQuestion, resolveDemoIntent } from '../queries';

const data = { asOfDate: AS_OF_DATE, holdings, timelineEvents };

describe('grounded synthetic query answers', () => {
  it('computes allocation from actual fixture values and retains citations', () => {
    const result = answerWorkspaceQuestion(
      'What is our asset allocation?',
      data,
    );
    expect(result.intent).toBe('allocation');
    expect(result.answer).toContain('128,000,000');
    expect(
      result.facts.find((fact) => fact.label === 'Public equities')?.value,
    ).toContain('42,000,000');
    expect(result.evidenceCitationIds).toHaveLength(holdings.length);
    expect(result.notice).toContain('No LLM');
  });

  it('answers liquidity from cash and one call, excluding the expected distribution', () => {
    const result = answerWorkspaceQuestion(
      'How much cash covers upcoming capital calls?',
      data,
    );
    expect(result.intent).toBe('liquidity');
    expect(result.answer).toContain('10,100,000');
    expect(result.answer).toContain('420,000');
    expect(result.answer).toContain('9,680,000');
    expect(result.evidenceCitationIds).toContain('source-event-01');
    expect(result.evidenceCitationIds).not.toContain('source-event-03');
    expect(result.answer).toContain('expected distributions are excluded');
  });

  it('can scope a question to a named family or the current UI family', () => {
    const result = answerWorkspaceQuestion(
      'How much cash does Laurent have?',
      data,
    );
    expect(result.answer).toContain('4,500,000');
    expect(result.answer).toContain('4,080,000');
    expect(result.evidenceCitationIds).not.toContain('source-seb-cash');
    const selected = answerWorkspaceQuestion(
      'What are unfunded commitments?',
      data,
      undefined,
      'bergstrom',
    );
    expect(selected.answer).toContain('4,400,000');
  });

  it('does not reduce unfunded commitment after a notice or duplicate copies', () => {
    const scenario = createWorkspaceDemoScenario(data);
    const state = completeDemoRun(scenario.state, {
      runId: 'run',
      now: '2026-09-07T10:00:00Z',
      proposals: scenario.proposals,
    });
    const result = answerWorkspaceQuestion(
      'What are our unfunded commitments?',
      data,
      state,
    );
    expect(result.answer).toContain('14,000,000');
    expect(buildDemoQueryData(data, state).obligations).toHaveLength(1);
  });

  it('uses the accepted revised value and its new source citation', () => {
    const scenario = createWorkspaceDemoScenario(data);
    const state = completeDemoRun(scenario.state, {
      runId: 'run',
      now: '2026-09-07T10:00:00Z',
      proposals: scenario.proposals,
    });
    const result = answerWorkspaceQuestion(
      'What is our asset allocation?',
      data,
      state,
    );
    expect(result.answer).toContain('128,120,000');
    expect(result.evidenceCitationIds).toContain(
      'source-demo-northstar-revision',
    );
    const knownIds = new Set(
      [...evidenceSources, ...scenario.evidenceSources].map(
        (source) => source.id,
      ),
    );
    expect(result.evidenceCitationIds.every((id) => knownIds.has(id))).toBe(
      true,
    );
    const latest = answerWorkspaceQuestion('latest updates', data, state);
    expect(latest.answer).toContain('effective 2026-06-30');
    expect(latest.evidenceCitationIds).toContain(
      'source-demo-northstar-revision',
    );
  });

  it('returns source text for updates and honestly bounds unsupported queries', () => {
    const result = answerWorkspaceQuestion(
      'What are the latest updates?',
      data,
    );
    expect(result.intent).toBe('latest_updates');
    expect(result.answer).toContain('Northstar III calls');
    expect(result.evidenceCitationIds).toContain('source-event-01');
    const unsupported = answerWorkspaceQuestion(
      'What should I buy tomorrow?',
      data,
    );
    expect(unsupported.intent).toBe('unsupported');
    expect(unsupported.evidenceCitationIds).toEqual([]);
    expect(unsupported.answer).toContain('does not use an LLM');
    expect(resolveDemoIntent('Any upcoming capital calls?')).toBe('liquidity');
    expect(resolveDemoIntent('Which portfolio assets should I buy?')).toBe(
      'unsupported',
    );
    expect(resolveDemoIntent('What is the portfolio performance?')).toBe(
      'unsupported',
    );
  });

  it('does not turn missing data into zero or sum different obligation currencies', () => {
    const query = buildDemoQueryData(data);
    expect(
      answerDemoQuestion('allocation', { ...query, holdings: [] }).answer,
    ).toContain('No holdings');
    const result = answerDemoQuestion('cash', {
      ...query,
      obligations: [
        ...query.obligations,
        {
          id: 'usd',
          name: 'USD call',
          amountMinor: 10_000_000,
          currency: 'USD',
          dueDate: '2026-09-10',
          status: 'expected',
          evidenceCitationIds: ['usd-evidence'],
        },
      ],
    });
    expect(result.answer).toContain('9,680,000');
    expect(result.answer).toContain('other currencies are excluded');
  });
});
