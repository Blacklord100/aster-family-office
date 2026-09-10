'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  RefreshCw,
  CalendarDays,
  ArrowUpRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  TableHead,
} from '@/components/ui/table';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type {
  HistoryObservation,
  PortfolioHistoryResponse,
} from '@/lib/portfolio-history-contract';
import {
  historyCsv,
  historyDateTime,
  historyMoney,
} from '@/lib/history-presentation';
import { rangeStartDate } from '@/lib/date-ranges';
import { dateLabel, Picker, Status } from './primitives';
import { EvidencePanel } from './evidence';
import { useWorkspace } from './workspace-context';
import type { HistoryControls } from './use-history-controls';
import styles from './investment-history.module.css';

export type HistoryChartPoint = {
  id: string;
  date: string;
  amount: string | null;
  carried?: boolean;
};
export function HistoryValueChart({
  points,
  currency,
  onSelect,
  selectedId,
}: {
  points: readonly HistoryChartPoint[];
  currency: string;
  onSelect?: (id: string) => void;
  selectedId?: string;
}) {
  const [focus, setFocus] = useState<{
    id: string;
    selection: string | undefined;
  } | null>(null);
  const labelId = useId();
  const plotted = useMemo(
    () =>
      points
        .map((point) => ({
          ...point,
          timestamp: Date.parse(point.date + 'T00:00:00Z'),
          geometry:
            point.amount !== null && Number.isFinite(Number(point.amount))
              ? Number(point.amount)
              : null,
        }))
        .filter((point) => Number.isFinite(point.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp),
    [points],
  );
  const available = plotted.filter((point) => point.geometry !== null);
  const active =
    available.find(
      (point) =>
        point.id ===
        ((focus?.selection === selectedId ? focus?.id : undefined) ||
          selectedId),
    ) ?? available.at(-1);
  const single = plotted.length === 1;
  const domain: [number | string, number | string] = single
    ? [
        plotted[0].timestamp - 15 * 86400000,
        plotted[0].timestamp + 15 * 86400000,
      ]
    : ['dataMin', 'dataMax'];
  const shortDate = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString('en-GB', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    });
  return (
    <div className={styles.chartWrap}>
      <figure
        className={styles.chart}
        aria-label={`Reported value history in ${currency}`}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 900, height: 310 }}
        >
          <LineChart
            data={plotted}
            margin={{ top: 22, right: 24, bottom: 12, left: 12 }}
            accessibilityLayer={false}
          >
            <CartesianGrid
              stroke="var(--border)"
              strokeDasharray="3 4"
              vertical={false}
            />
            <XAxis
              type="number"
              scale="time"
              dataKey="timestamp"
              domain={domain}
              ticks={single ? [plotted[0].timestamp] : undefined}
              axisLine={false}
              tickLine={false}
              tickMargin={13}
              minTickGap={35}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickFormatter={shortDate}
            />
            <YAxis
              width={65}
              domain={[0, 'auto']}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickFormatter={(value: number) =>
                new Intl.NumberFormat('en-GB', {
                  notation: 'compact',
                  maximumFractionDigits: 1,
                }).format(value)
              }
            />
            <Tooltip
              cursor={{ stroke: 'var(--border)', strokeDasharray: '4 4' }}
              content={({ active: hovering, payload }) => {
                const point = payload?.[0]?.payload as
                  | (typeof plotted)[number]
                  | undefined;
                return hovering && point ? (
                  <div className={styles.tooltip}>
                    {dateLabel(point.date)}
                    <strong>{historyMoney(point.amount, currency)}</strong>
                    {point.carried ? (
                      <span>Carried forward from an earlier report</span>
                    ) : null}
                  </div>
                ) : null;
              }}
            />
            <Line
              type="stepAfter"
              dataKey="geometry"
              connectNulls={false}
              stroke="#8064e5"
              strokeWidth={1.8}
              isAnimationActive={false}
              activeDot={false}
              dot={(properties) => {
                const point = properties.payload as (typeof plotted)[number];
                if (point.geometry === null) return <g key={point.id} />;
                const pinned = point.id === active?.id;
                return (
                  <circle
                    key={point.id}
                    cx={properties.cx}
                    cy={properties.cy}
                    r={pinned ? 5.5 : 3.7}
                    fill={pinned ? '#8064e5' : 'var(--card)'}
                    stroke="#8064e5"
                    strokeWidth={1.7}
                    opacity={point.carried ? 0.5 : 1}
                    className={onSelect ? styles.chartDot : undefined}
                    role={onSelect ? 'button' : undefined}
                    aria-label={`${dateLabel(point.date)}, ${historyMoney(point.amount, currency)}${point.carried ? ', carried forward' : ''}`}
                    onClick={() => {
                      setFocus({ id: point.id, selection: selectedId });
                      onSelect?.(point.id);
                    }}
                  />
                );
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </figure>
      {onSelect && available.length ? (
        <div className="sr-only focus-within:not-sr-only px-4">
          <label htmlFor={labelId + '-selection'}>
            Select history observation with the arrow keys
          </label>
          <input
            id={labelId + '-selection'}
            type="range"
            min={0}
            max={available.length - 1}
            step={1}
            value={Math.max(
              0,
              available.findIndex((point) => point.id === active?.id),
            )}
            aria-valuetext={
              active
                ? dateLabel(active.date) +
                  ', ' +
                  historyMoney(active.amount, currency)
                : ''
            }
            onChange={(event) =>
              setFocus({
                id: available[Number(event.target.value)].id,
                selection: selectedId,
              })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' && active) {
                event.preventDefault();
                onSelect(active.id);
              }
            }}
          />
        </div>
      ) : null}
      <div className={styles.chartMeta} id={labelId}>
        <p>
          {single
            ? 'One reported observation. '
            : 'Steps carry the last known mark between reports. '}
          Value change includes possible cash movements; it is not investment
          return.
        </p>
        {active && onSelect ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onSelect(active.id)}
            aria-label="Inspect selected history point"
          >
            {dateLabel(active.date)} · {historyMoney(active.amount, currency)}{' '}
            <ArrowUpRight data-icon="inline-end" />
          </Button>
        ) : null}
      </div>
      {onSelect ? (
        <p className="sr-only">
          Use left and right arrow keys to select an observation, then Enter to
          inspect it. Every observation is also available in the table.
        </p>
      ) : null}
    </div>
  );
}

