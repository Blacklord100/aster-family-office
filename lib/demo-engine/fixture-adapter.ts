import { createDemoEngineState } from './engine';
import {
  answerDemoQuestion,
  type DemoAnswer,
  type DemoQueryData,
} from './queries';
import type { DemoEngineState, DemoProposal } from './types';

/** Structural subset of data-pipeline fixtures: no imports from the Site checkout. */
export interface FixtureHolding {
  id: string;
  name: string;
  familyId: string;
  entityId: string;
  assetClass: string;
  valueEUR: number;
  costBasisEUR: number;
  unfundedCommitmentEUR: number;
  valuationDate: string;
  sourceId: string;
}
export interface FixtureEvent {
  id: string;
  familyId: string;
  holdingIds: string[];
  entityId: string;
  type: string;
  title: string;
  summary: string;
  date: string;
  sourceId: string;
  receivedAt?: string;
  amountEUR?: number;
}
export interface FixtureData {
  asOfDate: string;
  holdings: readonly FixtureHolding[];
  timelineEvents: readonly FixtureEvent[];
}
export interface ScenarioEvidence {
  id: string;
  mailboxId: string;
  familyId: 'laurent';
  holdingId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  effectiveDate: string;
  filename: string;
  page: number;
  excerpt: string;
  status: 'Accepted';
  synthetic: true;
}
export const DEMO_REVISION_EVIDENCE_ID = 'source-demo-northstar-revision';
const cents = (eur: number): number => Math.round(eur * 100);

