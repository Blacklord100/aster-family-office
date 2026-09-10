'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Search,
  ArrowLeft,
  Download,
  FileText,
  ArrowUpRight,
  Plus,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@/components/ui/field';
import { useWorkspace } from './workspace-context';
import {
  PageHeading,
  FamilyPicker,
  Picker,
  Panel,
  Metric,
  Status,
  money,
  dateLabel,
} from './primitives';
import { HoldingsTable } from './overview';
import { InvestmentActivity } from './timeline';
import { InvestmentHistory } from './investment-history';
import { HistoryLifecycle } from './history-lifecycle';
import { useHistoryControls } from './use-history-controls';
import { usePortfolioHistory } from './use-portfolio-history';
import { historyMoney } from '@/lib/history-presentation';
import { obligationSummary } from '@/lib/ledger';
import type { Holding } from '@/data';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import historyStyles from './investment-history.module.css';
export function InvestmentsView({
  family,
  onFamily,
  onHolding,
  onExport,
  onManagers,
}: {
  family: string;
  onFamily: (s: string) => void;
  onHolding: (id: string) => void;
  onExport: () => void;
  onManagers?: () => void;
}) {
  const { state, data } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState(''),
    [asset, setAsset] = useState('all'),
    [sort, setSort] = useState('value'),
    [entity, setEntity] = useState('all');
  const scoped = data.holdings.filter(
    (h) => family === 'all' || h.familyId === family,
  );
  const filtered = scoped
    .filter(
      (h) =>
        (asset === 'all' || h.assetClass === asset) &&
        (entity === 'all' || h.entityId === entity) &&
        [h.name, h.manager, h.ticker ?? '']
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : sort === 'date'
          ? a.valuationDate.localeCompare(b.valuationDate)
          : b.valueEUR - a.valueEUR,
    );
  const total = scoped.reduce(
    (sum, holding) =>
      sum + (holding.valuationStatus === 'unknown' ? 0 : holding.valueEUR),
    0,
  );
  return (
    <>
      <PageHeading
        title="Investments"
        subtitle={
          scoped.length +
          ' investments · ' +
          money(total) +
          (scoped.some((h) => h.valuationStatus === 'unknown')
            ? ' in reported value · valuations incomplete'
            : ' in portfolio value')
        }
      >
        <FamilyPicker
          value={family}
          onChange={(v) => {
            setEntity('all');
            onFamily(v);
          }}
        />
        {onManagers && !state.identity?.dataScope ? (
          <Button variant="ghost" onClick={onManagers}>
            Managers & contacts
          </Button>
        ) : null}
        <Button
          onClick={() => setAdding((v) => !v)}
          disabled={state.identity?.role === 'viewer'}
        >
          <Plus data-icon="inline-start" />
          Add holding
        </Button>
        <Button variant="outline" onClick={onExport}>
          <Download data-icon="inline-start" />
          Export report
        </Button>
      </PageHeading>
      {adding ? (
        <AddHoldingForm
          family={family}
          onSaved={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      <div className="list-toolbar">
        <div className="search-input">
          <Search />
          <Input
            aria-label="Search investments"
            placeholder="Search investments…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Picker
          label="Asset class filter"
          value={asset}
          onChange={setAsset}
          options={[
            { value: 'all', label: 'All asset classes' },
            ...[
              'Public equities',
              'Private equity',
              'Venture capital',
              'Real estate',
              'Fixed income',
              'Cash',
            ].map((v) => ({ value: v, label: v })),
          ]}
        />
        <Picker
          label="Entity filter"
          value={entity}
          onChange={setEntity}
          options={[
            { value: 'all', label: 'All entities' },
            ...data.entities
              .filter((e) => family === 'all' || e.familyId === family)
              .map((e) => ({ value: e.id, label: e.name })),
          ]}
        />
        <Picker
          label="Sort investments"
          value={sort}
          onChange={setSort}
          options={[
            { value: 'value', label: 'Value: high to low' },
            { value: 'name', label: 'Name: A to Z' },
            { value: 'date', label: 'Oldest valuation' },
          ]}
        />
      </div>
      <div className="investments-table-panel">
        {filtered.length ? (
          <HoldingsTable
            holdings={filtered}
            onSelect={onHolding}
            portfolioTotal={total}
          />
        ) : (
          <div className="empty-inline">
            <Search />
            <h3>
              {scoped.length
                ? 'No matching investments'
                : 'Add your first holding'}
            </h3>
            <p>
              {scoped.length
                ? 'Try a different name, entity or asset class.'
                : 'Create an opening position in EUR, then link incoming reports to it in Documents.'}
            </p>
            {!scoped.length ? (
              <Button
                onClick={() => setAdding(true)}
                disabled={state.identity?.role === 'viewer'}
              >
                <Plus data-icon="inline-start" />
                Add holding
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => {
                setSearch('');
                setAsset('all');
                setEntity('all');
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </div>
      <div className="table-footer">
        <span>
          {filtered.length} investments ·{' '}
          {money(
            filtered.reduce(
              (sum, holding) =>
                sum +
                (holding.valuationStatus === 'unknown' ? 0 : holding.valueEUR),
              0,
            ),
          )}{' '}
          matched
        </span>
        <span>Weights use the selected family’s complete portfolio.</span>
      </div>
    </>
  );
}
export function InvestmentDetail({
  id,
  onBack,
  onSource,
  onHolding,
}: {
  id: string;
  onBack: () => void;
  onSource: (id: string) => void;
  onHolding: (id: string) => void;
}) {
  const { data } = useWorkspace();
  const search = useSearchParams();
  const { controls, setControls, query } = useHistoryControls();
  const projection = usePortfolioHistory({ ...query, holdingIds: [id] });
  const h = data.holdings.find((holding) => holding.id === id);
  const tabValue = search.get('investmentTab');
  const tab = ['cash', 'activity', 'documents', 'exposure'].includes(
    tabValue ?? '',
  )
    ? tabValue!
    : 'history';
  const setTab = (value: string) => {
    const url = new URL(window.location.href);
    if (value === 'history') url.searchParams.delete('investmentTab');
    else url.searchParams.set('investmentTab', value);
    window.history.replaceState(null, '', url.pathname + url.search);
  };
  if (!h)
    return (
      <div className="empty-inline">
        <FileText />
        <h3>Investment unavailable</h3>
        <p>This holding is not in the current workspace.</p>
        <Button onClick={onBack}>All investments</Button>
      </div>
    );
  const position = projection.data?.positions.find(
    (item) => item.holdingId === id,
  );
  const exited = position?.ownership === 'closed';
  const latest = exited ? position.latestReported : position?.latest;
  const changeAmount = exited ? latest?.changeAmount : position?.changeAmount;
  const changePercent = exited
    ? latest?.changePercent
    : position?.changePercent;
  const events = data.events.filter((event) => event.holdingIds.includes(id));
  const documents = data.evidence
    .filter((source) => source.holdingId === id)
    .sort(
      (a, b) =>
        b.effectiveDate.localeCompare(a.effectiveDate) ||
        b.receivedAt.localeCompare(a.receivedAt) ||
        a.id.localeCompare(b.id),
    );
  const family = data.families.find((item) => item.id === h.familyId);
  const entity = data.entities.find((item) => item.id === h.entityId);
  const account = data.accounts.find((item) => item.id === h.accountId);
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft />
        All investments
      </button>
      <PageHeading
        title={h.name}
        subtitle={[
          h.manager === 'Not reported' ? 'Manager not reported' : h.manager,
          family?.name,
          entity?.name,
          h.currency,
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <HistoryLifecycle holding={h} onSaved={projection.refresh} />
        <Status>
          {h.assetClass}
          {h.assetClassStatus === 'inferred' ? ' · Inferred' : ''}
        </Status>
        {latest?.sourceId ? (
          <Button variant="outline" onClick={() => onSource(latest.sourceId!)}>
            <FileText data-icon="inline-start" />
            Latest source
          </Button>
        ) : null}
      </PageHeading>
      <div className={historyStyles.context}>
        <span>
          {account
            ? `${account.name} · ${account.institution} ${account.maskedNumber}`
            : 'Account details not recorded'}
        </span>
        <span>
          {position?.economicOpenedAt
            ? 'Opened ' + dateLabel(position.economicOpenedAt)
            : 'Opening date not recorded'}
          {position?.economicClosedAt
            ? ' · Exited ' + dateLabel(position.economicClosedAt)
            : ''}
          {position?.lifecycleCoverage === 'unknown'
            ? ' · Ownership history unverified'
            : ''}
        </span>
        <span>
          Liquidity:{' '}
          {h.liquidityStatus === 'unknown' ? 'Not reported' : h.liquidityBucket}
        </span>
      </div>
      <div className={'metrics-row three ' + historyStyles.detailMetrics}>
        <Metric
          label={
            exited
              ? 'Last reported NAV'
              : controls.asOf || controls.knownAt
                ? 'Selected reported value'
                : 'Latest reported value'
          }
          value={
            projection.loading
              ? 'Loading…'
              : position?.ownership === 'not_yet_opened'
                ? 'Not yet opened'
                : historyMoney(latest?.amount, controls.currency)
          }
          note={
            latest
              ? 'Reported ' +
                dateLabel(latest.effectiveDate) +
                (exited && position.economicClosedAt
                  ? ' · Exited ' + dateLabel(position.economicClosedAt)
                  : '')
              : position?.economicClosedAt
                ? 'Exit recorded ' + dateLabel(position.economicClosedAt)
                : position?.economicOpenedAt
                  ? 'Opening recorded ' + dateLabel(position.economicOpenedAt)
                  : 'A source observation is required'
          }
          help="This is the investor position’s reported value, not the manager’s total fund value. The actual source date remains visible."
        />
        <Metric
          label="Change since previous report"
          value={
            projection.loading
              ? 'Loading…'
              : historyMoney(changeAmount, controls.currency)
          }
          note={
            changePercent != null
              ? `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(2)}% value change${position?.previousComparable ? ' · since ' + dateLabel(position.previousComparable.effectiveDate) : ' between reported marks'}`
              : 'No comparable earlier report'
          }
          positive={changeAmount != null && !changeAmount.startsWith('-')}
          help="Change between comparable reported marks. Contributions, distributions and FX may affect the change; this is not an investment return."
        />
        <Metric
          label="Current unfunded commitment"
          value={
            h.unfundedStatus === 'unknown'
              ? 'Not reported'
              : money(h.unfundedCommitmentEUR)
          }
          note="EUR · current register · excluded from NAV"
          help="Current registered commitment. Historical commitment movements require separate evidence and are not inferred from NAV."
        />
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto mb-6">
          <TabsList variant="line" aria-label="Investment sections">
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="cash">Cash flows & commitments</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            <TabsTrigger value="exposure">Exposure</TabsTrigger>
          </TabsList>
        </div>
      </Tabs>
      {tab === 'history' ? (
        <InvestmentHistory
          {...projection}
          onRefresh={projection.refresh}
          controls={controls}
          onControls={setControls}
          onSource={onSource}
          onHolding={onHolding}
        />
      ) : tab === 'activity' ? (
        <InvestmentActivity events={events} onSource={onSource} />
      ) : tab === 'cash' ? (
        <InvestmentCash holding={h} onSource={onSource} />
      ) : tab === 'exposure' ? (
        <Panel
          title="Look-through & concentration"
          subtitle="Compare this position with the family’s other investments."
        >
          <p className="method-note">
            Underlying investments and shared-manager targets are maintained in
            the exposure workspace. Historical constituent weights are not
            inferred from current mappings.
          </p>
          <Link
            className="inline-flex items-center gap-2 mt-4 text-sm text-primary"
            href={'/?view=risk&family=' + encodeURIComponent(h.familyId)}
          >
            Open {family?.name ?? 'family'} exposure <ArrowUpRight size={15} />
          </Link>
        </Panel>
      ) : (
        <div className="document-grid">
          {documents.length ? (
            documents.map((source) => (
              <button
                className="document-tile"
                key={source.id}
                onClick={() => onSource(source.id)}
              >
                <span className="document-icon">
                  <FileText />
                </span>
                <div>
                  <h3>{source.subject}</h3>
                  <p>
                    {'effectiveDateBasis' in source &&
                    source.effectiveDateBasis === 'Receipt date fallback'
                      ? 'Effective date not supplied'
                      : dateLabel(source.effectiveDate)}{' '}
                    · {source.filename}
                  </p>
                  <Status
                    tone={source.status === 'Accepted' ? 'success' : 'warning'}
                  >
                    {source.status}
                  </Status>
                </div>
                <ArrowUpRight />
              </button>
            ))
          ) : (
            <div className="empty-inline">
              <FileText />
              <h3>No linked documents</h3>
              <p>Accepted source records for this investment appear here.</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function InvestmentCash({
  holding,
  onSource,
}: {
  holding: Holding;
  onSource: (id: string) => void;
}) {
  const { state } = useWorkspace();
  const finance = state.finance;
  const notices =
    finance?.obligations?.filter((notice) => notice.holdingId === holding.id) ??
    [];
  const settlements =
    finance?.events
      .filter((event) =>
        event.postings.some((posting) => posting.holdingId === holding.id),
      )
      .toSorted(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.at.localeCompare(a.at) ||
          a.id.localeCompare(b.id),
      ) ?? [];
  return (
    <div className={historyStyles.section}>
      <div className={historyStyles.cashCards}>
        <div>
          <h3>Current unfunded commitment</h3>
          <strong>
            {holding.unfundedStatus === 'unknown'
              ? 'Not reported'
              : money(holding.unfundedCommitmentEUR)}
          </strong>
          <p>Current register · EUR · not a reconstructed past balance</p>
        </div>
        <div>
          <h3>Remaining cost basis</h3>
          <strong>
            {holding.costBasisStatus === 'unknown'
              ? 'Not reported'
              : money(holding.costBasisEUR)}
          </strong>
          <p>Cost basis is not complete paid-in capital</p>
        </div>
        <div>
          <h3>Paid-in & distributed totals</h3>
          <strong>Not established</strong>
          <p>A complete investor cash-flow history is required</p>
        </div>
      </div>
      <Panel
        title="Calls & distributions"
        subtitle="Source notices and their settlement status remain separate from cash."
      >
        {notices.length ? (
          notices.map((notice) => {
            const summary = obligationSummary(finance!, notice);
            return (
              <div
                key={notice.id}
                className="flex flex-wrap items-start justify-between gap-4 border-b py-4 last:border-b-0"
              >
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">
                    {notice.kind === 'capital_call'
                      ? 'Capital call'
                      : 'Distribution'}{' '}
                    · {historyMoney(notice.amount, notice.currency ?? '')}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {notice.dueDate
                      ? 'Due ' + dateLabel(notice.dueDate)
                      : 'Due date not supplied'}{' '}
                    · {summary.status.replaceAll('_', ' ')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Settled{' '}
                    {historyMoney(summary.settledAmount, notice.currency ?? '')}{' '}
                    · remaining{' '}
                    {historyMoney(
                      summary.remainingAmount,
                      notice.currency ?? '',
                    )}
                  </p>
                </div>
                <div className="flex gap-3">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onSource(notice.sourceId)}
                  >
                    Source
                  </Button>
                  <Link
                    className="inline-flex items-center gap-1 text-sm text-primary"
                    href={
                      '/?view=ledger&holding=' +
                      encodeURIComponent(holding.id) +
                      '&obligation=' +
                      encodeURIComponent(notice.id)
                    }
                  >
                    Open obligation <ArrowUpRight size={14} />
                  </Link>
                </div>
              </div>
            );
          })
        ) : (
          <p className="method-note">
            No linked obligation records. The absence of a notice does not
            establish zero future calls or distributions.
          </p>
        )}
      </Panel>
      <Panel
        title="Recorded cash activity"
        subtitle="Settlements and reversals are shown with their original event dates."
      >
        {settlements.length ? (
          settlements.map((event) => {
            const transaction = finance!.transactions.find(
              (item) => item.id === event.transactionId,
            );
            return (
              <div
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b py-4 last:border-b-0"
              >
                <div>
                  <h3 className="text-sm font-medium">
                    {transaction?.kind.replaceAll('_', ' ') ?? 'Cash event'} ·{' '}
                    {event.type}
                  </h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {dateLabel(event.date)} ·{' '}
                    {transaction
                      ? historyMoney(transaction.amount, transaction.currency)
                      : 'Original transaction amount unavailable'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {event.source.reference}
                  </p>
                </div>
                {event.source.sourceId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onSource(event.source.sourceId!)}
                  >
                    View evidence
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Source reference only
                  </span>
                )}
              </div>
            );
          })
        ) : (
          <p className="method-note">
            No settlement events are recorded for this position. A notice alone
            never changes its settled cash history.
          </p>
        )}
        <Link
          className="inline-flex items-center gap-2 mt-4 text-sm text-primary"
          href={'/?view=ledger&holding=' + encodeURIComponent(holding.id)}
        >
          Open cash & commitments <ArrowUpRight size={15} />
        </Link>
      </Panel>
    </div>
  );
}

function AddHoldingForm({
  family,
  onSaved,
  onCancel,
}: {
  family: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { data, mutate } = useWorkspace();
  const [values, setValues] = useState({
    name: '',
    familyName: data.families.find((f) => f.id === family)?.name ?? '',
    assetClass: 'Private equity',
    valueEUR: '',
    costBasisEUR: '',
    unfundedCommitmentEUR: '0',
    valuationDate: new Date().toISOString().slice(0, 10),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const change = (key: keyof typeof values, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const amountKeys = [
      'valueEUR',
      'costBasisEUR',
      'unfundedCommitmentEUR',
    ] as const;
    if (
      amountKeys.some(
        (key) =>
          !/^\d+(?:\.\d{1,2})?$/.test(values[key]) ||
          Number(values[key]) > 1e12,
      )
    ) {
      setError(
        'Enter nonnegative EUR amounts with up to two decimal places, no more than 1,000,000,000,000.',
      );
      return;
    }
    if (
      values.name.trim().length < 2 ||
      values.familyName.trim().length < 2 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(values.valuationDate)
    ) {
      setError('Enter an investment name, family name and valuation date.');
      return;
    }
    setSaving(true);
    try {
      const saved = await mutate({
        type: 'addHolding',
        ...values,
        valueEUR: Number(values.valueEUR),
        costBasisEUR: Number(values.costBasisEUR),
        unfundedCommitmentEUR: Number(values.unfundedCommitmentEUR),
      });
      if (saved) onSaved();
      else
        setError(
          'The holding could not be saved. Check the workspace message and try again.',
        );
    } finally {
      setSaving(false);
    }
  }
  return (
    <Panel
      title="Opening holding"
      subtitle="Record the starting position in EUR. You can link source documents after import."
    >
      <form onSubmit={submit} className="flex flex-col gap-5 p-6">
        <FieldGroup className="grid gap-5 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="holding-name">Investment name</FieldLabel>
            <Input
              id="holding-name"
              required
              minLength={2}
              maxLength={150}
              value={values.name}
              onChange={(e) => change('name', e.target.value)}
              placeholder="Investment or fund name"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="holding-family">Family name</FieldLabel>
            <Input
              id="holding-family"
              required
              minLength={2}
              maxLength={80}
              value={values.familyName}
              onChange={(e) => change('familyName', e.target.value)}
              placeholder="Family name"
              list="workspace-families"
            />
            <datalist
              id="workspace-families"
              aria-label="Existing family names"
            >
              {data.families.map((f) => (
                <option key={f.id} value={f.name}>
                  {f.name}
                </option>
              ))}
            </datalist>
          </Field>
          <Field>
            <FieldLabel htmlFor="holding-asset">Asset class</FieldLabel>
            <Picker
              id="holding-asset"
              label="Opening holding asset class"
              value={values.assetClass}
              onChange={(v) => change('assetClass', v)}
              options={[
                'Public equities',
                'Private equity',
                'Venture capital',
                'Real estate',
                'Fixed income',
                'Cash',
              ].map((v) => ({ value: v, label: v }))}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="holding-date">Valuation date</FieldLabel>
            <Input
              id="holding-date"
              type="date"
              required
              value={values.valuationDate}
              onChange={(e) => change('valuationDate', e.target.value)}
            />
          </Field>
          {(
            [
              ['valueEUR', 'Opening value · EUR'],
              ['costBasisEUR', 'Remaining cost basis · EUR'],
              ['unfundedCommitmentEUR', 'Unfunded commitment · EUR'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} data-invalid={!!error}>
              <FieldLabel htmlFor={'holding-' + key}>{label}</FieldLabel>
              <Input
                id={'holding-' + key}
                inputMode="decimal"
                required
                aria-invalid={!!error}
                value={values[key]}
                onChange={(e) => change(key, e.target.value)}
                placeholder="0.00"
              />
            </Field>
          ))}
        </FieldGroup>
        <FieldDescription>
          This manual entry is not independent source evidence. Unfunded
          commitments are kept separate from portfolio value.
        </FieldDescription>
        {error ? (
          <p role="alert" className="negative">
            {error}
          </p>
        ) : null}
        <div className="flex gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save holding'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}
