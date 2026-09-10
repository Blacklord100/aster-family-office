'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Calculator,
  Download,
  FileCheck2,
  Save,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Field, FieldLabel, FieldGroup } from '@/components/ui/field';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LEDGER_CURRENCIES } from '@/lib/ledger-contract';
import {
  periodQuerySchema,
  type PeriodQuery,
  type ReportingResponse,
  type ReportingSnapshot,
  type PeriodReport,
  type ReportingScope,
  type StressSnapshot,
} from '@/lib/reporting-contract';
import {
  RISK_PRESETS,
  buildTotalExposure,
  runStressScenario,
} from '@/lib/risk-engine';
import { currentStressInputs } from '@/lib/reporting';
import { reportValue } from '@/lib/report-value';
import type { RiskScenario, StressResult } from '@/lib/risk-contract';
import {
  FamilyPicker,
  Metric,
  Panel,
  Picker,
  dateLabel,
  money,
} from './primitives';
import { useWorkspace } from './workspace-context';
import styles from './reporting.module.css';
import { HistoryReport } from './history-report';
import type { SavedReport } from '@/lib/workspace';

const today = () => new Date().toISOString().slice(0, 10);
const native = (amount: number | null, currency: string) =>
  amount === null
    ? 'Unavailable'
    : new Intl.NumberFormat('en-IE', {
        style: 'currency',
        currency,
        maximumFractionDigits: 2,
      }).format(amount);
const eur = (amount: number | null) =>
  amount === null ? 'Unavailable' : money(amount, 2);
class ReportingRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function requestReporting(
  params?: URLSearchParams,
  body?: unknown,
  signal?: AbortSignal,
  organizationId?: string,
): Promise<ReportingResponse> {
  const response = await fetch(
    '/api/reporting' + (params ? '?' + params.toString() : ''),
    {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
      headers: {
        ...(organizationId ? { 'x-aster-organization': organizationId } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body
        ? {
            body: JSON.stringify(body),
          }
        : {}),
    },
  );
  const result = await response.json();
  if (!response.ok)
    throw new ReportingRequestError(
      response.status,
      result.message ?? 'The report could not be completed.',
    );
  return result;
}
function download(value: unknown, name: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
      type: 'application/json',
    }),
    url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function PeriodResults({
  report,
  onSource,
}: {
  report: PeriodReport;
  onSource?: (id: string) => void;
}) {
  return (
    <div className={styles.stack}>
      <div className="metrics-row">
        <Metric
          label="Sourced opening value"
          value={eur(report.openingValueEUR)}
          note={dateLabel(report.query.from)}
        />
        <Metric
          label="Sourced closing value"
          value={eur(report.closingValueEUR)}
          note={dateLabel(report.query.to)}
        />
        <Metric
          label="Net external flows"
          value={eur(report.netExternalFlowEUR)}
          note={
            report.netExternalFlowEUR === null
              ? 'Known ledger flows: ' + eur(report.knownExternalFlowEUR)
              : 'Deposits less withdrawals'
          }
        />
        <Metric
          label="Estimated period return"
          value={
            report.returnEstimate.valuePercent === null
              ? 'Unavailable'
              : report.returnEstimate.valuePercent.toFixed(2) + '%'
          }
          note="Modified Dietz · not annualized"
        />
      </div>
      <Alert>
        <Calculator />
        <AlertTitle>{report.returnEstimate.method}</AlertTitle>
        <AlertDescription>
          {report.returnEstimate.reason} Value change:{' '}
          {eur(report.valueChangeEUR)}. Investment result after reconciled
          external flows: {eur(report.investmentResultEUR)}.{' '}
          <a
            href={report.returnEstimate.methodologyUrl}
            target="_blank"
            rel="noreferrer"
            className={styles.link}
          >
            Calculation methodology
          </a>
          .
        </AlertDescription>
      </Alert>
      {report.gaps.length ? (
        <Alert>
          <ShieldAlert />
          <AlertTitle>
            {report.gaps.length} source or reconciliation gaps
          </AlertTitle>
          <AlertDescription>
            <ul className={styles.gaps}>
              {report.gaps.map((gap, index) => (
                <li key={index}>{gap}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <Panel
        title="Opening and closing evidence"
        subtitle="Exact dates only; a missing mark remains unavailable"
      >
        <Table className={styles.table}>
          <TableHeader>
            <TableRow>
              <TableHead>Holding</TableHead>
              <TableHead>Opening</TableHead>
              <TableHead>Closing</TableHead>
              <TableHead>Change in EUR value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.holdings.map((row) => (
              <TableRow key={row.holdingId}>
                <TableCell>
                  <strong>{row.name}</strong>
                  <small>{row.assetClass}</small>
                </TableCell>
                <TableCell>
                  {eur(row.opening?.valueEUR ?? null)}
                  <small>
                    {row.opening
                      ? row.opening.source.reference + ' · ' + row.opening.basis
                      : 'Source mark missing'}
                  </small>
                  {row.opening?.sourceId && onSource ? (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => onSource(row.opening!.sourceId!)}
                    >
                      View opening source
                    </Button>
                  ) : null}
                </TableCell>
                <TableCell>
                  {eur(row.closing?.valueEUR ?? null)}
                  <small>
                    {row.closing
                      ? row.closing.source.reference + ' · ' + row.closing.basis
                      : 'Source mark missing'}
                  </small>
                  {row.closing?.sourceId && onSource ? (
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => onSource(row.closing!.sourceId!)}
                    >
                      View closing source
                    </Button>
                  ) : null}
                </TableCell>
                <TableCell>
                  {eur(row.changeEUR)}
                  <small>Includes flows; this is not a holding return</small>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!report.holdings.length ? (
          <p className={styles.note}>
            Register holdings in this selection before building a period report.
          </p>
        ) : null}
      </Panel>
      <div className={styles.twoColumns}>
        <Panel
          title="External flows"
          subtitle="Capital calls and internal transfers are excluded from this boundary"
        >
          {report.flows.length ? (
            <Table className={styles.table}>
              <TableHeader>
                <TableRow>
                  <TableHead>Date / kind</TableHead>
                  <TableHead>EUR movement</TableHead>
                  <TableHead>Evidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.flows.map((flow) => (
                  <TableRow key={flow.eventId}>
                    <TableCell>
                      {dateLabel(flow.date)}
                      <small>{flow.kind}</small>
                    </TableCell>
                    <TableCell>{eur(flow.amountEUR)}</TableCell>
                    <TableCell>
                      {flow.source.sourceId && onSource ? (
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => onSource(flow.source.sourceId!)}
                        >
                          {flow.source.reference}
                        </Button>
                      ) : (
                        flow.source.reference
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className={styles.note}>
              {report.netExternalFlowEUR === null
                ? 'No external flows are recorded. Coverage is incomplete; this does not establish zero flows.'
                : 'The reconciled ledger records no external flows during this period.'}
            </p>
          )}
        </Panel>
        <Panel
          title="Cash reconciliation"
          subtitle="Closing native cash − opening native cash − recorded movements"
        >
          <Table className={styles.table}>
            <TableHeader>
              <TableRow>
                <TableHead>Cash account</TableHead>
                <TableHead>Recorded movements</TableHead>
                <TableHead>Unexplained difference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.cashReconciliation.map((row) => (
                <TableRow key={row.holdingId}>
                  <TableCell>
                    {row.name}
                    <small>
                      {native(row.openingNative, row.currency)} →{' '}
                      {native(row.closingNative, row.currency)}
                    </small>
                    <small>
                      {row.coverageId
                        ? 'Statement coverage attested'
                        : 'Coverage missing'}
                    </small>
                  </TableCell>
                  <TableCell>
                    {native(row.recordedMovementsNative, row.currency)}
                  </TableCell>
                  <TableCell
                    className={
                      row.residualNative !== null && row.residualNative !== 0
                        ? styles.bad
                        : undefined
                    }
                  >
                    {native(row.residualNative, row.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!report.cashReconciliation.length ? (
            <p className={styles.note}>
              Cash accounts and period statement coverage are required.
            </p>
          ) : null}
        </Panel>
      </div>
      <Panel
        title="Dated liquidity"
        subtitle={
          dateLabel(report.query.liquidityAsOf) +
          ' cash view · currently reviewed obligations through ' +
          dateLabel(report.query.liquidityThrough)
        }
      >
        <Table className={styles.table}>
          <TableHeader>
            <TableRow>
              <TableHead>Legal entity / currency</TableHead>
              <TableHead>Recorded cash</TableHead>
              <TableHead>Restrictions</TableHead>
              <TableHead>Reviewed inflows / outflows</TableHead>
              <TableHead>Projected available cash</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.liquidity.map((group) => (
              <TableRow key={group.entityId + group.currency}>
                <TableCell>
                  <strong>{group.entityName}</strong>
                  <small>
                    {group.currency} ·{' '}
                    {group.cashAsOfDates.map(dateLabel).join(', ') ||
                      'Cash history unavailable'}
                  </small>
                </TableCell>
                <TableCell>
                  {native(group.recordedCashNative, group.currency)}
                  {group.unavailableBalanceCount ? (
                    <small>
                      {group.unavailableBalanceCount} historical balances
                      missing
                    </small>
                  ) : null}
                </TableCell>
                <TableCell>
                  {native(group.restrictedCashNative, group.currency)}{' '}
                  restricted
                  <small>
                    {group.restrictionUnknownAccountCount} accounts with
                    unreviewed restrictions
                  </small>
                </TableCell>
                <TableCell>
                  {native(group.reviewedInflowsNative, group.currency)} /{' '}
                  {native(group.reviewedOutflowsNative, group.currency)}
                  <small>
                    Overdue outflows:{' '}
                    {native(group.overdueOutflowsNative, group.currency)}
                    {group.blockedObligationCount
                      ? ' · ' +
                        group.blockedObligationCount +
                        ' obligations blocked by account restrictions'
                      : ''}
                  </small>
                </TableCell>
                <TableCell
                  className={
                    group.projectedAvailableNative !== null &&
                    group.projectedAvailableNative < 0
                      ? styles.bad
                      : undefined
                  }
                >
                  {native(group.projectedAvailableNative, group.currency)}
                  <small>
                    Assumes stated inflows arrive; no account transfers modeled
                  </small>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className={styles.note}>
          Balances stay separate by legal entity and currency. Restricted cash
          is excluded; missing balances or unknown restrictions suppress
          availability. Capital calls affect this cash projection and do not
          create a valuation loss.
        </p>
        {report.liquidity.some((g) => g.obligations.length) ? (
          <Table className={styles.table}>
            <TableHeader>
              <TableRow>
                <TableHead>Entity / obligation</TableHead>
                <TableHead>Due date</TableHead>
                <TableHead>Native cash movement</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.liquidity.flatMap((g) =>
                g.obligations.map((item, index) => (
                  <TableRow
                    key={g.entityId + g.currency + item.transactionId + index}
                  >
                    <TableCell>
                      {g.entityName}
                      <small>{item.name}</small>
                    </TableCell>
                    <TableCell>{dateLabel(item.date)}</TableCell>
                    <TableCell>
                      {native(item.nativeChange, g.currency)}
                    </TableCell>
                    <TableCell>{item.source.reference}</TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        ) : null}
      </Panel>
      <Panel title="Method and assumptions">
        <ul className={styles.notes}>
          {report.assumptions.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
export function StressSummary({
  result,
  inputs,
}: {
  result: StressResult;
  inputs: Pick<StressSnapshot['inputs'], 'holdings' | 'ownershipBasis'>;
}) {
  const valuation = reportValue(inputs.holdings),
    hasValue = valuation.valueEUR !== null;
  const shocks = [
    ...Object.entries(result.scenario.assetClassShocks).map(
      ([name, value]) => ({ name: 'Asset class · ' + name, value }),
    ),
    ...Object.entries(result.scenario.sectorShocks ?? {}).map(
      ([name, value]) => ({ name: 'Sector override · ' + name, value }),
    ),
    ...Object.entries(result.scenario.issuerShocks ?? {}).map(
      ([name, value]) => ({ name: 'Issuer override · ' + name, value }),
    ),
    ...Object.entries(result.scenario.currencyShocks ?? {}).map(
      ([name, value]) => ({ name: 'Currency · ' + name, value }),
    ),
  ];
  return (
    <div className={styles.stack}>
      <div className={styles.actions}>
        {shocks.map((shock) => (
          <Badge variant="outline" key={shock.name}>
            {shock.name}: {(shock.value * 100).toFixed(1)}%
          </Badge>
        ))}
      </div>
      <div className="metrics-row">
        <Metric
          label={
            valuation.coverage.complete
              ? 'Before scenario'
              : 'Before scenario · known subtotal'
          }
          value={hasValue ? money(result.beforeEUR) : 'Not reported'}
          note={`${valuation.coverage.knownCount} of ${valuation.coverage.totalCount} positions valued · EUR`}
        />
        <Metric
          label="After valuation shocks"
          value={hasValue ? money(result.afterEUR) : 'Unavailable'}
          note="Hypothetical valuation only"
        />
        <Metric
          label="Hypothetical valuation loss"
          value={hasValue ? money(result.lossEUR) : 'Unavailable'}
          note={
            result.lossPercent === null
              ? 'No starting NAV'
              : result.lossPercent.toFixed(2) + '% of modeled NAV'
          }
        />
        <Metric
          label="Unresolved look-through"
          value={hasValue ? money(result.unresolvedExposureEUR) : 'Unavailable'}
          note="Kept explicit in the model"
        />
      </div>
      <p className={styles.note}>
        {inputs.ownershipBasis
          ? `Current position cohort as of ${dateLabel(inputs.ownershipBasis.asOfDate)}. ${inputs.ownershipBasis.excludedCount} sourced exits or future acquisitions excluded; ${inputs.ownershipBasis.unknownOwnershipCount} positions retained with unknown ownership dates.`
          : 'Original saved register cohort. Ownership dates were not applied when this snapshot was created; it may include positions now closed.'}{' '}
        Latest recorded marks retain their own valuation dates. Missing NAV is
        unknown exposure, not zero.
      </p>
      <p className={styles.note}>
        {result.scenario.description} Hypothetical capital calls:{' '}
        {money(result.liquidity.capitalCallsEUR)}. These are separate from
        valuation loss. Aggregate cash does not establish that funds can move
        between legal entities or accounts.
      </p>
      <Table className={styles.table}>
        <TableHeader>
          <TableRow>
            <TableHead>Holding contributor</TableHead>
            <TableHead>Before</TableHead>
            <TableHead>After</TableHead>
            <TableHead>Loss / gain</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.contributors.map((row) => (
            <TableRow key={row.id}>
              <TableCell>{row.name}</TableCell>
              <TableCell>{money(row.beforeEUR)}</TableCell>
              <TableCell>{money(row.afterEUR)}</TableCell>
              <TableCell>{money(row.lossEUR)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className={styles.notes}>
        {result.limitations.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      {result.warnings.length ? (
        <Alert>
          <ShieldAlert />
          <AlertTitle>{result.warnings.length} exposure warnings</AlertTitle>
          <AlertDescription>
            <ul className={styles.gaps}>
              {result.warnings.map((warning, index) => (
                <li key={index}>{warning.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
function ReportingWorkbenchContent({
  family,
  onFamily,
  onSource,
  onLegacyPreview,
}: {
  family: string;
  onFamily: (value: string) => void;
  onSource?: (id: string) => void;
  onLegacyPreview?: (report: SavedReport) => void;
}) {
  const { data, state, reload } = useWorkspace();
  const organizationId = state.identity?.organizationId;
  const active = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    active.current = true;
    const pending = controllers.current;
    return () => {
      active.current = false;
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, []);
  async function scopedRequest(params?: URLSearchParams, body?: unknown) {
    if (!organizationId)
      throw new ReportingRequestError(403, 'Choose an authorized workspace.');
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      return await requestReporting(
        params,
        body,
        controller.signal,
        organizationId,
      );
    } finally {
      clearTimeout(timeout);
      controllers.current.delete(controller);
    }
  }
  const [accessDenied, setAccessDenied] = useState(false);
  const [response, setResponse] = useState<ReportingResponse | null>(null),
    [period, setPeriod] = useState<PeriodReport | null>(null),
    [opened, setOpened] = useState<ReportingSnapshot | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const handleFailure = useCallback(
    (cause: unknown, fallback: string) => {
      if (!active.current) return;
      if (
        cause instanceof ReportingRequestError &&
        [401, 403].includes(cause.status)
      ) {
        setAccessDenied(true);
        setResponse(null);
        setOpened(null);
        setPeriod(null);
        reload();
      }
      setError(
        cause instanceof Error && cause.name !== 'AbortError'
          ? cause.message
          : fallback,
      );
    },
    [reload],
  );

  const [tab, setTab] = useState('history');
  const [from, setFrom] = useState(() => today().slice(0, 4) + '-01-01'),
    [to, setTo] = useState(today),
    [cashDate, setCashDate] = useState(today),
    [through, setThrough] = useState(() =>
      new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
    );
  const [entity, setEntity] = useState('all'),
    [currency, setCurrency] = useState('all'),
    [scenarioId, setScenarioId] = useState(RISK_PRESETS[0].id),
    [name, setName] = useState('Reviewed period report');
  const retry = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    if (!organizationId) return;
    const controller = new AbortController();
    void requestReporting(
      undefined,
      undefined,
      controller.signal,
      organizationId,
    )
      .then((result) => {
        if (!controller.signal.aborted) setResponse(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          handleFailure(cause, 'Reports could not be loaded.');
      });
    return () => controller.abort();
  }, [organizationId, handleFailure]);
  const entities = data.entities.filter(
      (e) => family === 'all' || e.familyId === family,
    ),
    selectedEntity = entities.some((e) => e.id === entity) ? entity : 'all';
  const scope: ReportingScope = {
    familyIds: data.families
      .filter((f) => family === 'all' || f.id === family)
      .map((f) => f.id),
    ...(selectedEntity === 'all' ? {} : { entityIds: [selectedEntity] }),
  };
  const query: PeriodQuery = {
    ...scope,
    from,
    to,
    liquidityAsOf: cashDate,
    liquidityThrough: through,
    ...(currency === 'all'
      ? {}
      : {
          liquidityCurrencies: [currency as (typeof LEDGER_CURRENCIES)[number]],
        }),
  };
  const scenarios = useMemo(
    () => [
      ...RISK_PRESETS,
      ...(state.riskScenarios ?? []).map((saved) => ({
        ...saved.scenario,
        id: 'saved:' + saved.id,
        name: saved.name,
      })),
    ],
    [state.riskScenarios],
  );
  const scenario = scenarios.find((s) => s.id === scenarioId) ?? scenarios[0];
  const stressPreview = useMemo(() => {
    try {
      const inputs = currentStressInputs(
        data,
        {
          familyIds: data.families
            .filter((f) => family === 'all' || f.id === family)
            .map((f) => f.id),
          ...(selectedEntity === 'all' ? {} : { entityIds: [selectedEntity] }),
        },
        state.riskData,
        state.historyLifecycle,
        today(),
      );
      return {
        inputs,
        result: runStressScenario(
          buildTotalExposure(inputs.holdings, inputs.riskData, inputs.asOfDate),
          scenario,
        ),
        error: '',
      };
    } catch (cause) {
      return {
        inputs: null,
        result: null,
        error:
          cause instanceof Error
            ? cause.message
            : 'The risk mapping is invalid.',
      };
    }
  }, [
    data,
    family,
    selectedEntity,
    state.riskData,
    state.historyLifecycle,
    scenario,
  ]);
  const shownPeriod = opened?.kind === 'period' ? opened.result : period,
    filtersChanged =
      !!period && JSON.stringify(period.query) !== JSON.stringify(query);
  const visibleSnapshots = (response?.snapshots ?? []).filter(
    (snapshot) =>
      snapshot.familyIds.every((id) => scope.familyIds.includes(id)) &&
      (selectedEntity === 'all' ||
        snapshot.entityIds.every((id) => id === selectedEntity)),
  );
  async function calculate() {
    setBusy(true);
    setError('');
    try {
      const parsed = periodQuerySchema.parse(query),
        result = await scopedRequest(
          new URLSearchParams({ query: JSON.stringify(parsed) }),
        );
      if (!active.current) return;
      setResponse(result);
      setPeriod(result.period ?? null);
      setOpened(null);
      setTab('period');
      setNotice('Period recalculated from current reviewed records.');
    } catch (cause) {
      handleFailure(cause, 'The report could not be calculated.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function save(
    body:
      | { action: 'savePeriod'; query: PeriodQuery }
      | { action: 'saveStress'; scope: ReportingScope; scenario: RiskScenario },
  ) {
    if (!response) return;
    setBusy(true);
    setError('');
    const intent = { ...body, name },
      serialized = JSON.stringify(intent);
    if (retry.current?.body !== serialized)
      retry.current = { body: serialized, key: crypto.randomUUID() };
    try {
      const result = await scopedRequest(undefined, {
        ...intent,
        expectedRevision: response.revision,
        idempotencyKey: retry.current.key,
      });
      if (!active.current) return;
      retry.current = null;
      setResponse(result);
      setOpened(result.snapshot ?? null);
      if (result.snapshot) setTab(result.snapshot.kind);
      setNotice(
        result.duplicate
          ? 'The existing snapshot was returned; no duplicate was saved.'
          : 'Snapshot saved with its inputs and results.',
      );
      reload();
    } catch (cause) {
      handleFailure(cause, 'The snapshot could not be saved.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function openSnapshot(id: string) {
    setBusy(true);
    setError('');
    try {
      const result = await scopedRequest(new URLSearchParams({ id }));
      if (!active.current) return;
      setResponse(result);
      setOpened(result.snapshot ?? null);
      if (result.snapshot) setTab(result.snapshot.kind);
    } catch (cause) {
      handleFailure(cause, 'The snapshot could not be opened.');
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const dateField = (
    id: string,
    label: string,
    value: string,
    set: (value: string) => void,
  ) => (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </Field>
  );
  if (accessDenied)
    return (
      <Alert variant="destructive">
        <AlertTitle>Report access changed</AlertTitle>
        <AlertDescription>
          {error || 'Your session or workspace permissions changed.'}
          <Button variant="link" onClick={() => window.location.reload()}>
            Reload workspace
          </Button>
        </AlertDescription>
      </Alert>
    );
  return (
    <section className={styles.root} aria-label="Custom period reporting">
      <Tabs value={tab} onValueChange={setTab} className={styles.stack}>
        <TabsList variant="line" className={styles.tabs}>
          <TabsTrigger value="history">Portfolio snapshot</TabsTrigger>
          <TabsTrigger value="period">Period analysis</TabsTrigger>
          <TabsTrigger value="stress">Saved stress analysis</TabsTrigger>
          <TabsTrigger value="snapshots">Saved reports</TabsTrigger>
        </TabsList>
        {tab === 'period' ? (
          <>
            <Panel
              title="Period analysis & cash coverage"
              subtitle="Sourced valuations, reconciled cash flows and reproducible scenario runs"
              action={
                <FamilyPicker
                  value={family}
                  onChange={(value) => {
                    setEntity('all');
                    onFamily(value);
                  }}
                />
              }
            >
              <FieldGroup className={styles.filters}>
                {dateField('report-from', 'Opening date', from, setFrom)}
                {dateField('report-to', 'Closing date', to, setTo)}
                <Field>
                  <FieldLabel>Legal entity</FieldLabel>
                  <Picker
                    value={selectedEntity}
                    onChange={setEntity}
                    label="Reporting legal entity"
                    options={[
                      { value: 'all', label: 'All selected entities' },
                      ...entities.map((e) => ({ value: e.id, label: e.name })),
                    ]}
                  />
                </Field>
                {dateField(
                  'report-cash-date',
                  'Cash as of',
                  cashDate,
                  setCashDate,
                )}
                {dateField(
                  'report-through',
                  'Obligations through',
                  through,
                  setThrough,
                )}
                <Field>
                  <FieldLabel>Liquidity currency</FieldLabel>
                  <Picker
                    value={currency}
                    onChange={setCurrency}
                    label="Liquidity currency"
                    options={[
                      { value: 'all', label: 'All currencies separately' },
                      ...LEDGER_CURRENCIES.map((value) => ({
                        value,
                        label: value,
                      })),
                    ]}
                  />
                </Field>
              </FieldGroup>
              <div className={styles.actions}>
                <Button
                  onClick={() => void calculate()}
                  disabled={busy || !scope.familyIds.length}
                >
                  <Calculator data-icon="inline-start" />
                  {busy ? 'Working…' : 'Calculate period'}
                </Button>
                {filtersChanged ? (
                  <Badge variant="outline">
                    Filters changed · calculate again
                  </Badge>
                ) : null}
                <p className={styles.note}>
                  Performance is measured in EUR. Currency selection applies
                  only to liquidity.
                </p>
              </div>
            </Panel>
          </>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Report needs attention</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert>
            <FileCheck2 />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {tab === 'period' ? (
          <Panel
            title="Save a reproducible snapshot"
            subtitle="Inputs and results are pinned together; later portfolio or template edits do not rewrite them"
          >
            <div className={styles.snapshotControls}>
              <Field>
                <FieldLabel htmlFor="report-name">Snapshot name</FieldLabel>
                <Input
                  id="report-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={240}
                />
              </Field>
              <div className={styles.actions}>
                {response?.canWrite ? (
                  <Button
                    variant="outline"
                    disabled={
                      busy ||
                      !period ||
                      filtersChanged ||
                      !!opened ||
                      !name.trim()
                    }
                    onClick={() =>
                      period &&
                      void save({ action: 'savePeriod', query: period.query })
                    }
                  >
                    <Save data-icon="inline-start" />
                    Save calculated period
                  </Button>
                ) : (
                  <Badge variant="outline">Read-only report access</Badge>
                )}
                {shownPeriod ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      download(shownPeriod, 'aster-period-report.json')
                    }
                  >
                    <Download data-icon="inline-start" />
                    Export period JSON
                  </Button>
                ) : null}
              </div>
            </div>
          </Panel>
        ) : null}
        {opened ? (
          <Alert>
            <FileCheck2 />
            <AlertTitle>
              Saved {opened.kind} snapshot · {opened.name}
            </AlertTitle>
            <AlertDescription>
              Created {new Date(opened.createdAt).toLocaleString()} · workspace
              revision {opened.workspaceRevision}. This is the preserved result.{' '}
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    download(
                      opened,
                      'aster-' + opened.kind + '-' + opened.id + '.json',
                    )
                  }
                >
                  <Download data-icon="inline-start" />
                  Export inputs & result
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOpened(null)}
                >
                  Return to live calculations
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
        <TabsContent value="history" className={styles.stack}>
          <HistoryReport
            family={family}
            onFamily={onFamily}
            saved={opened?.kind === 'history' ? opened : undefined}
            onSource={onSource}
            onSaved={(value) => {
              setResponse(value);
              setOpened(value.snapshot ?? null);
              setTab('history');
              setNotice(
                'History snapshot saved with its source observations and coverage.',
              );
            }}
          />
        </TabsContent>
        <TabsContent value="period" className={styles.stack}>
          {shownPeriod ? (
            <PeriodResults report={shownPeriod} onSource={onSource} />
          ) : (
            <Panel title="Choose a period">
              <p className={styles.note}>
                Calculate to see which source marks, cash flows and statement
                coverage are available. Missing records stay visible instead of
                becoming estimated returns.
              </p>
            </Panel>
          )}
        </TabsContent>
        <TabsContent value="stress" className={styles.stack}>
          <Panel
            title={
              opened?.kind === 'stress'
                ? 'Saved hypothetical stress run'
                : 'Preserve a hypothetical stress run'
            }
            subtitle={
              opened?.kind === 'stress'
                ? 'Holdings, exposure mappings and assumptions preserved with this snapshot'
                : 'Current recorded holdings and saved exposure mappings; unsupported or missing exposures remain explicit'
            }
            action={
              opened?.kind === 'stress' ? (
                <Badge variant="outline" className={styles.snapshotScenario}>
                  Saved scenario: {opened.inputs.scenario.name}
                </Badge>
              ) : (
                <Picker
                  value={scenario.id}
                  onChange={setScenarioId}
                  label="Stress scenario"
                  options={scenarios.map((s) => ({
                    value: s.id,
                    label: s.name,
                  }))}
                />
              )
            }
          >
            <p className={styles.note}>
              Issuer shocks replace sector shocks, which replace asset-class
              shocks. A known currency shock then compounds multiplicatively.
              {opened?.kind === 'stress'
                ? 'The displayed inputs and results are pinned to the saved snapshot.'
                : 'The run uses current saved exposure mappings.'}{' '}
              Missing look-through remains unknown.
            </p>
            {opened?.kind !== 'stress' && stressPreview.error ? (
              <Alert variant="destructive">
                <AlertDescription>{stressPreview.error}</AlertDescription>
              </Alert>
            ) : null}
            <div className={styles.actions}>
              {response?.canWrite && opened?.kind !== 'stress' ? (
                <Button
                  disabled={
                    busy ||
                    !!opened ||
                    !stressPreview.result ||
                    !stressPreview.inputs?.holdings.length ||
                    !name.trim()
                  }
                  onClick={() =>
                    void save({ action: 'saveStress', scope, scenario })
                  }
                >
                  <Save data-icon="inline-start" />
                  Save current stress run
                </Button>
              ) : null}
              <span className={styles.note}>
                No historical replay, probability or VaR is implied.
              </span>
            </div>
          </Panel>
          {opened?.kind === 'stress' ? (
            <StressSummary
              result={opened.result.stress}
              inputs={opened.inputs}
            />
          ) : stressPreview.result ? (
            <StressSummary
              result={stressPreview.result}
              inputs={stressPreview.inputs!}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="snapshots">
          <Panel
            title="Immutable saved inputs & results"
            subtitle={`${visibleSnapshots.length} snapshots in this selection · bounded storage of 20 per workspace`}
          >
            <Table className={styles.table}>
              <TableHeader>
                <TableRow>
                  <TableHead>Snapshot</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Input revision</TableHead>
                  <TableHead>Integrity</TableHead>
                  <TableHead>Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(state.reports ?? [])
                  .filter(
                    (report) => family === 'all' || report.family === family,
                  )
                  .map((report) => (
                    <TableRow key={'legacy-' + report.id}>
                      <TableCell>
                        {report.name}
                        <small>Earlier portfolio snapshot</small>
                      </TableCell>
                      <TableCell>
                        {new Date(report.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>Legacy snapshot</TableCell>
                      <TableCell>
                        <Badge variant="outline">Preserved legacy format</Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onLegacyPreview?.(report)}
                          disabled={!onLegacyPreview}
                        >
                          Open snapshot
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                {visibleSnapshots.toReversed().map((snapshot) => (
                  <TableRow key={snapshot.id}>
                    <TableCell>
                      {snapshot.name}
                      <small>{snapshot.kind}</small>
                    </TableCell>
                    <TableCell>
                      {new Date(snapshot.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>{snapshot.workspaceRevision}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          snapshot.integrity === 'verified'
                            ? 'secondary'
                            : 'destructive'
                        }
                      >
                        {snapshot.integrity === 'verified'
                          ? 'Content hashes match'
                          : 'Integrity mismatch'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || snapshot.integrity !== 'verified'}
                        onClick={() => void openSnapshot(snapshot.id)}
                      >
                        Open snapshot
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!visibleSnapshots.length &&
            !(state.reports ?? []).some(
              (report) => family === 'all' || report.family === family,
            ) ? (
              <p className={styles.note}>
                No saved snapshots are available in this selection. Scoped
                viewers can calculate from their released records; full-input
                snapshots are private to workspace members with unrestricted
                access.
              </p>
            ) : null}
          </Panel>
        </TabsContent>
      </Tabs>
    </section>
  );
}

/** Permission changes remount the private report state, not only office switches. */
export function ReportingWorkbench(
  props: Parameters<typeof ReportingWorkbenchContent>[0],
) {
  const { state } = useWorkspace();
  const identity = state.identity;
  const contextKey = JSON.stringify([
    identity?.organizationId,
    identity?.user.id,
    identity?.role,
    identity?.dataScope,
    props.family,
  ]);
  return <ReportingWorkbenchContent key={contextKey} {...props} />;
}
