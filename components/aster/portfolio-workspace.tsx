'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ChevronRight,
  Download,
  FileText,
  RefreshCw,
  Clock3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { comparableHistoryMatches } from '@/lib/portfolio-history-selection';
import { historyAmount, downloadHistoryCSV } from '@/lib/history-display';
import { usePortfolioHistory } from './use-portfolio-history';
import { useHistoryControls } from './use-history-controls';
import { HistoryValueChart } from './investment-history';
import { useWorkspace } from './workspace-context';
import {
  PageHeading,
  FamilyPicker,
  Metric,
  Panel,
  Picker,
  dateLabel,
  TextAction,
} from './primitives';
import { AllocationBars } from './charts';
import { ParticipationHeatmap } from './participation-heatmap';
import type { View } from './shell';
import styles from './portfolio-workspace.module.css';

export type PortfolioWorkspaceProps = {
  family: string;
  onFamily: (value: string) => void;
  onNavigate: (view: View) => void;
  onHolding: (id: string) => void;
  onSource: (id: string) => void;
  onExport: () => void;
  taskStatus?: Record<string, string>;
};

export function PortfolioWorkspace({
  family,
  onFamily,
  onNavigate,
  onHolding,
  onSource,
  taskStatus = {},
}: PortfolioWorkspaceProps) {
  const { data: workspace, state } = useWorkspace();
  const { controls, setControls, query } = useHistoryControls();
  const search = useSearchParams();
  const entityId = search.get('historyEntity') ?? 'all';
  const entities = workspace.entities.filter(
    (entity) => family === 'all' || entity.familyId === family,
  );
  const entity = entities.some((item) => item.id === entityId)
    ? entityId
    : 'all';
  const changeEntity = (value: string) => {
    const url = new URL(window.location.href);
    if (value === 'all') url.searchParams.delete('historyEntity');
    else url.searchParams.set('historyEntity', value);
    url.searchParams.delete('observation');
    window.history.replaceState(null, '', url.pathname + url.search);
  };
  const scopedQuery = {
    ...query,
    limit: 20,
    offset: 0,
    includeSuperseded: false,
    ...(family === 'all' ? {} : { familyIds: [family] }),
    ...(entity === 'all' ? {} : { entityIds: [entity] }),
  };
  const fullHistory = usePortfolioHistory(scopedQuery);
  const comparableMode = search.get('historyComparison') === 'comparable';
  const comparableIds =
    fullHistory.data?.comparison.comparable.holdingIds ?? [];
  const comparableHistory = usePortfolioHistory(
    {
      ...scopedQuery,
      ...(comparableIds.length ? { holdingIds: comparableIds } : {}),
    },
    comparableMode && comparableIds.length > 0,
  );
  const comparableReady = comparableHistoryMatches(
    fullHistory.data,
    comparableHistory.data,
  );
  const history = comparableMode
    ? {
        ...comparableHistory,
        data: comparableReady ? comparableHistory.data : null,
        loading:
          fullHistory.loading ||
          comparableHistory.loading ||
          (comparableIds.length > 0 &&
            !comparableReady &&
            !fullHistory.error &&
            !comparableHistory.error),
        error: fullHistory.error ?? comparableHistory.error,
        refresh: () => {
          fullHistory.refresh();
          comparableHistory.refresh();
        },
      }
    : fullHistory;
  const setComparison = (enabled: boolean) => {
    const url = new URL(window.location.href);
    if (enabled) url.searchParams.set('historyComparison', 'comparable');
    else url.searchParams.delete('historyComparison');
    window.history.replaceState(null, '', url.pathname + url.search);
  };
  const result = history.data;
  const [table, setTable] = useState('positions');
  const [pageState, setPageState] = useState({ key: '', page: 0 });
  const pageKey = JSON.stringify([
    family,
    entity,
    query,
    table,
    comparableMode,
  ]);
  const page = pageState.key === pageKey ? pageState.page : 0;
  const pageSize = 12;
  const rows =
    table === 'positions'
      ? (result?.positions ?? [])
      : (result?.points.toReversed() ?? []);
  const pageCount = Math.ceil(rows.length / pageSize);
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  const asOf = result?.asOf ?? controls.asOf ?? controls.to;
  const observations =
    result?.positions
      .map((position) => position.latest)
      .filter((value) => value !== null) ?? [];
  const markDates = observations.map((mark) => mark.effectiveDate).sort();
  const staleCount = observations.filter(
    (mark) =>
      Date.parse(asOf) - Date.parse(mark.effectiveDate) > 100 * 86400000,
  ).length;
  const latestDate = markDates.at(-1);
  const oldestDate = markDates[0];
  const comparable = result?.comparison.comparable;
  const format = (value: string | null | undefined, compact = false) =>
    historyAmount(value, controls.currency, compact);
  const attention = workspace.tasks
    .filter(
      (task) =>
        (family === 'all' || task.familyId === family) &&
        (taskStatus[task.id] ?? task.status) !== 'Done' &&
        (entity === 'all' ||
          workspace.holdings.some(
            (h) => h.id === task.holdingId && h.entityId === entity,
          )),
    )
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 4);
  const scopeHoldings = useMemo(
    () => new Map(workspace.holdings.map((holding) => [holding.id, holding])),
    [workspace.holdings],
  );
  const allocations = useMemo(() => {
    const byClass = new Map<string, number>();
    for (const position of result?.positions ?? []) {
      const holding = scopeHoldings.get(position.holdingId);
      if (!holding || position.latest?.amount == null) continue;
      const name =
        position.metadataBasis === 'sourced_effective_details'
          ? position.metadata.assetClass
          : holding.assetClassStatus === 'inferred'
            ? holding.assetClass + ' · inferred'
            : holding.assetClass;
      byClass.set(
        name,
        (byClass.get(name) ?? 0) + Number(position.latest.amount),
      );
    }
    return [...byClass].map(([name, value]) => ({ name, value }));
  }, [result, scopeHoldings]);
  const updateDate = (key: 'from' | 'to', value: string) =>
    setControls({
      [key]: value,
      ...(key === 'to' ? { asOf: value } : {}),
      offset: 0,
      observation: '',
    });

  return (
    <>
      <PageHeading
        title="Portfolio"
        subtitle={
          result
            ? `Latest accepted values as of ${dateLabel(result.asOf)}`
            : 'Current positions, historical values and the evidence behind them.'
        }
      >
        <FamilyPicker value={family} onChange={onFamily} />
        <Button
          variant="outline"
          disabled={!result || history.refreshing || !!history.error}
          onClick={() => result && downloadHistoryCSV(result)}
        >
          <Download data-icon="inline-start" />
          Export this view
        </Button>
      </PageHeading>
      <div className={styles.stack}>
        <FieldGroup className={styles.filters}>
          <Field>
            <FieldLabel htmlFor="portfolio-history-from">From</FieldLabel>
            <Input
              id="portfolio-history-from"
              type="date"
              value={controls.from}
              onChange={(event) => updateDate('from', event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="portfolio-history-to">
              Through / as of
            </FieldLabel>
            <Input
              id="portfolio-history-to"
              type="date"
              value={controls.to || controls.asOf}
              onChange={(event) => updateDate('to', event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Legal entity</FieldLabel>
            <Picker
              label="Portfolio legal entity"
              value={entity}
              onChange={changeEntity}
              options={[
                { value: 'all', label: 'All selected entities' },
                ...entities.map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
          </Field>
          <Field>
            <FieldLabel>Value currency</FieldLabel>
            <Picker
              label="Portfolio value currency"
              value={controls.currency}
              onChange={(value) =>
                setControls({
                  currency: value as typeof controls.currency,
                  observation: '',
                  offset: 0,
                })
              }
              options={['EUR', 'USD', 'GBP', 'CHF'].map((value) => ({
                value,
                label:
                  value === 'EUR'
                    ? 'EUR · retained FX'
                    : value + ' · native records',
              }))}
            />
          </Field>
          <div className={styles.actions}>
            <Button
              variant="outline"
              onClick={() =>
                setControls({
                  from: '',
                  to: '',
                  asOf: '',
                  knownAt: '',
                  offset: 0,
                  observation: '',
                })
              }
            >
              All time
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh portfolio history"
              onClick={history.refresh}
              disabled={history.refreshing}
            >
              <RefreshCw />
            </Button>
          </div>
        </FieldGroup>
        {comparableMode ? (
          <Alert>
            <AlertDescription>
              {!comparableIds.length && !fullHistory.loading
                ? 'No holdings have comparable accepted values at both ends of this period. Choose another period or return to all selected holdings.'
                : comparableReady
                  ? `Comparing the same ${comparableIds.length} ${comparableIds.length === 1 ? 'holding' : 'holdings'} with values at both ends of the selected period. Figures, chart, table and export use this selection.`
                  : 'Updating the comparable selection from the same financial revision.'}
              <Button variant="link" onClick={() => setComparison(false)}>
                Show all selected holdings
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {history.error ? (
          <Alert variant="destructive">
            <AlertTitle>History needs attention</AlertTitle>
            <AlertDescription>
              {history.error}
              <Button variant="link" onClick={history.refresh}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {history.loading ? (
          <>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-96 w-full" />
          </>
        ) : result ? (
          <>
            <div className="metrics-row" style={{ margin: 0 }}>
              <Metric
                label={
                  result.summary.coverage.complete
                    ? 'Reported portfolio value'
                    : 'Known reported value'
                }
                value={
                  result.summary.knownAmount === null
                    ? 'Not reported'
                    : format(result.summary.knownAmount, true)
                }
                note={`${result.summary.coverage.knownCount} of ${result.summary.coverage.totalCount} holdings valued · ${controls.currency}`}
                help="Accepted values available at the selected date. Missing valuations are excluded from the known subtotal and remain visible in coverage."
              />
              <Metric
                label="Comparable value change"
                value={
                  comparable?.changeAmount == null
                    ? 'Unavailable'
                    : format(comparable.changeAmount, true)
                }
                note={
                  comparable?.holdingCount
                    ? `${comparable.holdingCount} ${comparable.holdingCount === 1 ? 'holding' : 'holdings'} with values at both period ends`
                    : 'Two comparable observations required'
                }
                help="Change in the same holdings’ reported values. Cash movements can affect this number; it is not an investment return."
              />
              <Metric
                label="Latest valuation"
                value={latestDate ? dateLabel(latestDate) : 'Not reported'}
                note={
                  oldestDate && oldestDate !== latestDate
                    ? 'Oldest included mark · ' + dateLabel(oldestDate)
                    : 'Source effective date'
                }
              />
              <Metric
                label="Valuation coverage"
                value={`${result.summary.coverage.knownCount} / ${result.summary.coverage.totalCount}`}
                note={
                  staleCount
                    ? `${staleCount} marks older than 100 days`
                    : result.summary.coverage.unknownCount
                      ? `${result.summary.coverage.unknownCount} holdings need a source value`
                      : 'Every selected holding has a dated value'
                }
              />
            </div>
            <Panel
              title={
                comparableMode
                  ? 'History of comparable holdings'
                  : 'Portfolio history'
              }
              subtitle={
                result.query.cohort === 'historical'
                  ? 'Positions owned on each date · sourced ownership where available'
                  : 'History of current positions · a fixed selection across time'
              }
              action={
                <div className={styles.actions}>
                  <Badge variant="outline">
                    {result.query.knowledge === 'as_known'
                      ? 'Knowledge cutoff applied'
                      : 'Latest accepted history'}
                  </Badge>
                  {!comparableMode ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!comparableIds.length || fullHistory.refreshing}
                      onClick={() => setComparison(true)}
                    >
                      Compare same holdings
                    </Button>
                  ) : null}
                </div>
              }
            >
              {result.points.length ? (
                <HistoryValueChart
                  points={result.points.map((point) => ({
                    id: point.date,
                    date: point.date,
                    amount: point.amount,
                    carried: point.coverage.carriedCount > 0,
                  }))}
                  currency={controls.currency}
                  selectedId={controls.asOf || undefined}
                  onSelect={(date) => {
                    setControls({
                      asOf: date,
                      to: date,
                      observation: '',
                      offset: 0,
                    });
                    setTable('positions');
                  }}
                />
              ) : (
                <Empty className={styles.empty}>
                  <EmptyHeader>
                    <EmptyTitle>
                      No accepted history in this selection
                    </EmptyTitle>
                    <EmptyDescription>
                      Choose another period or accept a sourced valuation from
                      Documents & review.
                    </EmptyDescription>
                  </EmptyHeader>
                  <Button
                    variant="outline"
                    onClick={() => onNavigate('agents')}
                  >
                    Open documents
                  </Button>
                </Empty>
              )}
              <div className={styles.coverage}>
                <Clock3 size={14} />
                <p className={styles.note}>
                  Only complete totals are plotted. The table retains partial
                  subtotals and their coverage. Values carried between reports
                  use their original dates; changes can include cash movements.
                </p>
              </div>
              <Tabs value={table} onValueChange={setTable}>
                <TabsList variant="line" className={styles.tableTabs}>
                  <TabsTrigger value="positions">
                    Positions at selected date
                  </TabsTrigger>
                  <TabsTrigger value="totals">Historical totals</TabsTrigger>
                  <TabsTrigger value="participation">
                    Families × deals
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="positions" className={styles.tableWrap}>
                  <Table className={styles.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Investment</TableHead>
                        <TableHead className={styles.numeric}>
                          Reported value
                        </TableHead>
                        <TableHead>Valuation date</TableHead>
                        <TableHead className={styles.numeric}>
                          Previous mark change
                        </TableHead>
                        <TableHead>Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.positions
                        .slice(safePage * pageSize, (safePage + 1) * pageSize)
                        .map((position) => (
                          <TableRow key={position.holdingId}>
                            <TableCell>
                              <button
                                className={styles.investment}
                                onClick={() => onHolding(position.holdingId)}
                              >
                                {position.metadata.name}
                                <small>
                                  {workspace.families.find(
                                    (f) => f.id === position.familyId,
                                  )?.name ?? position.familyId}
                                  {position.ownership === 'closed'
                                    ? ' · Exited ' +
                                      dateLabel(position.economicClosedAt!)
                                    : position.ownership === 'not_yet_opened'
                                      ? ' · Not yet acquired'
                                      : ''}
                                </small>
                              </button>
                            </TableCell>
                            <TableCell className={styles.numeric}>
                              {format(position.latest?.amount)}
                            </TableCell>
                            <TableCell>
                              {position.latest
                                ? dateLabel(position.latest.effectiveDate)
                                : 'Not reported'}
                              {position.latest &&
                              position.latest.effectiveDate !== result.asOf ? (
                                <small>Last reported observation</small>
                              ) : null}
                            </TableCell>
                            <TableCell className={styles.numeric}>
                              {position.changeAmount == null
                                ? '—'
                                : format(position.changeAmount)}
                              {position.previousComparable ? (
                                <small>
                                  Since{' '}
                                  {dateLabel(
                                    position.previousComparable.effectiveDate,
                                  )}
                                </small>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              {position.latest?.sourceId ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    onSource(position.latest!.sourceId!)
                                  }
                                >
                                  <FileText data-icon="inline-start" />
                                  View source
                                </Button>
                              ) : (
                                'Source unavailable'
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </TabsContent>
                <TabsContent value="totals" className={styles.tableWrap}>
                  <Table className={styles.table}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Effective date</TableHead>
                        <TableHead className={styles.numeric}>
                          Full value
                        </TableHead>
                        <TableHead className={styles.numeric}>
                          Known subtotal
                        </TableHead>
                        <TableHead>Coverage</TableHead>
                        <TableHead>Inspect</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.points
                        .toReversed()
                        .slice(safePage * pageSize, (safePage + 1) * pageSize)
                        .map((point) => (
                          <TableRow key={point.date}>
                            <TableCell>{dateLabel(point.date)}</TableCell>
                            <TableCell className={styles.numeric}>
                              {point.amount == null
                                ? 'Incomplete'
                                : format(point.amount)}
                            </TableCell>
                            <TableCell className={styles.numeric}>
                              {format(point.knownAmount)}
                            </TableCell>
                            <TableCell>
                              {point.coverage.knownCount} of{' '}
                              {point.coverage.totalCount} holdings
                              <small>
                                {point.coverage.carriedCount
                                  ? `${point.coverage.carriedCount} earlier marks carried forward`
                                  : 'Observations on this date'}
                              </small>
                            </TableCell>
                            <TableCell>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  updateDate('to', point.date);
                                  setTable('positions');
                                }}
                              >
                                Inspect date
                                <ChevronRight data-icon="inline-end" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </TabsContent>
                <TabsContent value="participation" className={styles.tableWrap}>
                  <ParticipationHeatmap
                    query={{
                      ...scopedQuery,
                      ...(comparableMode && comparableIds.length
                        ? { holdingIds: comparableIds }
                        : {}),
                    }}
                    expectedRevision={result.revision}
                    onHolding={onHolding}
                    onSource={onSource}
                    onInvestments={() => onNavigate('investments')}
                  />
                </TabsContent>
              </Tabs>
              {table !== 'participation' ? (
                <div className={styles.pagination}>
                  <span className={styles.note}>
                    {rows.length
                      ? `${safePage * pageSize + 1}–${Math.min((safePage + 1) * pageSize, rows.length)} of ${rows.length}`
                      : 'No records'}
                  </span>
                  <div className={styles.actions}>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!safePage}
                      onClick={() =>
                        setPageState({ key: pageKey, page: safePage - 1 })
                      }
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage + 1 >= pageCount}
                      onClick={() =>
                        setPageState({ key: pageKey, page: safePage + 1 })
                      }
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </Panel>
            <div className={styles.lower}>
              <Panel
                title="What changed?"
                subtitle={
                  result.comparison.from && result.comparison.to
                    ? dateLabel(result.comparison.from) +
                      ' to ' +
                      dateLabel(result.comparison.to)
                    : 'Choose a period with two observations'
                }
              >
                <dl className={styles.breakdown}>
                  <dt>Comparable holdings</dt>
                  <dd>{comparable?.holdingCount ?? 0}</dd>
                  <dt>Opening reported value</dt>
                  <dd>{format(comparable?.openingAmount)}</dd>
                  <dt>Closing reported value</dt>
                  <dd>{format(comparable?.closingAmount)}</dd>
                  <dt>Change in reported value</dt>
                  <dd>{format(comparable?.changeAmount)}</dd>
                </dl>
                <p className={styles.coverage + ' ' + styles.note}>
                  Cash-flow and FX attribution requires complete supporting
                  records. This change is not labelled profit or return.
                </p>
                <div className={styles.coverage}>
                  <TextAction onClick={() => onNavigate('reports')}>
                    Analyze a reconciled period
                  </TextAction>
                </div>
              </Panel>
              <Panel
                title="Needs your attention"
                action={
                  <TextAction onClick={() => onNavigate('exceptions')}>
                    View all
                  </TextAction>
                }
              >
                {attention.length ? (
                  <div className={styles.attention}>
                    {attention.map((task) => (
                      <button
                        key={task.id}
                        onClick={() => onSource(task.sourceId)}
                      >
                        <span>
                          <strong>{task.title}</strong>
                          <small>
                            {task.category} · Due {dateLabel(task.dueDate)}
                          </small>
                        </span>
                        <ChevronRight />
                      </button>
                    ))}
                  </div>
                ) : (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>No open tasks in this selection</EmptyTitle>
                      <EmptyDescription>
                        Missing reports and unresolved records are kept in one
                        shared attention list.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </Panel>
            </div>
            <Panel
              title="Allocation of reported values"
              subtitle={
                result.positions.some(
                  (p) => p.metadataBasis === 'current_register',
                )
                  ? 'Selected-date values. Current classifications are used where historical classifications are unknown.'
                  : 'Selected-date values grouped by their sourced historical classifications.'
              }
            >
              {allocations.length ? (
                <AllocationBars data={allocations} horizontal />
              ) : (
                <p className={styles.coverage + ' ' + styles.note}>
                  Accept a source value to build this allocation.
                </p>
              )}
            </Panel>
            <details className={styles.advanced}>
              <summary>History basis and knowledge cutoff</summary>
              <p>
                {result.basis}. Non-EUR selections show native source records in
                that currency; no new FX rate is assumed.
              </p>
              <Field>
                <FieldLabel>Position selection</FieldLabel>
                <Picker
                  label="Historical position selection"
                  value={controls.cohort}
                  onChange={(value) =>
                    setControls({
                      cohort: value as typeof controls.cohort,
                      observation: '',
                      offset: 0,
                    })
                  }
                  options={[
                    {
                      value: 'historical',
                      label: 'Owned on each date · sourced history',
                    },
                    {
                      value: 'current',
                      label: 'Current holdings · fixed selection',
                    },
                  ]}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="portfolio-known-at">
                  Only information accepted by (UTC)
                </FieldLabel>
                <Input
                  id="portfolio-known-at"
                  type="datetime-local"
                  value={controls.knownAt ? controls.knownAt.slice(0, 16) : ''}
                  onChange={(event) =>
                    setControls({
                      knownAt: event.target.value
                        ? event.target.value + ':00.000Z'
                        : '',
                      observation: '',
                      offset: 0,
                    })
                  }
                />
              </Field>
              <ul>
                {result.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </details>
          </>
        ) : !history.error && state.identity && !comparableMode ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Build your portfolio history</EmptyTitle>
              <EmptyDescription>
                Connect a source folder, then accept its financial observations.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
    </>
  );
}
