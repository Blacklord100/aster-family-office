export type FamilyId = string;
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
  type:
    | 'Holding company'
    | 'Property SPV'
    | 'Trust'
    | 'Foundation'
    | 'Partnership'
    | 'Individual';
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
  costBasisStatus?: 'reported' | 'unknown';
  unfundedStatus?: 'reported' | 'unknown';
  valuationStatus?: 'reported' | 'unknown';
  liquidityStatus?: 'reported' | 'unknown';
  assetClassStatus?: 'reported' | 'inferred';
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
    | 'Reported market mark'
    | 'Reported mark plus settled capital'
    | 'Equity appraisal, net of debt'
    | 'Cash balance';
}
/** All figures are synthetic. Flows are signed, external to the modeled portfolio,
 * and occur after the day's return. Internal distributions/transfers are not external flows. */
export interface HoldingValuation {
  flowCoverage?: 'unknown' | 'reconciled' | 'synthetic';
  holdingId: string;
  date: string;
  valueEUR: number;
  netExternalFlowEUR: number;
  valuationBasis:
    | 'Synthetic market mark'
    | 'Synthetic reported mark'
    | 'Carried forward'
    | 'Reported mark';
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
  /** Real retained source bytes belonging to an explicitly synthetic demo run. */
  demoSource?: boolean;
  reportedEffectiveDate?: string | null;
  effectiveDateBasis?: 'Source reported' | 'Receipt date fallback';
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
  synthetic: boolean;
  documentId?: string;
}
export interface TimelineEvent {
  dateBasis?: 'Source reported' | 'Receipt date fallback';
  reportedCurrency?: string | null;
  reportedAmount?: string | null;
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
