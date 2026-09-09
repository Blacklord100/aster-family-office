import { writeFile } from 'node:fs/promises';
import { pool, assertDatabaseRole } from '../lib/server/db';
import { workerOrganizationScope } from '../lib/server/worker-scope';
import {
  claimReportObligations,
  processReportObligationsClaim,
} from '../lib/server/report-obligations-queue';
import { reconcileReportObligations } from '../lib/server/report-obligations-store';

if (
  process.env.REPORT_OBLIGATIONS_ORGANIZATION_ID &&
  process.env.REPORT_OBLIGATIONS_ORGANIZATION_IDS
)
  throw new Error('Choose one report monitor organization scope setting');
const organizations = workerOrganizationScope(
  process.env.REPORT_OBLIGATIONS_ORGANIZATION_ID ??
    process.env.REPORT_OBLIGATIONS_ORGANIZATION_IDS,
);
const heartbeatFile =
  process.env.REPORT_OBLIGATIONS_HEARTBEAT_FILE ??
  '/tmp/aster-report-obligations-heartbeat';
let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    wake?.();
  });
async function pause(milliseconds: number) {
  if (stopping) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    }
    wake = done;
  });
}
async function main() {
  await assertDatabaseRole();
  while (!stopping) {
    try {
      const claim = await claimReportObligations(organizations);
      // Only successful DB polls refresh health; database outages become visible.
      await writeFile(heartbeatFile, String(Date.now()), { mode: 0o600 });
      if (!claim) {
        await pause(2000);
        continue;
      }
      const outcome = await processReportObligationsClaim(
        claim,
        reconcileReportObligations,
        () => stopping,
      );
      if (outcome === 'failed')
        console.error(
          'Report monitoring deferred after a reconciliation failure.',
        );
      // Evaluation is a bounded database transaction. Shutdown lets it finish;
      // process death leaves a 90-second lease for another worker to recover.
    } catch {
      console.error(
        'Report monitor could not verify its queue; retrying shortly.',
      );
      await pause(10000);
    }
  }
}
main()
  .catch(() => {
    console.error('Report monitor stopped. Check its database configuration.');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
