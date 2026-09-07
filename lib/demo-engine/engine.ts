import type {
  DemoEngineState,
  DemoProposal,
  DemoRun,
  RunIssue,
  StageId,
  TimelineItem,
} from './types';

export const DEMO_STAGES: ReadonlyArray<{ id: StageId; label: string }> = [
  { id: 'intake', label: 'Intake' },
  { id: 'entity_matching', label: 'Entity matching' },
  { id: 'extraction', label: 'Extraction' },
  { id: 'validation', label: 'Validation' },
  { id: 'timeline_commit', label: 'Timeline commit' },
];

const copy = <T>(value: T): T => structuredClone(value);
const unique = (items: string[]): string[] => [...new Set(items)].sort();
export const proposalKey = (
  proposal: Pick<DemoProposal, 'businessEventId' | 'revision'>,
): string => `${proposal.businessEventId}@${proposal.revision}`;

function clock(now: string): number {
  const value = Date.parse(now);
  if (!Number.isFinite(value))
    throw new Error('Pass a valid deterministic ISO clock value.');
  return value;
}

function assertRunClock(run: DemoRun, now: string): void {
  if (clock(now) < clock(run.updatedAt))
    throw new Error('Run clock cannot move backwards.');
}

/** Excludes evidence/copy IDs: several mailbox copies may support the same claim. */
export function proposalFingerprint(proposal: DemoProposal): string {
  const base = [
    proposal.kind,
    proposal.businessEventId,
    proposal.revision,
    proposal.entityId,
    proposal.title,
    proposal.effectiveDate,
  ];
  if (proposal.kind === 'capital_call')
    return JSON.stringify([
      ...base,
      proposal.fundId,
      proposal.amountMinor,
      proposal.currency,
      proposal.dueDate,
    ]);
  if (proposal.kind === 'statement_revision')
    return JSON.stringify([
      ...base,
      proposal.positionId,
      proposal.valueMinor,
      proposal.currency,
      proposal.valuationDate,
      proposal.supersedesRevision,
    ]);
  return JSON.stringify([...base, proposal.summary]);
}

export function createDemoEngineState(
  seed: Partial<Omit<DemoEngineState, 'mode' | 'runs'>> = {},
): DemoEngineState {
  return copy({
    mode: 'simulation',
    knownEntityIds: [],
    knownPositionIds: [],
    knownFundIds: [],
    cashBalances: [],
    obligations: [],
    valuationVersions: [],
    timeline: [],
    appliedProposalKeys: [],
    appliedFingerprints: {},
    ...seed,
    runs: [],
  });
}

export function startDemoRun(
  state: DemoEngineState,
  input: {
    runId: string;
    now: string;
    proposals: readonly DemoProposal[];
  },
): DemoEngineState {
  clock(input.now);
  if (!input.runId.trim()) throw new Error('A run ID is required.');
  if (state.runs.some((run) => run.id === input.runId)) return state;
  const run: DemoRun = {
    id: input.runId,
    mode: 'simulation',
    status: 'running',
    startedAt: input.now,
    updatedAt: input.now,
    currentStage: 'intake',
    stages: DEMO_STAGES.map((stage, index) => ({
      ...stage,
      status: index === 0 ? 'running' : 'pending',
      ...(index === 0 ? { startedAt: input.now } : {}),
      detail:
        index === 0
          ? 'Simulated mailbox copies queued; no mailbox connection is used.'
          : '',
    })),
    inputProposals: copy([...input.proposals]),
    proposals: [],
    issues: [],
    inputCopyCount: input.proposals.length,
    uniqueEventCount: 0,
    publishedEventCount: 0,
    replayedEventCount: 0,
  };
  return { ...copy(state), runs: [...copy(state.runs), run] };
}

function issue(
  run: DemoRun,
  proposal: DemoProposal,
  stage: StageId,
  message: string,
): void {
  const next: RunIssue = { proposalKey: proposalKey(proposal), stage, message };
  if (
    !run.issues.some((value) => JSON.stringify(value) === JSON.stringify(next))
  )
    run.issues.push(next);
}

