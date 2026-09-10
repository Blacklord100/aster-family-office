import type { PortfolioRecords } from './workspace';
import type { PortfolioHistoryResponse } from './portfolio-history-contract';
import {
  historyCents,
  historyMoney,
  PortfolioHistoryError,
} from './portfolio-history';
import {
  emptyParticipation,
  participationCommandSchema,
  PARTICIPATION_LIMITS,
  type ParticipationCommand,
  type ParticipationRecord,
  type ParticipationState,
  type ParticipationPosition,
  type ParticipationResponse,
  type ParticipationCoverage,
  type ParticipationFamily,
  type InvestmentParticipation,
} from './participation-contract';

function fail(code: string, message: string, status = 400): never {
  throw new PortfolioHistoryError(code, message, status);
}
export function effectiveParticipationRecords(
  state: ParticipationState | undefined,
  knownAt?: string,
): ParticipationRecord[] {
  const cutoff = knownAt ? Date.parse(knownAt) : null;
  const records = (state?.records ?? []).filter(
    (r) => cutoff === null || Date.parse(r.recordedAt) <= cutoff,
  );
  const replaced = new Set(
    records.flatMap((r) => (r.correctionOf ? [r.correctionOf] : [])),
  );
  return records
    .filter((r) => !replaced.has(r.id))
    .sort(
      (a, b) =>
        a.effectiveDate.localeCompare(b.effectiveDate) ||
        Number(a.kind === 'ownership') - Number(b.kind === 'ownership') ||
        a.recordedAt.localeCompare(b.recordedAt) ||
        a.id.localeCompare(b.id),
    );
}
export function participationLinkAt(
  records: readonly ParticipationRecord[],
  holdingId: string,
  date: string,
): ParticipationRecord | null {
  let link: ParticipationRecord | null = null;
  for (const record of records) {
    if (record.holdingId !== holdingId || record.effectiveDate > date) continue;
    if (record.kind === 'link') link = record;
    else if (record.kind === 'unlink') link = null;
  }
  return link;
}
/** Human-reviewed identity mapping; names, equal valuations and manager overlap
 * are never identity evidence. Each legal owner's position requires its source. */
