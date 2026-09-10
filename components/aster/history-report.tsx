'use client';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { comparableHistoryMatches } from '@/lib/portfolio-history-selection';
import { Download, Save, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  HistorySnapshot,
  ReportingResponse,
} from '@/lib/reporting-contract';
import { historyAmount, downloadHistoryCSV } from '@/lib/history-display';
import { usePortfolioHistory } from './use-portfolio-history';
import { useHistoryControls } from './use-history-controls';
import { useWorkspace } from './workspace-context';
import { HistoryValueChart } from './investment-history';
import { Panel, Picker, dateLabel } from './primitives';
import styles from './reporting.module.css';

export function HistoryReport({
  family,
  saved,
  onSaved,
  onSource,
}: {
  family: string;
  onFamily: (value: string) => void;
  saved?: HistorySnapshot;
  onSaved: (value: ReportingResponse) => void;
  onSource?: (id: string) => void;
}) {
  const { state, data: workspace, reload } = useWorkspace();
  const { query, controls, setControls } = useHistoryControls();
  const search = useSearchParams();
  const entity = workspace.entities.find(
    (row) =>
      row.id === search.get('historyEntity') &&
      (family === 'all' || row.familyId === family),
  );
  const comparableMode = search.get('historyComparison') === 'comparable';
  const scopedQuery = saved?.inputs.query ?? {
    ...query,
    ...(family === 'all' ? {} : { familyIds: [family] }),
    ...(entity ? { entityIds: [entity.id] } : {}),
  };
  const fullHistory = usePortfolioHistory(scopedQuery, !saved);
  const comparableIds =
    fullHistory.data?.comparison.comparable.holdingIds ?? [];
  const subsetHistory = usePortfolioHistory(
    {
      ...scopedQuery,
      ...(comparableIds.length ? { holdingIds: comparableIds } : {}),
    },
    !saved && comparableMode && comparableIds.length > 0,
  );
  const comparableReady = comparableHistoryMatches(
    fullHistory.data,
    subsetHistory.data,
  );
  const history =
    comparableMode && !saved
      ? {
          ...subsetHistory,
          data: comparableReady ? subsetHistory.data : null,
          loading:
            fullHistory.loading ||
            subsetHistory.loading ||
            (comparableIds.length > 0 &&
              !comparableReady &&
              !fullHistory.error &&
              !subsetHistory.error),
          error: fullHistory.error ?? subsetHistory.error,
          refresh: () => {
            fullHistory.refresh();
            subsetHistory.refresh();
          },
        }
      : fullHistory;
  function clearPortfolioScope() {
    const url = new URL(window.location.href);
    url.searchParams.delete('historyEntity');
    url.searchParams.delete('historyComparison');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const [accessDenied, setAccessDenied] = useState(false);
  const data = accessDenied ? null : (saved?.result ?? history.data);
  const active = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      inFlight.current?.abort();
    };
  }, []);
  const [name, setName] = useState('Portfolio history');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const retry = useRef<{ intent: string; key: string } | null>(null);
  async function save() {
    if (!data || busy || !state.identity?.organizationId) return;
    setBusy(true);
    setError('');
    const intent = JSON.stringify({ query: data.query, name: name.trim() });
    if (retry.current?.intent !== intent)
      retry.current = { intent, key: crypto.randomUUID() };
    const controller = new AbortController();
    inFlight.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch('/api/reporting', {
        method: 'POST',
        signal: controller.signal,
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'x-aster-organization': state.identity!.organizationId,
        },
        body: JSON.stringify({
          action: 'saveHistory',
          query: data.query,
          expectedRevision: data.revision,
          name: name.trim(),
          idempotencyKey: retry.current.key,
        }),
      });
      const result = await response.json();
      if (!active.current || controller.signal.aborted) return;
      if (!response.ok) {
        if ([401, 403].includes(response.status)) {
          setAccessDenied(true);
          reload();
        }
        throw new Error(
          result.message ?? 'The history snapshot could not be saved.',
        );
      }
      retry.current = null;
      onSaved(result);
      reload();
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error && cause.name !== 'AbortError'
            ? cause.message
            : 'The save took too long. Retry the same snapshot safely.',
        );
    } finally {
      clearTimeout(timeout);
      if (inFlight.current === controller) inFlight.current = null;
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className={styles.stack}>
      {!saved && (entity || comparableMode) ? (
        <Alert>
          <AlertTitle>Portfolio selection preserved</AlertTitle>
          <AlertDescription>
            {entity ? `Legal entity: ${entity.name}. ` : ''}
            {comparableMode
              ? comparableIds.length
                ? `The same ${comparableIds.length} comparable holdings are selected.`
                : 'No holdings have comparable values at both ends of this period.'
              : 'All holdings in the selected entity are included.'}
            <Button variant="link" onClick={clearPortfolioScope}>
              Clear Portfolio scope filters
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {!saved ? (
        <Panel
          title="Snapshot selection"
          subtitle="The same dated positions, historical totals and coverage used on Portfolio."
        >
          <FieldGroup className={styles.filters + ' ' + styles.historyFilters}>
            <Field>
              <FieldLabel htmlFor="history-report-from">From</FieldLabel>
              <Input
                id="history-report-from"
                type="date"
                value={controls.from}
                onChange={(event) =>
                  setControls({
                    from: event.target.value,
                    offset: 0,
                    observation: '',
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="history-report-to">
                Through / as of
              </FieldLabel>
              <Input
                id="history-report-to"
                type="date"
                value={controls.to || controls.asOf}
                onChange={(event) =>
                  setControls({
                    to: event.target.value,
                    asOf: event.target.value,
                    offset: 0,
                    observation: '',
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel>Currency</FieldLabel>
              <Picker
                label="Snapshot currency"
                value={controls.currency}
                onChange={(value) =>
                  setControls({
                    currency: value as typeof controls.currency,
                    offset: 0,
                    observation: '',
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
          </FieldGroup>
        </Panel>
      ) : null}
      {error || (!saved && history.error) ? (
        <Alert variant="destructive">
          <AlertTitle>Snapshot needs attention</AlertTitle>
          <AlertDescription>
            {error || (!saved && history.error)}
            <Button
              variant="link"
              onClick={() => {
                setError('');
                history.refresh();
              }}
            >
              Refresh history
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {history.loading && !saved ? (
        <Skeleton className="h-96 w-full" />
      ) : data ? (
        <>
          <Panel
            title={saved?.name ?? 'Historical portfolio value'}
            subtitle={`${dateLabel(data.asOf)} · ${data.query.currency} · ${data.summary.coverage.knownCount} of ${data.summary.coverage.totalCount} holdings valued`}
          >
            <div className={styles.historyHeadline}>
              <strong>
                {historyAmount(
                  data.summary.knownAmount,
                  data.query.currency,
                  true,
                )}
              </strong>
              <p className={styles.note}>{data.basis}</p>
            </div>
            <HistoryValueChart
              points={data.points.map((point) => ({
                id: point.date,
                date: point.date,
                amount: point.amount,
                carried: point.coverage.carriedCount > 0,
              }))}
              currency={data.query.currency}
            />
            <p className={styles.note}>
              Complete totals are plotted. Partial subtotals and original source
              dates remain in the export. Value changes may include cash
              movements.
            </p>
            <Table className={styles.table}>
              <TableHeader>
                <TableRow>
                  <TableHead>Investment</TableHead>
                  <TableHead>Reported value</TableHead>
                  <TableHead>Valuation date</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.positions.map((position) => (
                  <TableRow key={position.holdingId}>
                    <TableCell>
                      {position.investmentName}
                      {position.ownership === 'closed' ? (
                        <small>
                          Exited {dateLabel(position.economicClosedAt!)}
                        </small>
                      ) : position.ownership === 'not_yet_opened' ? (
                        <small>
                          Not yet acquired ·{' '}
                          {dateLabel(position.economicOpenedAt!)}
                        </small>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {historyAmount(
                        position.latest?.amount,
                        data.query.currency,
                      )}
                    </TableCell>
                    <TableCell>
                      {position.latest
                        ? dateLabel(position.latest.effectiveDate)
                        : 'Not reported'}
                    </TableCell>
                    <TableCell>
                      {position.latest?.sourceId && onSource ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onSource(position.latest!.sourceId!)}
                        >
                          <FileText data-icon="inline-start" />
                          View source
                        </Button>
                      ) : (
                        (position.latest?.filename ?? 'Unavailable')
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
          <Panel
            title={
              saved ? 'Export preserved figures' : 'Save or export this view'
            }
            subtitle="Saved observations, source references and results remain unchanged when later information arrives."
          >
            <div className={styles.snapshotControls}>
              {!saved ? (
                <Field>
                  <FieldLabel htmlFor="history-snapshot-name">
                    Snapshot name
                  </FieldLabel>
                  <Input
                    id="history-snapshot-name"
                    maxLength={240}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
              ) : null}
              <div className={styles.actions}>
                {!saved &&
                !state.identity?.dataScope &&
                ['owner', 'admin', 'analyst'].includes(
                  state.identity?.role ?? '',
                ) ? (
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      history.refreshing ||
                      !!history.error ||
                      !name.trim() ||
                      !data.positions.length
                    }
                    onClick={() => void save()}
                  >
                    <Save data-icon="inline-start" />
                    {busy ? 'Saving…' : 'Save history snapshot'}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={!saved && (history.refreshing || !!history.error)}
                  onClick={() => downloadHistoryCSV(data)}
                >
                  <Download data-icon="inline-start" />
                  Export this view
                </Button>
              </div>
            </div>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
