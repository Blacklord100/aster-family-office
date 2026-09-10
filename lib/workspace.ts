import {
  holdings,
  valuationHistory,
  timelineEvents,
  evidenceSources,
  AS_OF_DATE,
  accounts,
  entities,
  tasks,
  sources,
  families,
} from '@/data';
import type {
  Holding,
  TimelineEvent,
  HoldingValuation,
  EvidenceSource,
  OfficeTask,
  Family,
  Entity,
  Account,
} from '@/data';
import {
  createWorkspaceDemoScenario,
  createDemoEngineState,
} from './demo-engine';
import type { DemoEngineState } from './demo-engine';
import { calculatePortfolioMetrics } from './finance';
import type { RiskData, RiskScenario } from './risk-contract';
import type { FinanceState } from './ledger-contract';
import type { ReportingState } from './reporting-contract';
import type { IntelligenceState } from './intelligence-contract';
export const scenario = createWorkspaceDemoScenario({
  asOfDate: AS_OF_DATE,
  holdings,
  timelineEvents,
});
export type SavedReport = {
  synthetic?: boolean;
  id: string;
  name: string;
  family: string;
  range: string;
  createdAt: string;
  totalValueEUR: number | null;
  valuationCoverage?: import('./finance').MetricCoverage;
  holdingCount: number;
  holdings: Holding[];
  history: {
    date: string;
    value: number;
    flow: number | null;
    index: number | null;
  }[];
};
export type PortfolioRecords = {
  holdings: Holding[];
  history: HoldingValuation[];
  events: TimelineEvent[];
  evidence: EvidenceSource[];
  tasks: OfficeTask[];
  families: Family[];
  entities: Entity[];
  accounts: Account[];
};
export type WorkspaceState = {
  /** Transport metadata from the encrypted workspace row; never an input revision. */
  workspaceRevision?: number;
  demo?: import('./demo-contract').DemoWorkspaceState;
  sampleData?: boolean;
  sampleDataAllowed?: boolean;
  identity?: import('./processing-contract').WorkspaceIdentity;
  portfolio?: PortfolioRecords;
  version: 1;
  taskStatus: Record<string, string>;
  reviews: Record<string, string>;
  engine: DemoEngineState;
  reports: SavedReport[];
  riskData?: RiskData;
  riskScenarios?: SavedRiskScenario[];
  finance?: FinanceState;
  historyLifecycle?: import('./portfolio-history-lifecycle-contract').HistoryLifecycleState;
  participation?: import('./participation-contract').ParticipationState;
  reporting?: ReportingState;
  intelligence?: IntelligenceState;
  obligations?: import('./report-obligations-contract').ReportObligationsState;
  obligationReceipts?: { key: string; digest: string; resultId: string }[];
  syncs: Record<string, string>;
  officeName: string;
};
export type SavedRiskScenario = {
  id: string;
  name: string;
  scenario: RiskScenario;
  createdAt: string;
};
export function initialWorkspace(sampleData = true): WorkspaceState {
  return {
    version: 1,
    sampleData,
    taskStatus: {},
    reviews: {},
    engine: sampleData ? scenario.state : createDemoEngineState(),
    reports: [],
    syncs: {},
    officeName: 'Aster Family Office',
  };
}
export function deriveWorkspace(state: WorkspaceState) {
  if (state.portfolio || state.sampleData === false) {
    const records = state.portfolio ?? {
      holdings: [],
      history: [],
      events: [],
      evidence: [],
      tasks: [],
      families: [],
      entities: [],
      accounts: [],
    };
    return {
      ...records,
      mailboxes: state.sampleData ? sources : [],
      metrics: calculatePortfolioMetrics(records.holdings, records.history),
    };
  }
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
    families,
    entities,
    accounts,
    tasks,
    mailboxes: sources,
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
    metrics: calculatePortfolioMetrics(currentHoldings, history, AS_OF_DATE),
  };
}
