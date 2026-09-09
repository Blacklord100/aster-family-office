import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AssetClass, Currency, Holding } from '@/data/types';
import type { Extraction, ExtractedFact } from '../processing-contract';
import { ExtractionSchema } from '../processing-contract';
import type { ReviewDecision } from '../review-contract';
import { canonicalAmount, factAcceptanceIssue } from '../fact-review';
import { convertToEUR, LedgerError } from '../ledger';
import { readWorkspaceInTransaction, saveWorkspace } from '../workspace-store';
import { audit } from './audit';
import { decrypt, sha256 } from './crypto';
import { pool, withTenant } from './db';
import { AccessError, type WorkspaceContext } from './access';
import { DEMO_FX_POLICY, demoActorId, loadDemoCatalog } from './demo-corpus';
import { openFolderConfig } from './folder-store';
import { applyReview, readReview } from './review-store';
import { hasDemoSourceVerification } from './demo-review-policy';
import {
  resolveDemoNewsHoldingInTransaction,
  type DemoNewsRoute,
} from './demo-news-routing';

export const DEMO_IDENTITY_REVIEW_REASON =
  'The exact investment and family identity cannot be resolved from this demo source routing.';
const demoNewsRationale = (route: DemoNewsRoute) =>
  'Automated synthetic-demo review: the unchanged issuer news is linked to its unique same-family parent through accepted constituent disclosure ' +
  route.proposalId +
  ' dated ' +
  route.disclosureAsOfDate +
  '. No direct holding, financial posting or human approval is implied.';

const normalizeName = (name: string) =>
  name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function demoActionableWarnings(result: Pick<Extraction, 'warnings'>) {
  const informational = new Set([
    'Candidate facts only: review against the original before any financial posting.',
    'Confidence is synthetic relevance-classifier probability, not financial correctness or calibrated confidence.',
  ]);
  return result.warnings.filter((warning) => !informational.has(warning));
}
export function demoAssetClass(name: string): AssetClass {
  if (/\b(?:credit|bond)\b/i.test(name)) return 'Fixed income';
  if (/\b(?:venture|ventures)\b/i.test(name)) return 'Venture capital';
  if (/\b(?:property|real estate)\b/i.test(name)) return 'Real estate';
  return 'Private equity';
}
/** Confidence is relevance probability, not financial correctness; never use it as an approval score. */
export function demoFactIssue(
  result: Extraction,
  fact: ExtractedFact,
): string | null {
  if (result.execution !== 'local')
    return 'Demo automatic publication requires local execution.';
  if (
    !result.trace.some(
      (step) =>
        step.stage === 'validate' && ['ok', 'warning'].includes(step.status),
    )
  )
    return 'Independent source validation is missing.';
  if (
    result.warnings.some((warning) =>
      /OCR|image-only|no independently readable|stopped before|other pages may|incomplete coverage|manual source review is required/i.test(
        warning,
      ),
    )
  )
    return 'This source has a reading or coverage exception; a person must review it.';
  if (
    fact.kind !== 'news' &&
    (!fact.effectiveDate || fact.amount === null || !fact.currency)
  )
    return 'The financial notice has missing amount, currency or effective date.';
  if (
    fact.kind !== 'news' &&
    !['EUR', 'USD', 'GBP', 'CHF'].includes(fact.currency ?? '')
  )
    return 'This currency has no supported demonstration valuation or FX policy.';
  if (
    !normalizeName(fact.evidence.quote).includes(
      normalizeName(fact.investmentName),
    )
  )
    return 'The source quote does not identify this investment exactly.';
  const rate =
    fact.currency &&
    DEMO_FX_POLICY.ratesToEUR[
      fact.currency as keyof typeof DEMO_FX_POLICY.ratesToEUR
    ];
  const fx =
    rate && fact.effectiveDate
      ? {
          rateToEUR: rate,
          date: fact.effectiveDate,
          source: DEMO_FX_POLICY.source,
        }
      : undefined;
  return factAcceptanceIssue(fact, fx);
}

