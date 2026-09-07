'use client';
import { useState } from 'react';
import {
  Download,
  Plus,
  FileText,
  ArrowUpRight,
  CalendarDays,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-context';
import {
  PageHeading,
  FamilyPicker,
  Picker,
  Panel,
  money,
  percent,
  dateLabel,
} from './primitives';
import type { Holding } from '@/data';
import type { SavedReport } from '@/lib/workspace';
import { ValueChart, makeHistory } from './charts';
export function downloadHoldings(holdings: Holding[], family: string) {
  const cells = (v: string | number) =>
    '"' + String(v ?? '').replaceAll('"', '""') + '"';
  const rows = [
    [
      'Investment',
      'Family',
      'Asset class',
      'Currency',
      'Value EUR',
      'Cost basis EUR',
      'Unfunded EUR',
      'Valuation date',
      'Source ID',
    ],
    ...holdings.map((h) => [
      h.name,
      h.familyId,
      h.assetClass,
      h.currency,
      h.valueEUR.toFixed(2),
      h.costBasisEUR.toFixed(2),
      h.unfundedCommitmentEUR.toFixed(2),
      h.valuationDate,
      h.sourceId,
    ]),
  ];
  const blob = new Blob(
    ['\ufeff' + rows.map((row) => row.map(cells).join(',')).join('\r\n')],
    { type: 'text/csv;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'aster-' + family + '-portfolio-2026-09-07.csv';
  a.click();
  URL.revokeObjectURL(url);
}
export function ReportsView({
  family,
  onFamily,
  onPreview,
}: {
  family: string;
  onFamily: (s: string) => void;
  onPreview: (r: SavedReport | null, range?: string) => void;
}) {
  const { state, data, mutate } = useWorkspace();
  const [range, setRange] = useState('YTD'),
    [saving, setSaving] = useState(false);
  const hs = data.holdings.filter(
      (h) => family === 'all' || h.familyId === family,
    ),
    visible = state.reports.filter(
      (r) => family === 'all' || r.family === family,
    );
  async function create() {
    setSaving(true);
    await mutate({
      type: 'report',
      family,
      range,
      name:
        (family === 'all'
          ? 'Consolidated'
          : family[0].toUpperCase() + family.slice(1)) + ' portfolio report',
    });
    setSaving(false);
  }
  return (
    <>
      <PageHeading
        title="Reports"
        subtitle="Your portfolio, presented with clarity."
      >
        <FamilyPicker value={family} onChange={onFamily} />
        <Button onClick={() => void create()} disabled={saving}>
          <Plus data-icon="inline-start" />
          {saving ? 'Creating…' : 'Create report'}
        </Button>
      </PageHeading>
      <div className="report-builder">
        <button className="report-cover" onClick={() => onPreview(null, range)}>
          <div className="report-cover-top">
            <span>✳ Aster</span>
            <span>September 2026</span>
          </div>
          <div>
            <span className="report-cover-kicker">FAMILY OFFICE REPORT</span>
            <h2>
              Portfolio
              <br />
              review.
            </h2>
            <p>
              {family === 'all'
                ? 'Consolidated portfolio'
                : family[0].toUpperCase() + family.slice(1) + ' family'}
            </p>
          </div>
          <div className="report-cover-bottom">
            <span>
              Portfolio value
              <br />
              <strong>{money(hs.reduce((s, h) => s + h.valueEUR, 0))}</strong>
            </span>
            <ArrowUpRight />
          </div>
        </button>
        <div className="report-builder-content">
          <h2>Portfolio report</h2>
          <p>
            Allocation, performance, holdings and source dates in one structured
            view.
          </p>
          <div className="report-options">
            <span>Performance window</span>
            <Picker
              label="Report period"
              value={range}
              onChange={setRange}
              options={[
                { value: 'YTD', label: 'Year to date' },
                { value: '1Y', label: 'Trailing 12 months' },
              ]}
            />
            <span>Reporting currency</span>
            <strong>EUR</strong>
            <span>Included investments</span>
            <strong>{hs.length}</strong>
            <span>Portfolio snapshot</span>
            <strong>7 September 2026</strong>
          </div>
          <div className="report-builder-actions">
            <Button variant="outline" onClick={() => onPreview(null, range)}>
              <FileText data-icon="inline-start" />
              Preview report
            </Button>
            <Button
              variant="outline"
              onClick={() => downloadHoldings(hs, family)}
            >
              <Download data-icon="inline-start" />
              Export CSV
            </Button>
          </div>
          <p className="method-note">
            Save an immutable snapshot with its holdings and chart history. CSV
            includes precise position values, valuation dates and source IDs.
          </p>
        </div>
      </div>
      <Panel
        title="Saved reports"
        subtitle={
          visible.length
            ? 'Your workspace report history'
            : 'Create your first report snapshot'
        }
        className="saved-reports"
      >
        {visible.length ? (
          <div className="saved-report-list">
            {visible.map((r) => (
              <button key={r.id} onClick={() => onPreview(r)}>
                <span className="report-file-icon">
                  <FileText />
                </span>
                <div>
                  <h3>{r.name}</h3>
                  <p>
                    {new Date(r.createdAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}{' '}
                    · {r.holdingCount} investments · {r.range}
                  </p>
                </div>
                <strong>{money(r.totalValueEUR)}</strong>
                <ArrowUpRight />
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-report">
            <CalendarDays />
            <p>Your first snapshot will appear here.</p>
            <Button variant="link" onClick={() => void create()}>
              Create portfolio report <ArrowUpRight data-icon="inline-end" />
            </Button>
          </div>
        )}
      </Panel>
    </>
  );
}
export function PrintableReport({
  family,
  saved,
  range = 'YTD',
}: {
  family: string;
  saved: SavedReport | null;
  range?: string;
}) {
  const { data } = useWorkspace();
  const scope = saved?.family ?? family;
  const hs =
    saved?.holdings ??
    data.holdings.filter((h) => scope === 'all' || h.familyId === scope);
  const total = hs.reduce((s, h) => s + h.valueEUR, 0);
  const selectedRange = saved?.range ?? range;
  const history =
    saved?.history ??
    makeHistory(
      data.history,
      new Set(hs.map((h) => h.id)),
      selectedRange === '1Y' ? '2025-09-07' : '2025-12-31',
    );
  const lastIndex = history.at(-1)?.index;
  const twr = lastIndex == null ? null : lastIndex / 100 - 1;
  return (
    <article className="print-report">
      <header>
        <span className="report-brand">✳ Aster</span>
        <span>7 September 2026 · Synthetic demo</span>
      </header>
      <h1>{saved?.name ?? 'Consolidated portfolio report'}</h1>
      <p>
        {scope === 'all' ? 'All families' : scope + ' family'} · EUR · Latest
        accepted marks
      </p>
      {saved ? (
        <p className="saved-snapshot-note">
          Snapshot saved {new Date(saved.createdAt).toLocaleString('en-GB')}.
          Figures and chart history are preserved from that point.
        </p>
      ) : null}
      <div className="print-report-metrics">
        <div>
          <span>Total portfolio</span>
          <strong>{money(total)}</strong>
        </div>
        <div>
          <span>{selectedRange} return</span>
          <strong className={twr !== null && twr >= 0 ? 'positive' : ''}>
            {twr === null ? 'Unavailable' : percent(twr)}
          </strong>
        </div>
        <div>
          <span>Unfunded</span>
          <strong>
            {money(hs.reduce((s, h) => s + h.unfundedCommitmentEUR, 0))}
          </strong>
        </div>
        <div>
          <span>Cash</span>
          <strong>
            {money(
              hs
                .filter((h) => h.assetClass === 'Cash')
                .reduce((s, h) => s + h.valueEUR, 0),
            )}
          </strong>
        </div>
      </div>
      <h2>Portfolio performance</h2>
      <p className="report-chart-note">
        Daily-linked time-weighted return · {selectedRange} · synthetic marks
      </p>
      <ValueChart data={history} performance small />
      <h2>Asset allocation</h2>
      <div className="print-allocation">
        {[
          'Public equities',
          'Private equity',
          'Venture capital',
          'Real estate',
          'Fixed income',
          'Cash',
        ].map((name) => {
          const v = hs
            .filter((h) => h.assetClass === name)
            .reduce((s, h) => s + h.valueEUR, 0);
          return (
            <div key={name}>
              <span>{name}</span>
              <strong>{money(v)}</strong>
              <span>{percent(v / total)}</span>
            </div>
          );
        })}
      </div>
      <h2>Investment schedule</h2>
      <table>
        <thead>
          <tr>
            <th>Investment</th>
            <th>Value</th>
            <th>Weight</th>
            <th>Valuation date</th>
          </tr>
        </thead>
        <tbody>
          {hs.map((h) => (
            <tr key={h.id}>
              <td>{h.name}</td>
              <td>{money(h.valueEUR, 2)}</td>
              <td>{percent(h.valueEUR / total)}</td>
              <td>{dateLabel(h.valuationDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="print-note">
        All records are synthetic. Private investments retain their latest
        reported valuation. Unfunded commitments are excluded from NAV. Daily
        returns remove modeled end-of-day external flows before linking. This
        document is a product demonstration, not actual financial reporting.
      </p>
    </article>
  );
}
