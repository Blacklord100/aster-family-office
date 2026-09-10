import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EvidenceSource, Holding, TimelineEvent } from '@/data';
import { activityDate, orderActivity } from './activity-order';
import { historyCsv, historyMoney } from './history-presentation';
import { projectPortfolioHistory } from './portfolio-history';
import { emptyFinanceState } from './ledger-contract';
import {
  InvestmentHistory,
  HistoryValueChart,
} from '../components/aster/investment-history';
import { lifecycleSources } from '../components/aster/history-lifecycle';
import { TimelineList } from '../components/aster/timeline';

vi.mock('../components/aster/workspace-context', () => ({
  useWorkspace: () => ({
    state: { sampleData: false },
    data: { families: [], evidence: [{ id: 'source' }], holdings: [] },
    revision: 4,
  }),
}));

const holding: Holding = {
  id: 'holding',
  name: 'Source-backed fund',
  familyId: 'family',
  entityId: 'entity',
  accountId: 'account',
  manager: 'Manager',
  assetClass: 'Private equity',
  currency: 'EUR',
  valueEUR: 105,
  originalValue: 105,
  syntheticFXRateToEUR: 1,
  costBasisEUR: 0,
  costBasisStatus: 'unknown',
  unfundedCommitmentEUR: 0,
  unfundedStatus: 'unknown',
  liquidityBucket: '3+ years',
  liquidityStatus: 'unknown',
  valuationDate: '2026-06-30',
  sourceId: 'source',
  geography: '',
  description: '',
  color: '',
  valuationMethod: 'Reported fund NAV',
};
const source: EvidenceSource = {
  id: 'source',
  holdingId: holding.id,
  familyId: holding.familyId,
  subject: 'Quarterly NAV',
  sender: 'Manager',
  mailboxId: 'upload',
  filename: 'Statement.pdf',
  documentId: '00000000-0000-4000-8000-000000000001',
  receivedAt: '2026-09-10T10:00:00Z',
  effectiveDate: '2026-06-30',
  page: 1,
  excerpt: 'Source-backed reported position value.',
  synthetic: false,
  status: 'Accepted',
};
function event(
  id: string,
  date: string,
  receivedAt: string,
  fallback = false,
): TimelineEvent {
  return {
    id,
    date,
    receivedAt,
    dateBasis: fallback ? 'Receipt date fallback' : 'Source reported',
    familyId: 'family',
    holdingIds: ['holding'],
    entityId: 'entity',
    sourceId: 'source',
    title: id,
    summary: 'Retained development',
    type: 'Valuation',
    status: 'Accepted',
    materiality: 'Medium',
    financialEffect: 'Accepted valuation',
  };
}
function projection(count = 1) {
  const finance = emptyFinanceState();
  for (let day = 1; day <= count; day++)
    finance.valuations.push({
      id: 'observation-' + day,
      holdingId: holding.id,
      amount: '105.01',
      currency: 'EUR',
      valueEUR: 105.01,
      effectiveDate: '2026-06-' + String(day).padStart(2, '0'),
      sourceId: source.id,
      actorId: 'reviewer',
      recordedAt: '2026-09-10T10:00:00Z',
      valuationMethod: 'Reported fund NAV',
    });
  return projectPortfolioHistory(
    {
      holdings: [holding],
      evidence: [source],
      events: [],
      history: [],
      families: [],
      entities: [],
      accounts: [],
      tasks: [],
    },
    finance,
    { holdingIds: [holding.id], limit: 20 },
    { revision: 4, now: '2026-09-10T12:00:00Z' },
  );
}