export function appendParticipation(
  portfolio: PortfolioRecords,
  current: ParticipationState | undefined,
  value: ParticipationCommand,
  meta: {
    id: string;
    investmentId: string;
    actorId: string;
    at: string;
    sourceSha256: string;
  },
): { state: ParticipationState; record: ParticipationRecord } {
  const command = participationCommandSchema.parse(value);
  const holding = portfolio.holdings.find((h) => h.id === command.holdingId);
  if (!holding)
    fail(
      'PARTICIPATION_HOLDING_NOT_FOUND',
      'Choose a registered position from this office.',
      404,
    );
  const source = portfolio.evidence.find(
    (s) =>
      s.id === command.sourceId &&
      s.holdingId === holding.id &&
      s.familyId === holding.familyId &&
      s.status === 'Accepted' &&
      !s.synthetic &&
      s.documentId,
  );
  if (!source?.documentId || !/^[a-f0-9]{64}$/.test(meta.sourceSha256))
    fail(
      'PARTICIPATION_SOURCE_REQUIRED',
      'Choose an accepted retained source for this position.',
    );
  if (
    !meta.id ||
    !meta.investmentId ||
    !meta.actorId ||
    !Number.isFinite(Date.parse(meta.at))
  )
    fail(
      'PARTICIPATION_ACTOR_INVALID',
      'A recorded reviewer and time are required.',
    );
  const state = structuredClone(current ?? emptyParticipation());
  if (state.records.length >= PARTICIPATION_LIMITS.maxRecords)
    fail(
      'PARTICIPATION_CAPACITY',
      'The bounded participation history is full.',
      413,
    );
  if (state.records.some((r) => r.id === meta.id))
    fail(
      'PARTICIPATION_ID_CONFLICT',
      'This participation instruction is already recorded.',
      409,
    );
  const active = effectiveParticipationRecords(state);
  const previous = command.correctionOf
    ? active.find(
        (r) =>
          r.id === command.correctionOf &&
          r.holdingId === holding.id &&
          r.kind === command.kind,
      )
    : undefined;
  if (command.correctionOf && !previous)
    fail(
      'PARTICIPATION_CORRECTION_INVALID',
      'Correct an active record of the same position and instruction kind.',
      409,
    );
  if (previous && Date.parse(meta.at) < Date.parse(previous.recordedAt))
    fail(
      'PARTICIPATION_CORRECTION_INVALID',
      'A correction cannot precede the record it replaces.',
    );
  if (
    active.some(
      (r) =>
        r.holdingId === holding.id &&
        r.effectiveDate === command.effectiveDate &&
        r.id !== previous?.id &&
        (command.kind === 'ownership'
          ? r.kind === 'ownership'
          : r.kind !== 'ownership'),
    )
  )
    fail(
      'PARTICIPATION_DATE_CONFLICT',
      'Correct the mapping or ownership declaration already recorded on this date.',
      409,
    );
  const remaining = active.filter((r) => r.id !== previous?.id);
  const atDate = participationLinkAt(
    remaining,
    holding.id,
    command.effectiveDate,
  );
  let investmentId: string;
  if (command.kind === 'link') {
    if (command.newInvestment) {
      if (state.investments.length >= PARTICIPATION_LIMITS.maxInvestments)
        fail(
          'PARTICIPATION_CAPACITY',
          'The bounded investment identity catalog is full.',
          413,
        );
      if (state.investments.some((i) => i.id === meta.investmentId))
        fail(
          'PARTICIPATION_ID_CONFLICT',
          'This investment identifier is already registered.',
          409,
        );
      investmentId = meta.investmentId;
      state.investments.push({
        id: investmentId,
        identity: command.newInvestment,
      });
    } else {
      const investment = state.investments.find(
        (i) => i.id === command.investmentId,
      );
      if (!investment)
        fail(
          'PARTICIPATION_INVESTMENT_NOT_FOUND',
          'Choose an explicitly registered investment identity.',
          404,
        );
      investmentId = investment.id;
    }
  } else {
    if (!atDate)
      fail(
        'PARTICIPATION_LINK_REQUIRED',
        'A reviewed active investment link is required on this effective date.',
      );
    investmentId = atDate.investmentId;
  }
  const record: ParticipationRecord = {
    id: meta.id,
    holdingId: holding.id,
    familyId: holding.familyId,
    entityId: holding.entityId,
    kind: command.kind,
    investmentId,
    linkId: command.kind === 'link' ? meta.id : atDate!.id,
    effectiveDate: command.effectiveDate,
    recordedAt: new Date(meta.at).toISOString(),
    actorId: meta.actorId,
    sourceId: source.id,
    documentId: source.documentId,
    sourceSha256: meta.sourceSha256,
    page: command.page,
    quote: command.quote,
    reason: command.reason,
    correctionOf: previous?.id ?? null,
    percent: command.kind === 'ownership' ? command.percent : null,
    ownershipBasis:
      command.kind === 'ownership' ? command.ownershipBasis : null,
  };
  state.records.push(record);
  // Mapping periods must alternate. A holding cannot belong to two vehicles at
  // once; unlinking is a mapping correction, never a disposal or cash movement.
  let linked = false;
  for (const r of effectiveParticipationRecords(state).filter(
    (r) => r.holdingId === holding.id && r.kind !== 'ownership',
  )) {
    if ((r.kind === 'link' && linked) || (r.kind === 'unlink' && !linked))
      fail(
        'PARTICIPATION_PERIOD_CONFLICT',
        'Mapping periods overlap or an unlink has no preceding link. Use an explicit correction.',
        409,
      );
    linked = r.kind === 'link';
  }
  state.revision++;
  return { state, record };
}
function totals(positions: readonly ParticipationPosition[]): {
  nav: string | null;
  knownNAV: string | null;
  coverage: ParticipationCoverage;
} {
  const known = positions.filter((p) => p.nav !== null);
  const amount = known.length
    ? historyMoney(known.reduce((sum, p) => sum + historyCents(p.nav!), 0n))
    : null;
  const coverage = {
    knownCount: known.length,
    totalCount: positions.length,
    complete: positions.length > 0 && known.length === positions.length,
  };
  return { nav: coverage.complete ? amount : null, knownNAV: amount, coverage };
}
function share(
  numerator: string | null,
  denominator: string | null,
): number | null {
  if (
    numerator === null ||
    denominator === null ||
    historyCents(denominator) <= 0n
  )
    return null;
  return (
    Number((historyCents(numerator) * 100000000n) / historyCents(denominator)) /
    1000000
  );
}
/** Pure projection receives only authorized positions, evidence and mappings.
 * Its percentages always use visible/selected known NAV, not ownership. */
