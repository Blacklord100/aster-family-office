import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkspaceContext } from './access';
import { AccessError } from './access';
import { deriveWorkspace, type PortfolioRecords } from '../workspace';
import { readWorkspaceInTransaction, saveWorkspace } from '../workspace-store';
import type { Extraction, ExtractedFact } from '../processing-contract';
import { sha256 } from './crypto';
import {
  canonicalAmount,
  factAcceptanceIssue,
  supportedMoney,
  supersededValuationReplay,
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
  selections: { factIndex: number; holdingId: string | null }[],
) {
  const { state } = await readWorkspaceInTransaction(
      c,
      ctx.organizationId,
      true,
    ),
    derived = deriveWorkspace(state);
  const portfolio: PortfolioRecords = structuredClone({
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
    const issue = factAcceptanceIssue(fact);
    if (issue)
      throw new AccessError(
        400,
        fact.kind === 'valuation'
          ? 'VALUATION_INCOMPLETE'
          : 'AMOUNT_REQUIRES_REVIEW',
        issue,
      );
    const sourceId = randomUUID(),
      fingerprint = factFingerprint(fact, holding.id);
    const inserted = await c.query(
      'INSERT INTO app_accepted_facts(fingerprint,organization_id,job_id,source_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING fingerprint',
      [fingerprint, ctx.organizationId, job.id, sourceId],
    );
    if (!inserted.rowCount) {
      if (supersededValuationReplay(fact, holding, portfolio.history))
        throw new AccessError(
          409,
          'CORRECTION_REQUIRES_REVIEW',
          'This earlier accepted value has been superseded for the same date and cannot be restored by replaying it. An explicit correction review is required.',
        );
      continue;
    }
    applied++;
    const now = new Date().toISOString(),
      date = fact.effectiveDate ?? now.slice(0, 10);
    portfolio.evidence.unshift({
      id: sourceId,
      mailboxId: 'upload',
      familyId: holding.familyId,
      holdingId: holding.id,
      subject: fact.investmentName + ' · ' + fact.kind.replaceAll('_', ' '),
      sender: 'Uploaded document',
      receivedAt: now,
      effectiveDate: date,
      filename: job.filename,
      page: fact.evidence.page,
      excerpt: fact.evidence.quote,
      status: 'Accepted',
      synthetic: false,
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
      receivedAt: now,
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
      if (date >= holding.valuationDate) {
        holding.valueEUR = Number(fact.amount);
        holding.originalValue = Number(fact.amount);
        holding.currency = 'EUR';
        holding.syntheticFXRateToEUR = 1;
        holding.valuationDate = date;
        holding.sourceId = sourceId;
        holding.valuationMethod = 'Reported fund NAV';
      }
      // Recorded marks do not imply a complete cash-flow series or an investable return.
      portfolio.history = portfolio.history.filter(
        (h) => !(h.holdingId === holding.id && h.date === date),
      );
      portfolio.history.push({
        holdingId: holding.id,
        date,
        valueEUR: Number(fact.amount),
        netExternalFlowEUR: 0,
        valuationBasis: 'Reported mark',
      });
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
  await saveWorkspace(c, ctx.organizationId, { ...state, portfolio });
  return { applied, duplicates: selections.length - applied };
}
