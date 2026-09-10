'use client';

import { useState } from 'react';
import { ArrowUpRight, Link2, Users } from 'lucide-react';
import type { Holding } from '@/data';
import type { PortfolioHistoryQuery } from '@/lib/portfolio-history-contract';
import type { ParticipationResponse } from '@/lib/participation-contract';
import { historyAmount } from '@/lib/history-display';
import {
  investmentSummaries,
  historySparkline,
} from '@/lib/investment-summary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { cn } from '@/lib/utils';
import { dateLabel } from './primitives';
import { useWorkspace } from './workspace-context';
import { useParticipation } from './use-participation';
import { ParticipationEditor } from './participation-editor';
import styles from './participation.module.css';

export type SharedInvestment = ParticipationResponse['investments'][number];
export type ParticipatingFamily = SharedInvestment['families'][number];
export const participationPercent = (value: number | null | undefined) =>
  value == null ? 'Unavailable' : `${value.toFixed(2)}%`;

export function ParticipationBar({
  investment,
  onFamily,
  compact = false,
}: {
  investment: SharedInvestment;
  onFamily?: (family: ParticipatingFamily) => void;
  compact?: boolean;
}) {
  const segments = investment.families
    .filter((family) => (family.shareOfKnownNAV ?? 0) > 0)
    .toSorted(
      (a, b) =>
        (b.shareOfKnownNAV ?? 0) - (a.shareOfKnownNAV ?? 0) ||
        a.name.localeCompare(b.name),
    );
  if (
    investment.families.some(
      (family) =>
        (family.shareOfKnownNAV ?? 0) < 0 ||
        (family.shareOfKnownNAV ?? 0) > 100,
    )
  )
    return (
      <p className={styles.note}>
        Stacked proportions are unavailable for signed NAV balances.
      </p>
    );
  if (!segments.length)
    return (
      <p className={styles.note}>
        Participation proportions need comparable reported values.
      </p>
    );
  return (
    <div
      className={cn(styles.bar, compact && styles.barCompact)}
      aria-label="Family shares of recorded participation"
    >
      {segments.map((family) => {
        const label = `${family.name}: ${participationPercent(family.shareOfKnownNAV)} of ${investment.coverage.complete ? 'recorded' : 'known'} deal NAV`;
        const style = {
          width: `${family.shareOfKnownNAV}%`,
          backgroundColor: family.color,
        };
        return onFamily ? (
          <button
            key={family.familyId}
            type="button"
            style={style}
            title={label}
            aria-label={label}
            onClick={() => onFamily(family)}
          >
            <span>
              {!compact && (family.shareOfKnownNAV ?? 0) >= 16
                ? `${family.name} · ${participationPercent(family.shareOfKnownNAV)}`
                : ''}
            </span>
          </button>
        ) : (
          <span key={family.familyId} style={style} title={label}>
            <span>
              {!compact && (family.shareOfKnownNAV ?? 0) >= 16
                ? `${family.name} · ${participationPercent(family.shareOfKnownNAV)}`
                : ''}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function FamilyParticipationLabel({
  investment,
}: {
  investment: SharedInvestment;
}) {
  return (
    <div className={styles.familyLabel}>
      <div className={styles.familyDots} aria-hidden="true">
        {investment.families.slice(0, 4).map((family) => (
          <span key={family.familyId} style={{ backgroundColor: family.color }}>
            {family.name.slice(0, 1)}
          </span>
        ))}
      </div>
      <span>
        {investment.familyCount}{' '}
        {investment.familyCount === 1 ? 'family' : 'families'}
      </span>
    </div>
  );
}

export function DealParticipation({
  holding,
  query,
  onHolding,
  onSource,
}: {
  holding: Holding;
  query: Partial<PortfolioHistoryQuery>;
  onHolding: (id: string) => void;
  onSource: (id: string) => void;
}) {
  const { state } = useWorkspace();
  const {
    holdingIds: _holdingIds,
    familyIds: _familyIds,
    entityIds: _entityIds,
    ...selection
  } = query;
  const participation = useParticipation(selection);
  const [editing, setEditing] = useState(false);
  const investment = participation.data?.investments.find((deal) =>
    deal.positions.some((position) => position.holdingId === holding.id),
  );
  const current = investment?.positions.find(
    (position) => position.holdingId === holding.id,
  );
  const canWrite = participation.data?.canWrite ?? false;
  const scopeKey = JSON.stringify([
    state.identity?.organizationId,
    state.identity?.dataScope,
    holding.id,
  ]);
  if (!state.identity) return null;
  return (
    <section className={styles.panel} aria-label="Deal participation">
      <div className={styles.panelHeading}>
        <div>
          <div className={styles.eyebrow}>Shared deal</div>
          <h2>{investment?.identity.name ?? 'Family participation'}</h2>
          <p>
            {investment
              ? `${investment.identity.vehicle} · ${investment.identity.shareClass} · ${investment.identity.round}`
              : 'Connect the same investment across your families.'}
          </p>
        </div>
        <div className={styles.actions}>
          {investment ? (
            <Badge variant="secondary">
              {investment.familyCount}{' '}
              {investment.familyCount === 1 ? 'family' : 'families'} ·{' '}
              {investment.positionCount}{' '}
              {investment.positionCount === 1 ? 'position' : 'positions'}
            </Badge>
          ) : null}
          {canWrite ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Link2 data-icon="inline-start" />
              {investment ? 'Manage participation' : 'Link this position'}
            </Button>
          ) : null}
        </div>
      </div>
      {participation.loading ? (
        <div className={styles.loading}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : participation.error ? (
        <div className={styles.inner}>
          <Alert variant="destructive">
            <AlertTitle>Participation unavailable</AlertTitle>
            <AlertDescription>
              {participation.error}
              <Button
                variant="outline"
                size="sm"
                onClick={participation.refresh}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : investment && participation.data ? (
        <>
          <div className={styles.inner}>
            <div className={styles.barHeading}>
              <span>
                Share of {investment.coverage.complete ? 'recorded' : 'known'}{' '}
                deal NAV
              </span>
              <strong>
                {historyAmount(
                  investment.nav ?? investment.knownNAV,
                  participation.data.currency,
                )}
                <small>
                  {investment.coverage.complete ? '' : ' · known subtotal'}
                </small>
              </strong>
            </div>
            <ParticipationBar
              investment={investment}
              onFamily={(family) => onHolding(family.positions[0].holdingId)}
            />
            <div className={styles.mobileLegend}>
              {investment.families
                .toSorted(
                  (a, b) => (b.shareOfKnownNAV ?? 0) - (a.shareOfKnownNAV ?? 0),
                )
                .map((family) => (
                  <button
                    key={family.familyId}
                    onClick={() => onHolding(family.positions[0].holdingId)}
                  >
                    <span
                      className={styles.dot}
                      style={{ backgroundColor: family.color }}
                    />
                    <span>{family.name}</span>
                    <strong>
                      {participationPercent(family.shareOfKnownNAV)}
                    </strong>
                  </button>
                ))}
            </div>
            <div className={styles.barCaption}>
              <span>
                As of {dateLabel(participation.data.asOf)} ·{' '}
                {investment.coverage.knownCount}/
                {investment.coverage.totalCount} positions valued
              </span>
              <span>Participation is separate from actual ownership.</span>
            </div>
          </div>
          <Table className={styles.table}>
            <TableHeader>
              <TableRow>
                <TableHead>Participating family / entity</TableHead>
                <TableHead className={styles.numeric}>Reported NAV</TableHead>
                <TableHead className={styles.numeric}>
                  Deal participation
                </TableHead>
                <TableHead className={styles.numeric}>
                  Family portfolio weight
                </TableHead>
                <TableHead>Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {investment.families.map((family) => (
                <TableRow
                  key={family.familyId}
                  data-state={
                    family.familyId === holding.familyId
                      ? 'selected'
                      : undefined
                  }
                >
                  <TableCell>
                    <div className={styles.familyName}>
                      <span
                        className={styles.dot}
                        style={{ backgroundColor: family.color }}
                      />
                      <strong>{family.name}</strong>
                      {family.familyId === holding.familyId ? (
                        <Badge variant="outline">Selected family</Badge>
                      ) : null}
                    </div>
                    <div className={styles.positionLinks}>
                      {family.positions.map((position) => (
                        <button
                          key={position.holdingId}
                          onClick={() => onHolding(position.holdingId)}
                        >
                          {position.entityName}
                          <ArrowUpRight size={12} />
                        </button>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className={styles.numeric}>
                    {historyAmount(
                      family.nav ?? family.knownNAV,
                      participation.data!.currency,
                    )}
                    <small>
                      {family.investmentCoverage.complete
                        ? `${family.positions.length} ${family.positions.length === 1 ? 'position' : 'positions'}`
                        : 'Known subtotal · incomplete'}
                    </small>
                  </TableCell>
                  <TableCell className={styles.numeric}>
                    {participationPercent(family.shareOfKnownNAV)}
                    <small>
                      {investment.coverage.complete
                        ? 'of recorded deal NAV'
                        : 'of known deal NAV'}
                    </small>
                  </TableCell>
                  <TableCell className={styles.numeric}>
                    {participationPercent(family.portfolioWeight)}
                    <small>
                      {family.portfolioNAV == null
                        ? 'Portfolio coverage incomplete'
                        : 'of visible family NAV'}
                    </small>
                  </TableCell>
                  <TableCell>
                    <div className={styles.sourceLinks}>
                      {family.positions.map((position) => (
                        <div key={position.holdingId}>
                          {position.valuationSourceId ? (
                            <button
                              onClick={() =>
                                onSource(position.valuationSourceId!)
                              }
                            >
                              {dateLabel(position.valuationDate ?? '')}
                              <ArrowUpRight size={12} />
                            </button>
                          ) : (
                            <span className={styles.note}>No source mark</span>
                          )}
                          {position.sourceId ? (
                            <button
                              onClick={() => onSource(position.sourceId!)}
                            >
                              Participation evidence
                              <ArrowUpRight size={12} />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className={styles.ownership}>
            <span>Actual ownership of this position</span>
            <strong>
              {current?.actualOwnershipPercent != null
                ? `${current.actualOwnershipPercent}%`
                : 'Not reported'}
            </strong>
            <span>
              {current?.ownershipBasis ??
                'Requires a sourced units, equity or fund ownership record.'}
            </span>
            {current?.ownershipSourceId ? (
              <button onClick={() => onSource(current.ownershipSourceId!)}>
                Source · {dateLabel(current.ownershipEffectiveDate ?? '')}
                <ArrowUpRight size={12} />
              </button>
            ) : null}
          </div>
          <div className={styles.footnote}>
            {participation.data.denominatorLabel}
            {participation.refreshing ? ' · Refreshing…' : ''}
          </div>
        </>
      ) : (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users />
            </EmptyMedia>
            <EmptyTitle>
              This position has no reviewed shared-deal link
            </EmptyTitle>
            <EmptyDescription>
              Link documented positions in the same vehicle, share class and
              round to see which families participate. Similar investment names
              are not enough.
            </EmptyDescription>
          </EmptyHeader>
          {!canWrite ? (
            <p className={styles.note}>
              An unrestricted workspace editor can record participation.
            </p>
          ) : null}
        </Empty>
      )}
      {participation.data ? (
        <ParticipationEditor
          key={scopeKey}
          open={editing}
          onOpenChange={setEditing}
          holding={holding}
          response={participation.data}
          onSaved={participation.refresh}
        />
      ) : null}
    </section>
  );
}

export function DealsTable({
  response,
  sort = 'value',
  holdingIds,
  onHolding,
  onLink,
  onSource,
}: {
  response: ParticipationResponse;
  sort?: string;
  holdingIds: readonly string[];
  onHolding: (id: string) => void;
  onLink?: (id: string) => void;
  onSource?: (id: string) => void;
}) {
  const visible = new Set(holdingIds);
  const moneyOrder = (a: string | null, b: string | null) => {
    if (a == null) return b == null ? 0 : 1;
    if (b == null) return -1;
    const left = BigInt(a.replace('.', '')),
      right = BigInt(b.replace('.', ''));
    return left === right ? 0 : left > right ? -1 : 1;
  };
  const investments = response.investments
    .filter((deal) =>
      deal.positions.some((position) => visible.has(position.holdingId)),
    )
    .toSorted((a, b) =>
      sort === 'name'
        ? a.identity.name.localeCompare(b.identity.name)
        : sort === 'date'
          ? (
              a.positions
                .map((position) => position.valuationDate ?? '9999')
                .sort()[0] ?? '9999'
            ).localeCompare(
              b.positions
                .map((position) => position.valuationDate ?? '9999')
                .sort()[0] ?? '9999',
            )
          : moneyOrder(a.nav ?? a.knownNAV, b.nav ?? b.knownNAV),
    );
  const unlinked = response.unlinked
    .filter((position) => visible.has(position.holdingId))
    .toSorted((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : sort === 'date'
          ? (a.valuationDate ?? '9999').localeCompare(b.valuationDate ?? '9999')
          : moneyOrder(a.nav, b.nav),
    );
  return (
    <>
      <Table className={styles.table}>
        <TableHeader>
          <TableRow>
            <TableHead>Deal / vehicle</TableHead>
            <TableHead>Participating families</TableHead>
            <TableHead>Proportions</TableHead>
            <TableHead className={styles.numeric}>Recorded NAV</TableHead>
            <TableHead>Coverage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {investments.map((deal) => (
            <TableRow key={deal.id}>
              <TableCell>
                <button
                  className={styles.dealName}
                  onClick={() =>
                    onHolding(
                      deal.positions.find((position) =>
                        visible.has(position.holdingId),
                      )!.holdingId,
                    )
                  }
                >
                  {deal.identity.name}
                  <ArrowUpRight size={14} />
                </button>
                <small>
                  {deal.identity.vehicle} · {deal.identity.shareClass} ·{' '}
                  {deal.identity.round}
                </small>
              </TableCell>
              <TableCell>
                <FamilyParticipationLabel investment={deal} />
                <small>
                  {deal.families.map((family) => family.name).join(', ')}
                </small>
              </TableCell>
              <TableCell>
                <div className={styles.miniBar}>
                  <ParticipationBar
                    investment={deal}
                    compact
                    onFamily={(family) =>
                      onHolding(family.positions[0].holdingId)
                    }
                  />
                </div>
              </TableCell>
              <TableCell className={styles.numeric}>
                {historyAmount(deal.nav ?? deal.knownNAV, response.currency)}
                <small>
                  {deal.coverage.complete
                    ? 'Recorded participation'
                    : 'Known subtotal'}
                </small>
              </TableCell>
              <TableCell>
                <Badge
                  variant={deal.coverage.complete ? 'secondary' : 'outline'}
                >
                  {deal.coverage.knownCount}/{deal.coverage.totalCount} valued
                </Badge>
              </TableCell>
            </TableRow>
          ))}
          {unlinked.map((position) => (
            <TableRow key={position.holdingId}>
              <TableCell>
                <button
                  className={styles.dealName}
                  onClick={() => onHolding(position.holdingId)}
                >
                  {position.name}
                  <ArrowUpRight size={14} />
                </button>
                <small>{position.entityName}</small>
              </TableCell>
              <TableCell>
                <span>{position.familyName}</span>
                <small>Shared-deal link not recorded</small>
              </TableCell>
              <TableCell>
                {onLink && response.canWrite ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onLink(position.holdingId)}
                  >
                    <Link2 data-icon="inline-start" />
                    Link position
                  </Button>
                ) : (
                  <span className={styles.note}>Unlinked</span>
                )}
              </TableCell>
              <TableCell className={styles.numeric}>
                {historyAmount(position.nav, response.currency)}
                <small>
                  {position.valuationDate
                    ? dateLabel(position.valuationDate)
                    : 'No comparable mark'}
                </small>
              </TableCell>
              <TableCell>
                {position.valuationSourceId && onSource ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onSource(position.valuationSourceId!)}
                  >
                    Source
                    <ArrowUpRight data-icon="inline-end" />
                  </Button>
                ) : (
                  <span className={styles.note}>Position only</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!investments.length && !unlinked.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No positions for this selection</EmptyTitle>
            <EmptyDescription>
              Change the filters or as-of date to inspect recorded
              participation.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <p className={styles.footnote}>
        {investments.length} reviewed{' '}
        {investments.length === 1 ? 'deal' : 'deals'} · {unlinked.length}{' '}
        unlinked positions · As of {dateLabel(response.asOf)}.{' '}
        {response.denominatorLabel}
      </p>
    </>
  );
}

export function ParticipationPositionsTable({
  holdings,
  response,
  onHolding,
}: {
  holdings: Holding[];
  response: ParticipationResponse;
  onHolding: (id: string) => void;
}) {
  const { data } = useWorkspace();
  const summaries = investmentSummaries(data.history);
  const byHolding = new Map(
    response.investments.flatMap((deal) =>
      deal.positions.map((position) => [position.holdingId, deal] as const),
    ),
  );
  const positions = new Map(
    [
      ...response.investments.flatMap((deal) => deal.positions),
      ...response.unlinked,
    ].map((position) => [position.holdingId, position]),
  );
  return (
    <Table className={styles.table}>
      <TableHeader>
        <TableRow>
          <TableHead>Position / legal owner</TableHead>
          <TableHead>Shared deal</TableHead>
          <TableHead>Reported history</TableHead>
          <TableHead className={styles.numeric}>Reported NAV</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {holdings.map((holding) => {
          const deal = byHolding.get(holding.id),
            position = positions.get(holding.id),
            summary = summaries.get(holding.id),
            points = historySparkline(summary?.observations ?? []);
          return (
            <TableRow key={holding.id}>
              <TableCell>
                <button
                  className={styles.dealName}
                  onClick={() => onHolding(holding.id)}
                >
                  {holding.name}
                  <ArrowUpRight size={14} />
                </button>
                <small>
                  {position?.familyName ??
                    data.families.find(
                      (family) => family.id === holding.familyId,
                    )?.name}{' '}
                  ·{' '}
                  {position?.entityName ??
                    data.entities.find(
                      (entity) => entity.id === holding.entityId,
                    )?.name}
                </small>
              </TableCell>
              <TableCell>
                {deal ? (
                  <FamilyParticipationLabel investment={deal} />
                ) : (
                  <span className={styles.note}>Not linked</span>
                )}
                {deal ? <small>{deal.identity.name}</small> : null}
              </TableCell>
              <TableCell>
                {points.length ? (
                  <svg
                    className={styles.sparkline}
                    width="100"
                    height="30"
                    viewBox="0 0 100 30"
                    aria-label={`${points.length} reported NAV observations in EUR`}
                  >
                    <polyline
                      points={points
                        .map((point) => `${point.x},${point.y}`)
                        .join(' ')}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    {points.length === 1 ? (
                      <circle
                        cx={points[0].x}
                        cy={points[0].y}
                        r="3"
                        fill="currentColor"
                      />
                    ) : null}
                  </svg>
                ) : (
                  <span className={styles.note}>Awaiting reports</span>
                )}
              </TableCell>
              <TableCell className={styles.numeric}>
                {historyAmount(position?.nav, response.currency)}
                <small>
                  {position?.valuationDate
                    ? dateLabel(position.valuationDate)
                    : 'No comparable mark'}
                </small>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
