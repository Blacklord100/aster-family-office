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
  usePerformanceAvailable,
} from './primitives';
import { rangeStartDate } from '@/lib/date-ranges';
import { aggregateRecordedMarks } from '@/lib/recorded-marks';
import { reportValue } from '@/lib/report-value';
import type { Holding } from '@/data';
import type { SavedReport } from '@/lib/workspace';
import { ValueChart, makeHistory } from './charts';
export function downloadHoldings(holdings: Holding[], family: string) {
  const cells = (v: string | number) => {
    const text = String(v ?? '');
    return (
      '"' +
      (/^[=+@\t\r-]/.test(text) ? "'" + text : text).replaceAll('"', '""') +
      '"'
    );
  };
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
      'Valuation coverage',
      'Cost basis coverage',
      'Unfunded coverage',
      'Asset class status',
      'Liquidity terms',
      'Liquidity coverage',
    ],
    ...holdings.map((h) => [
      h.name,
      h.familyId,
      h.assetClass,
      h.currency,
      h.valuationStatus === 'unknown' ? '' : h.valueEUR.toFixed(2),
      h.costBasisStatus === 'unknown' ? '' : h.costBasisEUR.toFixed(2),
      h.unfundedStatus === 'unknown' ? '' : h.unfundedCommitmentEUR.toFixed(2),
      h.valuationStatus === 'unknown' ? '' : h.valuationDate,
      h.sourceId,
      h.valuationStatus ?? 'reported',
      h.costBasisStatus ?? 'reported',
      h.unfundedStatus ?? 'reported',
      h.assetClassStatus ?? 'reported',
      h.liquidityStatus === 'unknown' ? '' : h.liquidityBucket,
      h.liquidityStatus ?? 'reported',
    ]),
  ];
  const blob = new Blob(
    ['\ufeff' + rows.map((row) => row.map(cells).join(',')).join('\r\n')],
    { type: 'text/csv;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download =
    'aster-' +
    family +
    '-portfolio-' +
    new Date().toISOString().slice(0, 10) +
    '.csv';
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
  const valuation = reportValue(hs);
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
            <span>
              {new Date().toLocaleDateString('en-GB', {
                month: 'long',
                year: 'numeric',
              })}
            </span>
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
              {valuation.label}
              <br />
              <strong>
                {valuation.valueEUR === null
                  ? 'Not reported'
                  : money(valuation.valueEUR)}
              </strong>
            </span>
            <ArrowUpRight />
          </div>
        </button>
        <div className="report-builder-content">
          <h2>Portfolio report</h2>
          <p>Allocation, holdings and source dates in one structured view.</p>
          <div className="report-options">
            <span>History window</span>
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
            <strong>
              {valuation.asOfDate
                ? dateLabel(valuation.asOfDate)
                : 'No reported valuation date'}
            </strong>
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
            {visible.map((r) => {
              const snapshot = reportValue(r.holdings);
              return (
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
                      · {r.holdingCount} investments · {r.range} ·{' '}
                      {snapshot.label}
                    </p>
                  </div>
                  <strong>
                    {snapshot.valueEUR === null
                      ? 'Not reported'
                      : money(snapshot.valueEUR)}
                  </strong>
                  <ArrowUpRight />
                </button>
              );
            })}
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
  const { state, data } = useWorkspace();
  const currentPerformanceAvailable = usePerformanceAvailable();
  const performanceAvailable = saved?.synthetic ?? currentPerformanceAvailable;
  const containsSampleRecords = saved?.synthetic ?? state.sampleData;
  const scope = saved?.family ?? family;
  const hs =
    saved?.holdings ??
    data.holdings.filter((h) => scope === 'all' || h.familyId === scope);
  const valuation = reportValue(hs);
  const total = valuation.valueEUR ?? 0;
  const selectedRange = saved?.range ?? range;
  const history =
    saved?.history ??
    (performanceAvailable
      ? makeHistory(
          data.history,
          new Set(hs.map((h) => h.id)),
          rangeStartDate(
            performanceAvailable
              ? '2026-09-07'
              : new Date().toISOString().slice(0, 10),
            selectedRange,
          ),
        )
      : aggregateRecordedMarks(
          data.history,
          hs.map((h) => h.id),
          rangeStartDate(
            performanceAvailable
              ? '2026-09-07'
              : new Date().toISOString().slice(0, 10),
            selectedRange,
          ),
        ));
  const lastIndex = history.at(-1)?.index;
  const twr =
    !performanceAvailable || lastIndex == null ? null : lastIndex / 100 - 1;
  return (
    <article className="print-report">
      <header>
        <span className="report-brand">✳ Aster</span>
        <span>
          {saved
            ? dateLabel(saved.createdAt.slice(0, 10))
            : valuation.asOfDate
              ? dateLabel(valuation.asOfDate)
              : 'No reported valuation date'}{' '}
          · {containsSampleRecords ? 'Sample records' : 'Workspace records'}
        </span>
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
          <span>{valuation.label}</span>
          <strong>
            {valuation.valueEUR === null ? 'Not reported' : money(total)}
          </strong>
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
            {hs.some((h) => h.unfundedStatus === 'unknown')
              ? 'Coverage incomplete'
              : money(hs.reduce((s, h) => s + h.unfundedCommitmentEUR, 0))}
          </strong>
        </div>
        <div>
          <span>Cash</span>
          <strong>
            {hs.some(
              (h) =>
                h.assetClassStatus === 'inferred' ||
                h.valuationStatus === 'unknown',
            )
              ? 'Unavailable'
              : money(
                  hs
                    .filter((h) => h.assetClass === 'Cash')
                    .reduce((s, h) => s + h.valueEUR, 0),
                )}
          </strong>
        </div>
      </div>
      <h2>
        {performanceAvailable
          ? 'Portfolio performance'
          : 'Recorded portfolio value'}
      </h2>
      <p className="report-chart-note">
        {performanceAvailable
          ? 'Daily-linked time-weighted return · ' +
            selectedRange +
            ' · sample marks'
          : 'Latest known marks carried forward for current holdings. Changes may include cash movements; investment returns are unavailable.'}
      </p>
      {history.length > 1 ? (
        <ValueChart
          data={history}
          performance={performanceAvailable}
          recorded={!performanceAvailable}
          small
        />
      ) : null}
      <h2>Asset allocation</h2>
      {hs.some((h) => h.assetClassStatus === 'inferred') ? (
        <p className="report-chart-note">
          Includes inferred asset classes. Proposed classifications require
          review against source documents.
        </p>
      ) : null}
      <div className="print-allocation">
        {[
          'Public equities',
          'Private equity',
          'Venture capital',
          'Real estate',
          'Fixed income',
          'Cash',
        ].map((name) => {
          const rows = hs.filter((h) => h.assetClass === name);
          const allocation = reportValue(rows);
          const v = allocation.valueEUR ?? 0;
          const unavailable = rows.length > 0 && allocation.valueEUR === null;
          return (
            <div key={name}>
              <span>
                {name}
                {allocation.coverage.unknownCount > 0
                  ? ' · partial coverage'
                  : ''}
              </span>
              <strong>{unavailable ? 'Not reported' : money(v)}</strong>
              <span>
                {unavailable || total === 0 ? '—' : percent(v / total)}
              </span>
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
              <td>
                {h.valuationStatus === 'unknown'
                  ? 'Not reported'
                  : money(h.valueEUR, 2)}
              </td>
              <td>
                {h.valuationStatus === 'unknown' || total === 0
                  ? '—'
                  : percent(h.valueEUR / total)}
              </td>
              <td>
                {h.valuationStatus === 'unknown'
                  ? 'Not reported'
                  : dateLabel(h.valuationDate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="print-note">
        {containsSampleRecords ? 'This report includes sample records. ' : ''}
        {state.demo
          ? 'Synthetic source files and demonstration FX assumptions. '
          : ''}
        {hs.some((h) => h.liquidityStatus === 'unknown')
          ? 'Liquidity terms are not reported for all holdings; available liquidity cannot be established. '
          : ''}
        {hs.some((h) => h.valuationStatus === 'unknown')
          ? 'Portfolio totals include reported valuations only; unvalued holdings are excluded from allocation weights. '
          : ''}
        Private investments use their latest recorded valuation. Unfunded
        commitments are excluded from NAV.{' '}
        {performanceAvailable
          ? 'Sample daily returns remove modeled end-of-day external flows before linking.'
          : 'Recorded marks do not establish complete cash-flow history; investment returns are unavailable.'}{' '}
        Review source coverage and interpretation before relying on this report.
      </p>
    </article>
  );
}