function intake(run: DemoRun): void {
  const groups = new Map<string, DemoProposal>();
  for (const proposal of run.inputProposals) {
    const key = proposalKey(proposal);
    const previous = groups.get(key);
    if (!previous) {
      groups.set(key, copy(proposal));
    } else if (
      proposalFingerprint(previous) !== proposalFingerprint(proposal)
    ) {
      issue(
        run,
        proposal,
        'intake',
        'Conflicting copies share a business event and revision; nothing from this key will publish.',
      );
    } else {
      previous.evidenceCitationIds = unique([
        ...previous.evidenceCitationIds,
        ...proposal.evidenceCitationIds,
      ]);
      previous.mailboxCopyIds = unique([
        ...previous.mailboxCopyIds,
        ...proposal.mailboxCopyIds,
      ]);
    }
  }
  run.proposals = [...groups.values()].sort(
    (a, b) =>
      a.businessEventId.localeCompare(b.businessEventId) ||
      a.revision - b.revision,
  );
  run.uniqueEventCount = run.proposals.length;
}

function matchEntities(state: DemoEngineState, run: DemoRun): void {
  for (const proposal of run.proposals) {
    if (!state.knownEntityIds.includes(proposal.entityId))
      issue(
        run,
        proposal,
        'entity_matching',
        'Unknown entity; demo does not infer ownership.',
      );
    if (
      proposal.kind === 'capital_call' &&
      !state.knownFundIds.includes(proposal.fundId)
    )
      issue(run, proposal, 'entity_matching', 'Unknown fund identity.');
    if (
      proposal.kind === 'statement_revision' &&
      !state.knownPositionIds.includes(proposal.positionId)
    )
      issue(run, proposal, 'entity_matching', 'Unknown position identity.');
  }
}

function extract(run: DemoRun): void {
  for (const proposal of run.proposals) {
    if (!proposal.evidenceCitationIds.length)
      issue(run, proposal, 'extraction', 'Source evidence is required.');
    if (
      !proposal.businessEventId ||
      !Number.isInteger(proposal.revision) ||
      proposal.revision < 1
    )
      issue(
        run,
        proposal,
        'extraction',
        'Business event identity and positive revision are required.',
      );
    if (!Number.isFinite(Date.parse(proposal.effectiveDate)))
      issue(
        run,
        proposal,
        'extraction',
        'Effective date is missing or invalid.',
      );
    if (proposal.kind === 'capital_call') {
      if (
        !Number.isSafeInteger(proposal.amountMinor) ||
        proposal.amountMinor <= 0
      )
        issue(
          run,
          proposal,
          'extraction',
          'Call amount must be a positive integer in minor currency units.',
        );
      if (!Number.isFinite(Date.parse(proposal.dueDate)))
        issue(run, proposal, 'extraction', 'Capital-call due date is invalid.');
    }
    if (proposal.kind === 'statement_revision') {
      if (!Number.isSafeInteger(proposal.valueMinor))
        issue(
          run,
          proposal,
          'extraction',
          'Valuation must use integer minor currency units.',
        );
      if (!Number.isFinite(Date.parse(proposal.valuationDate)))
        issue(run, proposal, 'extraction', 'Valuation date is invalid.');
    }
  }
}

function validate(state: DemoEngineState, run: DemoRun): void {
  for (const proposal of run.proposals) {
    const key = proposalKey(proposal);
    const priorFingerprint = state.appliedFingerprints[key];
    if (
      state.appliedProposalKeys.includes(key) &&
      priorFingerprint !== proposalFingerprint(proposal)
    ) {
      issue(
        run,
        proposal,
        'validation',
        'Previously published revision has different content; require a new explicit revision.',
      );
    }
    if (proposal.kind === 'capital_call') {
      const previous = state.obligations.find(
        (value) => value.businessEventId === proposal.businessEventId,
      );
      if (previous && previous.revision !== proposal.revision)
        issue(
          run,
          proposal,
          'validation',
          'Amended capital calls are outside this demo publication rule.',
        );
    }
    if (
      proposal.kind === 'statement_revision' &&
      !state.appliedProposalKeys.includes(key)
    ) {
      const previous = state.valuationVersions.find(
        (value) =>
          value.businessEventId === proposal.businessEventId &&
          value.revision === proposal.supersedesRevision,
      );
      if (!previous || previous.status !== 'active')
        issue(
          run,
          proposal,
          'validation',
          'The explicitly superseded valuation must exist and be active.',
        );
      else if (
        previous.positionId !== proposal.positionId ||
        previous.entityId !== proposal.entityId ||
        previous.currency !== proposal.currency ||
        previous.valuationDate !== proposal.valuationDate
      ) {
        issue(
          run,
          proposal,
          'validation',
          'Correction must preserve the same position, owner, currency, and valuation date.',
        );
      }
      if (proposal.revision <= proposal.supersedesRevision)
        issue(
          run,
          proposal,
          'validation',
          'A revision must advance its predecessor.',
        );
    }
  }
}

