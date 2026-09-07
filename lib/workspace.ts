import {
  holdings,
  valuationHistory,
  timelineEvents,
  evidenceSources,
  AS_OF_DATE,
} from '@/data';
import type { Holding, TimelineEvent } from '@/data';
import { createWorkspaceDemoScenario } from './demo-engine';
import type { DemoEngineState } from './demo-engine';
import { calculatePortfolioMetrics } from './finance';
export const scenario = createWorkspaceDemoScenario({
  asOfDate: AS_OF_DATE,
  holdings,
  timelineEvents,
});
export type SavedReport = {
  id: string;
  name: string;
  family: string;
  range: string;
  createdAt: string;
  totalValueEUR: number;
  holdingCount: number;
  holdings: Holding[];
  history: {
    date: string;
    value: number;
    flow: number;
    index: number | null;
  }[];
};
export type WorkspaceState = {
  version: 1;
  taskStatus: Record<string, string>;
  reviews: Record<string, string>;
  engine: DemoEngineState;
  reports: SavedReport[];
  syncs: Record<string, string>;
  officeName: string;
};
export function initialWorkspace(): WorkspaceState {
  return {
    version: 1,
    taskStatus: {},
    reviews: {},
    engine: scenario.state,
    reports: [],
    syncs: {},
    officeName: 'Aster Family Office',
  };
}
export function deriveWorkspace(state: WorkspaceState) {
  const currentHoldings: Holding[] = holdings.map((h) => {
    const v = state.engine.valuationVersions
      .filter(
        (v) =>
          v.positionId === h.id &&
          v.status === 'active' &&
          v.currency === 'EUR',
      )
      .sort((a, b) => b.revision - a.revision)[0];
    return v
      ? {
          ...h,
          valueEUR: v.valueMinor / 100,
          originalValue: v.valueMinor / 100 / h.syntheticFXRateToEUR,
          sourceId: v.evidenceCitationIds[0],
          valuationDate: v.valuationDate,
        }
      : h;
  });
  const revisions = new Map(currentHoldings.map((h) => [h.id, h]));
  const history = valuationHistory.map((row) => {
    const h = revisions.get(row.holdingId)!,
      original = holdings.find((v) => v.id === row.holdingId)!;
    return row.date >= h.valuationDate && h.valueEUR !== original.valueEUR
      ? {
          ...row,
          valueEUR:
            Math.round((row.valueEUR + h.valueEUR - original.valueEUR) * 100) /
            100,
        }
      : row;
  });
  const eventMap = new Map(timelineEvents.map((e) => [e.id, e]));
  for (const e of state.engine.timeline.filter((e) => e.status === 'active')) {
    const source = [...evidenceSources, ...scenario.evidenceSources].find(
      (s) => s.id === e.evidenceCitationIds[0],
    );
    if (!source) continue;
    const h = currentHoldings.find((h) => h.id === source.holdingId)!;
    const event: TimelineEvent = {
      id: e.businessEventId,
      familyId: h.familyId,
      holdingIds: [h.id],
      entityId: h.entityId,
      type:
        e.kind === 'capital_call'
          ? 'Capital call'
          : e.kind === 'statement_revision'
            ? 'Valuation'
            : 'Manager update',
      title: e.title,
      summary: e.summary,
      date: e.effectiveDate,
      receivedAt: e.recordedAt,
      sourceId: e.evidenceCitationIds[0],
      status: e.kind === 'statement_revision' ? 'Accepted' : 'Source reported',
      materiality: e.kind === 'capital_call' ? 'High' : 'Medium',
      financialEffect:
        e.kind === 'statement_revision' ? 'Accepted valuation' : 'None',
    };
    eventMap.set(e.businessEventId, event);
  }
  return {
    holdings: currentHoldings,
    history,
    events: [...eventMap.values()].sort((a, b) =>
      b.receivedAt.localeCompare(a.receivedAt),
    ),
    evidence: [
      ...evidenceSources,
      ...scenario.evidenceSources.map((s) => ({
        ...s,
        status: state.engine.valuationVersions.some(
          (v) => v.status === 'active' && v.evidenceCitationIds.includes(s.id),
        )
          ? ('Accepted' as const)
          : ('Needs review' as const),
      })),
    ],
    metrics: calculatePortfolioMetrics(currentHoldings, history),
  };
}
