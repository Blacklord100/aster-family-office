import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { holdings } from '../../data/portfolio';
import { reportValue } from '../report-value';
import { emptyHistoryLifecycle } from '../portfolio-history-lifecycle-contract';
import { historyPositionDetails } from '../portfolio-history-lifecycle';
import {
  initialWorkspace,
  deriveWorkspace,
  type WorkspaceState,
  type SavedReport,
} from '../workspace';
const mocked = vi.hoisted(() => ({
  workspace: vi.fn(),
  change: vi.fn(),
  useWorkspace: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./auth', () => ({
  authEnvironment: () => ({ origin: 'https://aster.example.com' }),
}));
vi.mock('./access', async (original) => ({
  ...(await original<typeof import('./access')>()),
  requireWorkspace: mocked.workspace,
}));
vi.mock('../workspace-store', () => ({
  changeWorkspace: mocked.change,
  readWorkspace: vi.fn(),
}));
vi.mock('../../components/aster/workspace-context', () => ({
  useWorkspace: mocked.useWorkspace,
}));
vi.mock('../../components/aster/charts', () => ({
  ValueChart: () => null,
  makeHistory: () => [],
}));
import { POST } from '../../app/api/workspace/route';
import { ReportsView, PrintableReport } from '../../components/aster/reports';
import { StressSummary } from '../../components/aster/reporting-workbench';
import {
  buildTotalExposure,
  RISK_PRESETS,
  runStressScenario,
} from '../risk-engine';
const known = {
  ...holdings[0],
  id: 'known',
  valueEUR: 100,
  valuationDate: '2026-08-01',
};
const unknown = {
  ...known,
  id: 'unknown',
  valueEUR: 999_900,
  valuationStatus: 'unknown' as const,
  valuationDate: '',
};
let state: WorkspaceState;
beforeEach(() => {
  state = initialWorkspace(false);
  state.portfolio = {
    holdings: [known, unknown],
    history: [],
    events: [],
    tasks: [],
    evidence: [],
    families: [],
    entities: [],
    accounts: [],
  };
  mocked.workspace.mockResolvedValue({
    organizationId: '11111111-1111-4111-8111-111111111111',
    user: { id: 'owner' },
    role: 'owner',
  });
  mocked.change.mockImplementation(async (_context, update) => {
    state = structuredClone(update(state));
    return state;
  });
  mocked.useWorkspace.mockImplementation(() => ({
    state,
    data: deriveWorkspace(state),
    mutate: vi.fn(),
  }));
});
async function save() {
  return POST(
    new Request('https://aster.example.com/api/workspace', {
      method: 'POST',
      headers: {
        origin: 'https://aster.example.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'report',
        family: 'all',
        range: 'YTD',
        name: 'Source report',
      }),
    }),
  );
}
describe('source-derived report snapshots', () => {
  it('renders missing stress values as unavailable and partial values as known subtotals', () => {
    const scenario = RISK_PRESETS[0],
      empty = renderToStaticMarkup(
        createElement(StressSummary, {
          result: runStressScenario(buildTotalExposure([unknown]), scenario),
          inputs: {
            holdings: [unknown],
            ownershipBasis: {
              asOfDate: '2026-09-10',
              excludedCount: 1,
              unknownOwnershipCount: 1,
            },
          },
        }),
      );
    expect(empty).toContain('0 of 1 positions valued');
    expect(empty).toContain('Not reported');
    expect(empty).toContain('Unavailable');
    expect(empty).not.toContain('class="metric-value">€0');
    const partial = renderToStaticMarkup(
      createElement(StressSummary, {
        result: runStressScenario(
          buildTotalExposure([known, unknown]),
          scenario,
        ),
        inputs: { holdings: [known, unknown] },
      }),
    );
    expect(partial).toContain('Before scenario · known subtotal');
    expect(partial).toContain('1 of 2 positions valued');
    expect(partial).toContain('Original saved register cohort');
    expect(partial).not.toContain('999,900');
  });
  it('excludes sourced exits from live and newly saved reports without reinterpreting older snapshots', async () => {
    const closed = {
      ...known,
      id: 'closed',
      name: 'Exited position',
      valueEUR: 800,
    };
    state.portfolio!.holdings.push(closed);
    state.historyLifecycle = emptyHistoryLifecycle();
    state.historyLifecycle.records.push({
      id: 'exit',
      holdingId: closed.id,
      kind: 'closed',
      effectiveDate: '2020-01-01',
      recordedAt: '2020-01-01T12:00:00Z',
      actorId: 'reviewer',
      registeredDetails: historyPositionDetails(closed),
      details: null,
      sourceId: closed.sourceId,
      documentId: 'exit-document',
      sourceSha256: 'a'.repeat(64),
      page: 1,
      quote: 'Position was fully exited.',
      reason: 'Synthetic report regression.',
      correctionOf: null,
    });
    const original: SavedReport = {
      id: 'old',
      name: 'Original register snapshot',
      family: 'all',
      range: 'YTD',
      synthetic: false,
      createdAt: '2019-12-01T12:00:00Z',
      holdingCount: 1,
      totalValueEUR: 800,
      holdings: [closed],
      history: [],
    };
    const live = renderToStaticMarkup(
      createElement(PrintableReport, { family: 'all', saved: null }),
    );
    expect(live).not.toContain('Exited position');
    expect(live).toContain('1 sourced exits or future acquisitions excluded');
    expect(live).toContain('2 positions retain unknown ownership dates');
    const old = renderToStaticMarkup(
      createElement(PrintableReport, { family: 'all', saved: original }),
    );
    expect(old).toContain('Exited position');
    expect(old).toContain('€800');
    expect(old).toContain('Original saved register cohort');
    await save();
    expect(state.reports[0].holdings.map((holding) => holding.id)).toEqual([
      'known',
      'unknown',
    ]);
    expect(state.reports[0].totalValueEUR).toBe(100);
    expect(state.reports[0].ownershipBasis).toMatchObject({
      excludedCount: 1,
      unknownOwnershipCount: 2,
    });
    expect(original.holdings).toEqual([closed]);
  });
  it('persists a known subtotal and explicit coverage, preserving the original holding flags', async () => {
    const response = await save();
    expect(response.status).toBe(200);
    const snapshot = (await response.json()).reports[0];
    expect(snapshot).toMatchObject({
      totalValueEUR: 100,
      valuationCoverage: {
        knownCount: 1,
        unknownCount: 1,
        totalCount: 2,
        complete: false,
      },
    });
    expect(snapshot.holdings[1]).toMatchObject({
      valueEUR: 999_900,
      valuationStatus: 'unknown',
    });
  });
  it('persists null when no valuation is known and preserves a reported zero', async () => {
    state.portfolio!.holdings = [unknown];
    await save();
    expect(state.reports[0].totalValueEUR).toBeNull();
    expect(reportValue([unknown])).toMatchObject({
      valueEUR: null,
      label: 'Valuation not reported',
      asOfDate: null,
    });
    expect(reportValue([{ ...known, valueEUR: 0 }])).toMatchObject({
      valueEUR: 0,
      label: 'Reported portfolio value',
      coverage: { complete: true },
    });
    expect(reportValue([])).toMatchObject({
      valueEUR: null,
      label: 'No recorded holdings',
    });
  });
  it('renders saved legacy totals and printed allocations from their own known records with clear labels', () => {
    const snapshot: SavedReport = {
      id: 'snapshot',
      name: 'Original saved records',
      family: 'all',
      range: 'YTD',
      synthetic: false,
      createdAt: '2026-09-09T12:00:00Z',
      holdingCount: 2,
      totalValueEUR: 1_000_000,
      holdings: [known, unknown],
      history: [],
    };
    state.reports = [snapshot];
    // Live values may change; the saved report must retain its own records.
    state.portfolio!.holdings = [{ ...known, valueEUR: 700 }];
    const list = renderToStaticMarkup(
      createElement(ReportsView, {
        family: 'all',
        onFamily: () => {},
        onPreview: () => {},
      }),
    );
    const savedList = list.slice(list.indexOf('saved-report-list'));
    expect(savedList).toContain('Known portfolio subtotal');
    expect(savedList).toContain('€100');
    expect(savedList).not.toContain('€1,000,000');
    const printed = renderToStaticMarkup(
      createElement(PrintableReport, { family: 'all', saved: snapshot }),
    );
    expect(printed).toContain('Known portfolio subtotal');
    expect(printed).toContain(
      '<span>Known portfolio subtotal</span><strong>€100</strong>',
    );
    expect(printed).not.toContain('999,900');
    expect(printed).not.toContain('1,000,000');
    expect(printed).not.toContain('NaN');
    snapshot.holdings = [unknown];
    const unavailable = renderToStaticMarkup(
      createElement(ReportsView, {
        family: 'all',
        onFamily: () => {},
        onPreview: () => {},
      }),
    );
    expect(
      unavailable.slice(unavailable.indexOf('saved-report-list')),
    ).toContain('Valuation not reported');
    expect(
      unavailable.slice(unavailable.indexOf('saved-report-list')),
    ).not.toContain('€0');
  });
});
