/** Read-only export of one explicitly marked synthetic history run. No gold/model calls. */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pool, withTenant, isOrganizationId } from '../../lib/server/db';
import { decrypt } from '../../lib/server/crypto';
import { readWorkspaceInTransaction } from '../../lib/workspace-store';
import { ExtractionSchema } from '../../lib/processing-contract';
const [organizationId, output] = process.argv.slice(2);
if (!organizationId || !isOrganizationId(organizationId) || !output)
  throw new Error(
    'Usage: export-results.ts <synthetic-history-organization-uuid> <new-private-output.json>',
  );
const destination = path.resolve(output);
if (destination.startsWith(process.cwd() + path.sep))
  throw new Error(
    'Keep private validation exports outside the application repository.',
  );
try {
  const result = await withTenant(
    organizationId,
    async (c) => {
      const marked = await c.query(
        'SELECT 1 FROM app_organizations WHERE id=$1 AND demo_owner_user_id IS NOT NULL',
        [organizationId],
      );
      if (!marked.rowCount)
        throw new Error(
          'Only an explicitly marked synthetic demo can be exported by this benchmark.',
        );
      const { state, revision } = await readWorkspaceInTransaction(
        c,
        organizationId,
      );
      if (
        state.demo?.dataset !== 'history-v1' ||
        state.demo.runId !== organizationId
      )
        throw new Error(
          'The encrypted workspace is not a pinned history-v1 demo.',
        );
      const { rows } = await c.query(
        'SELECT j.id,j.document_id,j.status,j.mode,j.result,j.error_code,d.content_hash FROM app_jobs j JOIN app_documents d ON d.id=j.document_id AND d.organization_id=j.organization_id WHERE j.organization_id=$1 ORDER BY j.created_at,j.id LIMIT 101',
        [organizationId],
      );
      if (rows.length > 100)
        throw new Error(
          'Unexpected additional jobs in this isolated benchmark run.',
        );
      return {
        organizationId,
        dataset: 'history-v1',
        exportedAt: new Date().toISOString(),
        workspaceRevision: revision,
        goldProvidedToProcessor: false,
        answerKeyBoundary:
          'The production demo loader copies catalog-listed MIME originals only. This exporter never reads the answer key.',
        jobs: rows.map((row) => ({
          id: row.id,
          documentId: row.document_id,
          status: row.status,
          mode: row.mode,
          errorCode: row.error_code,
          contentHash: row.content_hash,
          result: row.result
            ? ExtractionSchema.parse(
                JSON.parse(
                  decrypt(
                    row.result,
                    `result:${organizationId}:${row.id}`,
                  ).toString(),
                ),
              )
            : null,
        })),
        publication: {
          holdings: state.portfolio?.holdings.length ?? 0,
          valuations: state.finance?.valuations.length ?? 0,
          obligations: state.finance?.obligations?.length ?? 0,
          ledgerEvents: state.finance?.events.length ?? 0,
          lifecycleRecords: state.historyLifecycle?.records.length ?? 0,
        },
      };
    },
    { readOnlySnapshot: true },
  );
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      organizationId,
      exportedJobs: result.jobs.length,
      output: destination,
    }),
  );
} finally {
  await pool.end();
}
