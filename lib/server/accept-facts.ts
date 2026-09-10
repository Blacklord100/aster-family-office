import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkspaceContext } from './access';
import { AccessError } from './access';
import { deriveWorkspace, type PortfolioRecords } from '../workspace';
import { readWorkspaceInTransaction, saveWorkspace } from '../workspace-store';
import type { Extraction, ExtractedFact } from '../processing-contract';
import { sha256 } from './crypto';
import type { ReviewDecision } from '../review-contract';
import {
  postReviewedValuation,
  postReviewedCashNotice,
  convertToEUR,
} from '../ledger';
import type { Currency } from '@/data/types';
import {
  canonicalAmount,
  factAcceptanceIssue,
  supportedMoney,
} from '../fact-review';
export function factFingerprint(fact: ExtractedFact, holdingId: string | null) {
  return sha256(
    JSON.stringify({
      kind: fact.kind,
      investment: holdingId ?? fact.investmentName.trim().toLowerCase(),
      effectiveDate: fact.effectiveDate,
      amount: fact.amount === null ? null : canonicalAmount(fact.amount),
      currency: fact.currency,
      dueDate: fact.dueDate,
      news: fact.kind === 'news' ? fact.summary.trim() : null,
    }),
  );
}
export async function acceptFacts(
  c: PoolClient,
  ctx: WorkspaceContext,
  job: { id: string; document_id: string; filename: string },
  result: Extraction,
  selections: (Pick<
    ReviewDecision,
    'factIndex' | 'holdingId' | 'fx' | 'correction'
  > & { reviewRevision?: number })[],
) {
  const { state } = await readWorkspaceInTransaction(
      c,
      ctx.organizationId,
      true,
    ),
    derived = deriveWorkspace(state);
  let portfolio: PortfolioRecords = structuredClone({
    holdings: derived.holdings,
    history: derived.history,
    events: derived.events,
    evidence: derived.evidence,
    tasks: derived.tasks,
    families: derived.families,
    entities: derived.entities,
    accounts: derived.accounts,
  });
  let applied = 0;
  let finance = state.finance;
  const sources: Record<number, string> = {};
  const provenance = await c.query(
    'SELECT r.mailbox_id,f.connection_id AS folder_id,d.created_at FROM app_documents d LEFT JOIN app_mailbox_receipts r ON r.document_id=d.id AND r.organization_id=d.organization_id LEFT JOIN app_folder_receipts f ON f.document_id=d.id AND f.organization_id=d.organization_id WHERE d.id=$1 AND d.organization_id=$2 ORDER BY r.created_at,f.created_at LIMIT 1',
    [job.document_id, ctx.organizationId],
  );
  for (const selection of selections) {
    const fact = result.facts[selection.factIndex];
    if (!fact)
      throw new AccessError(400, 'INVALID_FACT', 'Select an extracted fact.');
    const holding = portfolio.holdings.find(
      (h) => h.id === selection.holdingId,
    );
    if (!holding)
      throw new AccessError(
        400,
        'HOLDING_REQUIRED',
        'Link each accepted fact to a holding in this workspace.',
      );
    const issue = factAcceptanceIssue(fact, selection.fx);
    if (issue)
      throw new AccessError(
        400,
        fact.kind === 'valuation'
          ? 'VALUATION_INCOMPLETE'
          : 'AMOUNT_REQUIRES_REVIEW',
        issue,
      );
    const sourceId = randomUUID(),
      baseFingerprint = factFingerprint(fact, holding.id),
      fingerprint = selection.correction
        ? sha256(
            baseFingerprint +
              ':review-correction:' +
              job.id +
              ':' +
              selection.reviewRevision +
              ':' +
              selection.factIndex,
          )
        : baseFingerprint;
    const inserted = await c.query(
      'INSERT INTO app_accepted_facts(fingerprint,organization_id,job_id,source_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING fingerprint',
      [fingerprint, ctx.organizationId, job.id, sourceId],
    );
    if (!inserted.rowCount) {
      // Deduplication is a no-op only when it cannot restore a superseded mark.
      if (fact.kind === 'valuation' && fact.effectiveDate) {
        const prior = portfolio.history.find(
          (row) =>
            row.holdingId === holding.id && row.date === fact.effectiveDate,
        );
        const current =
          prior?.valueEUR ??
          (holding.valuationDate === fact.effectiveDate
            ? holding.valueEUR
            : undefined);
        const intended = convertToEUR(
          canonicalAmount(fact.amount!),
          fact.currency as Currency,
          selection.fx,
          fact.effectiveDate,
        );
        if (current !== undefined && current !== intended)
          throw new AccessError(
            409,
            'CORRECTION_REQUIRES_REVIEW',
            'This accepted value has been superseded. Confirm the current value and provide an explicit correction reason.',
          );
      }
      const existing = await c.query(
        'SELECT source_id FROM app_accepted_facts WHERE organization_id=$1 AND fingerprint=$2',
        [ctx.organizationId, fingerprint],
      );
      if (existing.rows[0])
        sources[selection.factIndex] = existing.rows[0].source_id;
      continue;
    }
    sources[selection.factIndex] = sourceId;
    applied++;
    const now = new Date().toISOString(),
      receivedAt = provenance.rows[0]?.created_at
        ? new Date(provenance.rows[0].created_at).toISOString()
        : now,
      date = fact.effectiveDate ?? receivedAt.slice(0, 10),
      dateBasis = fact.effectiveDate
        ? ('Source reported' as const)
        : ('Receipt date fallback' as const);
    portfolio.evidence.unshift({
      id: sourceId,
      mailboxId:
        provenance.rows[0]?.mailbox_id ??
        (provenance.rows[0]?.folder_id
          ? 'folder:' + provenance.rows[0].folder_id
          : 'upload'),
      familyId: holding.familyId,
      holdingId: holding.id,
      subject: fact.investmentName + ' · ' + fact.kind.replaceAll('_', ' '),
      sender: provenance.rows[0]?.mailbox_id
        ? 'Imported email source'
        : provenance.rows[0]?.folder_id
          ? 'Local folder import'
          : 'Uploaded document',
      receivedAt,
      reportedEffectiveDate: fact.effectiveDate,
      effectiveDateBasis: dateBasis,
      effectiveDate: date,
      filename: job.filename,
      page: fact.evidence.page,
      excerpt: fact.evidence.quote,
      status: 'Accepted',
      synthetic: false,
      ...(state.demo ? { demoSource: true } : {}),
      documentId: job.document_id,
    });
    portfolio.events.unshift({
      id: randomUUID(),
      familyId: holding.familyId,
      holdingIds: [holding.id],
      entityId: holding.entityId,
      type:
        fact.kind === 'valuation'
          ? 'Valuation'
          : fact.kind === 'capital_call'
            ? 'Capital call'
            : fact.kind === 'distribution'
              ? 'Distribution'
              : 'Manager update',
      title: fact.investmentName + ' · ' + fact.kind.replaceAll('_', ' '),
      summary: fact.summary,
      date,
      dateBasis,
      reportedCurrency: fact.currency,
      reportedAmount: fact.amount,
      receivedAt,
      sourceId,
      status: fact.kind === 'valuation' ? 'Accepted' : 'Source reported',
      materiality: fact.kind === 'news' ? 'Medium' : 'High',
      ...(fact.currency === 'EUR' && supportedMoney(fact.amount)
        ? { amountEUR: Number(fact.amount) }
        : {}),
      financialEffect:
        fact.kind === 'valuation' ? 'Accepted valuation' : 'None',
    });
    if (fact.kind === 'valuation') {
      const posted = postReviewedValuation(
        portfolio,
        finance,
        {
          holdingId: holding.id,
          amount: canonicalAmount(fact.amount!),
          currency: fact.currency as Currency,
          effectiveDate: fact.effectiveDate!,
          sourceId,
          fx: selection.fx,
          correction: selection.correction,
        },
        { id: randomUUID(), actorId: ctx.user.id, at: now },
      );
      portfolio = posted.portfolio;
      finance = posted.finance;
      // Use the reviewed conversion on the timeline while the valuation record retains source currency and FX provenance.
      const event = portfolio.events.find((row) => row.sourceId === sourceId);
      if (event) event.amountEUR = posted.valuation.valueEUR;
    }
    if (fact.kind === 'capital_call' || fact.kind === 'distribution') {
      finance = postReviewedCashNotice(
        portfolio,
        finance,
        {
          holdingId: holding.id,
          kind: fact.kind,
          sourceId,
          fingerprint: baseFingerprint,
          documentId: job.document_id,
          jobId: job.id,
          factIndex: selection.factIndex,
          reviewRevision: selection.reviewRevision,
          amount: fact.amount === null ? null : canonicalAmount(fact.amount),
          currency: fact.currency,
          effectiveDate: fact.effectiveDate,
          dueDate: fact.dueDate,
          importedAt: provenance.rows[0]?.created_at ? receivedAt : null,
          summary: fact.summary,
          origin: 'accepted_fact',
        },
        { id: randomUUID(), actorId: ctx.user.id, at: now },
      ).finance;
    }
    if (fact.kind === 'capital_call')
      portfolio.tasks.unshift({
        id: randomUUID(),
        title: 'Review capital call · ' + holding.name,
        description:
          fact.summary + ' Notice recorded; no payment or cash balance change.',
        familyId: holding.familyId,
        holdingId: holding.id,
        sourceId,
        assignee: ctx.user.name,
        dueDate: fact.dueDate ?? date,
        priority: 'High',
        status: 'To do',
        category: 'Capital call',
      });
  }
  await saveWorkspace(c, ctx.organizationId, { ...state, portfolio, finance });
  return { applied, duplicates: selections.length - applied, sources };
}
