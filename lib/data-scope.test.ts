import { describe, it, expect } from 'vitest';
import {
  DataScopeSchema,
  scopeAllows,
  documentScopeAllows,
  scopeWorkspace,
} from './data-scope';
import { initialWorkspace, deriveWorkspace } from './workspace';
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
});
