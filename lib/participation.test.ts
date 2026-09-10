import { describe, expect, it } from 'vitest';
import type { PortfolioRecords } from './workspace';
import { scopeWorkspace } from './data-scope';
import { initialWorkspace } from './workspace';
import { appendParticipation, projectParticipation } from './participation';
import {
  emptyParticipation,
  participationCommandSchema,
  type ParticipationCommand,
  type ParticipationState,
} from './participation-contract';
import { projectPortfolioHistory } from './portfolio-history';
import { emptyFinanceState } from './ledger-contract';
import { participationCSV } from './participation-display';

const identity = {
  name: 'Orion Growth',
  manager: 'Orion',
  vehicle: 'Orion LP',
  shareClass: 'Class A',
  round: 'Fund II',
  identifier: 'SYNTHETIC-II-A',
};
function fixture() {
  const portfolio: PortfolioRecords = {
    holdings: ['one', 'two', 'cash'].map((id, index) => ({
      id,
      name: id === 'cash' ? 'Reserve' : 'Same printed name',
      familyId: index === 1 ? 'f2' : 'f1',
      entityId: index === 1 ? 'e2' : 'e1',
      accountId: index === 1 ? 'a2' : 'a1',
      assetClass: id === 'cash' ? 'Cash' : 'Private equity',
      currency: 'EUR',
      valueEUR: index === 0 ? 600 : index === 1 ? 300 : 400,
      originalValue: 0,
      syntheticFXRateToEUR: 1,
      costBasisEUR: 0,
      unfundedCommitmentEUR: 0,
      liquidityBucket: '3+ years',
      valuationDate: '2026-06-30',
      sourceId: 's-' + id,
      geography: '',
      manager: 'Orion',
      description: '',
      color: '',
      valuationMethod: 'Reported fund NAV',
    })),
    history: [],
    events: [],
    tasks: [],
    evidence: ['one', 'two', 'cash'].map((id, index) => ({
      id: 's-' + id,
      holdingId: id,
      familyId: index === 1 ? 'f2' : 'f1',
      documentId: 'd-' + id,
      mailboxId: '',
      subject: 'Investor statement',
      sender: '',
      receivedAt: '2026-07-10T10:00:00Z',
      effectiveDate: '2026-06-30',
      filename: id + '.pdf',
      page: 1,
      excerpt: 'Investor units in Class A',
      status: 'Accepted',
      synthetic: false,
    })),
    families: ['f1', 'f2'].map((id) => ({
      id,
      name: id === 'f1' ? 'First family' : 'Second family',
      initials: '',
      principal: '',
      location: '',
      color: '#aaa',
    })),
    entities: ['1', '2'].map((id) => ({
      id: 'e' + id,
      familyId: 'f' + id,
      name: 'Entity ' + id,
      type: 'Trust',
      jurisdiction: '',
      ownershipPercent: 100,
    })),
    accounts: [],
  };
  const finance = emptyFinanceState();
  finance.valuations = portfolio.holdings.map((h) => ({
    id: 'v-' + h.id,
    sourceId: h.sourceId,
    holdingId: h.id,
    amount: h.valueEUR.toFixed(2),
    valueEUR: h.valueEUR,
    currency: 'EUR',
    effectiveDate: '2026-06-30',
    actorId: 'reviewer',
    recordedAt: '2026-07-11T10:00:00Z',
    valuationMethod: 'Reported fund NAV',
  }));
  return { portfolio, finance };
}
function command(
  holdingId = 'one',
): Extract<ParticipationCommand, { kind: 'link' }> {
  return {
    kind: 'link',
    holdingId,
    sourceId: 's-' + holdingId,
    effectiveDate: '2026-01-01',
    evidenceVerified: true,
    page: 1,
    quote: 'Investor units in Orion LP Class A',
    reason: 'Reviewed the retained investor statement.',
    newInvestment: identity,
  };
}
function append(
  state = emptyParticipation(),
  value: ParticipationCommand = command(),
  id = 'r1',
  at = '2026-07-12T10:00:00Z',
) {
  return appendParticipation(fixture().portfolio, state, value, {
    id,
    investmentId: 'i-' + id,
    actorId: 'reviewer',
    at,
    sourceSha256: 'a'.repeat(64),
  });
}
function linked() {
  const first = append();
  const second = {
    ...command('two'),
    newInvestment: undefined,
    investmentId: first.record.investmentId,
  } as ParticipationCommand;
  return append(first.state, second, 'r2').state;
}
function project(
  state?: ParticipationState,
  query = {},
  mutate?: (data: ReturnType<typeof fixture>) => void,
) {
  const data = fixture();
  mutate?.(data);
  return projectParticipation(
    data.portfolio,
    state,
    projectPortfolioHistory(
      data.portfolio,
      data.finance,
      { asOf: '2026-08-01', cohort: 'historical', ...query },
      { revision: 7 },
    ),
    { canWrite: true },
  );
}
describe('reviewed investment identity and participation', () => {
  it('excludes sourced closed and not-yet-opened positions even when they retain earlier NAV evidence', () => {
    const { portfolio, finance } = fixture();
    const history = projectPortfolioHistory(
      portfolio,
      finance,
      { asOf: '2026-08-01', cohort: 'historical' },
      { revision: 7 },
    );
    history.positions.find((p) => p.holdingId === 'one')!.ownership = 'closed';
    history.positions.find((p) => p.holdingId === 'two')!.ownership =
      'not_yet_opened';
    const result = projectParticipation(portfolio, linked(), history, {
      canWrite: false,
    });
    expect(result.investments).toEqual([]);
    expect(result.unlinked.map((p) => p.holdingId)).toEqual(['cash']);
    expect(result.families[0].portfolioNAV).toBe('400.00');
  });
  it('preserves signed NAV but suppresses misleading allocation shares on a nonpositive allocation basis', () => {
    const { portfolio, finance } = fixture();
    const history = projectPortfolioHistory(
      portfolio,
      finance,
      { asOf: '2026-08-01', cohort: 'historical' },
      { revision: 7 },
    );
    history.positions.find((p) => p.holdingId === 'one')!.latest!.amount =
      '-100.00';
    const result = projectParticipation(portfolio, linked(), history, {
      canWrite: false,
    });
    expect(result.investments[0].knownNAV).toBe('200.00');
    expect(result.investments[0].positions[0].nav).toBe('-100.00');
    expect(
      result.investments[0].families.every((f) => f.shareOfKnownNAV === null),
    ).toBe(true);
    expect(result.gaps.some((gap) => gap.includes('Negative NAV'))).toBe(true);
  });

  it('exports the full scoped rows with exact money, ownership basis and escaped formula text', () => {
    const result = project(linked());
    result.investments[0].identity.name = '=HYPERLINK("malicious")';
    const first = result.investments[0].positions[0];
    first.nav = '123456789012.34';
    first.actualOwnershipPercent = '6';
    first.ownershipBasis = 'Class A issued units';
    first.ownershipSourceId = 'ownership-source';
    const csv = participationCSV(result);
    expect(csv).toContain('123456789012.34');
    expect(csv).toContain('Class A issued units');
    expect(csv).toContain('ownership-source');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('Workspace revision');
    expect(csv).toContain('Unlinked position');
    expect(csv).toContain('Selected family portfolio NAV');
    expect(csv).toContain('s-two');
  });

  it('never groups identical holding names without reviewed links', () => {
    const result = project();
    expect(result.investments).toEqual([]);
    expect(result.unlinked).toHaveLength(3);
    expect(result.catalog).toEqual([]);
  });
  it('separates visible NAV participation, family concentration and sourced actual ownership', () => {
    const ownership: ParticipationCommand = {
      ...command(),
      kind: 'ownership',
      percent: '6',
      ownershipBasis: 'Class A issued units',
    };
    delete (ownership as { newInvestment?: unknown }).newInvestment;
    const result = project(append(linked(), ownership, 'o1').state);
    const deal = result.investments[0];
    expect(deal.knownNAV).toBe('900.00');
    expect(deal.families[0].shareOfKnownNAV).toBeCloseTo(66.666666);
    expect(deal.families[0].portfolioNAV).toBe('1000.00');
    expect(deal.families[0].portfolioWeight).toBe(60);
    expect(deal.positions[0].actualOwnershipPercent).toBe('6');
    expect(deal.positions[0].ownershipBasis).toBe('Class A issued units');
    expect(deal.positions[1].actualOwnershipPercent).toBeNull();
    expect(deal.positions[0].ownershipSourceId).toBe('s-one');
  });
  it('keeps separately reviewed vehicles with identical names separate', () => {
    const first = append();
    const second = append(
      first.state,
      {
        ...command('two'),
        newInvestment: { ...identity, shareClass: 'Class B' },
      },
      'r2',
    );
    expect(
      project(second.state).investments.map((i) => i.identity.shareClass),
    ).toEqual(['Class A', 'Class B']);
  });
  it('requires a retained accepted source belonging to the exact family position', () => {
    expect(() =>
      append(undefined, { ...command(), sourceId: 's-two' }),
    ).toThrow(/accepted retained/);
    const data = fixture();
    data.portfolio.evidence[0].synthetic = true;
    expect(() =>
      appendParticipation(data.portfolio, undefined, command(), {
        id: 'r',
        investmentId: 'i',
        actorId: 'u',
        at: '2026-01-01',
        sourceSha256: 'a'.repeat(64),
      }),
    ).toThrow(/accepted retained/);
  });
  it('rejects overlapping mapping periods and allows an explicit unlink before relinking', () => {
    const first = append();
    expect(() =>
      append(first.state, { ...command(), effectiveDate: '2026-03-01' }, 'r2'),
    ).toThrow(/overlap/);
    const { newInvestment: _, ...base } = command() as Extract<
      ParticipationCommand,
      { kind: 'link' }
    >;
    const unlinked = append(
      first.state,
      { ...base, kind: 'unlink', effectiveDate: '2026-03-01' },
      'u1',
    );
    const relinked = append(
      unlinked.state,
      { ...command(), effectiveDate: '2026-04-01' },
      'r2',
    );
    expect(project(relinked.state, { asOf: '2026-03-15' }).investments).toEqual(
      [],
    );
    expect(project(relinked.state).investments[0].id).toBe('i-r2');
  });
  it('preserves earlier identity under an as-known cutoff after an explicit correction', () => {
    const first = append();
    const corrected = append(
      first.state,
      {
        ...command(),
        correctionOf: 'r1',
        newInvestment: { ...identity, vehicle: 'Corrected LP' },
      },
      'r2',
      '2026-08-02T10:00:00Z',
    );
    expect(project(corrected.state).investments[0].identity.vehicle).toBe(
      'Corrected LP',
    );
    expect(
      project(corrected.state, {
        knowledge: 'as_known',
        knownAt: '2026-08-01T23:59:59Z',
      }).investments[0].identity.vehicle,
    ).toBe('Orion LP');
    expect(corrected.state.records).toHaveLength(2);
  });
  it('does not carry actual ownership across an identity correction', () => {
    const { newInvestment: _, ...base } = command() as Extract<
      ParticipationCommand,
      { kind: 'link' }
    >;
    const owned = append(
      linked(),
      {
        ...base,
        kind: 'ownership',
        percent: '6',
        ownershipBasis: 'Class A issued units',
      },
      'o1',
    );
    const corrected = append(
      owned.state,
      {
        ...command(),
        correctionOf: 'r1',
        newInvestment: { ...identity, shareClass: 'Class B' },
      },
      'r3',
      '2026-08-02T10:00:00Z',
    );
    expect(
      project(corrected.state).investments.find((i) => i.id === 'i-r3')!
        .positions[0].actualOwnershipPercent,
    ).toBeNull();
  });
  it('keeps unavailable currency distinct from zero and suppresses unsupported portfolio weights', () => {
    const result = project(linked(), { currency: 'USD' });
    expect(result.investments[0].nav).toBeNull();
    expect(result.investments[0].knownNAV).toBeNull();
    expect(result.investments[0].families[0].portfolioWeight).toBeNull();
    expect(result.investments[0].families[0].shareOfKnownNAV).toBeNull();
  });
  it('retains known NAV share with a missing mark but blocks incomplete family concentration', () => {
    const result = project(linked(), {}, (data) => {
      data.finance.valuations = data.finance.valuations.filter(
        (v) => v.holdingId !== 'cash',
      );
      data.portfolio.holdings.find((h) => h.id === 'cash')!.valuationDate =
        '2027-01-01';
    });
    expect(result.investments[0].families[0].shareOfKnownNAV).toBeCloseTo(
      66.666666,
    );
    expect(result.investments[0].families[0].portfolioWeight).toBeNull();
    expect(result.investments[0].families[0].coverage.complete).toBe(false);
  });
  it('excludes future links without treating an unlinked position as zero', () => {
    const future = append(undefined, {
      ...command(),
      effectiveDate: '2027-01-01',
    });
    expect(project(future.state).investments).toEqual([]);
    expect(project(future.state).unlinked[0].nav).toBe('600.00');
  });
  it('requires precise ownership basis and bounds percentages independently of NAV', () => {
    const { newInvestment: _, ...base } = command() as Extract<
      ParticipationCommand,
      { kind: 'link' }
    >;
    expect(
      participationCommandSchema.safeParse({
        ...base,
        kind: 'ownership',
        percent: '100.000001',
        ownershipBasis: 'Issued units',
      }).success,
    ).toBe(false);
    expect(
      participationCommandSchema.safeParse({
        ...base,
        kind: 'ownership',
        percent: '6',
      }).success,
    ).toBe(false);
    expect(() =>
      append(undefined, {
        ...base,
        kind: 'ownership',
        percent: '6',
        ownershipBasis: 'Issued units',
      }),
    ).toThrow(/active investment link/);
  });
  it('scopes raw workspace identities and records before disclosure, clearing receipts', () => {
    const participation = linked();
    participation.receipts.push({
      key: 'secret',
      digest: 'hidden',
      resultId: 'r2',
    });
    const scoped = scopeWorkspace(
      {
        ...initialWorkspace(false),
        portfolio: fixture().portfolio,
        participation,
      },
      { familyIds: ['f1'] },
      new Set(['d-one', 'd-cash']),
    );
    expect(scoped.participation!.records.map((r) => r.holdingId)).toEqual([
      'one',
    ]);
    expect(scoped.participation!.receipts).toEqual([]);
    expect(JSON.stringify(scoped.participation)).not.toContain('s-two');
    expect(scoped.participation!.investments).toHaveLength(1);
  });
  it('withholding a correction source cannot resurrect a superseded link in scoped workspace DTO', () => {
    const first = append();
    const corrected = append(
      first.state,
      { ...command(), correctionOf: 'r1' },
      'r2',
      '2026-08-02T10:00:00Z',
    ).state;
    corrected.records[1].documentId = 'withheld-document';
    const scoped = scopeWorkspace(
      {
        ...initialWorkspace(false),
        portfolio: fixture().portfolio,
        participation: corrected,
      },
      { familyIds: ['f1'] },
      new Set(['d-one', 'd-cash']),
    );
    expect(scoped.participation!.records).toEqual([]);
    expect(scoped.participation!.investments).toEqual([]);
  });
});
