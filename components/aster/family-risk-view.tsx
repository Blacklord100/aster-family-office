'use client';

import { useMemo, useState } from 'react';
import { ArrowUpRight, FileText } from 'lucide-react';
import type { Family, Holding } from '@/data/types';
import type {
  ExposureLot,
  StressResult,
  TotalExposure,
} from '@/lib/risk-contract';
import {
  familyIssuerExposure,
  familyStressExposure,
  managerIssuerMatrix,
} from '@/lib/family-exposure';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { Panel, Picker, dateLabel, money } from './primitives';
import { cn } from '@/lib/utils';
import styles from './risk.module.css';

type SharedProps = {
  holdings: Holding[];
  families: Family[];
  evidenceIds: Set<string>;
  onSource: (id: string) => void;
  navScope?: 'family' | 'visible';
};

const percent = (value: number | null) =>
  value === null ? 'Unavailable' : `${Math.abs(value).toFixed(1)}%`;

function ExposurePaths({
  title,
  lots,
  evidenceIds,
  onSource,
  onClose,
}: {
  title: string;
  lots: ExposureLot[];
  evidenceIds: Set<string>;
  onSource: (id: string) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const safePage = Math.min(page, Math.max(0, Math.ceil(lots.length / 12) - 1));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Follow each recorded position to its final allocation. Fund wrappers
            are replaced by their underlying slices, so each euro appears once.
          </DialogDescription>
        </DialogHeader>
        <div className={styles.familyPathList}>
          {lots.slice(safePage * 12, safePage * 12 + 12).map((lot) => (
            <article className={styles.familyPath} key={lot.id}>
              <div>
                <strong>{lot.holdingName}</strong>
                <span>{money(lot.valueEUR)}</span>
              </div>
              <p>
                {lot.pathNames.join(' → ') ||
                  'Underlying allocation not disclosed'}
              </p>
              {lot.unresolvedReason ? <p>{lot.unresolvedReason}</p> : null}
              {'lossEUR' in lot && typeof lot.lossEUR === 'number' ? (
                <p>
                  Scenario {lot.lossEUR < 0 ? 'gain' : 'loss'}:{' '}
                  {money(Math.abs(lot.lossEUR))}
                </p>
              ) : null}
              <div className={styles.actions}>
                {[
                  ...new Map(
                    lot.sources.map((source) => [
                      JSON.stringify([
                        source.sourceId,
                        source.asOfDate,
                        source.label,
                      ]),
                      source,
                    ]),
                  ).values(),
                ].map((source, index) =>
                  source.sourceId && evidenceIds.has(source.sourceId) ? (
                    <Button
                      key={`${source.sourceId}:${index}`}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onClose();
                        onSource(source.sourceId!);
                      }}
                    >
                      <FileText data-icon="inline-start" />
                      {source.label}
                      {source.asOfDate
                        ? ` · ${dateLabel(source.asOfDate)}`
                        : ''}
                    </Button>
                  ) : (
                    <span key={index} className={styles.note}>
                      {source.label} ·{' '}
                      {source.asOfDate
                        ? dateLabel(source.asOfDate)
                        : 'Date missing'}{' '}
                      · Source unavailable in this view
                    </span>
                  ),
                )}
              </div>
            </article>
          ))}
        </div>
        {lots.length > 12 ? (
          <div className={styles.familyPagination}>
            <span>
              {safePage * 12 + 1}–{Math.min(lots.length, (safePage + 1) * 12)}{' '}
              of {lots.length} paths
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!safePage}
              onClick={() => setPage(safePage - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={(safePage + 1) * 12 >= lots.length}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function FamilyStressView({
  holdings,
  families,
  stress,
  navScope = 'family',
  evidenceIds,
  onSource,
}: SharedProps & { stress: StressResult }) {
  const [basis, setBasis] = useState('amount');
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(
    () => familyStressExposure(holdings, families, stress),
    [holdings, families, stress],
  );
  const ranked = useMemo(
    () =>
      basis === 'percent'
        ? [...rows].sort(
            (a, b) =>
              (b.lossPercent === null ? -1 : Math.abs(b.lossPercent)) -
              (a.lossPercent === null ? -1 : Math.abs(a.lossPercent)),
          )
        : rows,
    [rows, basis],
  );
  const max = Math.max(
    1,
    ...rows.map((row) =>
      Math.abs(basis === 'amount' ? row.lossEUR : (row.lossPercent ?? 0)),
    ),
  );
  const detail = rows.find((row) => row.familyId === selected);
  return (
    <Panel
      title="Who bears the impact?"
      subtitle={`${stress.scenario.name} · the same assumptions across every family`}
      className={styles.panel}
      action={
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[basis]}
          onValueChange={(values) => {
            if (values[0]) setBasis(values[0]);
          }}
          aria-label="Compare family scenario impact"
        >
          <ToggleGroupItem value="amount">EUR loss</ToggleGroupItem>
          <ToggleGroupItem value="percent">% of {navScope} NAV</ToggleGroupItem>
        </ToggleGroup>
      }
    >
      <div className={styles.familyBars}>
        {ranked.map((row) => (
          <div className={styles.familyBarRow} key={row.familyId}>
            <div className={styles.familyBarLabel}>
              <Button
                variant="link"
                size="sm"
                disabled={!row.lots.length}
                onClick={() => setSelected(row.familyId)}
              >
                {row.name}
                <ArrowUpRight data-icon="inline-end" />
              </Button>
              <span>
                {money(row.knownValueEUR)}{' '}
                {row.missingValuationCount ? 'known NAV' : 'recorded NAV'} ·{' '}
                {row.holdingCount} holdings
              </span>
            </div>
            <div className={styles.familyBarNumbers}>
              <strong className={row.lossEUR >= 0 ? styles.loss : styles.gain}>
                {row.lossEUR > 0 ? '−' : row.lossEUR < 0 ? '+' : ''}
                {money(Math.abs(row.lossEUR))}
              </strong>
              <span>
                {percent(row.lossPercent)}
                {row.lossPercent !== null
                  ? ` ${row.lossEUR < 0 ? 'gain' : 'loss'} of ${navScope} NAV`
                  : ' · incomplete NAV'}
              </span>
            </div>
            <div className={styles.familyTrack} aria-hidden="true">
              <span
                className={row.lossEUR >= 0 ? styles.lossBar : styles.gainBar}
                style={{
                  width: `${(Math.abs(basis === 'amount' ? row.lossEUR : (row.lossPercent ?? 0)) / max) * 100}%`,
                }}
              />
            </div>
            <div className={styles.familyCoverage}>
              {row.missingValuationCount ? (
                <Badge variant="outline">
                  {row.missingValuationCount} missing NAV · partial loss
                </Badge>
              ) : null}
              {row.unresolvedEUR > 0 ? (
                <span>{money(row.unresolvedEUR)} undisclosed look-through</span>
              ) : null}
              {row.unknownCurrencyEUR > 0 &&
              Object.values(stress.scenario.currencyShocks ?? {}).some(
                Boolean,
              ) ? (
                <span>
                  {money(row.unknownCurrencyEUR)} unknown currency · FX shock
                  not applied
                </span>
              ) : null}
              {row.noValuationShockEUR > 0 ? (
                <span>
                  {money(row.noValuationShockEUR)} has no applicable valuation
                  shock
                </span>
              ) : null}
              {row.inferredAssetClassCount > 0 ? (
                <span>
                  {row.inferredAssetClassCount} inferred asset classifications
                </span>
              ) : null}
              {row.oldestValuationDate ? (
                <span>
                  Marks {dateLabel(row.oldestValuationDate)}
                  {row.latestValuationDate !== row.oldestValuationDate
                    ? `–${dateLabel(row.latestValuationDate!)}`
                    : ''}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <p className={styles.note}>
        Percentages use each family’s recorded NAV within this view.{' '}
        {navScope === 'visible'
          ? 'Your entity access is restricted, so this denominator is only the visible portion of each family.'
          : 'The combined office is not the denominator.'}
        Missing valuations suppress that percentage; a known-value subtotal
        cannot establish total family wealth. Shocks are hypothetical. Capital
        calls remain separate cash demand.
      </p>
      {detail ? (
        <ExposurePaths
          title={`${detail.name} · scenario paths`}
          lots={detail.lots}
          evidenceIds={evidenceIds}
          onSource={onSource}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Panel>
  );
}

export function FamilyIssuerView({
  holdings,
  families,
  exposure,
  navScope = 'family',
  evidenceIds,
  onSource,
}: SharedProps & { exposure: TotalExposure }) {
  const [issuer, setIssuer] = useState('');
  const [selectedFamily, setSelectedFamily] = useState<string | null>(null);
  const issuers = exposure.issuerExposure.filter(
    (row) => row.id !== '__unknown__',
  );
  const selectedIssuer = issuers.find((row) => row.id === issuer) ?? issuers[0];
  const rows = familyIssuerExposure(
    holdings,
    families,
    exposure,
    selectedIssuer?.id ?? '',
  );
  const max = Math.max(1, ...rows.map((row) => row.exposureEUR));
  const detail = rows.find((row) => row.familyId === selectedFamily);
  return (
    <Panel
      title="Which families are exposed?"
      subtitle="Direct holdings and fund look-through, shown separately"
      className={styles.panel}
      action={
        selectedIssuer ? (
          <Picker
            label="Company for family exposure"
            value={selectedIssuer.id}
            onChange={(id) => {
              setIssuer(id);
              setSelectedFamily(null);
            }}
            options={issuers.map((row) => ({ value: row.id, label: row.name }))}
          />
        ) : undefined
      }
    >
      {!selectedIssuer ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Map a company to compare family exposure</EmptyTitle>
            <EmptyDescription>
              Recorded NAV is available, but no underlying issuer has a
              quantified allocation. Add sourced issuer identities and weights
              in Manage exposures.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className={styles.familyLegend}>
            <span>
              <i className={styles.familyDirect} />
              Direct
            </span>
            <span>
              <i className={styles.familyIndirect} />
              Through funds / vehicles
            </span>
            <span>EUR · bar lengths share one scale</span>
          </div>
          <div className={styles.familyBars}>
            {rows.map((row) => (
              <div className={styles.familyBarRow} key={row.familyId}>
                <div className={styles.familyBarLabel}>
                  <Button
                    variant="link"
                    size="sm"
                    disabled={!row.matchedLots.length}
                    onClick={() => setSelectedFamily(row.familyId)}
                  >
                    {row.name}
                    <ArrowUpRight data-icon="inline-end" />
                  </Button>
                  <span>
                    {money(row.directEUR)} direct · {money(row.indirectEUR)}{' '}
                    indirect
                  </span>
                </div>
                <div className={styles.familyBarNumbers}>
                  <strong>{money(row.exposureEUR)}</strong>
                  <span>
                    {row.portfolioPercent === null
                      ? `${navScope === 'visible' ? 'Visible' : 'Family'} NAV percentage unavailable`
                      : `${row.portfolioPercent.toFixed(1)}% of ${navScope} NAV`}
                  </span>
                </div>
                <div className={styles.familyTrack} aria-hidden="true">
                  <span
                    className={styles.familyDirect}
                    style={{ width: `${(row.directEUR / max) * 100}%` }}
                  />
                  <span
                    className={styles.familyIndirect}
                    style={{ width: `${(row.indirectEUR / max) * 100}%` }}
                  />
                </div>
                <div className={styles.familyCoverage}>
                  {!row.matchedLots.length ? (
                    <span>No quantified exposure to this company</span>
                  ) : null}
                  {row.undisclosedIssuerEUR > 0 ? (
                    <span>
                      {money(row.undisclosedIssuerEUR)} issuer undisclosed · may
                      include further exposure
                    </span>
                  ) : null}
                  {row.missingValuationCount > 0 ? (
                    <Badge variant="outline">
                      {row.missingValuationCount} missing NAV
                    </Badge>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
          <p className={styles.note}>
            {navScope === 'visible'
              ? 'Your entity access is restricted; percentages use only the visible family NAV. '
              : ''}
            These amounts measure economic exposure, not ownership of the
            company. Unknown weights stay outside the company total; they are
            never equally allocated. Direct means the recorded holding maps
            straight to an asset; indirect passes through one or more funds or
            vehicles.
          </p>
        </>
      )}
      {detail && detail.matchedLots.length ? (
        <ExposurePaths
          title={`${detail.name} → ${selectedIssuer?.name} · exposure paths`}
          lots={detail.matchedLots}
          evidenceIds={evidenceIds}
          onSource={onSource}
          onClose={() => setSelectedFamily(null)}
        />
      ) : null}
    </Panel>
  );
}

export function ManagerIssuerView({
  holdings,
  exposure,
  evidenceIds,
  onSource,
}: Omit<SharedProps, 'families'> & { exposure: TotalExposure }) {
  const matrix = useMemo(
    () => managerIssuerMatrix(holdings, exposure),
    [holdings, exposure],
  );
  const [selection, setSelection] = useState<{
    managerId: string;
    issuerId: string;
  } | null>(null);
  const [overlapOnly, setOverlapOnly] = useState(true);
  const [page, setPage] = useState(0);
  const issuers = matrix.issuers.filter(
    (issuer) => !overlapOnly || issuer.managerCount > 1,
  );
  const safePage = Math.min(
    page,
    Math.max(0, Math.ceil(issuers.length / 6) - 1),
  );
  const visibleIssuers = issuers.slice(safePage * 6, safePage * 6 + 6);
  const visibleIds = new Set(visibleIssuers.map((issuer) => issuer.id));
  const managers = matrix.managers.filter((manager) =>
    manager.cells.some((cell) => visibleIds.has(cell.issuerId)),
  );
  const max = Math.max(
    1,
    ...managers.flatMap((manager) =>
      manager.cells
        .filter((cell) => visibleIds.has(cell.issuerId))
        .map((cell) => cell.valueEUR),
    ),
  );
  const selectedManager = matrix.managers.find(
    (manager) => manager.id === selection?.managerId,
  );
  const detail = selectedManager?.cells.find(
    (cell) => cell.issuerId === selection?.issuerId,
  );
  return (
    <Panel
      title="Do managers invest in the same companies?"
      subtitle="Each cell combines distinct recorded paths to an explicitly identified company"
      className={styles.panel}
      action={
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[overlapOnly ? 'overlap' : 'all']}
          onValueChange={(values) => {
            if (values[0]) {
              setOverlapOnly(values[0] === 'overlap');
              setPage(0);
            }
          }}
          aria-label="Manager company matrix scope"
        >
          <ToggleGroupItem value="overlap">Shared companies</ToggleGroupItem>
          <ToggleGroupItem value="all">All mapped</ToggleGroupItem>
        </ToggleGroup>
      }
    >
      {visibleIssuers.length ? (
        <section
          className={styles.familyMatrixScroll}
          aria-label="Manager by company exposure matrix"
        >
          <Table className={cn(styles.table, styles.familyMatrix)}>
            <TableHeader>
              <TableRow>
                <TableHead>Attributed manager</TableHead>
                {visibleIssuers.map((issuer) => (
                  <TableHead key={issuer.id}>
                    {issuer.name}
                    <small>
                      {issuer.managerCount} manager
                      {issuer.managerCount === 1 ? '' : 's'}
                    </small>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {managers.map((manager) => (
                <TableRow key={manager.id}>
                  <TableCell>{manager.name}</TableCell>
                  {visibleIssuers.map((issuer) => {
                    const cell = manager.cells.find(
                      (item) => item.issuerId === issuer.id,
                    );
                    return (
                      <TableCell key={issuer.id}>
                        {cell ? (
                          <button
                            type="button"
                            className={styles.familyMatrixCell}
                            style={{
                              background: `color-mix(in srgb, var(--primary) ${8 + (25 * cell.valueEUR) / max}%, var(--background))`,
                            }}
                            aria-label={`${manager.name}, ${issuer.name}, ${money(cell.valueEUR)}, view ${cell.lots.length} paths`}
                            onClick={() =>
                              setSelection({
                                managerId: manager.id,
                                issuerId: issuer.id,
                              })
                            }
                          >
                            {money(cell.valueEUR)}
                            <small>
                              {cell.lots.length} path
                              {cell.lots.length === 1 ? '' : 's'}
                            </small>
                          </button>
                        ) : (
                          <span
                            className={styles.muted}
                            aria-label="No quantified path"
                          >
                            —
                          </span>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {overlapOnly
                ? 'No quantified overlap across managers'
                : 'No quantified manager and company paths'}
            </EmptyTitle>
            <EmptyDescription>
              {overlapOnly
                ? 'Switch to All mapped to inspect individual exposures. Undisclosed allocations may contain additional overlap.'
                : 'Add sourced company identities, manager attribution and allocation weights to populate this matrix.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {issuers.length > 6 ? (
        <div className={styles.familyPagination}>
          <span>
            Companies {safePage * 6 + 1}–
            {Math.min(issuers.length, (safePage + 1) * 6)} of {issuers.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!safePage}
            onClick={() => setPage(safePage - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={(safePage + 1) * 6 >= issuers.length}
            onClick={() => setPage(safePage + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
      <p className={styles.note}>
        {money(matrix.omittedEUR)} has no quantified issuer / manager
        combination. A dash means no quantified path, not confirmed absence.
        Attribution follows the nearest disclosed manager, with the holding’s
        reported manager as fallback; that field may identify a custodian. This
        view describes recorded holdings, not a manager’s investment pipeline.
      </p>
      {detail ? (
        <ExposurePaths
          title={`${selectedManager!.name} → ${matrix.issuers.find((issuer) => issuer.id === selection?.issuerId)?.name}`}
          lots={detail.lots}
          evidenceIds={evidenceIds}
          onSource={onSource}
          onClose={() => setSelection(null)}
        />
      ) : null}
    </Panel>
  );
}
