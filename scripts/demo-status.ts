import { pool, withTenant, isOrganizationId } from '../lib/server/db';
import { decrypt } from '../lib/server/crypto';
import { readWorkspaceInTransaction } from '../lib/workspace-store';
import { ExtractionSchema } from '../lib/processing-contract';
import { demoActionableWarnings } from '../lib/server/demo-publish';

const organizationId = process.argv[2];
if (!organizationId || !isOrganizationId(organizationId))
  throw new Error('Usage: demo-status <demo-organization-uuid>');
try {
  const marked = await pool.query(
    'SELECT 1 FROM app_organizations WHERE id=$1 AND demo_owner_user_id IS NOT NULL',
    [organizationId],
  );
  if (!marked.rowCount)
    throw new Error(
      'This command reports only explicitly marked synthetic demo workspaces.',
    );
  const report = await withTenant(organizationId, async (c) => {
    const jobs = (
      await c.query(
        'SELECT j.id,j.document_id,j.status,j.mode,j.error_code,j.result,j.review_state,j.created_at,j.updated_at,d.filename FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id WHERE j.organization_id=$1 ORDER BY j.created_at,j.id',
        [organizationId],
      )
    ).rows;
    const counts: Record<string, number> = {};
    const models: Record<string, number> = {};
    let extractedFacts = 0,
      modelCalls = 0,
      completed = 0,
      actionableWarnings = 0,
      acceptedFacts = 0,
      deferredFacts = 0;
    for (const job of jobs) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
      if (job.result) {
        const result = ExtractionSchema.parse(
          JSON.parse(
            decrypt(
              job.result,
              'result:' + organizationId + ':' + job.id,
            ).toString(),
          ),
        );
        completed++;
        extractedFacts += result.facts.length;
        actionableWarnings += demoActionableWarnings(result).length;
        models[result.model ?? 'No model'] =
          (models[result.model ?? 'No model'] ?? 0) + 1;
        modelCalls += Number(
          result.trace
            .find((step) => step.stage === 'model_usage')
            ?.detail.match(/^\d+/)?.[0] ?? 0,
        );
      }
      if (job.review_state) {
        const review = JSON.parse(
          decrypt(
            job.review_state,
            'review:' + organizationId + ':' + job.id,
          ).toString(),
        ) as { facts: { status: string }[] };
        acceptedFacts += review.facts.filter(
          (fact) => fact.status === 'accepted',
        ).length;
        deferredFacts += review.facts.filter(
          (fact) => fact.status === 'deferred',
        ).length;
      }
    }
    const { state } = await readWorkspaceInTransaction(c, organizationId);
    const receipts = (
      await c.query(
        'SELECT outcome,count(*)::int FROM app_folder_receipts WHERE organization_id=$1 GROUP BY outcome',
        [organizationId],
      )
    ).rows;
    const indexed = (
      await c.query(
        'SELECT count(*)::int FROM app_intelligence_documents WHERE organization_id=$1',
        [organizationId],
      )
    ).rows[0].count;
    const p = state.portfolio!;
    return {
      organizationId,
      name: state.officeName,
      at: new Date().toISOString(),
      sourceReceipts: receipts,
      uniqueDocuments: new Set(jobs.map((job) => job.document_id)).size,
      processingJobs: jobs.length,
      counts,
      extraction: {
        completed,
        extractedFacts,
        models,
        modelCalls,
        actionableWarnings,
      },
      publication: {
        acceptedFacts,
        deferredFacts,
        holdings: p.holdings.length,
        valuedHoldings: p.holdings.filter(
          (h) => h.valuationStatus === 'reported',
        ).length,
        sourceCitations: p.evidence.length,
        timelineEvents: p.events.length,
        tasks: p.tasks.length,
        ledgerValuations: state.finance?.valuations.length ?? 0,
        settledCashEvents: state.finance?.events.length ?? 0,
      },
      families: p.families.map((family) => ({
        name: family.name,
        holdings: p.holdings.filter((h) => h.familyId === family.id).length,
      })),
      intelligence: {
        indexed,
        proposals: state.intelligence?.proposals.length ?? 0,
        acceptedConstituents:
          state.intelligence?.proposals.filter(
            (proposal) => proposal.status === 'accepted',
          ).length ?? 0,
        exposureLinks: state.riskData?.links.length ?? 0,
      },
      active: jobs
        .filter((job) => job.status === 'processing')
        .map((job) => ({ filename: job.filename, updatedAt: job.updated_at })),
      failures: jobs
        .filter((job) => job.status === 'failed')
        .map((job) => ({ filename: job.filename, error: job.error_code })),
    };
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pool.end();
}
