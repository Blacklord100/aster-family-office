import { runWorkerOperation } from '../lib/server/lifecycle';
import { writeFile } from 'node:fs/promises';
import { pool, assertDatabaseRole } from '../lib/server/db';
import { workerOrganizationScope } from '../lib/server/worker-scope';
import {
  claimFolderConnection,
  syncFolderConnection,
  renewFolderClaim,
  releaseFolderClaim,
  FolderLeaseLost,
} from '../lib/server/folder-sync';

const organizations = workerOrganizationScope(
  process.env.FOLDER_ORGANIZATION_IDS,
);
let stopping = false,
  active: AbortController | undefined,
  wake: (() => void) | undefined;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    active?.abort();
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
async function heartbeat() {
  await writeFile(
    process.env.FOLDER_HEARTBEAT_FILE ?? '/tmp/aster-folder-heartbeat',
    String(Date.now()),
    { mode: 0o600 },
  );
}
async function main() {
  await assertDatabaseRole();
  while (!stopping) {
    const allowed = await runWorkerOperation('folder', iteration);
    if (!allowed) {
      await heartbeat();
      await pause(2000);
    }
  }
  async function iteration(lifecycleSignal: AbortSignal) {
    try {
      const claim = await claimFolderConnection(organizations);
      await heartbeat();
      if (!claim) {
        await pause(2000);
        return;
      }
      const controller = new AbortController();
      active = controller;
      const cancelAdmission = () => controller.abort();
      lifecycleSignal.addEventListener('abort', cancelAdmission, {
        once: true,
      });
      if (lifecycleSignal.aborted) cancelAdmission();
      let renewing = false,
        leaseLost = false;
      const timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void renewFolderClaim(claim)
          .then(async (renewed) => {
            if (!renewed) {
              leaseLost = true;
              controller.abort();
            } else await heartbeat();
          })
          .catch(() => {
            leaseLost = true;
            controller.abort();
          })
          .finally(() => {
            renewing = false;
          });
      }, 10_000);
      try {
        await syncFolderConnection(claim, controller.signal);
      } catch (error) {
        await releaseFolderClaim(
          claim,
          stopping || leaseLost || lifecycleSignal.aborted
            ? new FolderLeaseLost()
            : error,
        );
      } finally {
        clearInterval(timer);
        lifecycleSignal.removeEventListener('abort', cancelAdmission);
        active = undefined;
      }
    } catch {
      console.error(
        'Local intake could not verify its queue; retrying shortly.',
      );
      await pause(10_000);
    }
  }
}
main()
  .catch(() => {
    console.error('Local intake stopped. Check its database configuration.');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