/** All competing marks are held. Their order inside a document cannot decide a value. */
export function demoConflictingFacts(facts: ExtractedFact[]) {
  const groups = new Map<string, { values: Set<string>; indices: number[] }>();
  for (const [index, fact] of facts.entries()) {
    if (fact.kind !== 'valuation' || !fact.effectiveDate) continue;
    const key = normalizeName(fact.investmentName) + ':' + fact.effectiveDate;
    const group = groups.get(key) ?? { values: new Set<string>(), indices: [] };
    group.values.add(
      JSON.stringify([
        fact.amount === null ? null : canonicalAmount(fact.amount),
        fact.currency,
      ]),
    );
    group.indices.push(index);
    groups.set(key, group);
  }
  return new Set(
    [...groups.values()]
      .filter((group) => group.values.size > 1)
      .flatMap((group) => group.indices),
  );
}

async function evaluate(c: PoolClient, organizationId: string, jobId: string) {
  const organization = await c.query(
    'SELECT 1 FROM app_organizations WHERE id=$1 AND demo_owner_user_id IS NOT NULL AND demo_source_directory=$2',
    [organizationId, 'Demo mails'],
  );
  if (!organization.rowCount) return;
  const row = (
    await c.query(
      `SELECT j.*,d.filename,d.content_hash,d.payload AS source_payload FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id
     WHERE j.organization_id=$1 AND j.id=$2 AND j.status='awaiting_review' AND j.review_revision=0 AND j.result IS NOT NULL FOR UPDATE OF j`,
      [organizationId, jobId],
    )
  ).rows[0];
  if (!row) return;
  if (
    (
      await c.query(
        "SELECT 1 FROM app_audit WHERE organization_id=$1 AND resource_id=$2 AND action='demo.evaluated' LIMIT 1",
        [organizationId, jobId],
      )
    ).rowCount
  )
    return;
  const ctx: WorkspaceContext = {
    organizationId,
    user: {
      id: demoActorId(organizationId),
      name: 'Aster demo agent',
      email: organizationId + '@demo-agent.example.invalid',
    },
    role: 'analyst',
    sessionId: 'demo-system',
  };
  const receipt = await c.query<{ id: string; config: Buffer }>(
    `SELECT f.id,f.config FROM app_folder_receipts r JOIN app_folder_connections f ON f.id=r.connection_id AND f.organization_id=r.organization_id
     WHERE r.organization_id=$1 AND r.document_id=$2`,
    [organizationId, row.document_id],
  );
  const sourceIsDemo = receipt.rows.some((item) => {
    const config = openFolderConfig(item.config, organizationId, item.id);
    return config.isDemo && config.directory === 'Demo mails';
  });
  const catalog = await loadDemoCatalog();
  const sources = catalog.documents.filter(
    (document) => document.sha256 === row.content_hash,
  );
  if (!sourceIsDemo || !sources.length) {
    await audit(c, organizationId, ctx.user.id, 'demo.evaluated', jobId, {
      published: 0,
      reason:
        'Not a verified synthetic demo original; ordinary review retained',
    });
    return;
  }
  const bytes = decrypt(
    row.source_payload,
    'document:' + organizationId + ':' + row.document_id,
  );
  if (sha256(bytes) !== row.content_hash)
    throw new Error('DEMO_SOURCE_CHANGED');
  const result = ExtractionSchema.parse(
    JSON.parse(
      decrypt(row.result, 'result:' + organizationId + ':' + jobId).toString(),
    ),
  );
  if (
    result.documentId !== row.document_id ||
    result.mode !== row.mode ||
    result.execution !== 'local'
  )
    throw new Error('DEMO_RESULT_MISMATCH');
  await audit(
    c,
    organizationId,
    ctx.user.id,
    'demo.source_verified',
    row.document_id,
    {
      checksum: row.content_hash,
      method: 'Immutable synthetic corpus plus processor evidence validation',
      humanReview: false,
    },
  );
  const { state } = await readWorkspaceInTransaction(c, organizationId, true);
  if (
    !state.demo?.autoPublish ||
    state.demo.runId !== organizationId ||
    !state.portfolio
  )
    throw new Error('DEMO_STATE_MISMATCH');
  const officeIds = new Set(sources.map((source) => source.office_id));
  const office =
    officeIds.size === 1
      ? catalog.offices.find((item) => officeIds.has(item.id))
      : undefined;
  const portfolio = structuredClone(state.portfolio);
  const decisions: ReviewDecision[] = [];
  const newsRoutes: { factIndex: number; route: DemoNewsRoute }[] = [];
  const competing = demoConflictingFacts(result.facts);
  for (const [factIndex, fact] of result.facts.entries()) {
    const declaredName = office?.names.find(
      (name) => normalizeName(name) === normalizeName(fact.investmentName),
    );
    let issue = demoFactIssue(result, fact);
    if (competing.has(factIndex))
      issue =
        'This source contains competing marks for the same investment and date; every competing mark requires review.';
    const newsRoute =
      !issue && office && !declaredName && fact.kind === 'news'
        ? await resolveDemoNewsHoldingInTransaction(
            c,
            ctx,
            fact,
            office.id,
            portfolio.holdings,
            state.intelligence?.proposals ?? [],
            state.riskData,
            catalog,
          )
        : null;
    if (!office || (!declaredName && !newsRoute))
      issue = DEMO_IDENTITY_REVIEW_REASON;
    let holding: Holding | undefined = newsRoute
      ? portfolio.holdings.find((item) => item.id === newsRoute.holdingId)
      : portfolio.holdings.find(
          (item) =>
            item.familyId === office?.id &&
            normalizeName(item.name) === normalizeName(declaredName ?? ''),
        );
    const rate =
      fact.currency &&
      DEMO_FX_POLICY.ratesToEUR[
        fact.currency as keyof typeof DEMO_FX_POLICY.ratesToEUR
      ];
    const fx =
      rate && fact.currency !== 'EUR' && fact.effectiveDate
        ? {
            rateToEUR: rate,
            date: fact.effectiveDate,
            source: DEMO_FX_POLICY.source,
          }
        : undefined;
    if (!issue && !holding && office && declaredName) {
      holding = {
        id: randomUUID(),
        name: declaredName,
        assetClass: demoAssetClass(declaredName),
        familyId: office.id,
        entityId: office.id + '-entity',
        accountId: office.id + '-account',
        currency: (['EUR', 'USD', 'GBP', 'CHF'].includes(fact.currency ?? '')
          ? fact.currency
          : office.currency) as Currency,
        valueEUR: 0,
        costBasisEUR: 0,
        originalValue: 0,
        syntheticFXRateToEUR: 1,
        unfundedCommitmentEUR: 0,
        costBasisStatus: 'unknown',
        unfundedStatus: 'unknown',
        valuationStatus: 'unknown',
        liquidityStatus: 'unknown',
        assetClassStatus: 'inferred',
        liquidityBucket: '3+ years',
        valuationDate: '',
        sourceId: '',
        geography: 'Not reported',
        manager: 'Not reported',
        description:
          'Identified in a processed demo source. Asset class is inferred from the name; entity routing is a demonstration assumption. Liquidity, cost basis and commitments have not been supplied.',
        color:
          portfolio.families.find((family) => family.id === office.id)?.color ??
          '#557b6c',
        valuationMethod: 'Reported fund NAV',
      };
      portfolio.holdings.push(holding);
    }
    if (!issue && holding && fact.kind === 'valuation') {
      const prior = state.finance?.valuations
        .filter(
          (valuation) =>
            valuation.holdingId === holding.id &&
            valuation.effectiveDate === fact.effectiveDate,
        )
        .at(-1);
      if (
        prior &&
        (prior.valueEUR !==
          convertToEUR(
            fact.amount!,
            fact.currency as Currency,
            fx,
            fact.effectiveDate!,
          ) ||
          prior.currency !== fact.currency ||
          Number(prior.amount) !== Number(fact.amount))
      )
        issue =
          'Another source reports a different value for this date. A person must resolve the correction.';
    }
    if (!issue && holding && newsRoute)
      newsRoutes.push({ factIndex, route: newsRoute });
    decisions.push({
      factIndex,
      holdingId: holding?.id ?? null,
      status: issue ? 'deferred' : 'accepted',
      evidenceVerified: !issue,
      rationale:
        issue ??
        (newsRoute
          ? demoNewsRationale(newsRoute)
          : 'Automated synthetic-demo review: exact source and investment identity verified by the local processor. No human approval is implied.'),
      ...(fx ? { fx } : {}),
    });
  }
  await saveWorkspace(c, organizationId, { ...state, portfolio });
  const reviewed = await applyReview(c, ctx, row, result, 0, decisions);
  for (const { factIndex, route } of newsRoutes)
    await audit(c, organizationId, ctx.user.id, 'demo.news_linked', jobId, {
      factIndex,
      ...route,
      extractedSubjectUnchanged: true,
      humanReview: false,
    });
  // Reading warnings stay visible even when independently supported facts were published.
  const actionableWarnings = demoActionableWarnings(result);
  const status = actionableWarnings.length
    ? 'awaiting_review'
    : reviewed.status;
  await c.query(
    'UPDATE app_jobs SET status=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2',
    [organizationId, jobId, status, ctx.user.id],
  );
  await audit(c, organizationId, ctx.user.id, 'demo.evaluated', jobId, {
    published: reviewed.applied,
    duplicates: reviewed.duplicates,
    deferred: decisions.filter((decision) => decision.status === 'deferred')
      .length,
    warnings: actionableWarnings.length,
    humanReview: false,
  });
}

