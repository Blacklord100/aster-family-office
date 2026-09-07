'use client';
import { useMemo, useState } from 'react';
import {
  Search,
  ArrowLeft,
  Download,
  Building2,
  FileText,
  ArrowUpRight,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { accounts, entities } from '@/data';
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
  const { data } = useWorkspace();
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
          ' in portfolio value'
        }
      >
        <FamilyPicker
          value={family}
          onChange={(v) => {
            setEntity('all');
            onFamily(v);
          }}
        />
        <Button variant="outline" onClick={onExport}>
          <Download data-icon="inline-start" />
          Export report
        </Button>
      </PageHeading>
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
            ...entities
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
            <h3>No matching investments</h3>
            <p>Try a different name, entity or asset class.</p>
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
  const { data } = useWorkspace();
  const h = data.holdings.find((h) => h.id === id)!;
  const [tab, setTab] = useState('overview');
  const [selectedSource, setSelectedSource] = useState(h.sourceId);
  const sourceId = data.evidence.some(
    (s) => s.id === selectedSource && s.holdingId === id,
  )
    ? selectedSource
    : h.sourceId;
  const events = data.events.filter((e) => e.holdingIds.includes(id));
  const documents = data.evidence.filter((s) => s.holdingId === id);
  const history = useMemo(
    () => makeHistory(data.history, new Set([id]), '2025-09-07'),
    [data.history, id],
  );
  const acc = accounts.find((a) => a.id === h.accountId)!;
  const costRatio = h.costBasisEUR ? h.valueEUR / h.costBasisEUR : 0;
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
          h.familyId[0].toUpperCase() +
          h.familyId.slice(1) +
          ' family · ' +
          h.currency
        }
      >
        <Status>{h.assetClass}</Status>
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
      <div className="metrics-row three">
        <Metric
          label="Net asset value"
          value={money(h.valueEUR)}
          note={'As of ' + dateLabel(h.valuationDate)}
        />
        <Metric
          label={
            h.unfundedCommitmentEUR ? 'Unfunded commitment' : 'Unrealized gain'
          }
          value={money(h.unfundedCommitmentEUR || h.valueEUR - h.costBasisEUR)}
          note={
            h.unfundedCommitmentEUR
              ? 'Excluded from portfolio NAV'
              : 'Versus remaining cost basis'
          }
        />
        <Metric
          label="Value / cost"
          value={costRatio.toFixed(2) + '×'}
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
                    : [
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
              <ValueChart data={history} small />
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
                  {money(h.costBasisEUR + h.unfundedCommitmentEUR)}
                </div>
                <p className="method-note">
                  Cost basis plus remaining commitment
                </p>
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
                <div className="capital-row">
                  <span>Invested cost basis</span>
                  <strong>{money(h.costBasisEUR)}</strong>
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
                    <h3>{entities.find((e) => e.id === h.entityId)?.name}</h3>
                    <p>
                      {acc.institution} {acc.maskedNumber}
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
