# Reporting calendar and exception monitor

The calendar and unified exception inbox share a durable monitor. Viewing the
inbox evaluates the current workspace immediately and enrolls that office for
background evaluation. Mutations wake its existing queue entry. Once enrolled,
the monitor continues while every browser is closed; it evaluates an office
approximately every 60 seconds, subject to backlog and bounded database work.

Run reviewed migrations `011-report-obligations.sql` and
`012-report-source-index.sql` with the migration role,
then build services and start `npm run reports:worker`. Native development uses
`npm run reports:dev`, which reads the local private environment. The Compose
package includes `report-obligations-worker` as a default service. It joins only
the internal database network and needs the runtime database credential and
workspace encryption keys. It has no processor, model, mailbox-provider or
SMTP dependency and sends no email.

The queue contains one row per enrolled organization: UUID, due time, lease
UUID/deadline, wake generation and an allowlisted failure code. All report names,
people, evidence and exception notes remain inside the existing tenant-bound
workspace ciphertext. The table has forced tenant RLS. Two restricted definer
functions can claim one due metadata row and finish an exact claim; their fixed
search path excludes caller-controlled schemas and PUBLIC execution is revoked.
The migration owner's cross-tenant policy applies only to this metadata table.
Normal workspace evaluation uses the restricted runtime role and tenant context.
The source lookup uses a tenant/document/time index across every job status,
including accepted and rejected work. One bounded source query selects at most
one current job per document instead of issuing a database round trip per source.
That query checks the aggregate result/review ciphertext size and withholds
payloads above 64 MiB before they reach the worker. An oversized batch stops with
an explicit capacity error; it does not silently mark omitted sources resolved.
[PostgreSQL definer-function guidance](https://www.postgresql.org/docs/current/sql-createfunction.html)
and [row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
inform these boundaries.

Each claim lasts 90 seconds. A fresh random claim UUID prevents an expired worker
from completing a replacement worker's run. A workspace wake increments the
generation without clearing a live lease; completion detects a concurrent wake
and leaves that office immediately due. Duplicate evaluation is idempotent under
the workspace lock. Successful unchanged runs do not append artificial workspace
history. Failed evaluations retain only `RECONCILIATION_FAILED` and retry in 60
seconds; no raw exception message or source text enters routing metadata.

SIGINT/SIGTERM interrupts idle waits immediately. A claimed but unstarted office
is released immediately; an active bounded reconciliation finishes before exit.
Abrupt process loss is recovered after lease expiry. A restored queue can contain
old leases: keep only one intended writer fleet and allow up to 90 seconds for
recovery. The native restore inventory includes this table. Calendar state needs
no additional encryption-rotation manifest because it is already in
`app_workspace.payload`; linked document UUIDs are also preserved by the existing
workspace-reference retention check.

`REPORT_OBLIGATIONS_HEARTBEAT_FILE` defaults to
`/tmp/aster-report-obligations-heartbeat`; Compose uses
`/run/aster-health/report-obligations`. Only successful database polls refresh
the file. The shared health check selects it when
`ASTER_SERVICE=report-obligations` and fails after 180 seconds without progress.
Operational logs contain fixed messages only. Repeated reconciliation errors
require operator investigation; a live heartbeat alone does not prove every
office reconciled successfully.

For a dedicated test or office worker, set
`REPORT_OBLIGATIONS_ORGANIZATION_ID` to one UUID, or
`REPORT_OBLIGATIONS_ORGANIZATION_IDS` to 1–100 comma-separated UUIDs. These
operator routing filters are mutually exclusive and are not authorization
boundaries. An unset filter services any enrolled office, returning only one
claimed organization's routing metadata at a time.

## Validation

The unit suite is `lib/server/report-obligations-queue.test.ts`. The native
PostgreSQL suite is opt-in and requires the reviewed migration plus local
restricted `DATABASE_URL` and fixture-admin `MIGRATION_DATABASE_URL`. It creates
fresh synthetic organization UUIDs, scopes all claims to them, touches no real
document/mailbox queue, and removes only those organizations afterward:

```sh
ASTER_REPORT_OBLIGATIONS_INTEGRATION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run lib/server/report-obligations-queue.integration.test.ts
```

This suite covers forced tenant RLS, concurrent claims, wake preservation, expired
lease fencing/recovery, bounded failure retry, shutdown release, exact routing
and function privileges. Deployment still needs a target-host test of the actual
container, health check, restart, backup restoration and sustained queue volume.
No Linux container qualification is implied by source or native tests.

The native development validation on 9 September 2026 passed nine focused unit
checks and all seven PostgreSQL queue tests with a restricted runtime role.
Migration 012's index was selected by the normal synthetic-document query plan;
a transaction-local diagnostic confirmed the same index remained eligible.
The Compose network/secret topology and missing, fresh and stale heartbeat
behavior were checked locally. These are bounded development checks, not a
measurement of client-scale throughput or a Linux appliance qualification.

The compiled worker also passed an actual process check against a synthetic
office: it expired a short API-created snooze while browsers were closed,
recorded the background change, kept the workspace revision unchanged on a
second evaluation, updated its heartbeat and left a second office untouched.
SIGTERM stopped it cleanly in 17 ms with no stderr or retained lease. That test
used the single-office routing option and made no model or mail calls.