export function projectParticipation(
  portfolio: PortfolioRecords,
  state: ParticipationState | undefined,
  history: PortfolioHistoryResponse,
  context: { canWrite: boolean },
): ParticipationResponse {
  const current = state ?? emptyParticipation();
  if (
    current.records.length > PARTICIPATION_LIMITS.maxRecords ||
    current.investments.length > PARTICIPATION_LIMITS.maxInvestments
  )
    fail(
      'PARTICIPATION_CAPACITY',
      'This participation library exceeds its bounded capacity. No partial results were returned.',
      413,
    );
  const knownAt =
    history.query.knowledge === 'as_known' ? history.query.knownAt : undefined;
  const records = effectiveParticipationRecords(current, knownAt);
  const positions: ParticipationPosition[] = history.positions
    .filter((p) => p.ownership !== 'closed' && p.ownership !== 'not_yet_opened')
    .map((p) => {
      const family = portfolio.families.find((f) => f.id === p.familyId);
      const link = participationLinkAt(records, p.holdingId, history.asOf);
      const ownership = link
        ? records
            .filter(
              (r) =>
                r.kind === 'ownership' &&
                r.holdingId === p.holdingId &&
                r.linkId === link.id &&
                r.effectiveDate <= history.asOf,
            )
            .at(-1)
        : null;
      return {
        holdingId: p.holdingId,
        name: p.investmentName,
        familyId: p.familyId,
        familyName: family?.name ?? p.familyId,
        entityId: p.entityId,
        entityName:
          portfolio.entities.find((e) => e.id === p.entityId)?.name ??
          p.entityId,
        accountId: p.metadata.accountId,
        accountName:
          portfolio.accounts.find((a) => a.id === p.metadata.accountId)?.name ??
          p.metadata.accountId,
        nav: p.latest?.amount ?? null,
        valuationDate: p.latest?.effectiveDate ?? null,
        valuationSourceId: p.latest?.sourceId ?? null,
        ownership: p.ownership as 'owned' | 'unknown',
        linkId: link?.id ?? null,
        investmentId: link?.investmentId ?? null,
        sourceId: link?.sourceId ?? null,
        effectiveDate: link?.effectiveDate ?? null,
        actualOwnershipPercent: ownership?.percent ?? null,
        ownershipSourceId: ownership?.sourceId ?? null,
        ownershipEffectiveDate: ownership?.effectiveDate ?? null,
        ownershipBasis: ownership?.ownershipBasis ?? null,
      };
    });
  const families: ParticipationFamily[] = [
    ...new Set(positions.map((p) => p.familyId)),
  ].map((familyId) => {
    const family = portfolio.families.find((f) => f.id === familyId);
    const total = totals(positions.filter((p) => p.familyId === familyId));
    return {
      familyId,
      name: family?.name ?? familyId,
      color: family?.color ?? '#818cf8',
      portfolioNAV: total.nav,
      portfolioKnownNAV: total.knownNAV,
      coverage: total.coverage,
    };
  });
  const selected = history.query.holdingIds
    ? positions.filter((p) => history.query.holdingIds!.includes(p.holdingId))
    : positions;
  const investments: InvestmentParticipation[] = current.investments
    .flatMap((investment) => {
      const members = selected.filter((p) => p.investmentId === investment.id);
      if (!members.length) return [];
      const total = totals(members);
      const positiveBasis = members.every(
        (p) => p.nav === null || historyCents(p.nav) >= 0n,
      );
      const participatingFamilies = families.flatMap((family) => {
        const familyPositions = members.filter(
          (p) => p.familyId === family.familyId,
        );
        if (!familyPositions.length) return [];
        const values = totals(familyPositions);
        return [
          {
            ...family,
            nav: values.nav,
            knownNAV: values.knownNAV,
            shareOfKnownNAV: positiveBasis
              ? share(values.knownNAV, total.knownNAV)
              : null,
            portfolioWeight: share(values.nav, family.portfolioNAV),
            investmentCoverage: values.coverage,
            positions: familyPositions,
          },
        ];
      });
      return [
        {
          ...investment,
          ...total,
          families: participatingFamilies,
          familyCount: participatingFamilies.length,
          positionCount: members.length,
          positions: members,
        },
      ];
    })
    .sort((a, b) => a.identity.name.localeCompare(b.identity.name));
  const selectedIds = new Set(history.positions.map((p) => p.holdingId));
  const visibleRecords = current.records.filter(
    (r) =>
      selectedIds.has(r.holdingId) &&
      (!knownAt || Date.parse(r.recordedAt) <= Date.parse(knownAt)),
  );
  const catalogIds = new Set(visibleRecords.map((r) => r.investmentId));
  const gaps = [...history.gaps];
  const unlinked = selected.filter((p) => !p.investmentId);
  if (unlinked.length)
    gaps.push(
      `${unlinked.length} visible position${unlinked.length === 1 ? ' has' : 's have'} no reviewed investment identity at this date.`,
    );
  if (positions.some((p) => p.ownership === 'unknown'))
    gaps.push(
      'Some position ownership periods are unresolved; these positions remain included and labeled.',
    );
  if (families.some((f) => !f.coverage.complete))
    gaps.push(
      'Some family NAV is unavailable in this currency or at this date. Portfolio weights require a complete visible denominator.',
    );
  if (investments.some((i) => !i.coverage.complete))
    gaps.push(
      'Participation shares use known visible NAV; missing marks are not zero participation.',
    );
  if (positions.some((p) => p.nav !== null && historyCents(p.nav) < 0n))
    gaps.push(
      'Negative NAV is present; participation percentages are unavailable for affected investments because a positive allocation basis is required.',
    );
  if (history.query.entityIds?.length || history.query.holdingIds?.length)
    gaps.push(
      'Selection filters restrict the visible participation set. Family portfolio weights use the selected entities, before any holding filter.',
    );
  gaps.push(
    'Recorded NAV shares are not actual ownership. Commitments, paid-in capital and distributions are unavailable in this view.',
  );
  return {
    query: history.query,
    revision: history.revision,
    participationRevision: current.revision,
    asOf: history.asOf,
    currency: history.query.currency,
    canWrite: context.canWrite,
    denominatorLabel: 'Visible selected recorded NAV',
    investments,
    catalog: current.investments.filter((i) => catalogIds.has(i.id)),
    families,
    unlinked,
    records: visibleRecords,
    gaps: [...new Set(gaps)],
    limits: PARTICIPATION_LIMITS,
  };
}
