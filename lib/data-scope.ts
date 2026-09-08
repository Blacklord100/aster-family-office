import { z } from 'zod';
import {
  deriveWorkspace,
  initialWorkspace,
  type WorkspaceState,
} from './workspace';

const ids = z
  .array(z.string().min(1).max(160))
  .max(200)
  .refine((v) => new Set(v).size === v.length);
export const DataScopeSchema = z
  .object({ familyIds: ids.min(1), entityIds: ids.optional() })
  .strict();
export type DataScope = z.infer<typeof DataScopeSchema>;
export function scopeAllows(
  scope: DataScope | undefined | null,
  familyId: string,
  entityId?: string,
): boolean {
  return (
    !scope ||
    (scope.familyIds.includes(familyId) &&
      (!scope.entityIds?.length ||
        (!!entityId && scope.entityIds.includes(entityId))))
  );
}
export function documentScopeAllows(
  scope: DataScope,
  grant: { family_ids: string[]; entity_ids: string[] },
): boolean {
  return (
    grant.family_ids.length > 0 &&
    grant.family_ids.every((id) => scope.familyIds.includes(id)) &&
    (!scope.entityIds?.length ||
      (grant.entity_ids.length > 0 &&
        grant.entity_ids.every((id) => scope.entityIds!.includes(id))))
  );
}
/** Explicit DTO allowlist. New workspace properties are private until deliberately scoped here. */
export function scopeWorkspace(
  state: WorkspaceState,
  scope?: DataScope | null,
  releasedDocuments: ReadonlySet<string> = new Set(),
): WorkspaceState {
  if (!scope) return state;
  const data = deriveWorkspace(state);
  const holdings = data.holdings.filter((h) =>
    scopeAllows(scope, h.familyId, h.entityId),
  );
  const holdingIds = new Set(holdings.map((h) => h.id));
  const entityIds = new Set(holdings.map((h) => h.entityId));
  const accountIds = new Set(holdings.map((h) => h.accountId));
  const evidence = data.evidence.filter(
    (e) =>
      holdingIds.has(e.holdingId) &&
      (!('documentId' in e) ||
        !e.documentId ||
        releasedDocuments.has(e.documentId)),
  );
  const sourceIds = new Set(evidence.map((e) => e.id));
  const tasks = data.tasks.filter(
    (t) => holdingIds.has(t.holdingId) && sourceIds.has(t.sourceId),
  );
  const portfolio = {
    holdings,
    history: data.history.filter((h) => holdingIds.has(h.holdingId)),
    families: data.families.filter((f) => scope.familyIds.includes(f.id)),
    entities: data.entities.filter(
      (e) => entityIds.has(e.id) && scopeAllows(scope, e.familyId, e.id),
    ),
    accounts: data.accounts.filter(
      (a) => accountIds.has(a.id) && scopeAllows(scope, a.familyId, a.entityId),
    ),
    evidence,
    tasks,
    events: data.events.filter(
      (e) =>
        e.holdingIds.length > 0 &&
        e.holdingIds.every((id) => holdingIds.has(id)) &&
        sourceIds.has(e.sourceId),
    ),
  };
  const result: WorkspaceState = {
    ...initialWorkspace(false),
    sampleData: false,
    portfolio,
    officeName: state.officeName,
    identity: state.identity,
    taskStatus: Object.fromEntries(
      tasks.map((t) => [t.id, state.taskStatus[t.id] ?? t.status]),
    ),
    reports: [],
  };
  if (state.riskData) {
    const positions = state.riskData.positions.filter((p) =>
      holdingIds.has(p.holdingId),
    );
    const reachable = new Set(positions.map((p) => p.nodeId));
    for (let changed = true; changed;) {
      changed = false;
      for (const link of state.riskData.links)
        if (reachable.has(link.parentId) && !reachable.has(link.childId)) {
          reachable.add(link.childId);
          changed = true;
        }
    }
    result.riskData = {
      version: 1,
      positions,
      nodes: state.riskData.nodes
        .filter((n) => reachable.has(n.id))
        .map((n) => ({
          ...n,
          sourceId:
            n.sourceId && sourceIds.has(n.sourceId) ? n.sourceId : undefined,
        })),
      links: state.riskData.links
        .filter((l) => reachable.has(l.parentId) && reachable.has(l.childId))
        .map((l) => ({
          ...l,
          sourceId:
            l.sourceId && sourceIds.has(l.sourceId) ? l.sourceId : undefined,
        })),
    };
  }
  if (state.finance) {
    const finance = state.finance;
    const transactions = finance.transactions.filter(
      (t) =>
        holdingIds.has(t.cashHoldingId) &&
        (!t.holdingId || holdingIds.has(t.holdingId)) &&
        (!t.destinationCashHoldingId ||
          holdingIds.has(t.destinationCashHoldingId)),
    );
    const transactionIds = new Set(transactions.map((t) => t.id));
    result.finance = {
      ...finance,
      entities: Object.fromEntries(
        Object.entries(finance.entities ?? {}).filter(([id]) =>
          entityIds.has(id),
        ),
      ),
      transactions,
      events: finance.events.filter(
        (e) =>
          transactionIds.has(e.transactionId) &&
          e.postings.every((p) => holdingIds.has(p.holdingId)),
      ),
      valuations: finance.valuations.filter((v) => holdingIds.has(v.holdingId)),
      coverage: finance.coverage
        .filter(
          (c) =>
            scopeAllows(scope, c.familyId, c.entityId) &&
            c.cashHoldingIds.every((id) => holdingIds.has(id)),
        )
        .map((c) => ({
          ...c,
          eventCount: finance.events
            .slice(0, c.eventCount)
            .filter(
              (e) =>
                transactionIds.has(e.transactionId) &&
                e.postings.every((p) => holdingIds.has(p.holdingId)),
            ).length,
          valuationCount: finance.valuations
            .slice(0, c.valuationCount)
            .filter((v) => holdingIds.has(v.holdingId)).length,
        })),
      holdings: Object.fromEntries(
        Object.entries(finance.holdings).filter(([id]) => holdingIds.has(id)),
      ),
      accounts: Object.fromEntries(
        Object.entries(finance.accounts).filter(([id]) => accountIds.has(id)),
      ),
      receipts: [],
    };
  }
  return result;
}
