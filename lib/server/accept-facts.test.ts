import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { holdings, families, entities, accounts } from '@/data';
import { initialWorkspace, type WorkspaceState } from '../workspace';
import type { Extraction } from '../processing-contract';
import type { WorkspaceContext } from './access';

const fixtures = vi.hoisted(() => ({
  state: {} as WorkspaceState,
  fingerprints: new Map<string, string>(),
  save: vi.fn(),
}));
vi.mock('./access', () => ({
  AccessError: class extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../workspace-store', () => ({
  readWorkspaceInTransaction: async () => ({
    state: fixtures.state,
    revision: 1,
  }),
  saveWorkspace: fixtures.save,
}));
import { acceptFacts } from './accept-facts';
const ctx = {
  organizationId: 'synthetic-org',
  user: { id: 'synthetic-reviewer', name: 'Synthetic reviewer' },
  role: 'analyst',
} as WorkspaceContext;
const job = {
  id: 'synthetic-job',
  document_id: 'synthetic-document',
  filename: 'synthetic-statement.pdf',
};
const extraction: Extraction = {
  schemaVersion: 1,
  documentId: '00000000-0000-4000-8000-000000000012',
  mode: 'workflow',
  execution: 'local',
  documentType: 'statement',
  relevant: true,
  confidence: 0.8,
  warnings: [],
  trace: [],
  model: null,
  facts: [
    {
      kind: 'valuation',
      investmentName: 'Synthetic fund',
      effectiveDate: '2026-06-30',
      dueDate: null,
      amount: '100.00',
      currency: 'EUR',
      summary: 'Synthetic fixture',
      evidence: { page: 1, quote: 'NAV EUR 100.00' },
    },
  ],
};
const client = {
  query: async (sql: string, values: unknown[]) => {
    if (sql.startsWith('SELECT r.mailbox_id'))
      return {
        rows: [
          {
            mailbox_id: 'synthetic-mailbox',
            created_at: '2026-05-01T08:00:00Z',
          },
        ],
      };
    if (sql.startsWith('INSERT INTO app_accepted_facts')) {
      const key = values[0] as string;
      if (fixtures.fingerprints.has(key)) return { rowCount: 0, rows: [] };
      fixtures.fingerprints.set(key, values[3] as string);
      return { rowCount: 1, rows: [{ fingerprint: key }] };
    }
    if (sql.startsWith('SELECT source_id'))
      return {
        rows: [{ source_id: fixtures.fingerprints.get(values[1] as string) }],
      };
    throw new Error('Unexpected SQL: ' + sql);
  },
} as unknown as PoolClient;
async function run(
  result: Extraction,
  selections: Parameters<typeof acceptFacts>[4] = [
    { factIndex: 0, holdingId: holdings[0].id },
  ],
) {
  const previous = new Map(fixtures.fingerprints);
  try {
    return await acceptFacts(client, ctx, job, result, selections);
  } catch (error) {
    fixtures.fingerprints = previous;
    throw error;
  }
}
describe('reviewed financial fact posting', () => {
  beforeEach(() => {
    fixtures.fingerprints.clear();
    fixtures.save.mockReset();
    fixtures.save.mockImplementation(async (_c, _org, state) => {
      fixtures.state = state;
    });
    const holding = {
      ...holdings[0],
      currency: 'EUR' as const,
      valueEUR: 90,
      originalValue: 90,
      syntheticFXRateToEUR: 1,
      valuationDate: '2026-03-31',
      valuationMethod: 'Reported market mark' as const,
    };
    fixtures.state = {
      ...initialWorkspace(false),
      portfolio: {
        holdings: [holding],
        history: [
          {
            holdingId: holding.id,
            date: '2026-03-31',
            valueEUR: 90,
            netExternalFlowEUR: 0,
            valuationBasis: 'Reported mark',
          },
        ],
        events: [],
        evidence: [],
        tasks: [],
        families: structuredClone(families),
        entities: structuredClone(entities),
        accounts: structuredClone(accounts),
      },
    };
  });
  it('posts only selected facts and deduplicates a safe replay without a new valuation', async () => {
    const result = {
      ...extraction,
      facts: [
        ...extraction.facts,
        {
          ...extraction.facts[0],
          kind: 'capital_call' as const,
          amount: '25.00',
        },
      ],
    };
    expect((await run(result)).applied).toBe(1);
    expect(fixtures.state.portfolio?.tasks).toHaveLength(0);
    expect(fixtures.state.finance?.valuations).toHaveLength(1);
    expect((await run(result)).duplicates).toBe(1);
    expect(fixtures.state.finance?.valuations).toHaveLength(1);
  });
  it('preserves source currency, exact sourced FX, effective date and valuation basis', async () => {
    const result = {
      ...extraction,
      facts: [{ ...extraction.facts[0], currency: 'USD' }],
    };
    await run(result, [
      {
        factIndex: 0,
        holdingId: holdings[0].id,
        fx: {
          rateToEUR: '0.91',
          date: '2026-06-30',
          source: 'Synthetic dated FX statement',
        },
      },
    ]);
    expect(fixtures.state.portfolio?.holdings[0]).toMatchObject({
      valueEUR: 91,
      originalValue: 100,
      currency: 'USD',
      valuationDate: '2026-06-30',
      valuationMethod: 'Reported market mark',
    });
    expect(fixtures.state.finance?.valuations[0]).toMatchObject({
      amount: '100.00',
      currency: 'USD',
      valueEUR: 91,
      fx: { source: 'Synthetic dated FX statement' },
    });
    expect(fixtures.state.portfolio?.events[0]).toMatchObject({
      amountEUR: 91,
      reportedAmount: '100.00',
      reportedCurrency: 'USD',
    });
  });
  it('requires dated FX and never silently applies an unsupported native-currency mark', async () => {
    await expect(
      run({
        ...extraction,
        facts: [{ ...extraction.facts[0], currency: 'USD' }],
      }),
    ).rejects.toMatchObject({ code: 'VALUATION_INCOMPLETE' });
    expect(fixtures.save).not.toHaveBeenCalled();
    await expect(
      run(
        { ...extraction, facts: [{ ...extraction.facts[0], currency: 'USD' }] },
        [
          {
            factIndex: 0,
            holdingId: holdings[0].id,
            fx: {
              rateToEUR: '0.91',
              date: '2026-07-01',
              source: 'Synthetic future FX',
            },
          },
        ],
      ),
    ).rejects.toMatchObject({ code: 'FX_DATE_INVALID' });
    expect(fixtures.save).not.toHaveBeenCalled();
  });
  it('requires explicit same-date correction and retains the previous valuation version', async () => {
    await run(extraction);
    const corrected = {
      ...extraction,
      facts: [{ ...extraction.facts[0], amount: '120.00' }],
    };
    await expect(run(corrected)).rejects.toMatchObject({
      code: 'CORRECTION_REQUIRED',
    });
    expect(fixtures.state.portfolio?.holdings[0].valueEUR).toBe(100);
    await run(corrected, [
      {
        factIndex: 0,
        holdingId: holdings[0].id,
        correction: {
          expectedValueEUR: 100,
          reason: 'Corrected source statement',
        },
        reviewRevision: 2,
      },
    ]);
    expect(
      fixtures.state.finance?.valuations.map((value) => value.valueEUR),
    ).toEqual([100, 120]);
    expect(fixtures.state.finance?.valuations[1]).toMatchObject({
      supersededValueEUR: 100,
      correctionReason: 'Corrected source statement',
    });
    await expect(run(extraction)).rejects.toMatchObject({
      code: 'CORRECTION_REQUIRES_REVIEW',
    });
    expect(fixtures.state.portfolio?.holdings[0].valueEUR).toBe(120);
  });
  it('blocks stale correction expectations and holdings outside the tenant portfolio', async () => {
    await run(extraction);
    await expect(
      run(
        {
          ...extraction,
          facts: [{ ...extraction.facts[0], amount: '120.00' }],
        },
        [
          {
            factIndex: 0,
            holdingId: holdings[0].id,
            correction: {
              expectedValueEUR: 90,
              reason: 'Stale reviewer expectation',
            },
            reviewRevision: 2,
          },
        ],
      ),
    ).rejects.toMatchObject({ code: 'CORRECTION_REQUIRED' });
    await expect(
      run(extraction, [{ factIndex: 0, holdingId: 'foreign-holding' }]),
    ).rejects.toMatchObject({ code: 'HOLDING_REQUIRED' });
    expect(fixtures.state.portfolio?.holdings[0].valueEUR).toBe(100);
  });
  it('preserves undated notice provenance without treating receipt date as source-reported', async () => {
    await run({
      ...extraction,
      facts: [
        {
          ...extraction.facts[0],
          kind: 'capital_call',
          effectiveDate: null,
          currency: 'USD',
          amount: '25.00',
        },
      ],
    });
    expect(fixtures.state.portfolio?.evidence[0]).toMatchObject({
      mailboxId: 'synthetic-mailbox',
      effectiveDate: '2026-05-01',
      reportedEffectiveDate: null,
      effectiveDateBasis: 'Receipt date fallback',
    });
    expect(fixtures.state.portfolio?.events[0]).toMatchObject({
      date: '2026-05-01',
      dateBasis: 'Receipt date fallback',
      reportedCurrency: 'USD',
      reportedAmount: '25.00',
      financialEffect: 'None',
    });
    expect(fixtures.state.portfolio?.holdings[0].valueEUR).toBe(90);
    expect(fixtures.state.portfolio?.tasks).toHaveLength(1);
  });
});