function attachEvidence(state: DemoEngineState, proposal: DemoProposal): void {
  for (const record of [
    ...state.obligations,
    ...state.valuationVersions,
    ...state.timeline,
  ]) {
    if (
      record.businessEventId === proposal.businessEventId &&
      record.revision === proposal.revision
    ) {
      record.evidenceCitationIds = unique([
        ...record.evidenceCitationIds,
        ...proposal.evidenceCitationIds,
      ]);
      record.mailboxCopyIds = unique([
        ...record.mailboxCopyIds,
        ...proposal.mailboxCopyIds,
      ]);
    }
  }
}

function commit(state: DemoEngineState, run: DemoRun, now: string): void {
  for (const proposal of run.proposals) {
    // Revalidate each write against the newest state, including earlier writes in this batch.
    validate(state, { ...run, proposals: [proposal] });
    const key = proposalKey(proposal);
    if (run.issues.some((value) => value.proposalKey === key)) continue;
    if (state.appliedProposalKeys.includes(key)) {
      attachEvidence(state, proposal);
      run.replayedEventCount += 1;
      continue;
    }
    let summary = '';
    let supersedesId: string | undefined;
    if (proposal.kind === 'capital_call') {
      state.obligations.push({
        id: `obligation:${key}`,
        businessEventId: proposal.businessEventId,
        revision: proposal.revision,
        entityId: proposal.entityId,
        fundId: proposal.fundId,
        amountMinor: proposal.amountMinor,
        currency: proposal.currency,
        dueDate: proposal.dueDate,
        status: 'expected',
        recordedAt: now,
        evidenceCitationIds: unique(proposal.evidenceCitationIds),
        mailboxCopyIds: unique(proposal.mailboxCopyIds),
      });
      summary = `Expected capital call due ${proposal.dueDate}. Notice recorded; no settlement or cash movement created.`;
    } else if (proposal.kind === 'statement_revision') {
      const previous = state.valuationVersions.find(
        (value) =>
          value.businessEventId === proposal.businessEventId &&
          value.revision === proposal.supersedesRevision,
      )!;
      previous.status = 'superseded';
      state.valuationVersions.push({
        id: `valuation:${key}`,
        businessEventId: proposal.businessEventId,
        revision: proposal.revision,
        positionId: proposal.positionId,
        entityId: proposal.entityId,
        valueMinor: proposal.valueMinor,
        currency: proposal.currency,
        valuationDate: proposal.valuationDate,
        recordedAt: now,
        status: 'active',
        supersedesId: previous.id,
        evidenceCitationIds: unique(proposal.evidenceCitationIds),
        mailboxCopyIds: unique(proposal.mailboxCopyIds),
      });
      const priorEvent = state.timeline.find(
        (value) =>
          value.businessEventId === proposal.businessEventId &&
          value.revision === proposal.supersedesRevision,
      );
      if (priorEvent) {
        priorEvent.status = 'superseded';
        supersedesId = priorEvent.id;
      }
      summary = `Source-reported valuation corrected for ${proposal.valuationDate}; revision ${proposal.supersedesRevision} remains in history.`;
    } else {
      summary = `${proposal.summary} Newsletter context only; holdings and cash are unchanged.`;
    }
    const timelineItem: TimelineItem = {
      id: `timeline:${key}`,
      businessEventId: proposal.businessEventId,
      revision: proposal.revision,
      kind: proposal.kind,
      entityId: proposal.entityId,
      title: proposal.title,
      summary,
      effectiveDate: proposal.effectiveDate,
      recordedAt: now,
      status: 'active',
      ...(supersedesId ? { supersedesId } : {}),
      evidenceCitationIds: unique(proposal.evidenceCitationIds),
      mailboxCopyIds: unique(proposal.mailboxCopyIds),
    };
    state.timeline.push(timelineItem);
    state.appliedProposalKeys.push(key);
    state.appliedFingerprints[key] = proposalFingerprint(proposal);
    run.publishedEventCount += 1;
  }
}

