'use client';
import { useMemo, useState } from 'react';
import {
  Search,
  ArrowLeft,
  Download,
  Building2,
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
  ViewTabs,
  Metric,
  Status,
  money,
  percent,
  dateLabel,
  usePerformanceAvailable,
} from './primitives';
import { HoldingsTable } from './overview';
import { ValueChart, makeHistory } from './charts';
import { TimelineList } from './timeline';
import { EvidencePanel } from './evidence';
export function InvestmentsView({
  family,
  onFamily,
  onHolding,
  onExport,
}: {
  family: string;
  onFamily: (s: string) => void;
  onHolding: (id: string) => void;
  onExport: () => void;
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
  const total = scoped.reduce((s, h) => s + h.valueEUR, 0);
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
          {money(filtered.reduce((s, h) => s + h.valueEUR, 0))} matched
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
  const { state, data } = useWorkspace();
  const performanceAvailable = usePerformanceAvailable();
  const h = data.holdings.find((h) => h.id === id);
  const [tab, setTab] = useState('overview');
  const [selectedSource, setSelectedSource] = useState('');
  const sourceId = data.evidence.some(
    (s) => s.id === selectedSource && s.holdingId === id,
  )
    ? selectedSource
    : (h?.sourceId ?? '');
  const events = data.events.filter((e) => e.holdingIds.includes(id));
  const documents = data.evidence.filter((s) => s.holdingId === id);
  const history = useMemo(
    () => makeHistory(data.history, new Set([id]), '2025-09-07'),
    [data.history, id],
  );
  const acc = data.accounts.find((a) => a.id === h?.accountId);
  if (!h)
    return (
      <div className="empty-inline">
        <FileText />
        <h3>Investment unavailable</h3>
        <p>This holding is not in the current workspace.</p>
        <Button onClick={onBack}>All investments</Button>
      </div>
    );
  const valueKnown = h.valuationStatus !== 'unknown';
  const costKnown = h.costBasisStatus !== 'unknown';
  const unfundedKnown = h.unfundedStatus !== 'unknown';
  const costRatio =
    valueKnown && costKnown && h.costBasisEUR
      ? h.valueEUR / h.costBasisEUR
      : null;
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft />
        All investments
      </button>
      <PageHeading
        title={h.name}
        subtitle={
          h.manager +
          ' · ' +
          (data.families.find((f) => f.id === h.familyId)?.name ??
            'Unassigned') +
          ' family · ' +
          h.currency
        }
      >
        <Status>
          {h.assetClass}
          {h.assetClassStatus === 'inferred' ? ' · Inferred' : ''}
        </Status>
        <Button variant="outline" onClick={() => onSource(h.sourceId)}>
          <FileText data-icon="inline-start" />
          View source
        </Button>
      </PageHeading>
      <ViewTabs
        value={tab}
        onChange={setTab}
        items={['Overview', 'Timeline', 'Documents']}
      />
      <p className="method-note">
        Liquidity ·{' '}
        {h.liquidityStatus === 'unknown' ? 'Not reported' : h.liquidityBucket}
        {h.assetClassStatus === 'inferred'
          ? ' · Asset class is inferred and requires review.'
          : ''}
      </p>
      <div className="metrics-row three">
        <Metric
          label="Net asset value"
          value={valueKnown ? money(h.valueEUR) : 'Not reported'}
          note={
            valueKnown
              ? 'As of ' + dateLabel(h.valuationDate)
              : 'A source valuation is still required'
          }
        />
        <Metric
          label={
            !unfundedKnown || h.unfundedCommitmentEUR
              ? 'Unfunded commitment'
              : 'Unrealized gain'
          }
          value={
            !unfundedKnown
              ? 'Not reported'
              : h.unfundedCommitmentEUR
                ? money(h.unfundedCommitmentEUR)
                : valueKnown && costKnown
                  ? money(h.valueEUR - h.costBasisEUR)
                  : 'Unavailable'
          }
          note={
            !unfundedKnown
              ? 'A reported commitment is still required'
              : !costKnown && !h.unfundedCommitmentEUR
                ? 'Remaining cost basis is not reported'
                : h.unfundedCommitmentEUR
                  ? 'Excluded from portfolio NAV'
                  : 'Versus remaining cost basis'
          }
        />
        <Metric
          label="Value / cost"
          value={
            costRatio === null ? 'Unavailable' : costRatio.toFixed(2) + '×'
          }
          note="Current NAV / cost basis"
          help="This ratio excludes historic distributions and is not a TVPI or net fund multiple."
        />
      </div>
      {tab === 'timeline' ? (
        <Panel
          title="All investment developments"
          subtitle="A chronological record, with every update linked to its source."
        >
          <TimelineList events={events} onSource={onSource} />
        </Panel>
      ) : tab === 'documents' ? (
        <div className="document-grid">
          {documents.map((s) => (
            <button
              className="document-tile"
              key={s.id}
              onClick={() => onSource(s.id)}
            >
              <span className="document-icon">
                <FileText />
              </span>
              <div>
                <h3>{s.subject}</h3>
                <p>
                  {dateLabel(s.effectiveDate)} ·{' '}
                  {s.filename.endsWith('.pdf') ? 'Statement' : 'Correspondence'}
                </p>
                <Status tone={s.status === 'Accepted' ? 'success' : 'warning'}>
                  {s.status}
                </Status>
              </div>
              <ArrowUpRight />
            </button>
          ))}
        </div>
      ) : (
        <div className="reporting-grid detail-grid">
          <div className="detail-main">
            <Panel
              title="Investment timeline"
              subtitle={events.length + ' source-linked developments'}
            >
              <TimelineList
                events={
                  events.length
                    ? events
                    : state.sampleData
                      ? [
                          {
                            id: 'base-' + h.id,
                            familyId: h.familyId,
                            holdingIds: [h.id],
                            entityId: h.entityId,
                            type: 'Valuation',
                            title: 'Latest valuation statement received',
                            summary:
                              'Accepted investor-level value of ' +
                              money(h.valueEUR) +
                              '. ' +
                              h.description,
                            date: h.valuationDate,
                            receivedAt: h.valuationDate + 'T12:00:00Z',
                            sourceId: h.sourceId,
                            status: 'Accepted',
                            materiality: 'Medium',
                            financialEffect: 'Accepted valuation',
                          },
                        ]
                      : []
                }
                onSource={setSelectedSource}
                selectedId={sourceId}
                compact
              />
            </Panel>
            <Panel
              title="Valuation history"
              subtitle="Latest reported marks · EUR"
            >
              {performanceAvailable && history.length > 1 ? (
                <ValueChart data={history} small />
              ) : (
                <div className="flex flex-col gap-3 p-6">
                  {data.history
                    .filter((row) => row.holdingId === id)
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .slice(0, 8)
                    .map((row) => (
                      <div
                        className="flex items-center justify-between gap-3"
                        key={row.date}
                      >
                        <span className="whitespace-nowrap">
                          {dateLabel(row.date)}
                        </span>
                        <strong>{money(row.valueEUR, 2)}</strong>
                      </div>
                    ))}
                  <p className="method-note">
                    Recorded marks only. Complete cash-flow history is
                    unavailable; no return is calculated.
                  </p>
                </div>
              )}
            </Panel>
          </div>
          <div className="detail-rail">
            <Panel title="">
              <EvidencePanel
                sourceId={sourceId}
                onHolding={onHolding}
                embedded
              />
            </Panel>
            {h.unfundedCommitmentEUR ? (
              <Panel title="Capital overview">
                <div className="capital-value">
                  {costKnown
                    ? money(h.costBasisEUR + h.unfundedCommitmentEUR)
                    : 'Cost basis not reported'}
                </div>
                <p className="method-note">
                  Cost basis plus remaining commitment
                </p>
                {costKnown ? (
                  <div className="capital-track">
                    <span
                      style={{
                        width: percent(
                          h.costBasisEUR /
                            (h.costBasisEUR + h.unfundedCommitmentEUR),
                        ),
                      }}
                    />
                  </div>
                ) : null}
                <div className="capital-row">
                  <span>Invested cost basis</span>
                  <strong>
                    {costKnown ? money(h.costBasisEUR) : 'Not reported'}
                  </strong>
                </div>
                <div className="capital-row">
                  <span>Remaining commitment</span>
                  <strong>{money(h.unfundedCommitmentEUR)}</strong>
                </div>
              </Panel>
            ) : (
              <Panel title="Ownership & account">
                <div className="account-detail">
                  <Building2 />
                  <div>
                    <h3>
                      {data.entities.find((e) => e.id === h.entityId)?.name}
                    </h3>
                    <p>
                      {acc
                        ? acc.institution + ' ' + acc.maskedNumber
                        : 'Account details unavailable'}
                    </p>
                  </div>
                </div>
                <p className="method-note">{h.valuationMethod}</p>
              </Panel>
            )}
          </div>
        </div>
      )}
    </>
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
