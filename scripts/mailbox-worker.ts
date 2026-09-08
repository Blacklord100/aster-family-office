import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pool, assertDatabaseRole } from '../lib/server/db';
import {
  claimMailbox,
  syncMailboxPage,
  releaseMailboxClaim,
  MailboxLeaseLost,
} from '../lib/server/mailbox-sync';
const workerId = randomUUID();
let stopping = false,
  active: AbortController | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    stopping = true;
    active?.abort();
  });
async function heartbeat() {
  if (process.env.MAILBOX_HEARTBEAT_FILE)
    await writeFile(process.env.MAILBOX_HEARTBEAT_FILE, String(Date.now()), {
      mode: 0o600,
    });
}
async function main() {
  await assertDatabaseRole();
  while (!stopping) {
    await heartbeat();
    const claim = await claimMailbox(workerId);
    if (!claim) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    active = new AbortController();
    const controller = active;
    let leaseLost = false,
      renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void pool
        .query(
          "UPDATE app_mailbox_queue SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND organization_id=$2 AND lease_owner=$3 AND lease_until>now() RETURNING id",
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
        stopping || leaseLost ? new MailboxLeaseLost() : error,
      );
    } finally {
      clearInterval(timer);
      active = undefined;
    }
  }
}
main()
  .catch(() => {
    console.error(
      'Mailbox worker stopped. Check database and provider configuration.',
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
