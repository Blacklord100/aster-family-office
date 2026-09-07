export type FamilyId = 'laurent' | 'bergstrom' | 'chen';
export type Currency = 'EUR' | 'USD' | 'GBP' | 'CHF';
export type AssetClass =
  | 'Public equities'
  | 'Private equity'
  | 'Venture capital'
  | 'Real estate'
  | 'Fixed income'
  | 'Cash';
export type LiquidityBucket =
  | 'Daily'
  | 'Within 30 days'
  | '1–3 years'
  | '3+ years';

export interface Family {
  id: FamilyId;
  name: string;
  initials: string;
  principal: string;
  location: string;
  color: string;
}
export interface Entity {
  id: string;
  familyId: FamilyId;
  name: string;
  type: 'Holding company' | 'Property SPV';
  jurisdiction: string;
  ownershipPercent: number;
}
export interface Account {
  id: string;
  familyId: FamilyId;
  entityId: string;
  name: string;
  institution: string;
  maskedNumber: string;
  type: 'Custody' | 'Private investments' | 'Property';
}
export interface Holding {
  id: string;
  name: string;
  ticker?: string;
  assetClass: AssetClass;
  familyId: FamilyId;
  entityId: string;
  accountId: string;
  currency: Currency;
  valueEUR: number;
  costBasisEUR: number;
  originalValue: number;
  syntheticFXRateToEUR: number;
  unfundedCommitmentEUR: number;
  liquidityBucket: LiquidityBucket;
  valuationDate: string;
  sourceId: string;
  geography: string;
  manager: string;
  description: string;
  color: string;
  valuationMethod:
    | 'Synthetic market mark'
    | 'Reported fund NAV'
    | 'Equity appraisal, net of debt'
    | 'Cash balance';
}
/** All figures are synthetic. Flows are signed, external to the modeled portfolio,
 * and occur after the day's return. Internal distributions/transfers are not external flows. */
export interface HoldingValuation {
  holdingId: string;
  date: string;
  valueEUR: number;
  netExternalFlowEUR: number;
  valuationBasis:
    | 'Synthetic market mark'
    | 'Synthetic reported mark'
    | 'Carried forward';
}
export interface MailboxSource {
  id: string;
  person: string;
  email: string;
  provider: 'Google Workspace' | 'Microsoft 365';
  familyIds: FamilyId[];
  status: 'Connected';
  messagesIndexed: number;
  relevantMessages: number;
  lastSyncedAt: string;
  coverageStart: string;
  coverageEnd: string;
}
export interface EvidenceSource {
  id: string;
  mailboxId: string;
  familyId: FamilyId;
  holdingId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  effectiveDate: string;
  filename: string;
  page: number;
  excerpt: string;
  status: 'Accepted' | 'Needs review';
  synthetic: true;
}
export interface TimelineEvent {
  id: string;
  familyId: FamilyId;
  holdingIds: string[];
  entityId: string;
  type:
    | 'Valuation'
    | 'Capital call'
    | 'Distribution'
    | 'Manager update'
    | 'Public news'
    | 'Review';
  title: string;
  summary: string;
  date: string;
  receivedAt: string;
  sourceId: string;
  status: 'Accepted' | 'Source reported' | 'Needs review';
  materiality: 'High' | 'Medium' | 'Low';
  amountEUR?: number;
  financialEffect: 'None' | 'Accepted valuation';
}
export interface OfficeTask {
  id: string;
  title: string;
  description: string;
  familyId: FamilyId;
  holdingId: string;
  sourceId: string;
  assignee: string;
  dueDate: string;
  priority: 'High' | 'Medium' | 'Low';
  status: 'To do' | 'In progress' | 'Done';
  category: 'Review' | 'Capital call' | 'Reporting' | 'Follow-up';
}
export interface AgentRun {
  id: string;
  name: string;
  role: string;
  status: 'Completed' | 'Needs review' | 'Running';
  startedAt: string;
  durationSeconds: number;
  sourcesProcessed: number;
  eventsCreated: number;
  summary: string;
  familyIds: FamilyId[];
  steps: { label: string; status: 'Complete' | 'Running' | 'Waiting' }[];
}