/** Five simulated incoming copies: one call in 3 mailboxes, a correction, and a newsletter. */
export function createWorkspaceDemoScenario(data: FixtureData): {
  state: DemoEngineState;
  proposals: DemoProposal[];
  evidenceSources: ScenarioEvidence[];
} {
  const northstar = data.holdings.find((holding) => holding.id === 'northstar');
  const pacific = data.holdings.find(
    (holding) => holding.id === 'pacific-ventures',
  );
  if (!northstar || !pacific)
    throw new Error(
      'This named scenario requires the Northstar and Pacific synthetic fixtures.',
    );
  const businessEventId = `northstar-nav-${northstar.valuationDate}`;
  const recordedAt = '2026-07-15T09:00:00.000Z';
  const state = createDemoEngineState({
    knownEntityIds: [
      ...new Set(data.holdings.map((holding) => holding.entityId)),
    ],
    knownPositionIds: data.holdings.map((holding) => holding.id),
    knownFundIds: data.holdings
      .filter((holding) => holding.unfundedCommitmentEUR > 0)
      .map((holding) => holding.id),
    cashBalances: data.holdings
      .filter((holding) => holding.assetClass === 'Cash')
      .map((holding) => ({
        id: holding.id,
        entityId: holding.entityId,
        amountMinor: cents(holding.valueEUR),
        currency: 'EUR',
        asOfDate: holding.valuationDate,
        evidenceCitationIds: [holding.sourceId],
      })),
    valuationVersions: [
      {
        id: `valuation:${businessEventId}@1`,
        businessEventId,
        revision: 1,
        positionId: northstar.id,
        entityId: northstar.entityId,
        valueMinor: cents(northstar.valueEUR),
        currency: 'EUR',
        valuationDate: northstar.valuationDate,
        recordedAt,
        status: 'active',
        evidenceCitationIds: [northstar.sourceId],
        mailboxCopyIds: ['mailbox-camille:northstar-nav-original'],
      },
    ],
    timeline: [
      {
        id: `timeline:${businessEventId}@1`,
        businessEventId,
        revision: 1,
        kind: 'statement_revision',
        entityId: northstar.entityId,
        title: 'Northstar III: original June NAV',
        summary:
          'Original synthetic investor NAV; retained when a revision is accepted.',
        effectiveDate: northstar.valuationDate,
        recordedAt,
        status: 'active',
        evidenceCitationIds: [northstar.sourceId],
        mailboxCopyIds: ['mailbox-camille:northstar-nav-original'],
      },
    ],
  });
  const proposals: DemoProposal[] = [
    'mailbox-camille',
    'mailbox-sofia',
    'mailbox-daniel',
  ].map((mailboxId, index) => ({
    id: `demo-call-copy-${index + 1}`,
    businessEventId: 'event-01',
    revision: 1,
    kind: 'capital_call',
    entityId: northstar.entityId,
    fundId: northstar.id,
    title: 'Northstar III calls €420,000',
    effectiveDate: '2026-09-07',
    dueDate: '2026-09-18',
    amountMinor: 42_000_000,
    currency: 'EUR',
    evidenceCitationIds: ['source-event-01'],
    mailboxCopyIds: [`${mailboxId}:northstar-call-september`],
  }));
  proposals.push(
    {
      id: 'demo-northstar-revision',
      businessEventId,
      revision: 2,
      kind: 'statement_revision',
      entityId: northstar.entityId,
      positionId: northstar.id,
      title: 'Northstar III: revised June investor NAV',
      effectiveDate: northstar.valuationDate,
      valuationDate: northstar.valuationDate,
      valueMinor: cents(northstar.valueEUR + 120_000),
      currency: 'EUR',
      supersedesRevision: 1,
      evidenceCitationIds: [DEMO_REVISION_EVIDENCE_ID],
      mailboxCopyIds: ['mailbox-camille:northstar-nav-revised'],
    },
    {
      id: 'demo-pacific-newsletter',
      businessEventId: 'event-06',
      revision: 1,
      kind: 'newsletter',
      entityId: pacific.entityId,
      title: 'Pacific III: two portfolio follow-on rounds',
      effectiveDate: '2026-09-04',
      summary:
        'The synthetic manager update reports two financing rounds and maintains its last investor NAV.',
      evidenceCitationIds: ['source-event-06'],
      mailboxCopyIds: ['mailbox-daniel:pacific-update'],
    },
  );
  return {
    state,
    proposals,
    evidenceSources: [
      {
        id: DEMO_REVISION_EVIDENCE_ID,
        mailboxId: 'mailbox-camille',
        familyId: 'laurent',
        holdingId: northstar.id,
        subject: 'Northstar III — revised 30 June investor statement',
        sender: 'Northstar Partners <reporting@northstar.example>',
        receivedAt: '2026-09-07T09:15:00Z',
        effectiveDate: northstar.valuationDate,
        filename: 'northstar_june_nav_revision_2_synthetic.pdf',
        page: 2,
        excerpt: `SYNTHETIC DEMONSTRATION. Revision 2 supersedes the investor NAV of EUR ${northstar.valueEUR.toLocaleString('en-IE')} at ${northstar.valuationDate}. Corrected investor NAV: EUR ${(northstar.valueEUR + 120_000).toLocaleString('en-IE')}. This is a historical valuation correction, not a cash movement. Cost basis remains EUR ${northstar.costBasisEUR.toLocaleString('en-IE')}. Unfunded commitment remains EUR ${northstar.unfundedCommitmentEUR.toLocaleString('en-IE')}.`,
        status: 'Accepted',
        synthetic: true,
      },
    ],
  };
}

