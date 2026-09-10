import { describe, it, expect } from 'vitest';
import {
  DataScopeSchema,
  scopeAllows,
  documentScopeAllows,
  scopeWorkspace,
} from './data-scope';
import { initialWorkspace, deriveWorkspace } from './workspace';
import { emptyFinanceState, type CashObligation } from './ledger-contract';
describe('client data scope', () => {
  it('rejects empty/duplicate and malformed family scopes', () => {
    expect(DataScopeSchema.safeParse({ familyIds: [] }).success).toBe(false);
    expect(DataScopeSchema.safeParse({ familyIds: ['a', 'a'] }).success).toBe(
      false,
    );
    expect(
      DataScopeSchema.safeParse({ familyIds: ['a'], all: true }).success,
    ).toBe(false);
  });
  it('requires family AND entity membership, not either', () => {
    const scope = { familyIds: ['a'], entityIds: ['one'] };
    expect(scopeAllows(scope, 'a', 'one')).toBe(true);
    expect(scopeAllows(scope, 'b', 'one')).toBe(false);
    expect(scopeAllows(scope, 'a', 'two')).toBe(false);
    expect(scopeAllows(scope, 'a')).toBe(false);
  });
  it('only releases a whole original when every declared scope is authorized', () => {
    const scope = { familyIds: ['a'], entityIds: ['one'] };
    expect(
      documentScopeAllows(scope, { family_ids: ['a'], entity_ids: ['one'] }),
    ).toBe(true);
    expect(
      documentScopeAllows(scope, {
        family_ids: ['a', 'b'],
        entity_ids: ['one'],
      }),
    ).toBe(false);
    expect(
      documentScopeAllows(scope, { family_ids: ['a'], entity_ids: [] }),
    ).toBe(false);
    expect(
      documentScopeAllows(scope, {
        family_ids: ['a'],
        entity_ids: ['one', 'two'],
      }),
    ).toBe(false);
  });
  it('constructs a fresh scoped DTO and hides shared originals, unrelated clients and global state', () => {
    const state = initialWorkspace(true),
      data = deriveWorkspace(state),
      own = data.holdings[0];
    state.portfolio = {
      ...data,
      evidence: data.evidence.map((e) => ({ ...e, documentId: 'shared' })),
    };
    state.reports = [
      {
        id: 'private',
        name: 'Other client private report',
        family: 'all',
        range: 'YTD',
        createdAt: '2026-09-08',
        totalValueEUR: 1,
        holdingCount: data.holdings.length,
        holdings: data.holdings,
        history: [],
      },
    ];
    const scope = { familyIds: [own.familyId], entityIds: [own.entityId] },
      view = scopeWorkspace(state, scope);
    expect(view.portfolio!.holdings.length).toBeGreaterThan(0);
    expect(
      view.portfolio!.holdings.every(
        (h) => h.familyId === own.familyId && h.entityId === own.entityId,
      ),
    ).toBe(true);
    expect(view.portfolio!.evidence).toEqual([]);
    expect(view.reports).toEqual([]);
    expect(view.intelligence).toBeUndefined();
    expect(state.reports).toHaveLength(1);
    const released = scopeWorkspace(state, scope, new Set(['shared']));
    expect(
      released.portfolio!.evidence.every((e) =>
        released.portfolio!.holdings.some((h) => h.id === e.holdingId),
      ),
    ).toBe(true);
  });
  it('requires released original and amendment sources for cash drafts and removes hidden relation IDs', () => {
    const state = initialWorkspace(true),
      data = deriveWorkspace(state),
      own = data.holdings[0],
      foreign = data.holdings.find((row) => row.familyId !== own.familyId)!;
    state.portfolio = {
      ...data,
      evidence: [
        {
          ...data.evidence[0],
          id: 'own-source',
          familyId: own.familyId,
          holdingId: own.id,
          documentId: 'own-doc',
        },
        {
          ...data.evidence[0],
          id: 'foreign-source',
          familyId: foreign.familyId,
          holdingId: foreign.id,
          documentId: 'foreign-doc',
        },
        {
          ...data.evidence[0],
          id: 'amended-source',
          familyId: own.familyId,
          holdingId: own.id,
          documentId: 'amended-doc',
        },
      ],
    };
    const terms = {
      amount: '10.01',
      currency: 'EUR',
      effectiveDate: '2026-09-01',
      dueDate: null,
    };
    const notice: CashObligation = {
      ...terms,
      id: 'own',
      holdingId: own.id,
      sourceId: 'own-source',
      documentId: 'own-doc',
      kind: 'capital_call',
      fingerprint: 'own',
      original: terms,
      importedAt: null,
      acceptedAt: '2026-09-10T12:00:00Z',
      acceptedBy: 'reviewer',
      summary: 'Allowed notice',
      origin: 'accepted_fact',
      amendments: [],
      distinctFrom: [
        {
          obligationId: 'foreign',
          noticeRevision: 0,
          otherRevision: 0,
          reason: 'Private other source',
          source: {
            sourceId: 'foreign-source',
            date: '2026-09-01',
            reference: 'Private reference',
          },
          actorId: 'reviewer',
          at: '2026-09-10T12:00:00Z',
        },
      ],
    };
    state.finance = {
      ...emptyFinanceState(),
      obligations: [
        notice,
        {
          ...notice,
          id: 'foreign',
          holdingId: foreign.id,
          sourceId: 'foreign-source',
          documentId: 'foreign-doc',
          summary: 'PRIVATE other family',
          distinctFrom: [],
        },
      ],
    };
    const scope = { familyIds: [own.familyId], entityIds: [own.entityId] };
    expect(scopeWorkspace(state, scope).finance?.obligations).toEqual([]);
    const released = scopeWorkspace(
      state,
      scope,
      new Set(['own-doc', 'foreign-doc']),
    );
    expect(released.finance?.obligations?.map((row) => row.id)).toEqual([
      'own',
    ]);
    expect(released.finance?.obligations?.[0].distinctFrom).toEqual([]);
    expect(JSON.stringify(released)).not.toContain('Private reference');
    notice.amendments.push({
      id: 'amendment',
      before: terms,
      after: { ...terms, amount: '11' },
      source: {
        sourceId: 'amended-source',
        reference: 'Unreleased revised notice',
        date: '2026-09-01',
      },
      reason: 'New amount',
      actorId: 'reviewer',
      at: notice.acceptedAt,
    });
    expect(
      scopeWorkspace(state, scope, new Set(['own-doc'])).finance?.obligations,
    ).toEqual([]);
    expect(
      scopeWorkspace(state, scope, new Set(['own-doc', 'amended-doc'])).finance
        ?.obligations,
    ).toHaveLength(1);
    expect(state.finance.obligations).toHaveLength(2);
  });
});
