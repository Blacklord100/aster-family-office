# Durable update lifecycle

Migration016 adds one installation-wide admission barrier. It does not change financial observations, processing results, or source originals. PostgreSQL persists the mode, active release, writer generation, schema version and operator replay receipts. Its runtime role cannot edit this control state.

All HTTP mutations, mutating GET callbacks, audited source previews/downloads and the document, mailbox, folder, archive, reporting and delivery workers enter a renewable operation before starting work. Queue leases remain independently authoritative. Statement triggers enforce the barrier on every `app_*` and `auth_*` runtime table, including writes inside the security-definer queue claim functions. Tenant transactions acquire the shared barrier before tenant row locks; archive publication holds it through the filesystem commit and database receipt transaction.

| Mode | New intake/mutations | Already admitted work | Core reads |
| --- | --- | --- | --- |
| `open` | Admitted for the active release and generation | Runs with its operation and queue leases | Available |
| `draining` | Returns503 or workers idle | Finishes; leases can renew | Available |
| `maintenance` | Blocked at the database boundary | Sealing requires zero active admissions and queue leases | Available on a schema-compatible application |

Core reads include workspace, portfolio history, ledger, reporting and valid sessions. During maintenance, the reporting monitor GET uses existing saved evaluation and does not enroll or reconcile schedules; workers reconcile after resume. A missing workspace is represented in memory until writes reopen. Session GET never refreshes or deletes a session. Audited original/archive file access, model discovery, search with usage accounting, auth mutations and OAuth callbacks return explicit maintenance503 instead of silently dropping their required writes. Responses use `Cache-Control: private, no-store`, `Retry-After:10` and an `X-Aster-Maintenance` header where relevant.

## Runtime identity

Set the same values on web and all six database workers:

```text
ASTER_RELEASE_ID=release-identifier
ASTER_WRITER_GENERATION=2
ASTER_SCHEMA_MIN=16
ASTER_SCHEMA_MAX=16
```

Release identifiers permit only letters, digits, `.`, `_` and `-`, and start with a letter or digit. Generation is a positive safe integer. The compiled application supports schema16; environment values cannot expand that compatibility range. PostgreSQL connection startup settings pin each process to its release and generation. An old process cannot commit after a different release/generation is activated, even if it retains an old connection or queue claim. This fences stale software; the host, migrator credentials and runtime credentials remain trusted operator assets. It does not fence a failed physical host or implement multi-host PostgreSQL failover.

Existing native installations default to `legacy` generation1 until explicit activation. Migration016 initializes that identity even if a new migrator process already has another release in its environment. A missing lifecycle schema is tolerated only by the native `legacy` runtime, enabling a controlled transition; a named appliance release fails closed. Health reports its actual runtime release and generation plus the database lifecycle state, and remains successful when the compatible candidate is sealed.

## Operator protocol

Build with `npm run build:services`. Run `node dist-ops/lifecycle.js` with the schema-owner `MIGRATION_DATABASE_URL`, supplied through the operator secret wrapper. It writes one JSON object to stdout and returns nonzero on failure. Runtime credentials are refused by database permissions. Do not put passwords in command arguments or logs.

```text
status
drain --expected-generation N --request-id UUID
seal --expected-generation N --request-id UUID
activate --release RELEASE --expected-generation N --request-id UUID
resume --release RELEASE --expected-generation N --request-id UUID
```

`--request-id` is optional for interactive use and should be persisted by automated controllers. Exact retries return the original committed receipt; reusing the ID with different arguments fails. After replay, read `status` to observe any later operator command. `status` has no flags and returns:

```json
{"ok":true,"enabled":true,"mode":"maintenance","generation":2,"activeRelease":"release-identifier","schemaVersion":16,"activeOperations":0,"activeLeases":{"document":0,"mailbox":0,"folder":0,"archive":0,"reporting":0,"delivery":0,"total":0},"canSeal":true,"resumedAt":null,"updatedAt":"2026-09-12T00:00:00.000Z"}
```

The controller drains, polls status, seals, takes/verifies its recovery point, applies compatible migrations, and activates the candidate. Activation increments generation while remaining sealed, so the controller can write the candidate environment before starting it. It then validates read health, local model identity and required services, and explicitly resumes the reserved release/generation. Sealing returns `DRAIN_BUSY` while any unexpired operation or queue lease remains. Counts and expiry checks use database wall-clock time. Locks serialize the migrator and lifecycle commands; they are not held while the controller waits for external work.

**Resume is the point after which new writes may exist.** A successful resume, or an interrupted command that may have committed resume, must be reconciled from database status/events. Do not automatically restore a pre-update database afterward. Recovery of a stopped installation must preserve this journal and decide between resuming the selected release, a separately qualified forward recovery, or a deliberate disaster restore with its stated data-loss boundary. This CLI has no automatic database restore action.

A sealed operation may be abandoned by explicitly resuming the same reserved release/generation when its schema and runtime remain compatible. To select a different release while still sealed, activate it explicitly; this advances the generation again. A drained-but-not-sealed update is first sealed after admitted work finishes, then resumed explicitly. Nothing automatically reopens the barrier after an error.

## Disaster restore sessions

After a disaster database restore and migration, while still sealed and drained, run `node dist-ops/recovery-sessions.js --request-id UUID` with the schema-owner connection. It atomically revokes all restored browser sessions (and their pending OAuth authorization states), records an operator receipt, and emits only `{"ok":true,"revokedSessions":N}`. Persist the request ID: exact retries return the original count without deleting any later sessions again. It refuses an open/draining database or runtime credentials. This command belongs only to explicit disaster recovery; ordinary updates preserve sessions. Activate/start the selected release and require users to sign in again.

## Migrations and adoption

The migrator takes a single installation writer lock and stores SHA-256 for each SQL file. It rejects changed or missing applied files, including using an older migration inventory against a newer database. Each migration and its checksum/schema version commit in the same transaction. A failed SQL file rolls back; rerunning resumes at the next unapplied file. Runtime grants and new-table write guards are applied transactionally before success is reported. Later schema changes require sealed maintenance.

Older installations have migration names without historic checksums. First compare the installed migration source with a trusted retained release. `ASTER_ADOPT_LEGACY_MIGRATIONS=1` explicitly records the current trusted baseline and marks those rows `checksum_adopted=true`; this does not prove the bytes originally executed. No checksum is silently adopted. If the installation predates migration016, stop every legacy writer before this first adoption/migration: it has no durable lifecycle barrier yet. This offline adoption is distinct from an ordinary appliance update.

The native recovery inventory includes all40 current public application/auth/migration tables, including lifecycle state and replay receipts. Restore validation still checks every record and encryption context. Archive files, operator journals, secrets, model files and TLS material are separate recovery assets handled by the appliance recovery controller. Key-rotation apply additionally checks that the database is sealed and fully drained, alongside its existing explicit maintenance flag and verified backup receipt.

## Qualification scope

Disposable PostgreSQL tests exercise concurrent in-flight drain, sealed runtime and security-definer denial, expiry/token isolation, active delivery leases, CLI replay across processes, old-generation fencing, unsupported schemas, changed migration checksums, explicit baseline adoption, SQL rollback, actual authenticated/expired-session reads and a real document-worker drain/resume with a loopback synthetic processor. The complete application/ingestion/auth/archive/recovery suite also runs on a fresh generated database. No live accounts, customer records, mailbox calls, model inference or running services are modified by these tests.

This is an update consistency boundary for one database and its supervised services. Multi-host automatic failover still needs independent host fencing, PostgreSQL replication/backup operations, storage semantics and measured failover qualification; an application generation number alone cannot provide those guarantees.
