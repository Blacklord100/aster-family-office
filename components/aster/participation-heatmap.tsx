'use client';

import { useState, type CSSProperties } from 'react';
import { Download, FileText } from 'lucide-react';
import type { PortfolioHistoryQuery } from '@/lib/portfolio-history-contract';
import { historyAmount } from '@/lib/history-display';
import { participationCSV } from '@/lib/participation-display';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { useParticipation } from './use-participation';
import { useWorkspace } from './workspace-context';
import { Picker, dateLabel } from './primitives';
import styles from './participation-heatmap.module.css';

export function ParticipationHeatmap({
  query,
  expectedRevision,
  onHolding,
  onSource,
  onInvestments,
}: {
  query: Partial<PortfolioHistoryQuery>;
  expectedRevision: number;
  onHolding: (id: string) => void;
  onSource: (id: string) => void;
  onInvestments: () => void;
}) {
  const result = useParticipation(query);
  const { state } = useWorkspace();
  const [mode, setMode] = useState('weight');
  const [navigation, setNavigation] = useState({
    key: '',
    page: 0,
    familyPage: 0,
    selected: '',
  });
  const key = JSON.stringify([query, result.data?.revision]);
  const nav =
    navigation.key === key
      ? navigation
      : { key, page: 0, familyPage: 0, selected: '' };
  const update = (value: Partial<typeof navigation>) =>
    setNavigation({ ...nav, ...value, key });
  // Never combine different accepted snapshots in one portfolio view.
  const data = result.data?.revision === expectedRevision ? result.data : null;
  if (result.error)
    return (
      <Alert variant="destructive" className={styles.feedback}>
        <AlertTitle>Participation needs attention</AlertTitle>
        <AlertDescription>
          {result.error}
          <Button variant="link" onClick={result.refresh}>
            Retry participation
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!data)
    return (
      <div className={styles.feedback}>
        <Skeleton className="h-48 w-full" />
        <p className={styles.note}>
          Loading participation for this portfolio snapshot…
        </p>
      </div>
    );
  const deals = data.investments.toSorted(
    (a, b) =>
      b.familyCount - a.familyCount ||
      Number(b.knownNAV ?? 0) - Number(a.knownNAV ?? 0),
  );
  const families = data.families;
  const page = Math.min(
    nav.page,
    Math.max(0, Math.ceil(deals.length / 10) - 1),
  );
  const familyPage = Math.min(
    nav.familyPage,
    Math.max(0, Math.ceil(families.length / 6) - 1),
  );
  const visibleFamilies = families.slice(familyPage * 6, (familyPage + 1) * 6);
  const visibleDeals = deals.slice(page * 10, (page + 1) * 10);
  const maximum = Math.max(
    1,
    ...deals.flatMap((deal) =>
      deal.families.map((family) =>
        mode === 'weight'
          ? (family.portfolioWeight ?? 0)
          : Number(family.nav ?? 0),
      ),
    ),
  );
  const selected = deals
    .flatMap((deal) =>
      deal.families.map((family) => ({
        deal,
        family,
        id: deal.id + ':' + family.familyId,
      })),
    )
    .find((cell) => cell.id === nav.selected);
  function download() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([participationCSV(data)], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `aster-participation-${data.asOf}-${data.currency}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div>
          <h3>Who participates, and how concentrated are they?</h3>
          <p className={styles.note}>
            As of {dateLabel(data.asOf)} · {data.currency} ·{' '}
            {data.query.entityIds?.length ||
            state.identity?.dataScope?.entityIds?.length
              ? 'Selected entities within each family'
              : 'Selected family portfolios'}
          </p>
        </div>
        <div className={styles.actions}>
          <Picker
            label="Heatmap value"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'weight', label: '% of visible family NAV' },
              { value: 'nav', label: 'Recorded deal NAV' },
            ]}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={result.refreshing}
            onClick={download}
          >
            <Download data-icon="inline-start" />
            Export participation
          </Button>
        </div>
      </div>
      {!deals.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              No shared investment links in this selection
            </EmptyTitle>
            <EmptyDescription>
              Confirm which positions belong to the same legal vehicle, share
              class and round in Investments. Similar names alone do not
              establish participation.
            </EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={onInvestments}>
            Review investment links
          </Button>
        </Empty>
      ) : (
        <>
          <p className={styles.mobileHint + ' ' + styles.note}>
            Scroll horizontally to compare families.
          </p>
          <Table className={styles.grid}>
            <TableHeader>
              <TableRow>
                <TableHead className={styles.deal}>Shared investment</TableHead>
                {visibleFamilies.map((family) => (
                  <TableHead key={family.familyId}>
                    <span className={styles.family}>
                      <i style={{ backgroundColor: family.color }} />
                      {family.name}
                    </span>
                    <small>
                      {historyAmount(family.portfolioNAV, data.currency, true)}{' '}
                      portfolio NAV
                    </small>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleDeals.map((deal) => (
                <TableRow key={deal.id}>
                  <TableCell className={styles.deal}>
                    <strong>{deal.identity.name}</strong>
                    <small>
                      {deal.identity.shareClass} · {deal.identity.round}
                    </small>
                    <small>
                      {deal.familyCount}{' '}
                      {deal.familyCount === 1 ? 'family' : 'families'} ·{' '}
                      {historyAmount(deal.knownNAV, data.currency, true)}{' '}
                      {deal.coverage.complete ? 'NAV' : 'known NAV'}
                    </small>
                  </TableCell>
                  {visibleFamilies.map((family) => {
                    const member = deal.families.find(
                      (item) => item.familyId === family.familyId,
                    );
                    const value = member
                      ? mode === 'weight'
                        ? member.portfolioWeight
                        : member.nav === null
                          ? null
                          : Number(member.nav)
                      : null;
                    const id = deal.id + ':' + family.familyId;
                    const label = !member
                      ? 'No linked position'
                      : value === null
                        ? 'Unavailable'
                        : mode === 'weight'
                          ? value.toLocaleString('en-GB', {
                              maximumFractionDigits: 2,
                            }) + '%'
                          : historyAmount(member.nav, data.currency, true);
                    return (
                      <TableCell key={family.familyId}>
                        {member ? (
                          <button
                            className={styles.cell}
                            style={
                              {
                                '--heat':
                                  value === null || value <= 0
                                    ? '0%'
                                    : Math.max(
                                        5,
                                        Math.min(
                                          72,
                                          8 +
                                            (Math.max(0, value) / maximum) * 64,
                                        ),
                                      ) + '%',
                              } as CSSProperties
                            }
                            aria-label={`${deal.identity.name}, ${family.name}: ${label}`}
                            aria-pressed={nav.selected === id}
                            onClick={() =>
                              update({
                                selected: nav.selected === id ? '' : id,
                              })
                            }
                          >
                            <strong>{label}</strong>
                            <small>
                              {member.investmentCoverage.complete
                                ? member.positions.length +
                                  ' position' +
                                  (member.positions.length === 1 ? '' : 's')
                                : 'Incomplete valuation'}
                            </small>
                          </button>
                        ) : (
                          <span
                            className={styles.absent}
                            title="No reviewed participation link at this date"
                          >
                            —<small>No linked position</small>
                          </span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className={styles.legend}>
            <span className={styles.scale} />
            {mode === 'weight'
              ? 'Higher concentration'
              : 'Higher recorded NAV'}{' '}
            <span>
              · Unavailable = linked, with insufficient valuation data
            </span>
            <span>· — = no reviewed link</span>
          </div>
          {selected ? (
            <div className={styles.selection}>
              <div className={styles.toolbar}>
                <div>
                  <h4>
                    {selected.family.name} · {selected.deal.identity.name}
                  </h4>
                  <p className={styles.note}>
                    {selected.deal.identity.vehicle} ·{' '}
                    {selected.deal.identity.shareClass} ·{' '}
                    {selected.deal.identity.round}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => update({ selected: '' })}
                >
                  Close selection
                </Button>
              </div>
              <div className={styles.summary}>
                <span>
                  <strong>
                    {historyAmount(selected.family.nav, data.currency, true)}
                  </strong>
                  Family deal NAV
                </span>
                <span>
                  <strong>
                    {selected.family.shareOfKnownNAV?.toLocaleString('en-GB', {
                      maximumFractionDigits: 2,
                    }) ?? 'Unavailable'}
                    {selected.family.shareOfKnownNAV !== null ? '%' : ''}
                  </strong>
                  Share of visible known deal NAV
                </span>
                <span>
                  <strong>
                    {selected.family.portfolioWeight?.toLocaleString('en-GB', {
                      maximumFractionDigits: 2,
                    }) ?? 'Unavailable'}
                    {selected.family.portfolioWeight !== null ? '%' : ''}
                  </strong>
                  Weight in selected family NAV
                </span>
              </div>
              {selected.family.positions.map((position) => (
                <div className={styles.position} key={position.holdingId}>
                  <div>
                    <Button
                      variant="link"
                      className={styles.positionLink}
                      onClick={() => onHolding(position.holdingId)}
                    >
                      {position.entityName} → {position.name}
                    </Button>
                    <p className={styles.note}>
                      {position.accountName} ·{' '}
                      {historyAmount(position.nav, data.currency)} ·{' '}
                      {position.valuationDate
                        ? 'Valued ' + dateLabel(position.valuationDate)
                        : 'Valuation unavailable'}
                    </p>
                    <p className={styles.note}>
                      {position.actualOwnershipPercent === null
                        ? 'Actual ownership not reported'
                        : `${position.actualOwnershipPercent}% of ${position.ownershipBasis} · effective ${dateLabel(position.ownershipEffectiveDate!)}`}
                    </p>
                  </div>
                  <div className={styles.actions}>
                    {position.valuationSourceId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSource(position.valuationSourceId!)}
                      >
                        <FileText data-icon="inline-start" />
                        Valuation evidence
                      </Button>
                    ) : null}
                    {position.sourceId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSource(position.sourceId!)}
                      >
                        <FileText data-icon="inline-start" />
                        Link evidence
                      </Button>
                    ) : null}
                    {position.ownershipSourceId &&
                    position.ownershipSourceId !== position.sourceId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onSource(position.ownershipSourceId!)}
                      >
                        Ownership evidence
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {deals.length > 10 || families.length > 6 ? (
            <div className={styles.pagination}>
              <span className={styles.note}>
                Deals {page * 10 + 1}–{Math.min(deals.length, (page + 1) * 10)}{' '}
                of {deals.length} · Families {familyPage * 6 + 1}–
                {Math.min(families.length, (familyPage + 1) * 6)} of{' '}
                {families.length}
              </span>
              <div className={styles.actions}>
                {families.length > 6 ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!familyPage}
                      onClick={() => update({ familyPage: familyPage - 1 })}
                    >
                      Previous families
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={(familyPage + 1) * 6 >= families.length}
                      onClick={() => update({ familyPage: familyPage + 1 })}
                    >
                      Next families
                    </Button>
                  </>
                ) : null}
                {deals.length > 10 ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!page}
                      onClick={() => update({ page: page - 1 })}
                    >
                      Previous deals
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={(page + 1) * 10 >= deals.length}
                      onClick={() => update({ page: page + 1 })}
                    >
                      Next deals
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
      <div className={styles.footer}>
        <p className={styles.note}>
          {data.unlinked.length} positions have no reviewed deal link in this
          selection. Percentages describe recorded exposure; they are not legal
          ownership. Family NAV includes all positions in the selected
          family/entity scope, including unlinked positions.
        </p>
        {data.unlinked.length ? (
          <Button variant="link" size="sm" onClick={onInvestments}>
            Review unlinked positions
          </Button>
        ) : null}
        {data.gaps.length ? (
          <details className={styles.details}>
            <summary>Coverage and calculation notes</summary>
            {data.gaps.map((gap) => (
              <p key={gap} className={styles.note}>
                {gap}
              </p>
            ))}
          </details>
        ) : null}
      </div>
    </div>
  );
}