/** Explicit bounded retry. Existing decisions and every extraction byte are retained. */
export async function retryDemoNewsJob(organizationId: string, jobId: string) {
  const none = {
    changed: false,
    applied: 0,
    duplicates: 0,
    revision: null as number | null,
  };
  if (process.env.ASTER_ENABLE_DEMO !== 'true') return none;
  return withTenant(organizationId, async (c) => {
    const ctx: WorkspaceContext = {
      organizationId,
      role: 'analyst',
      sessionId: 'demo-system',
      user: {
        id: demoActorId(organizationId),
        name: 'Aster demo agent',
        email: organizationId + '@demo-agent.example.invalid',
      },
    };
    const row = (
      await c.query(
        `SELECT j.*,d.filename,d.content_hash,d.payload AS source_payload
       FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id
       WHERE j.organization_id=$1 AND j.id=$2 AND j.status='awaiting_review'
        AND j.review_revision>0 AND j.result IS NOT NULL FOR UPDATE OF j`,
        [organizationId, jobId],
      )
    ).rows[0];
    if (!row || !(await hasDemoSourceVerification(c, ctx, row.document_id)))
      return none;
    const catalog = await loadDemoCatalog();
    const sources = catalog.documents.filter(
      (source) => source.sha256 === row.content_hash,
    );
    const familyIds = new Set(sources.map((source) => source.office_id));
    if (familyIds.size !== 1) return none;
    if (
      sha256(
        decrypt(
          row.source_payload,
          'document:' + organizationId + ':' + row.document_id,
        ),
      ) !== row.content_hash
    )
      throw new Error('DEMO_SOURCE_CHANGED');
    const result = ExtractionSchema.parse(
      JSON.parse(
        decrypt(
          row.result,
          'result:' + organizationId + ':' + jobId,
        ).toString(),
      ),
    );
    if (
      result.documentId !== row.document_id ||
      result.mode !== row.mode ||
      result.execution !== 'local'
    )
      throw new Error('DEMO_RESULT_MISMATCH');
    const review = readReview(row, organizationId, result);
    const { state } = await readWorkspaceInTransaction(c, organizationId, true);
    if (
      !state.demo?.autoPublish ||
      state.demo.runId !== organizationId ||
      !state.portfolio
    )
      return none;
    const decisions: ReviewDecision[] = [];
    const routes: { factIndex: number; route: DemoNewsRoute }[] = [];
    for (const record of review.facts) {
      const fact = result.facts[record.factIndex];
      if (
        record.status !== 'deferred' ||
        record.reviewedBy !== ctx.user.id ||
        record.rationale !== DEMO_IDENTITY_REVIEW_REASON ||
        record.amendedFact ||
        record.correction ||
        fact?.kind !== 'news' ||
        demoFactIssue(result, fact)
      )
        continue;
      const route = await resolveDemoNewsHoldingInTransaction(
        c,
        ctx,
        fact,
        [...familyIds][0],
        state.portfolio.holdings,
        state.intelligence?.proposals ?? [],
        state.riskData,
        catalog,
      );
      if (!route) continue;
      decisions.push({
        factIndex: record.factIndex,
        holdingId: route.holdingId,
        status: 'accepted',
        evidenceVerified: true,
        rationale: demoNewsRationale(route),
      });
      routes.push({ factIndex: record.factIndex, route });
      if (decisions.length >= 20) break;
    }
    if (!decisions.length) return none;
    const outcome = await applyReview(
      c,
      ctx,
      row,
      result,
      review.revision,
      decisions,
    );
    await c.query(
      'UPDATE app_jobs SET status=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2',
      [
        organizationId,
        jobId,
        demoActionableWarnings(result).length
          ? 'awaiting_review'
          : outcome.status,
        ctx.user.id,
      ],
    );
    for (const { factIndex, route } of routes)
      await audit(c, organizationId, ctx.user.id, 'demo.news_linked', jobId, {
        factIndex,
        ...route,
        reviewRevision: outcome.review.revision,
        extractedSubjectUnchanged: true,
        humanReview: false,
      });
    await audit(
      c,
      organizationId,
      ctx.user.id,
      'demo.news_routing_retried',
      jobId,
      {
        previousReviewRevision: review.revision,
        reviewRevision: outcome.review.revision,
        accepted: decisions.length,
        extractionUnchanged: true,
        humanReview: false,
      },
    );
    return {
      changed: true,
      applied: outcome.applied,
      duplicates: outcome.duplicates,
      revision: outcome.review.revision,
    };
  });
}

