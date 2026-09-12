# Access, account recovery and maintenance

These controls are implemented in the application. Their presence does not establish that a particular host, mail relay or backup destination is correctly operated. The local validation record separates exercised behavior from deployment gates.

## Runtime database credentials

Production rejects schema/database CREATE rights, ownership of public application objects, elevated role memberships and the SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION flags. Checking flags alone would incorrectly allow the supplied schema-owning migrator. A NOINHERIT role that can switch to an owner is also rejected. The guard runs on initial runtime use; changing database privileges requires a controlled restart and requalification. A restricted role complements the existing transaction-local tenant context and database RLS. The secret adapter refuses mixed `DATABASE_URL` / password-file configuration and conflicting maintenance URLs instead of silently selecting another database.

## Client viewers in a multi-family office

Workspace settings → Family & entity access assigns an existing **viewer** to one or more families and optionally a subset of their legal entities. An empty entity selection means every entity in the selected families. An empty family list is refused. Saving access revokes the member's current sessions. Analysts, administrators and owners have workspace-wide access; promoting a scoped viewer removes their restriction.

The server builds a fresh filtered workspace DTO. Financial register, transaction history and period calculations follow the same scope. Processing queues, mailbox connections, engine settings, operational controls and office-wide knowledge management are unavailable to a scoped viewer. MCP credentials remain administrator-issued, workspace-wide credentials with explicitly selected read-only capabilities; a demoted or revoked issuer's token is refused. Do not give an office MCP token to a client viewer.

Originals have a separate release boundary. An administrator must open the entire original and explicitly identify every family/entity whose information it contains. A scoped viewer receives the original only when **all** declared scopes fit their access. Accepting one extracted fact does not release a mixed-family PDF. Released quotations and source-aware answers follow document grants. Revoking a grant takes effect on later reads; Ask rechecks authorization and all touched source grants after inference. A screenshot or a file already downloaded by an authorized recipient cannot be recalled.

## Optional password-reset delivery

Password reset is disabled until `EMAIL_DELIVERY_ENABLED=true`. It does not disable the authenticator or substitute for MFA recovery codes. The reset flow uses Better Auth's one-time 30-minute token, returns the same public response for unknown accounts, enforces the password policy, revokes existing sessions and refuses token reuse. The email link carries its token in a URL fragment, which the client removes after reading it into memory.

The application queues an encrypted message; it does not contact SMTP. A separate delivery worker sends through an operator-configured authenticated TLS relay. No SMTP relay has been contacted in local validation; the actual auth reset and durable queue were tested with synthetic accounts and no sending worker.

For Docker, add the following private JSON to the `smtp_settings` secret (replace values through your secret manager, never commit them):

```json
{
  "SMTP_HOST": "smtp.example.com",
  "SMTP_PORT": "465",
  "SMTP_USER": "configured-service-account",
  "SMTP_PASSWORD": "retrieve-from-secret-manager",
  "SMTP_FROM": "office@example.com"
}
```

Port 465 uses implicit TLS; port 587 requires STARTTLS. Certificate verification cannot be disabled by this configuration. File and URL attachments, transport debug output and raw provider errors are disabled. The web container does not receive SMTP credentials. Set `EMAIL_DELIVERY_ENABLED=true` in operations configuration, then explicitly start the optional worker:

```sh
docker compose --profile delivery up -d web delivery-worker
```

The worker has database and dedicated delivery egress access, without processor/Ollama network membership. Validate relay credentials, verified sender, deliverability and failure alerts with an authorized test recipient before enabling recovery for a real office. Messages have at most three leased attempts, bounded timeouts, stable Message-IDs and secret-content tombstones after success/expiry. Delivery is at least once across a process crash; SMTP cannot guarantee exactly-once delivery. A final exhausted lease becomes a failed item. Failed messages retain encrypted contents only until token expiry. Invitations continue to use explicitly shared one-time links; creating one does not send mail.

## Encryption keys

`ENCRYPTION_KEY` is the original 32-byte base64 key. Existing envelopes remain readable. Optional `ENCRYPTION_KEYRING` contains named 32-byte base64 keys; `ENCRYPTION_ACTIVE_KEY_ID` selects the key for new envelopes. Named envelopes authenticate both their record context and key identifier. The original key continues to authenticate the audit hash chain; **retain it**, including after all data envelopes use a named key. Better Auth's own authenticator secrets depend on `BETTER_AUTH_SECRET`, which is a separate recovery asset.

Docker reads `encryption_keyring` through a secret file. Existing installations must add a private file containing `{}` before upgrading to the new Compose version. New secret provisioning creates it without replacing an existing secret directory. Give web, document/mailbox/delivery workers and maintenance processes the same retained decryption keyring before selecting a new active identifier.

Rotation is a controlled maintenance operation, not a web endpoint:

