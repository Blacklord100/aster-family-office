import { runWorkerOperation } from '../lib/server/lifecycle';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pool, assertDatabaseRole } from '../lib/server/db';
import { startMailboxBroker } from '../lib/server/mailbox-broker';
import {
  claimMailbox,
  syncMailboxPage,
  releaseMailboxClaim,
  MailboxLeaseLost,
} from '../lib/server/mailbox-sync';
const workerId = randomUUID();
let stopping = false,
  active: AbortController | undefined;
let broker: Awaited<ReturnType<typeof startMailboxBroker>>;
let closingBroker: Promise<void> | undefined;
function closeBroker() {
  closingBroker ??= broker?.close();
  // Signal handlers start cleanup before the polling loop exits. The final
  // await below reports cleanup errors without an interim unhandled rejection.
  void closingBroker?.catch(() => undefined);
  return closingBroker;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopping = true;
    active?.abort();
    void closeBroker();
  });
async function heartbeat() {
  if (process.env.MAILBOX_HEARTBEAT_FILE)
    await writeFile(process.env.MAILBOX_HEARTBEAT_FILE, String(Date.now()), {
      mode: 0o600,
    });
}
async function main() {
  await assertDatabaseRole();
  broker = await startMailboxBroker((run) =>
    runWorkerOperation('mailbox', run),
  );
  if (stopping) void closeBroker();
  while (!stopping) {
    const allowed = await runWorkerOperation('mailbox', iteration);
    if (!allowed) {
      await heartbeat();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  async function iteration(lifecycleSignal: AbortSignal) {
    await heartbeat();
    const claim = await claimMailbox(workerId);
    if (!claim) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    }
    active = new AbortController();
    const controller = active;
    const cancelAdmission = () => controller.abort();
    lifecycleSignal.addEventListener('abort', cancelAdmission, { once: true });
    if (lifecycleSignal.aborted) cancelAdmission();
    let leaseLost = false,
      renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void pool
        .query(
          "UPDATE app_mailbox_queue SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() RETURNING id",
          [claim.id, claim.organization_id, workerId],
        )
        .then(async (result) => {
          if (!result.rowCount) {
            leaseLost = true;
            controller.abort();
          }
          await heartbeat();
        })
        .catch(() => {
          leaseLost = true;
          controller.abort();
        })
        .finally(() => {
          renewing = false;
        });
    }, 10000);
    try {
      await syncMailboxPage(claim, controller.signal);
    } catch (error) {
      await releaseMailboxClaim(
        claim,
        stopping || leaseLost || lifecycleSignal.aborted
          ? new MailboxLeaseLost()
          : error,
      );
    } finally {
      clearInterval(timer);
      lifecycleSignal.removeEventListener('abort', cancelAdmission);
      active = undefined;
    }
  }
}
main()
  .finally(async () => {
    try {
      await closeBroker();
    } finally {
      await pool.end();
    }
  })
  .catch(() => {
    console.error(
      'Mailbox worker stopped. Check database and provider configuration.',
    );
    process.exitCode = 1;
  });
