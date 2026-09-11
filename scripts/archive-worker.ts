import { writeFile } from 'node:fs/promises';
import { pool, assertDatabaseRole } from '../lib/server/db';
import { workerOrganizationScope } from '../lib/server/worker-scope';
import {
  discoverArchives,
  claimArchive,
  processArchive,
  renewArchiveLease,
  failArchive,
  ArchiveLeaseLost,
} from '../lib/server/archive-store';
const organizations = workerOrganizationScope(
  process.env.ARCHIVE_ORGANIZATION_IDS,
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
async function pause(ms: number) {
  if (stopping) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
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
    process.env.ARCHIVE_HEARTBEAT_FILE ?? '/tmp/aster-archive-heartbeat',
    String(Date.now()),
    { mode: 0o600 },
  );
}
async function main() {
  await assertDatabaseRole();
  let after: string | null = null,
    lastDiscovery = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastDiscovery > 5000) {
        const discovered = await discoverArchives(organizations, after);
        after = discovered.after;
        lastDiscovery = Date.now();
      }
      const claim = await claimArchive(organizations);
      await heartbeat();
      if (!claim) {
        await pause(2000);
        continue;
      }
      const controller = new AbortController();
      active = controller;
      let renewing = false,
        lost = false;
      const timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void renewArchiveLease(claim)
          .then(async (ok) => {
            if (!ok) {
              lost = true;
              controller.abort();
            } else await heartbeat();
          })
          .catch(() => {
            lost = true;
            controller.abort();
          })
          .finally(() => {
            renewing = false;
          });
      }, 10_000);
      try {
        await processArchive(claim, controller.signal);
      } catch (error) {
        await failArchive(
          claim,
          stopping || lost ? new ArchiveLeaseLost() : error,
        );
      } finally {
        clearInterval(timer);
        active = undefined;
      }
    } catch {
      console.error(
        'Document archive could not verify its queue; retrying shortly.',
      );
      await pause(10_000);
    }
  }
}
main()
  .catch(() => {
    console.error(
      'Document archive stopped. Check its database configuration.',
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