describe('investment history presentation', () => {
  it('formats all authoritative decimal digits without IEEE-754 rounding', () => {
    expect(historyMoney('9007199254740993.17', 'USD')).toBe(
      'USD 9,007,199,254,740,993.17',
    );
    expect(historyMoney('-1234.05')).toBe('−EUR 1,234.05');
    expect(historyMoney('0.00')).toBe('EUR 0.00');
    expect(historyMoney(null)).toBe('Not available');
  });
  it('renders a one-observation source-backed history without cost or performance coverage', () => {
    const data = projection();
    const html = renderToStaticMarkup(
      createElement(InvestmentHistory, {
        data,
        loading: false,
        refreshing: false,
        error: null,
        onRefresh: () => {},
        controls: {
          cohort: 'current',
          from: '',
          to: '',
          asOf: '',
          knownAt: '',
          observation: '',
          currency: 'EUR',
          offset: 0,
          versions: false,
        },
        onControls: () => {},
        onSource: () => {},
        onHolding: () => {},
      }),
    );
    expect(html).toContain('Valuation history');
    expect(html).toContain('One reported observation.');
    expect(html).toContain('EUR 105.01');
    expect(html).toContain('Statement.pdf');
    expect(html).toContain('1–1 of 1 observations');
    expect(html).not.toContain('Performance is unavailable');
    expect(html).toContain('not investment return');
  });
  it('keeps the complete bounded chart while paginating the observation table', () => {
    const data = projection(25);
    expect(data.observations).toHaveLength(20);
    const html = renderToStaticMarkup(
      createElement(InvestmentHistory, {
        data,
        loading: false,
        refreshing: false,
        error: null,
        onRefresh: () => {},
        controls: {
          cohort: 'current',
          from: '',
          to: '',
          asOf: '',
          knownAt: '',
          observation: '',
          currency: 'EUR',
          offset: 0,
          versions: false,
        },
        onControls: () => {},
        onSource: () => {},
        onHolding: () => {},
      }),
    );
    expect(html).toContain('1–20 of 25 observations');
    expect(
      data.points.filter((point) => point.observationIds.length),
    ).toHaveLength(25);
    expect(html).toContain('Next');
  });
  it('offers keyboard selection and preserves actual dates in chart point metadata', () => {
    const html = renderToStaticMarkup(
      createElement(HistoryValueChart, {
        points: [
          { id: 'march', date: '2026-03-31', amount: '100.00' },
          { id: 'april', date: '2026-04-01', amount: '101.00' },
          { id: 'december', date: '2026-12-31', amount: '125.00' },
        ],
        currency: 'EUR',
        onSelect: () => {},
        selectedId: 'march',
      }),
    );
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-valuetext="31 Mar 2026, EUR 100.00"');
    expect(html).toContain('Inspect selected history point');
  });
  it('exports original amounts and source/version references while neutralizing spreadsheet formulas', () => {
    const row = {
      ...projection().observations[0],
      investmentName: '=HYPERLINK("unsafe")',
      nativeAmount: '9007199254740993.17',
      correctionOf: 'previous-record',
      correctionReason: 'Manager correction',
    };
    const csv = historyCsv([row]);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('9007199254740993.17');
    expect(csv).toContain('previous-record');
    expect(csv).toContain('Manager correction');
  });
  it('only offers accepted retained originals for this exact investment and family in lifecycle review', () => {
    const candidates = [
      source,
      { ...source, id: 'sample', synthetic: true },
      { ...source, id: 'other-holding', holdingId: 'other' },
      { ...source, id: 'other-family', familyId: 'other' },
      { ...source, id: 'no-original', documentId: undefined },
      { ...source, id: 'pending', status: 'Needs review' as const },
    ];
    expect(
      lifecycleSources(candidates, holding).map((item) => item.id),
    ).toEqual(['source']);
  });
});

describe('effective and imported activity chronology', () => {
  const lateMarch = event('late-march', '2026-03-31', '2026-09-10T10:00:00Z');
  const june = event('june', '2026-06-30', '2026-07-02T10:00:00Z');
  const undated = event('undated', '2026-09-10', '2026-09-10T11:00:00Z', true);
  it('puts late reports in their economic period and unknown dates last in either direction', () => {
    const original = [undated, lateMarch, june];
    expect(orderActivity(original).map((item) => item.id)).toEqual([
      'june',
      'late-march',
      'undated',
    ]);
    expect(
      orderActivity(original, 'effective', 'oldest').map((item) => item.id),
    ).toEqual(['late-march', 'june', 'undated']);
    expect(original[0]).toBe(undated);
    expect(activityDate(undated, 'effective')).toBeNull();
  });
  it('orders arrivals separately and stabilizes same-date ties', () => {
    expect(
      orderActivity([june, lateMarch, undated], 'imported').map(
        (item) => item.id,
      ),
    ).toEqual(['undated', 'late-march', 'june']);
    const tied = [
      event('b', '2026-06-30', june.receivedAt),
      event('a', '2026-06-30', june.receivedAt),
    ];
    expect(orderActivity(tied).map((item) => item.id)).toEqual(['a', 'b']);
  });
  it('does not display a receipt fallback as a reported effective date', () => {
    const html = renderToStaticMarkup(
      createElement(TimelineList, {
        events: [undated, june, lateMarch],
        onSource: () => {},
      }),
    );
    expect(html.indexOf('>june<')).toBeLessThan(html.indexOf('>late-march<'));
    expect(html).toContain('Effective date not supplied');
    expect(html).toContain('Imported / recorded');
    expect(html).toContain('Source did not supply an effective date');
  });
});