function ObservationStatus({ row }: { row: HistoryObservation }) {
  return (
    <Status
      tone={
        row.status === 'current'
          ? 'success'
          : row.status === 'superseded'
            ? 'neutral'
            : 'warning'
      }
    >
      {row.status === 'current'
        ? 'Accepted'
        : row.status === 'superseded'
          ? 'Superseded'
          : row.status === 'conflicted'
            ? 'Conflict'
            : 'Legacy record'}
      {row.version > 1 ? ` · v${row.version}` : ''}
    </Status>
  );
}
function Change({ row }: { row: HistoryObservation }) {
  return (
    <>
      <strong
        className={
          row.changeAmount?.startsWith('-')
            ? styles.negative
            : row.changeAmount !== null
              ? styles.positive
              : undefined
        }
      >
        {row.changeAmount === null
          ? '—'
          : historyMoney(row.changeAmount, row.displayCurrency)}
      </strong>
      <small>
        {row.changePercent === null
          ? 'No comparable prior observation'
          : `${row.changePercent > 0 ? '+' : ''}${row.changePercent.toFixed(2)}% value change`}
      </small>
    </>
  );
}

export function InvestmentHistory({
  data,
  loading,
  refreshing,
  error,
  onRefresh,
  controls,
  onControls,
  onSource,
  onHolding,
}: {
  data: PortfolioHistoryResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  onRefresh: () => void;
  controls: HistoryControls;
  onControls: (patch: Partial<HistoryControls>) => void;
  onSource: (id: string) => void;
  onHolding: (id: string) => void;
}) {
  const controlId = useId();
  const [custom, setCustom] = useState(false);
  const { state } = useWorkspace();
  const organizationId = state.identity?.organizationId;
  const exportScope = JSON.stringify([
    organizationId,
    state.identity?.dataScope,
  ]);
  const [exportState, setExportState] = useState({
    scope: '',
    busy: false,
    error: '',
  });
  const exportController = useRef<AbortController | null>(null);
  const exporting = exportState.scope === exportScope && exportState.busy;
  const exportError =
    exportState.scope === exportScope ? exportState.error : '';
  useEffect(
    () => () => {
      exportController.current?.abort();
    },
    [exportScope],
  );
  const selected = data?.selectedObservation ?? null;
  useEffect(() => {
    if (
      controls.observation &&
      data?.selectedOffset != null &&
      data.selectedOffset !== controls.offset
    )
      onControls({ offset: data.selectedOffset });
  }, [controls.observation, controls.offset, data?.selectedOffset, onControls]);
  const chartPoints =
    data?.points
      .filter((point) => point.observationIds.length > 0)
      .map((point) => ({
        id: point.observationIds[0] ?? 'date:' + point.date,
        date: point.date,
        amount: point.amount,
        carried: point.coverage.carriedCount > 0,
      })) ?? [];
  const adjust = (patch: Partial<HistoryControls>) =>
    onControls({ ...patch, offset: 0, observation: '' });
  async function exportAll() {
    if (!data || exporting || !organizationId) return;
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExportState({ scope: exportScope, busy: true, error: '' });
    try {
      const rows: HistoryObservation[] = [];
      let offset = 0;
      do {
        const query = {
          ...data!.query,
          observationId: undefined,
          asOf: data!.asOf,
          offset,
          limit: 100,
        };
        const response = await fetch(
          '/api/portfolio-history?' +
            new URLSearchParams({ query: JSON.stringify(query) }),
          {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'x-aster-organization': organizationId },
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(20_000),
            ]),
          },
        );
        const next = await response.json();
        if (!response.ok)
          throw new Error(next?.message ?? 'History export failed.');
        if (
          next.revision !== data!.revision ||
          next.financeRevision !== data!.financeRevision
        )
          throw new Error(
            'The records changed during export. Refresh and export again.',
          );
        controller.signal.throwIfAborted();
        rows.push(...next.observations);
        if (rows.length > data!.limits.maxObservations)
          throw new Error(
            'History exceeds the bounded export limit. Narrow the date range.',
          );
        if (
          next.page.hasMore &&
          (!Number.isInteger(next.page.nextOffset) ||
            next.page.nextOffset <= offset)
        )
          throw new Error(
            'History returned an incomplete page. Refresh and export again.',
          );
        offset =
          next.page.hasMore && next.page.nextOffset !== null
            ? next.page.nextOffset
            : -1;
      } while (offset >= 0);
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob([historyCsv(rows)], { type: 'text/csv;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'aster-investment-history.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      if (!controller.signal.aborted)
        setExportState({
          scope: exportScope,
          busy: false,
          error:
            cause instanceof Error ? cause.message : 'History export failed.',
        });
    } finally {
      if (!controller.signal.aborted)
        setExportState((current) => ({ ...current, busy: false }));
    }
  }
  return (
    <section className={styles.panel} aria-label="Investment valuation history">
      <div className={styles.heading}>
        <div>
          <h2>Valuation history</h2>
          <p>Reported observations · select a value to inspect its source</p>
        </div>
        <div className={styles.controls}>
          <fieldset className={styles.ranges} aria-label="History range">
            <Button
              size="sm"
              variant={!controls.from && !controls.to ? 'secondary' : 'ghost'}
              aria-pressed={!controls.from && !controls.to}
              onClick={() => {
                setCustom(false);
                adjust({ from: '', to: '' });
              }}
            >
              All time
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCustom(false);
                adjust({
                  from: rangeStartDate(
                    controls.asOf || new Date().toISOString().slice(0, 10),
                    '1Y',
                  ),
                  to: controls.asOf || '',
                });
              }}
            >
              1Y
            </Button>
            <Button
              size="sm"
              variant={custom ? 'secondary' : 'ghost'}
              aria-expanded={custom}
              onClick={() => setCustom((value) => !value)}
            >
              Custom <CalendarDays data-icon="inline-end" />
            </Button>
          </fieldset>
          <Picker
            label="History currency"
            value={controls.currency}
            onChange={(value) =>
              adjust({ currency: value as HistoryControls['currency'] })
            }
            options={['EUR', 'USD', 'GBP', 'CHF'].map((value) => ({
              value,
              label: value,
            }))}
          />
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh investment history"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw className={refreshing ? 'animate-spin' : ''} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || exporting || !!error}
            onClick={() => void exportAll()}
          >
            <Download data-icon="inline-start" />
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </div>
      </div>
      {custom ||
      controls.from ||
      controls.to ||
      controls.asOf ||
      controls.knownAt ? (
        <div className={styles.fields}>
          <label className={styles.field} htmlFor={controlId + '-from'}>
            From
            <Input
              id={controlId + '-from'}
              type="date"
              aria-label="History from date"
              value={controls.from}
              onChange={(event) => adjust({ from: event.target.value })}
            />
          </label>
          <label className={styles.field} htmlFor={controlId + '-to'}>
            Through
            <Input
              id={controlId + '-to'}
              type="date"
              aria-label="History through date"
              value={controls.to}
              onChange={(event) => adjust({ to: event.target.value })}
            />
          </label>
          <label className={styles.field} htmlFor={controlId + '-asOf'}>
            Position as of
            <Input
              id={controlId + '-asOf'}
              type="date"
              aria-label="History as of date"
              value={controls.asOf}
              onChange={(event) => adjust({ asOf: event.target.value })}
            />
          </label>
        </div>
      ) : null}
      {controls.knownAt ? (
        <div className={styles.notice}>
          <Alert>
            <AlertTitle>
              As known at {historyDateTime(controls.knownAt)}
            </AlertTitle>
            <AlertDescription>
              Only records accepted by this cutoff are included.{' '}
              <Button
                size="sm"
                variant="link"
                onClick={() => adjust({ knownAt: '' })}
              >
                Use latest accepted knowledge
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {error || exportError ? (
        <div className={styles.notice}>
          <Alert variant="destructive">
            <AlertTitle>History needs attention</AlertTitle>
            <AlertDescription>
              {error || exportError}
              {data && error ? ' Showing the last loaded revision.' : ''}{' '}
              <Button size="sm" variant="outline" onClick={onRefresh}>
                Retry history
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      {loading && !data ? (
        <div className="p-6" aria-label="Loading investment history">
          <Skeleton className="h-72 w-full" />
        </div>
      ) : data?.points.some((point) => point.amount !== null) ? (
        <HistoryValueChart
          points={chartPoints}
          currency={controls.currency}
          selectedId={controls.observation}
          onSelect={(id) => onControls({ observation: id })}
        />
      ) : (
        <div className={styles.empty}>
          <FileText />
          <h3>
            {error
              ? 'Valuation history unavailable'
              : data?.page.total
                ? 'No comparable values in this currency'
                : 'No reported observations in this selection'}
          </h3>
          <p>
            {data?.page.total
              ? 'EUR uses the stored historical FX basis. Other currencies show matching original source amounts only.'
              : 'Accepted dated valuations appear here. Missing history is not treated as zero.'}
          </p>
        </div>
      )}
      {data?.gaps.length ? (
        <details className={styles.notice}>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Coverage & calculation notes ({data.gaps.length})
          </summary>
          <ul className="mt-3 list-disc space-y-2 pl-4 text-xs text-muted-foreground">
            {data.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <div className={styles.tableHead}>
        <h3>Historical observations</h3>
        <label
          className={styles.versionToggle}
          htmlFor={controlId + '-versions'}
        >
          <Checkbox
            id={controlId + '-versions'}
            checked={controls.versions}
            onCheckedChange={(checked) =>
              adjust({ versions: checked === true })
            }
          />
          Include earlier revisions
        </label>
      </div>
      <div className={styles.desktopTable}>
        <Table className={styles.table}>
          <TableHeader>
            <TableRow>
              <TableHead>Effective date</TableHead>
              <TableHead>Reported value</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Basis & revision</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.observations.map((row) => (
              <TableRow
                key={row.id}
                className={
                  row.id === controls.observation ? styles.selected : undefined
                }
                aria-selected={row.id === controls.observation}
              >
                <TableCell>
                  <button
                    className={styles.dateButton}
                    onClick={() => onControls({ observation: row.id })}
                  >
                    {dateLabel(row.effectiveDate)}
                  </button>
                  <small>
                    Imported{' '}
                    {row.importedAt
                      ? dateLabel(row.importedAt.slice(0, 10))
                      : 'date not recorded'}
                  </small>
                </TableCell>
                <TableCell>
                  <strong>
                    {historyMoney(row.amount, row.displayCurrency)}
                  </strong>
                  <small>
                    Original:{' '}
                    {historyMoney(row.nativeAmount, row.currency ?? '')}
                  </small>
                </TableCell>
                <TableCell>
                  <Change row={row} />
                </TableCell>
                <TableCell>
                  {row.valuationBasis}
                  <small>
                    <ObservationStatus row={row} />
                  </small>
                  {row.fx ? (
                    <small>
                      FX {row.fx.rateToEUR} · {dateLabel(row.fx.date)}
                    </small>
                  ) : null}
                </TableCell>
                <TableCell>
                  <button
                    className={styles.sourceButton}
                    onClick={() => onControls({ observation: row.id })}
                  >
                    <FileText />
                    <span>{row.filename ?? 'Inspect legacy provenance'}</span>
                    <ChevronRight />
                  </button>
                  {row.correctionOf ? (
                    <small>Correction · earlier version retained</small>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div
        className={styles.mobileRows}
        aria-label="Historical observation records"
      >
        {data?.observations.map((row) => (
          <article
            key={row.id}
            className={
              styles.mobileRow +
              (row.id === controls.observation ? ' ' + styles.selected : '')
            }
          >
            <div className={styles.mobileRowHeader}>
              <button
                className={styles.dateButton}
                onClick={() => onControls({ observation: row.id })}
              >
                {dateLabel(row.effectiveDate)}
              </button>
              <ObservationStatus row={row} />
            </div>
            <dl className={styles.mobileValues}>
              <div>
                <dt>Reported value</dt>
                <dd>{historyMoney(row.amount, row.displayCurrency)}</dd>
              </div>
              <div>
                <dt>Change</dt>
                <dd>
                  <Change row={row} />
                </dd>
              </div>
              <div>
                <dt>Original amount</dt>
                <dd>{historyMoney(row.nativeAmount, row.currency ?? '')}</dd>
              </div>
              <div>
                <dt>Basis</dt>
                <dd>{row.valuationBasis}</dd>
              </div>
            </dl>
            <button
              className={styles.sourceButton}
              onClick={() => onControls({ observation: row.id })}
            >
              <FileText />
              <span>{row.filename ?? 'Inspect legacy provenance'}</span>
              <ChevronRight />
            </button>
          </article>
        ))}
      </div>
      {data && !data.observations.length ? (
        <div className={styles.empty}>
          <p>No observations match these filters.</p>
        </div>
      ) : null}
      <div className={styles.footer}>
        <span>
          {data
            ? `${data.page.total ? data.page.offset + 1 : 0}–${Math.min(data.page.offset + data.observations.length, data.page.total)} of ${data.page.total} observations`
            : 'Observation count unavailable'}
          {data ? ` · Revision ${data.revision}` : ''}
        </span>
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || !data.page.offset || refreshing}
            onClick={() =>
              onControls({
                offset: Math.max(0, controls.offset - 20),
                observation: '',
              })
            }
          >
            <ChevronLeft data-icon="inline-start" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={
              !data?.page.hasMore || data.page.nextOffset === null || refreshing
            }
            onClick={() =>
              data?.page.nextOffset != null &&
              onControls({ offset: data.page.nextOffset, observation: '' })
            }
          >
            Next
            <ChevronRight data-icon="inline-end" />
          </Button>
        </div>
      </div>
      <Sheet
        open={!!controls.observation}
        onOpenChange={(open) => {
          if (!open) onControls({ observation: '' });
        }}
      >
        <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-[620px] gap-0">
          <SheetHeader className="border-b pr-12">
            <SheetTitle>Valuation observation</SheetTitle>
            <SheetDescription>
              {selected
                ? `${selected.investmentName} · ${dateLabel(selected.effectiveDate)}`
                : 'Source and revision details for the selected value'}
            </SheetDescription>
          </SheetHeader>
          <div className={styles.drawer}>
            {selected ? (
              <>
                <ObservationStatus row={selected} />
                <dl className={styles.drawerValues}>
                  <div>
                    <dt>Original amount</dt>
                    <dd>
                      {historyMoney(
                        selected.nativeAmount,
                        selected.currency ?? '',
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Reporting amount</dt>
                    <dd>
                      {historyMoney(selected.amount, selected.displayCurrency)}
                    </dd>
                  </div>
                  <div>
                    <dt>Effective date</dt>
                    <dd>{dateLabel(selected.effectiveDate)}</dd>
                  </div>
                  <div>
                    <dt>Imported at</dt>
                    <dd>{historyDateTime(selected.importedAt)}</dd>
                  </div>
                  <div>
                    <dt>Accepted / recorded at</dt>
                    <dd>{historyDateTime(selected.recordedAt)}</dd>
                  </div>
                  <div>
                    <dt>Valuation basis</dt>
                    <dd>{selected.valuationBasis}</dd>
                  </div>
                </dl>
                {selected.fx ? (
                  <div>
                    <h3 className={styles.drawerTitle}>
                      Historical currency conversion
                    </h3>
                    <p className={styles.note}>
                      1 {selected.currency} = {selected.fx.rateToEUR} EUR ·{' '}
                      {dateLabel(selected.fx.date)} · {selected.fx.source}. No
                      current market FX is substituted.
                    </p>
                  </div>
                ) : null}
                {selected.correctionOf || selected.supersededBy ? (
                  <div className={styles.correction}>
                    <strong>
                      {selected.supersededBy
                        ? 'A later accepted version supersedes this value.'
                        : 'This observation corrects an earlier version.'}
                    </strong>
                    <p>
                      {selected.correctionReason ||
                        'A correction reason is not retained on this earlier record.'}
                    </p>
                    <Button
                      size="sm"
                      variant="link"
                      onClick={() =>
                        onControls({
                          versions: true,
                          observation:
                            selected.supersededBy ||
                            selected.correctionOf ||
                            '',
                          offset: 0,
                        })
                      }
                    >
                      {selected.supersededBy
                        ? 'Inspect current version'
                        : 'Inspect earlier version'}
                    </Button>
                  </div>
                ) : null}
                {selected.sourceId ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => {
                        onControls({ observation: '' });
                        onSource(selected.sourceId!);
                      }}
                    >
                      <FileText data-icon="inline-start" />
                      Open source details
                    </Button>
                    <EvidencePanel
                      key={selected.sourceId}
                      sourceId={selected.sourceId}
                      embedded
                      onHolding={onHolding}
                    />
                  </>
                ) : (
                  <Alert>
                    <AlertTitle>Original source unavailable</AlertTitle>
                    <AlertDescription>
                      This retained legacy observation has incomplete
                      provenance. Its amount is not independently verified.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            ) : refreshing || loading ? (
              <Skeleton className="h-60" />
            ) : (
              <Alert>
                <AlertTitle>
                  {error
                    ? 'Observation could not be loaded'
                    : 'Observation unavailable in this selection'}
                </AlertTitle>
                <AlertDescription>
                  {error ||
                    'The selected record may be outside the date, currency or revision filters.'}
                  <Button size="sm" variant="outline" onClick={onRefresh}>
                    Refresh observation
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