/** Completes exactly one simulated stage. The caller controls animation and clock. */
export function advanceDemoRun(
  state: DemoEngineState,
  input: { runId: string; now: string },
): DemoEngineState {
  const existing = state.runs.find((run) => run.id === input.runId);
  if (!existing) throw new Error(`Unknown demo run: ${input.runId}`);
  if (existing.status !== 'running') return state;
  assertRunClock(existing, input.now);
  const next = copy(state);
  const run = next.runs.find((value) => value.id === input.runId)!;
  const stageIndex = run.stages.findIndex(
    (value) => value.id === run.currentStage,
  );
  const stage = run.stages[stageIndex];
  if (stage.id === 'intake') intake(run);
  if (stage.id === 'entity_matching') matchEntities(next, run);
  if (stage.id === 'extraction') extract(run);
  if (stage.id === 'validation') validate(next, run);
  if (stage.id === 'timeline_commit') commit(next, run, input.now);
  const details: Record<StageId, string> = {
    intake: `${run.inputCopyCount} simulated copies → ${run.uniqueEventCount} event revisions.`,
    entity_matching:
      'Fixture identities checked against the known entity, fund, and position registry.',
    extraction:
      'Typed fixture facts loaded; no OCR, LLM, or mailbox service was called.',
    validation: `${run.issues.length} issue(s); dates, evidence, amounts, replay, and correction rules checked.`,
    timeline_commit: `${run.publishedEventCount} event(s) published; ${run.replayedEventCount} already applied; cash unchanged.`,
  };
  stage.status = 'completed';
  stage.completedAt = input.now;
  stage.detail = details[stage.id];
  run.updatedAt = input.now;
  const following = run.stages[stageIndex + 1];
  if (following) {
    following.status = 'running';
    following.startedAt = input.now;
    run.currentStage = following.id;
  } else {
    run.status = 'completed';
    run.completedAt = input.now;
    run.currentStage = null;
  }
  return next;
}

/** Cancellation before commit publishes nothing. Completed runs are never rolled back. */
export function cancelDemoRun(
  state: DemoEngineState,
  input: { runId: string; now: string },
): DemoEngineState {
  const existing = state.runs.find((run) => run.id === input.runId);
  if (!existing) throw new Error(`Unknown demo run: ${input.runId}`);
  if (existing.status !== 'running') return state;
  assertRunClock(existing, input.now);
  const next = copy(state);
  const run = next.runs.find((value) => value.id === input.runId)!;
  run.status = 'cancelled';
  run.updatedAt = input.now;
  run.completedAt = input.now;
  run.currentStage = null;
  for (const stage of run.stages) {
    if (stage.status === 'pending' || stage.status === 'running') {
      stage.status = 'cancelled';
      stage.completedAt = input.now;
      stage.detail = 'Cancelled before publication.';
    }
  }
  return next;
}

export function completeDemoRun(
  state: DemoEngineState,
  input: {
    runId: string;
    now: string;
    proposals: readonly DemoProposal[];
    stepMilliseconds?: number;
  },
): DemoEngineState {
  const start = clock(input.now);
  const step = input.stepMilliseconds ?? 1000;
  if (!Number.isSafeInteger(step) || step < 0)
    throw new Error('Step duration must be a non-negative integer.');
  let next = startDemoRun(state, input);
  for (let index = 0; index < DEMO_STAGES.length; index += 1) {
    next = advanceDemoRun(next, {
      runId: input.runId,
      now: new Date(start + (index + 1) * step).toISOString(),
    });
  }
  return next;
}
