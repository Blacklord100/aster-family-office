import { writeFile, rename } from 'node:fs/promises';
import { pool, withTenant, assertDatabaseRole } from '../lib/server/db';
import { operationsStatus } from '../lib/server/operations-store';
import { classifyDeliveryQueue } from '../lib/delivery-monitor';
try {
  await assertDatabaseRole();
  const organizations = (
    await pool.query(
      'SELECT o.id FROM app_organizations o WHERE EXISTS(SELECT 1 FROM app_memberships m WHERE m.organization_id=o.id AND m.revoked_at IS NULL) ORDER BY o.id',
    )
  ).rows;
  const results = [];
  for (const org of organizations) {
    const status = await withTenant(org.id, (c) =>
      operationsStatus(c, {
        organizationId: org.id,
        role: 'owner',
        sessionId: 'monitor',
        user: {
          id: 'operator-monitor',
          name: 'Operator monitor',
          email: 'monitor@example.invalid',
        },
      }),
    );
    results.push({
      organizationId: org.id,
      queue: status.queue,
      storage: status.storage,
      mailboxes: status.mailboxes,
      services: status.services,
      alerts: status.alerts,
    });
  }
  const deliveryEvidence = (
    await pool.query(
      "SELECT count(*) FILTER(WHERE status IN ('pending','sending'))::int AS pending,count(*) FILTER(WHERE status='failed' AND expires_at>now())::int AS failed,count(*) FILTER(WHERE status IN ('pending','sending','failed') AND expires_at<=now())::int AS expired_unprocessed,min(created_at) FILTER(WHERE status IN ('pending','sending')) AS oldest_pending_at,max(created_at) FILTER(WHERE status IN ('pending','sending')) AS latest_pending_at FROM app_delivery_outbox",
    )
  ).rows[0];
  const delivery = classifyDeliveryQueue(deliveryEvidence);
  const report = {
    result:
      results.some((r) => r.alerts.length) || delivery.result === 'attention'
        ? 'attention'
        : 'passed',
    at: new Date().toISOString(),
    delivery,
    workspaces: results,
  };
  const text = JSON.stringify(report, null, 2) + '\n',
    file = process.env.MONITOR_STATUS_FILE;
  if (file) {
    await writeFile(file + '.partial', text, { mode: 0o600 });
    await rename(file + '.partial', file);
  }
  console.log(text);
  if (report.result !== 'passed') process.exitCode = 2;
} catch {
  console.error(
    'Operational monitor failed; credentials and record contents suppressed.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
