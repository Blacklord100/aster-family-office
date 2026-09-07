'use client';
import { useMemo, useState } from 'react';
import {
  Download,
  ChevronRight,
  FileText,
  ArrowUpRight,
  Clock3,
  CheckCircle2,
} from 'lucide-react';
import { tasks, AS_OF_DATE } from '@/data';
import type { Holding } from '@/data';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  PageHeading,
  FamilyPicker,
  ViewTabs,
  Metric,
  Panel,
  Picker,
  Monogram,
  money,
  percent,
  TextAction,
} from './primitives';
import {
  ValueChart,
  AllocationChart,
  AllocationBars,
  makeHistory,
  classColors,
} from './charts';
import type { View } from './shell';
import { useWorkspace } from './workspace-context';
export function HoldingsTable({
  holdings,
  onSelect,
  compact = false,
  portfolioTotal,
}: {
  holdings: Holding[];
  onSelect: (id: string) => void;
  compact?: boolean;
  portfolioTotal?: number;
}) {
  const total = portfolioTotal ?? holdings.reduce((s, h) => s + h.valueEUR, 0);
  return (
    <Table className="holdings-table">
      <TableHeader>
        <TableRow>
          <TableHead>Investment</TableHead>
          <TableHead>Asset class</TableHead>
          {!compact ? <TableHead>Family</TableHead> : null}
          <TableHead className="number">Value</TableHead>
          <TableHead className="number">Weight</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {holdings.slice(0, compact ? 4 : undefined).map((h) => (
          <TableRow
            key={h.id}
            onClick={() => onSelect(h.id)}
            className="clickable-row"
          >
            <TableCell>
              <button
                className="holding-name"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(h.id);
                }}
              >
                <Monogram
                  name={h.name}
                  color={
                    h.assetClass === 'Private equity'
                      ? 'teal'
                      : h.assetClass === 'Real estate'
                        ? 'blue'
                        : h.assetClass === 'Fixed income'
                          ? 'amber'
                          : 'violet'
                  }
                />
                <span>
                  {h.name}
                  {!compact ? <small>{h.manager}</small> : null}
                </span>
              </button>
            </TableCell>
            <TableCell>
              <span className="class-label">
                {!compact ? (
                  <i style={{ background: classColors[h.assetClass] }} />
                ) : null}
                {h.assetClass}
              </span>
            </TableCell>
            {!compact ? (
              <TableCell className="muted">
                {h.familyId === 'bergstrom'
                  ? 'Bergström'
                  : h.familyId[0].toUpperCase() + h.familyId.slice(1)}
              </TableCell>
            ) : null}
            <TableCell className="number strong">{money(h.valueEUR)}</TableCell>
            <TableCell className="number muted">
              {percent(h.valueEUR / total)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
export function Overview({
  family,
  onFamily,
  onNavigate,
  onHolding,
  onSource,
  onExport,
  taskStatus = {},
}: {
  family: string;
  onFamily: (v: string) => void;
  onNavigate: (v: View) => void;
  onHolding: (id: string) => void;
  onSource: (id: string) => void;
  onExport: () => void;
  taskStatus?: Record<string, string>;
}) {
  const { data } = useWorkspace();
  const [tab, setTab] = useState('portfolio'),
    [range, setRange] = useState('ytd'),
    [dimension, setDimension] = useState('assetClass');
  const holdings = useMemo(
    () =>
      data.holdings.filter((h) => family === 'all' || h.familyId === family),
    [family, data.holdings],
  );
  const total = holdings.reduce((s, h) => s + h.valueEUR, 0),
    cost = holdings.reduce((s, h) => s + h.costBasisEUR, 0),
    unfunded = holdings.reduce((s, h) => s + h.unfundedCommitmentEUR, 0),
    liquid = holdings
      .filter((h) => ['Daily', 'Within 30 days'].includes(h.liquidityBucket))
      .reduce((s, h) => s + h.valueEUR, 0);
  const start =
    range === '1m'
      ? '2026-08-07'
      : range === '3m'
        ? '2026-06-07'
        : range === '1y'
          ? '2025-09-07'
          : '2025-12-31';
  const history = useMemo(
    () => makeHistory(data.history, new Set(holdings.map((h) => h.id)), start),
    [holdings, start, data.history],
  );
  const lastIndex = history.at(-1)?.index;
  const twr = lastIndex == null ? null : lastIndex / 100 - 1;
  const relevantTasks = tasks
    .filter(
      (t) =>
        (family === 'all' || t.familyId === family) &&
        (taskStatus[t.id] ?? t.status) !== 'Done',
    )
    .slice(0, 2);
  const relevantEvents = data.events
    .filter((e) => family === 'all' || e.familyId === family)
    .slice(0, 2);
  const byLiquidity = ['Daily', 'Within 30 days', '1–3 years', '3+ years'].map(
    (name) => ({
      name,
      value: holdings
        .filter((h) => h.liquidityBucket === name)
        .reduce((s, h) => s + h.valueEUR, 0),
    }),
  );
  return (
    <>
      <PageHeading title="Overview" subtitle="Monday, 7 September 2026">
        <FamilyPicker value={family} onChange={onFamily} />
        <Button variant="outline" onClick={onExport}>
          <Download data-icon="inline-start" />
          Export report
        </Button>
      </PageHeading>
      <ViewTabs
        value={tab}
        onChange={setTab}
        items={['Portfolio', 'Performance', 'Liquidity']}
      />
      <div className="metrics-row">
        <Metric
          label="Total portfolio"
          value={money(total)}
          note={
            twr === null
              ? 'Return unavailable'
              : (twr >= 0 ? '+' : '') +
                percent(twr) +
                ' ' +
                range.toUpperCase() +
                ' return'
          }
          positive={twr !== null && twr >= 0}
          help="Sum of accepted position values in EUR. Private assets use their latest reported NAV; unfunded commitments are excluded."
        />
        <Metric
          label="Investment gain"
          value={(total - cost >= 0 ? '+' : '') + money(total - cost)}
          note="Unrealized · versus cost basis"
          help="Current value minus remaining cost basis. This is an unrealized gain, not a total or annualized investment return."
        />
        <Metric
          label="Available liquidity"
          value={money(liquid)}
          note={percent(liquid / total) + ' · within 30 days'}
          help="Illustrative liquid assets: daily-traded positions, cash and fixed income. Values are not a guarantee of sale proceeds."
        />
        <Metric
          label="Unfunded commitments"
          value={money(unfunded)}
          note={
            'Across ' +
            holdings.filter((h) => h.unfundedCommitmentEUR > 0).length +
            ' funds'
          }
          help="Future contractual commitments, kept separate from invested NAV. Capital-call notices do not establish settlement."
        />
      </div>
      {tab === 'liquidity' ? (
        <div className="reporting-grid">
          <Panel
            title="Liquidity profile"
            subtitle="When assets could become available"
          >
            <AllocationBars data={byLiquidity} horizontal />
          </Panel>
          <Panel
            title="Commitments & cash"
            subtitle={'Planning capacity, as of ' + AS_OF_DATE}
          >
            <div className="liquidity-summary">
              <span>Cash on hand</span>
              <strong>
                {money(
                  holdings
                    .filter((h) => h.assetClass === 'Cash')
                    .reduce((s, h) => s + h.valueEUR, 0),
                )}
              </strong>
              <span>Unfunded commitments</span>
              <strong>{money(unfunded)}</strong>
              <span>Liquid assets / unfunded</span>
              <strong>
                {unfunded
                  ? (liquid / unfunded).toFixed(2) + '×'
                  : 'No commitments'}
              </strong>
            </div>
            <p className="method-note">
              Liquidity buckets are illustrative. Expected calls and
              distributions are tracked separately until settlement is
              evidenced.
            </p>
          </Panel>
        </div>
      ) : (
        <div className="reporting-grid">
          <Panel
            title={
              tab === 'performance'
                ? 'Portfolio performance'
                : 'Portfolio value'
            }
            subtitle={
              tab === 'performance'
                ? 'Time-weighted return · EUR · synthetic'
                : 'Net asset value over time'
            }
            action={
              <ViewTabs
                compact
                value={range}
                onChange={setRange}
                items={['1M', '3M', 'YTD', '1Y']}
              />
            }
          >
            <ValueChart data={history} performance={tab === 'performance'} />
          </Panel>
          <Panel
            title="Asset allocation"
            action={
              <Picker
                value={dimension}
                onChange={setDimension}
                label="Allocation dimension"
                options={[
                  { value: 'assetClass', label: 'Asset class' },
                  { value: 'geography', label: 'Geography' },
                  { value: 'currency', label: 'Currency' },
                ]}
              />
            }
          >
            <AllocationChart
              holdings={holdings}
              dimension={dimension as 'assetClass' | 'geography' | 'currency'}
            />
          </Panel>
        </div>
      )}
      {tab === 'performance' ? (
        <div className="reporting-grid lower-grid">
          <Panel
            title="Performance by asset class"
            subtitle={'Time-weighted return · ' + range.toUpperCase()}
          >
            <div className="return-rows">
              {Object.entries(classColors).map(([name, color]) => {
                const hs = holdings.filter((h) => h.assetClass === name),
                  series = makeHistory(
                    data.history,
                    new Set(hs.map((h) => h.id)),
                    start,
                  ),
                  idx = series.at(-1)?.index,
                  ret = idx == null ? null : idx / 100 - 1;
                return (
                  <div key={name}>
                    <i style={{ background: color }} />
                    <span>{name}</span>
                    <strong
                      className={
                        ret !== null && ret >= 0 ? 'positive' : 'negative'
                      }
                    >
                      {ret === null ? '—' : percent(ret)}
                    </strong>
                    <div className="return-track">
                      <span
                        style={{
                          width: Math.min(100, Math.abs(ret ?? 0) * 600) + '%',
                          background: color,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
          <Panel title="About these returns" subtitle="Methodology matters">
            <div className="methodology">
              <CheckCircle2 />
              <div>
                <h3>Cash-flow adjusted</h3>
                <p>
                  Daily returns are linked after removing explicitly modeled
                  end-of-day external flows.
                </p>
              </div>
              <Clock3 />
              <div>
                <h3>Reported valuations</h3>
                <p>
                  Private assets carry forward their last reported mark between
                  synthetic statements.
                </p>
              </div>
              <FileText />
              <div>
                <h3>Every value has a source</h3>
                <p>
                  Open an investment to inspect its valuation date and
                  underlying evidence.
                </p>
              </div>
            </div>
          </Panel>
        </div>
      ) : (
        <div className="reporting-grid lower-grid">
          <Panel
            title="Holdings"
            action={
              <TextAction onClick={() => onNavigate('investments')}>
                View all investments
              </TextAction>
            }
          >
            <HoldingsTable
              holdings={[...holdings].sort((a, b) => b.valueEUR - a.valueEUR)}
              onSelect={onHolding}
              compact
            />
          </Panel>
          <div className="attention-rail">
            <Panel
              title="Needs your attention"
              action={
                <span className="subtle-count">{relevantTasks.length}</span>
              }
            >
              <div className="attention-list">
                {relevantTasks.map((t) => (
                  <button key={t.id} onClick={() => onSource(t.sourceId)}>
                    <span
                      className={
                        'attention-dot ' +
                        (t.priority === 'High' ? 'amber' : 'violet')
                      }
                    />
                    <div>
                      <strong>{t.title}</strong>
                      <small>
                        {t.category} · Due{' '}
                        {new Date(t.dueDate + 'T12:00:00Z').toLocaleDateString(
                          'en-GB',
                          { day: 'numeric', month: 'short' },
                        )}
                      </small>
                    </div>
                    <ChevronRight />
                  </button>
                ))}
              </div>
            </Panel>
            <Panel title="Latest activity">
              <div className="activity-list">
                {relevantEvents.map((e) => (
                  <button key={e.id} onClick={() => onSource(e.sourceId)}>
                    <span className="activity-icon">
                      <FileText />
                    </span>
                    <div>
                      <strong>{e.title}</strong>
                      <small>
                        {e.type} · {e.date === AS_OF_DATE ? 'Today' : e.date}
                      </small>
                    </div>
                    <ArrowUpRight />
                  </button>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      )}
      <div className="source-note">
        <span className="dot" />
        All figures in EUR · Private values reflect the latest reported date.
        <button onClick={() => onNavigate('connections')}>
          View source coverage <ChevronRight />
        </button>
      </div>
    </>
  );
}
