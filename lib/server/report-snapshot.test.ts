import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { holdings } from '../../data/portfolio';
import { reportValue } from '../report-value';
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
    expect(printed).toContain('<span>Known portfolio subtotal</span><strong>€100</strong>');
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