1. Preserve a verified encrypted backup, configuration and all old keys in the recovery set. The backup helper produces a checksum/time receipt. Prove restoration separately.
2. Add a fresh named key through the secret manager and distribute the keyring. Never overwrite `ENCRYPTION_KEY`.
3. Run `npm run build:services` and use the schema-owner connection as `ROTATION_DATABASE_URL`, supplied privately. Run `npm run keys:dry-run`. It verifies every application envelope and reports counts by table/key, without plaintext or record IDs.
4. Use the [durable lifecycle](lifecycle.md) to drain and seal the database, then stop web and all workers during the maintenance window. Select the new `ENCRYPTION_ACTIVE_KEY_ID`. Set `ASTER_MAINTENANCE=1` and `ROTATION_BACKUP_RECEIPT` to a passed checksum receipt less than 24 hours old, then run `npm run keys:rotate`.
5. The CLI verifies sealed, drained database state and obtains maintenance/table locks, temporarily disables only named ciphertext immutability triggers inside its transaction, re-encrypts bounded batches, authenticates every stored plaintext round trip, re-enables the triggers and commits atomically. A fault rolls back all changes and trigger state. Runtime credentials are refused. Lock contention fails after 5 seconds rather than waiting indefinitely.
6. Retain the receipt (`ROTATION_REPORT_FILE` can name a new mode-0600 file), repeat the dry-run, test a restored database with the retained keyring, and restart services. Keep old keys for retained backups and the audit chain. A receipt-write failure after commit is reported explicitly; it does not imply that rotation rolled back.

The local suite proves both successful rotation and rollback after corrupted ciphertext in a separate disposable database. The original office key and stored records were not rotated.

## Retention

Operations → Retention previews at most 500 old originals using the saved policy. Retention is disabled by default. A purge requires an enabled policy, a current preview digest and the exact confirmation phrase in the UI. The server locks the workspace, sources and jobs, then repeats eligibility checks before deletion.

Only unreferenced originals with no active/successful/reviewable jobs qualify. Any review version, accepted fact, client release or workspace reference protects the document. Review history, accounting evidence, financial postings and audit entries are preserved. This is an explicit batch purge, not a time-based deletion scheduler or a legal retention-policy determination. It does not remove copies already in backups or downloaded by users. Agree retention periods and backup handling with the office before enabling it.

## Monitoring and release checks

The Operations panel reads tenant-specific job/storage/mailbox counts, processor reachability, document-worker heartbeat and a backup receipt. Missing backup evidence is shown as **unreported**, never healthy by default. The Compose worker health directory is shared read-only with the web container. Backup receipts are mounted read-only from `operations/receipts`. Their checksum/time/replication metadata is readable by the container (mode 0444) in a dedicated traversable directory (normally 0755). The backup helper refuses an existing non-traversable receipt directory instead of widening its permissions. Keep originals, encrypted backup dumps, keys and private configuration in separate private directories.

`npm run monitor` emits only operational counts, service state and alert codes, with optional atomic `MONITOR_STATUS_FILE`. Exit 0 means no configured alerts, exit 2 means attention and exit 1 means the check failed. Run it under an existing scheduler/monitoring service with protected configuration; connect that service's alerts to a named operator. Recovery delivery alerts include failed items, pending messages aged five minutes or more, and expired messages awaiting cleanup. Missing, inconsistent or future-dated queue evidence produces attention status without exposing raw values. No notification is automatically sent by Aster. HTTP reachability and a fresh backup receipt do not prove network isolation or restorability.

`backup.sh DESTINATION AGE_RECIPIENTS_FILE [RECEIPT_FILE]` streams encrypted output, checks its checksum and writes a receipt only after success. Optional `ASTER_BACKUP_REPLICA_DIR` copies the encrypted artifact to a separately operated mounted destination and verifies its checksum. Merely using another directory does not establish off-host storage or independent deletion controls. Restore drills remain mandatory.

The repository's `Verify release` workflow uses read-only GitHub permissions and pinned action commits. It prepares a synthetic PostgreSQL fixture, runs application/processor tests, migrations and opt-in database suites, builds images without application secrets, checks runtime identities/filesystem controls, scans dependencies/images/secrets and retains an SBOM. No publish/deploy step exists. The latest completed [Linux run 34447324893](https://github.com/Blacklord100/aster-family-office/actions/runs/34447324893) passed the application job but remains blocked by the [processor image findings](processor-release-blockers.md). Configure successful release verification as a required branch check; local changes need their own new run. Action pinning follows [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

On the target host, run the full Compose startup/TLS/recovery checks in readiness.md. To collect bounded transport evidence from the local processor network, run the reviewed egress probe there:

```sh
docker compose exec -T processor python - < scripts/verify-egress.py
```

The probe opens TCP connections and makes a content-free public HTTPS request; it never sends a document or asks the metadata service for a resource. A pass covers those destinations only. Review host routes, DNS, proxies, cloud-mode separation, credentials, logs, capacity and firewall policy independently.
