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
import { rangeStartDate } from '@/lib/date-ranges';
import { aggregateRecordedMarks } from '@/lib/recorded-marks';
import type { Holding } from '@/data';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
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
  usePerformanceAvailable,
  dateLabel,
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
  const { data } = useWorkspace();
  const total = portfolioTotal ?? holdings.reduce((s, h) => s + h.valueEUR, 0);
  return (
    <Table className="holdings-table">
      <TableHeader>
        <TableRow>
          <TableHead>Investment</TableHead>
          <TableHead
            className={compact ? 'compact-asset-class' : 'holding-secondary'}
          >
            Asset class
          </TableHead>
          {!compact ? (
            <TableHead className="holding-secondary">Family</TableHead>
          ) : null}
          <TableHead className="number">Value</TableHead>
          <TableHead className="number holding-weight">Weight</TableHead>
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
            <TableCell
              className={compact ? 'compact-asset-class' : 'holding-secondary'}
            >
              <span className="class-label">
                {!compact ? (
                  <i style={{ background: classColors[h.assetClass] }} />
                ) : null}
                {h.assetClass}
                {h.assetClassStatus === 'inferred' ? ' · Inferred' : ''}
              </span>
            </TableCell>
            {!compact ? (
              <TableCell className="muted holding-secondary">
                {data.families.find((f) => f.id === h.familyId)?.name ??
                  'Unassigned'}
              </TableCell>
            ) : null}
            <TableCell className="number strong">
              {h.valuationStatus === 'unknown'
                ? 'Not reported'
                : money(h.valueEUR)}
            </TableCell>
            <TableCell className="number muted holding-weight">
              {h.valuationStatus === 'unknown'
                ? '—'
                : percent(h.valueEUR / total)}
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
  const { state, data } = useWorkspace();
  const performanceAvailable = usePerformanceAvailable();
  const [tab, setTab] = useState('portfolio'),
    [range, setRange] = useState('ytd'),
    [dimension, setDimension] = useState('assetClass');
  const holdings = useMemo(
    () =>
      data.holdings.filter((h) => family === 'all' || h.familyId === family),
    [family, data.holdings],
  );
  const missingValues = holdings.filter(
    (h) => h.valuationStatus === 'unknown',
  ).length;
  const missingCosts = holdings.filter(
    (h) => h.costBasisStatus === 'unknown',
  ).length;
  const missingUnfunded = holdings.filter(
    (h) => h.unfundedStatus === 'unknown',
  ).length;
  const missingLiquidity = holdings.filter(
    (h) => h.liquidityStatus === 'unknown',
  ).length;
  const inferredClasses = holdings.filter(
    (h) => h.assetClassStatus === 'inferred',
  ).length;
  const liquidityUnavailable = missingLiquidity > 0 || missingValues > 0;
  const total = holdings.reduce(
      (s, h) => s + (h.valuationStatus === 'unknown' ? 0 : h.valueEUR),
      0,
    ),
    cost = holdings.reduce((s, h) => s + h.costBasisEUR, 0),
    unfunded = holdings.reduce((s, h) => s + h.unfundedCommitmentEUR, 0),
    liquid = holdings
      .filter(
        (h) =>
          h.liquidityStatus !== 'unknown' &&
          h.valuationStatus !== 'unknown' &&
          ['Daily', 'Within 30 days'].includes(h.liquidityBucket),
      )
      .reduce((s, h) => s + h.valueEUR, 0);
  const start = rangeStartDate(
    performanceAvailable ? '2026-09-07' : new Date().toISOString().slice(0, 10),
    range,
  );
  const history = useMemo(
    () =>
      performanceAvailable
        ? makeHistory(data.history, new Set(holdings.map((h) => h.id)), start)
        : aggregateRecordedMarks(
            data.history,
            holdings
              .filter((h) => h.valuationStatus !== 'unknown')
              .map((h) => h.id),
            start,
          ),
    [holdings, start, data.history, performanceAvailable],
  );
  const lastIndex = history.at(-1)?.index;
  const twr =
    !performanceAvailable || lastIndex == null ? null : lastIndex / 100 - 1;
  const relevantTasks = data.tasks
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
        .filter(
          (h) =>
            h.liquidityStatus !== 'unknown' &&
            h.valuationStatus !== 'unknown' &&
            h.liquidityBucket === name,
        )
        .reduce((s, h) => s + h.valueEUR, 0),
    }),
  );
  return (
    <>
      <PageHeading
        title="Overview"
        subtitle={
          holdings.length && missingValues === holdings.length
            ? 'Awaiting the first source valuation'
            : holdings.length
              ? 'Latest recorded valuations · ' +
                dateLabel(
                  holdings
                    .filter((h) => h.valuationStatus !== 'unknown')
                    .map((h) => h.valuationDate)
                    .sort()
                    .at(-1)!,
                )
              : 'Your workspace starts with your records'
        }
      >
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
      {!state.sampleData && holdings.length ? (
        <p className="method-note">
          Recorded position values only. Coverage, ownership and source
          interpretation require review; portfolio returns are unavailable.
        </p>
      ) : null}
      <div className="metrics-row">
        <Metric
          label={missingValues ? 'Reported portfolio value' : 'Total portfolio'}
          value={
            holdings.length && missingValues === holdings.length
              ? 'Not reported'
              : money(total)
          }
          note={
            missingValues
              ? `${missingValues} ${missingValues === 1 ? 'holding awaits' : 'holdings await'} a valuation`
              : twr === null
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
          value={
            missingCosts || missingValues
              ? 'Unavailable'
              : (total - cost >= 0 ? '+' : '') + money(total - cost)
          }
          note={
            missingCosts || missingValues
              ? 'Complete valuations and cost basis required'
              : 'Unrealized · versus cost basis'
          }
          help="Current value minus remaining cost basis. This is an unrealized gain, not a total or annualized investment return."
        />
        <Metric
          label="Available liquidity"
          value={liquidityUnavailable ? 'Unavailable' : money(liquid)}
          note={
            missingLiquidity
              ? `${missingLiquidity} holdings have no reported liquidity terms`
              : missingValues
                ? 'Valuation coverage is incomplete'
                : percent(liquid / total) + ' · within 30 days'
          }
          help="Illustrative liquid assets: daily-traded positions, cash and fixed income. Values are not a guarantee of sale proceeds."
        />
        <Metric
          label="Unfunded commitments"
          value={
            holdings.length && missingUnfunded === holdings.length
              ? 'Not reported'
              : money(unfunded)
          }
          note={
            missingUnfunded
              ? `${missingUnfunded} ${missingUnfunded === 1 ? 'holding has' : 'holdings have'} no reported commitment`
              : 'Across ' +
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
            {liquidityUnavailable ? (
              <div className="empty-inline">
                <Clock3 />
                <h3>Liquidity profile unavailable</h3>
                <p>
                  Reported liquidity terms and valuations are required for every
                  holding. Unreported terms are not treated as a lockup.
                </p>
              </div>
            ) : (
              <AllocationBars data={byLiquidity} horizontal />
            )}
          </Panel>
          <Panel
            title="Commitments & cash"
            subtitle="Recorded cash and commitments"
          >
            <div className="liquidity-summary">
              <span>Cash on hand</span>
              <strong>
                {inferredClasses || missingValues
                  ? 'Unavailable'
                  : money(
                      holdings
                        .filter((h) => h.assetClass === 'Cash')
                        .reduce((s, h) => s + h.valueEUR, 0),
                    )}
              </strong>
              <span>Unfunded commitments</span>
              <strong>
                {missingUnfunded ? 'Incomplete coverage' : money(unfunded)}
              </strong>
              <span>Liquid assets / unfunded</span>
              <strong>
                {missingUnfunded || liquidityUnavailable
                  ? 'Unavailable'
                  : unfunded
                    ? (liquid / unfunded).toFixed(2) + '×'
                    : 'No commitments'}
              </strong>
            </div>
            <p className="method-note">
              {inferredClasses ? 'Cash classification requires review. ' : ''}
              Expected calls and distributions are tracked separately until
              settlement is evidenced.
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
                ? performanceAvailable
                  ? 'Time-weighted return · EUR · sample history'
                  : 'Return unavailable · complete cash-flow history required'
                : missingValues
                  ? `Reported marks · ${holdings.length - missingValues} of ${holdings.length} holdings valued`
                  : 'Recorded portfolio value over time'
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
            {history.length > 0 &&
            (performanceAvailable || tab !== 'performance') ? (
              <>
                <ValueChart
                  data={history}
                  performance={tab === 'performance'}
                  recorded={!performanceAvailable}
                />
                {!performanceAvailable ? (
                  <p className="method-note">
                    {history.length === 1
                      ? 'One reported snapshot is available. '
                      : 'Reported marks are carried forward only after every included holding has a source value. '}
                    {missingValues
                      ? `${missingValues} unvalued holdings are excluded. `
                      : ''}
                    Changes may include cash movements; no investment return is
                    calculated.
                  </p>
                ) : null}
              </>
            ) : (
              <div className="empty-inline">
                <Clock3 />
                <h3>
                  {tab === 'performance'
                    ? 'Performance is unavailable'
                    : 'Build your portfolio history'}
                </h3>
                <p>
                  {holdings.length
                    ? 'Recorded marks do not establish a complete valuation and external cash-flow history.'
                    : 'Add an opening holding in Investments, then import a report in Processing.'}
                </p>
                {!holdings.length ? (
                  <Button
                    variant="outline"
                    onClick={() => onNavigate('investments')}
                  >
                    Add your first holding
                  </Button>
                ) : null}
              </div>
            )}
          </Panel>
          <Panel
            title="Asset allocation"
            subtitle={
              dimension === 'assetClass' && inferredClasses
                ? `${inferredClasses} holdings use inferred asset classes · review required`
                : undefined
            }
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
            {holdings.length && missingValues === holdings.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText />
                  </EmptyMedia>
                  <EmptyTitle>Awaiting reported values</EmptyTitle>
                  <EmptyDescription>
                    Allocation appears as source valuations are accepted.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <AllocationChart
                holdings={holdings.filter(
                  (h) => h.valuationStatus !== 'unknown',
                )}
                dimension={dimension as 'assetClass' | 'geography' | 'currency'}
              />
            )}
          </Panel>
        </div>
      )}
      {tab === 'performance' ? (
        <div className="reporting-grid lower-grid">
          <Panel
            title="Performance by asset class"
            subtitle={
              'Time-weighted return · ' +
              range.toUpperCase() +
              (inferredClasses ? ' · Includes inferred asset classes' : '')
            }
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
                  ret =
                    !performanceAvailable || idx == null ? null : idx / 100 - 1;
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
                <h3>
                  {performanceAvailable
                    ? 'Sample cash-flow adjustment'
                    : 'Complete cash flows needed'}
                </h3>
                <p>
                  {performanceAvailable
                    ? 'Sample daily returns remove explicitly modeled end-of-day external flows before linking.'
                    : 'A valuation update alone is insufficient to measure return. Complete external flows and comparable dated marks are required.'}
                </p>
              </div>
              <Clock3 />
              <div>
                <h3>Reported valuations</h3>
                <p>
                  Private assets carry forward their last reported mark between
                  source statements.
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
                        {e.type} · {dateLabel(e.date)}
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