/** Invoked after durable extraction completion and again on idle for crash recovery. */
export async function publishDemoJob(organizationId: string, jobId: string) {
  if (process.env.ASTER_ENABLE_DEMO !== 'true') return;
  try {
    await withTenant(organizationId, (c) => evaluate(c, organizationId, jobId));
  } catch (error) {
    // Never fail or erase a completed extraction because autonomous publication needs help.
    await withTenant(organizationId, async (c) => {
      const deterministic =
        error instanceof AccessError || error instanceof LedgerError;
      await audit(
        c,
        organizationId,
        demoActorId(organizationId),
        deterministic ? 'demo.evaluated' : 'demo.publication_retry',
        jobId,
        {
          published: 0,
          reason: deterministic ? error.code : 'DEMO_PUBLICATION_UNAVAILABLE',
        },
      );
    });
  }
}
export async function publishReadyDemoJobs(scope: string[] | null) {
  if (process.env.ASTER_ENABLE_DEMO !== 'true') return;
  const organizations = await pool.query<{ id: string }>(
    `SELECT id FROM app_organizations WHERE demo_owner_user_id IS NOT NULL ${scope ? 'AND id=ANY($1::uuid[])' : ''} ORDER BY created_at DESC LIMIT 100`,
    scope ? [scope] : [],
  );
  for (const { id } of organizations.rows) {
    const jobs = await withTenant(
      id,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT j.id FROM app_jobs j WHERE j.organization_id=$1 AND j.status='awaiting_review' AND j.review_revision=0 AND j.result IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM app_audit a WHERE a.organization_id=$1 AND a.resource_id=j.id::text AND a.action='demo.evaluated') ORDER BY j.created_at,j.id LIMIT 10`,
            [id],
          )
        ).rows,
    );
    for (const job of jobs) await publishDemoJob(id, job.id);
  }
}