/** The caller passes the selected family; totals always remain within that selection. */
export function buildDemoQueryData(
  data: FixtureData,
  state?: DemoEngineState,
  familyId?: string,
): DemoQueryData {
  const selected = data.holdings.filter(
    (holding) => !familyId || holding.familyId === familyId,
  );
  const holdingIds = new Set(selected.map((holding) => holding.id));
  const entityIds = new Set(selected.map((holding) => holding.entityId));
  const holdings = selected.map((holding) => {
    const revision = state?.valuationVersions
      .filter(
        (value) =>
          value.positionId === holding.id &&
          value.status === 'active' &&
          value.currency === 'EUR',
      )
      .sort(
        (a, b) =>
          b.valuationDate.localeCompare(a.valuationDate) ||
          b.revision - a.revision,
      )[0];
    return {
      id: holding.id,
      name: holding.name,
      assetClass: holding.assetClass,
      valueMinor: revision?.valueMinor ?? cents(holding.valueEUR),
      valuationDate: revision?.valuationDate ?? holding.valuationDate,
      evidenceCitationIds: revision?.evidenceCitationIds ?? [holding.sourceId],
    };
  });
  const baseEvents = data.timelineEvents.filter((event) =>
    event.holdingIds.some((id) => holdingIds.has(id)),
  );
  const updates = new Map<string, DemoQueryData['updates'][number]>(
    baseEvents.map((event) => [
      event.id,
      {
        id: event.id,
        title: event.title,
        summary: event.summary,
        date: event.receivedAt?.slice(0, 10) ?? event.date,
        effectiveDate: event.date,
        evidenceCitationIds: [event.sourceId],
      },
    ]),
  );
  for (const event of state?.timeline ?? []) {
    if (event.status === 'active' && entityIds.has(event.entityId))
      updates.set(event.businessEventId, {
        id: event.businessEventId,
        title: event.title,
        summary: event.summary,
        date: event.recordedAt.slice(0, 10),
        effectiveDate: event.effectiveDate,
        evidenceCitationIds: event.evidenceCitationIds,
      });
  }
  // Fixed typed due date from the synthetic notice; never inferred from generic prose.
  const baseCall = baseEvents.find((event) => event.id === 'event-01');
  const obligations = new Map<string, DemoQueryData['obligations'][number]>();
  if (baseCall?.amountEUR != null)
    obligations.set('event-01', {
      id: 'event-01',
      name: baseCall.title,
      amountMinor: cents(baseCall.amountEUR),
      currency: 'EUR',
      dueDate: '2026-09-18',
      status: 'expected',
      evidenceCitationIds: [baseCall.sourceId],
    });
  for (const obligation of state?.obligations ?? []) {
    if (entityIds.has(obligation.entityId))
      obligations.set(obligation.businessEventId, {
        id: obligation.businessEventId,
        name:
          selected.find((holding) => holding.id === obligation.fundId)?.name ??
          obligation.fundId,
        amountMinor: obligation.amountMinor,
        currency: obligation.currency,
        dueDate: obligation.dueDate,
        status: obligation.status,
        evidenceCitationIds: obligation.evidenceCitationIds,
      });
  }
  return {
    asOfDate: data.asOfDate,
    reportingCurrency: 'EUR',
    holdings,
    cash: selected
      .filter((holding) => holding.assetClass === 'Cash')
      .map((holding) => ({
        id: holding.id,
        name: holding.name,
        amountMinor: cents(holding.valueEUR),
        asOfDate: holding.valuationDate,
        evidenceCitationIds: [holding.sourceId],
      })),
    commitments: selected
      .filter((holding) => holding.unfundedCommitmentEUR > 0)
      .map((holding) => ({
        id: holding.id,
        fundName: holding.name,
        unfundedMinor: cents(holding.unfundedCommitmentEUR),
        evidenceCitationIds: [holding.sourceId],
      })),
    obligations: [...obligations.values()],
    updates: [...updates.values()],
  };
}

/** Optional convenience: route an explicitly named family, otherwise use current selection. */
export function answerWorkspaceQuestion(
  question: string,
  data: FixtureData,
  state?: DemoEngineState,
  selectedFamilyId?: string,
): DemoAnswer {
  const normalised = question
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const named = ['laurent', 'bergstrom', 'chen'].filter((id) =>
    new RegExp(`\\b${id}\\b`).test(normalised),
  );
  if (named.length > 1)
    return {
      mode: 'grounded_demo',
      intent: 'unsupported',
      answer:
        'This demo can answer for all families or one named family at a time. Select all families for the combined view.',
      evidenceCitationIds: [],
      facts: [],
      notice:
        'Fixed query rules over synthetic records; no LLM or live connection.',
    };
  const queryData = buildDemoQueryData(
    data,
    state,
    named[0] ?? selectedFamilyId,
  );
  const answer = answerDemoQuestion(question, queryData);
  if (answer.intent !== 'unsupported')
    answer.answer = `${named[0] ?? selectedFamilyId ?? 'All families'} · ${answer.answer}`;
  return answer;
}
