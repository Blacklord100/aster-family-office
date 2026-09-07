export type Currency = string;
export type StageId =
  | 'intake'
  | 'entity_matching'
  | 'extraction'
  | 'validation'
  | 'timeline_commit';
export type ProposalKind = 'capital_call' | 'statement_revision' | 'newsletter';

interface ProposalBase {
  id: string;
  businessEventId: string;
  revision: number;
  entityId: string;
  title: string;
  effectiveDate: string;
  evidenceCitationIds: string[];
  mailboxCopyIds: string[];
}

export interface CapitalCallProposal extends ProposalBase {
  kind: 'capital_call';
  fundId: string;
  amountMinor: number;
  currency: Currency;
  dueDate: string;
}

export interface StatementRevisionProposal extends ProposalBase {
  kind: 'statement_revision';
  positionId: string;
  valueMinor: number;
  currency: Currency;
  valuationDate: string;
  supersedesRevision: number;
}

export interface NewsletterProposal extends ProposalBase {
  kind: 'newsletter';
  summary: string;
}

export type DemoProposal =
  | CapitalCallProposal
  | StatementRevisionProposal
  | NewsletterProposal;

export interface CashBalance {
  id: string;
  entityId: string;
  amountMinor: number;
  currency: Currency;
  asOfDate: string;
  evidenceCitationIds: string[];
}

export interface Obligation {
  id: string;
  businessEventId: string;
  revision: number;
  entityId: string;
  fundId: string;
  amountMinor: number;
  currency: Currency;
  dueDate: string;
  status: 'expected';
  recordedAt: string;
  evidenceCitationIds: string[];
  mailboxCopyIds: string[];
}

export interface ValuationVersion {
  id: string;
  businessEventId: string;
  revision: number;
  positionId: string;
  entityId: string;
  valueMinor: number;
  currency: Currency;
  valuationDate: string;
  recordedAt: string;
  status: 'active' | 'superseded';
  supersedesId?: string;
  evidenceCitationIds: string[];
  mailboxCopyIds: string[];
}

export interface TimelineItem {
  id: string;
  businessEventId: string;
  revision: number;
  kind: ProposalKind;
  entityId: string;
  title: string;
  summary: string;
  effectiveDate: string;
  recordedAt: string;
  status: 'active' | 'superseded';
  supersedesId?: string;
  evidenceCitationIds: string[];
  mailboxCopyIds: string[];
}

export interface StageProgress {
  id: StageId;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'cancelled';
  startedAt?: string;
  completedAt?: string;
  detail: string;
}

export interface RunIssue {
  proposalKey: string;
  stage: StageId;
  message: string;
}

export interface DemoRun {
  id: string;
  mode: 'simulation';
  status: 'running' | 'completed' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  currentStage: StageId | null;
  stages: StageProgress[];
  inputProposals: DemoProposal[];
  proposals: DemoProposal[];
  issues: RunIssue[];
  inputCopyCount: number;
  uniqueEventCount: number;
  publishedEventCount: number;
  replayedEventCount: number;
}

export interface DemoEngineState {
  mode: 'simulation';
  knownEntityIds: string[];
  knownPositionIds: string[];
  knownFundIds: string[];
  cashBalances: CashBalance[];
  obligations: Obligation[];
  valuationVersions: ValuationVersion[];
  timeline: TimelineItem[];
  appliedProposalKeys: string[];
  appliedFingerprints: Record<string, string>;
  runs: DemoRun[];
}
