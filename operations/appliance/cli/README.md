# asterctl

`asterctl` is the local host controller for Aster's preview Linux appliance. It
uses The Update Framework for release verification and age for encrypted recovery.
The web application never receives the Docker socket or authority to run it.
An executable that builds and passes unit tests is not yet a qualified appliance;
see the [release and qualification status](../README.md).

## Build and verify

For a source build, use Go 1.27.1 and the committed module checksums. Run these
commands from the repository root:

```sh
cd operations/appliance/cli
go test -race ./...
go vet ./...
go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o asterctl .
```

This produces a Linux amd64 executable. Run it on the target platform and install
the authenticated executable at a stable, root-owned path on `PATH` before using
the operator commands below. To generate recovery keys on another platform, use
an independently authenticated controller built for that machine.

The initial binary and publisher root fingerprint must come through an
independently authenticated channel. A verifier found inside an untrusted bundle
cannot establish its own authenticity. `verify` never makes a network request:

```sh
asterctl verify --bundle /media/aster/release \
  --trust-root /media/trusted/initial-root.json \
  --trust-root-sha256 PUBLISHER_ROOT_SHA256
```

For a download containing `parts.json` and numbered parts, use the independently
trusted controller to unpack it into a new directory:

```sh
asterctl unpack --input /media/download/parts.json --output /media/aster/release \
  --trust-root /media/trusted/initial-root.json \
  --trust-root-sha256 PUBLISHER_ROOT_SHA256 --max-unpack-gib 64
```

Unpacking checks the consumed part hashes, bounds expansion, rejects unsafe archive
entries and verifies current TUF metadata plus every payload file before publishing
the output directory. Existing destinations are refused. Transport hashes alone
do not authenticate a release. The size limit must exceed the expanded release.

The standalone check has no previous installation state. Installation and update
add persistent TUF version/expiry checks, a strictly increasing release sequence,
exact runtime and image checks, payload path/link checks, and another verification
of the copied release before it can run. The staged directory and state writes
are synchronized before the release becomes active.

## First installation

Use a dedicated Ubuntu 24.04 amd64 host with 32 GiB RAM and sufficient free space
for retained releases, imported images/models, intake, archive and recovery. The
controller requires at least 31 GiB visible memory and twice the release size plus
10 GiB free during staging. This is a minimum admission check, not a retention or
performance sizing guarantee. Keep host storage encrypted through customer IT.

Generate the recovery identity on an independently controlled machine. The command
prints only the public recipient. Create its private parent directory first; the
output file must not exist. Keep the private file offline and outside the appliance
and backup destination:

```sh
asterctl recovery-key --output /secure/offline/aster-recovery.txt
```

On the dedicated server, after verifying its release media:

```sh
sudo asterctl install --root /var/lib/aster \
  --bundle /media/aster/release \
  --trust-root /media/trusted/initial-root.json \
  --trust-root-sha256 PUBLISHER_ROOT_SHA256 \
  --hostname aster.office.example --profile offline --tls-mode internal \
  --recovery-recipient CUSTOMER_PUBLIC_AGE_RECIPIENT --install-runtime
```

`--install-runtime` allows installing only the inventoried offline package closure.
APT simulation and installation both forbid downloads and package removal. An
incompatible existing Docker installation is refused, not replaced. The connected
profile keeps inference local; separate mailbox/delivery setup is still required.

For a connected office, choose optional services explicitly on the **initial**
`install` command: add `--profile connected --optional-services mailbox,delivery`
in place of `--profile offline`. Use `mailbox` or `delivery` alone to select only
that service. Omit `--optional-services` to leave both disabled; offline installs
reject it when nonempty. Selecting delivery also enables application email
delivery. It is an authorization to run that worker, not provider credential setup
or a cloud-inference switch.

The choice is stored in `installation.json` and carried through continuation,
update, backup and restore. Existing installations without this field have neither
service enabled. There is no command to change the choice after installation yet;
do not edit the generated `.env` file or installation/journal JSON, and do not rely
on shell `COMPOSE_PROFILES`. Those overrides are deliberately not adopted.

The appliance creates private `data/secrets/mailbox_providers` and
`data/secrets/smtp_settings` files. Populate only the approved fields described in
[mail provider setup](../../mailbox-oauth.md) and
[SMTP setup](../../access-recovery-maintenance.md#optional-password-reset-delivery), preserving their
existing ownership and private modes. These references describe credential
formats; their legacy Compose commands are not appliance lifecycle commands.
Selected workers start automatically and can access configured providers, so
complete provider approval and host egress policy before making credentials live.
For credential changes, use `asterctl stop --root /var/lib/aster` during an agreed
maintenance window, update those private files, then use
`asterctl resume --root /var/lib/aster` to restart the fleet with the new credentials.
This restarts all services; it does not change the recorded optional-service choice.
Do not put credentials in command arguments, public configuration or this repository.

Fresh Gmail/Microsoft authorization uses the mailbox worker's authenticated
internal broker. The web callback consumes its session-bound, one-use OAuth state;
the broker checks the configured origin and client ID, then exchanges the code and
retrieves the identity from fixed provider endpoints. The controller provisions a
dedicated internal token without replacing existing provider or encryption keys.
Only an explicitly selected mailbox service enables this path; disabled or
unavailable brokers fail closed. Keep web egress closed. Synthetic HTTP and
disposable database tests cover the application contract; actual connected
appliance routing and customer OAuth authorization still require target-server
qualification. The broker does not maintain a separate replay cache.

For customer PKI use `--tls-mode supplied --tls-cert /secure/server.crt
--tls-key /secure/server.key`. Supply a matching, current leaf certificate and its
chain. For internal TLS, distribute only the public CA certificate at
`data/caddy/data/caddy/pki/authorities/local/root.crt` through office IT. Never copy
the CA private key to a browser or bypass certificate validation.

Create the first owner with a strong 15–128-character password stored in a mode-0600 file. No
password appears in command arguments or logs, and no default account exists:

```sh
sudo asterctl bootstrap --root /var/lib/aster \
  --email owner@office.example --name 'Office Owner' \
  --organization 'Example Family Office' --password-file /secure/first-owner.txt
```

Sign in over HTTPS and enroll an authenticator. Bootstrap closes after an owner
exists. Remove the temporary first-owner password file through customer controls.
Use owner invitations for further users.

## Operations and interruption

```sh
sudo asterctl status --root /var/lib/aster
sudo asterctl doctor --root /var/lib/aster
```

`doctor` checks the payload, installed runtime versions, pinned model, application
release/generation, and local HTTPS certificate/hostname. It does not replace an
inference accuracy test, archive reconciliation, restore drill or load test.

Every mutation is serialized by a host lock. PostgreSQL provides the durable
drain/seal and generation barrier. A failed operation leaves an inspectable
`journal.json`. After an interruption:

| Operation | Explicit continuation |
| --- | --- |
| Initial installation | `continue-install --root /var/lib/aster` (add `--install-runtime` if the runtime step remains incomplete) |
| Update before completion | `continue-update --root /var/lib/aster` |
| Return to the DB's active, compatible release | `resume --root /var/lib/aster` |
| Restore after its authenticated database import committed | `continue-restore` with the original independently trusted backup digest and publisher root (see below) |
| Restore with an ambiguous database import | `stop --root /var/lib/aster-recovery`, retain that destination, and recover into a different new destination |

Continuation preserves existing keys and database records. A partial PostgreSQL
initialization is not automatically deleted or regenerated. If installation stopped
before supplied TLS files were copied, repeat the original `--tls-mode supplied
--tls-cert /secure/server.crt --tls-key /secure/server.key` options with
`continue-install`; the journal preserves the hostname and other installation settings.
If an update produced
a backup but died before binding its checksum to the journal, continue with
`--output /independent/backups/new-name.age` while still before migration; an
unbound existing receipt is never adopted as proof of the recovery point.
An already staged release is reused only after its signed manifest and every
payload file pass verification again. Changed or incomplete staging is refused.

After writes resume, they may contain new accepted financial data. No error path
automatically restores an older database. Resuming a drain first waits for work to
finish and seals the same generation. A candidate that cannot read the migrated
schema cannot be resumed as a rollback.

## Coordinated backup and recovery

Prepare the independently managed backup directory first, outside the installation
root. Each backup output filename must be new:

```sh
sudo asterctl backup --root /var/lib/aster --timeout 2h \
  --output /independent/backups/aster-20260912.age
```

The encrypted artifact includes a custom-format database export, original archive,
intake, all local model cache assets, the active release media, configuration,
trust state, encryption/authentication secrets, TLS files and receipts. Database
plaintext is never staged on disk. The inventory hashes every archived file.
Backup briefly stops TLS and model services after writes drain so certificate and
model files cannot change during the snapshot; it restarts and verifies them before
reopening writes. Measure the interruption window with realistic archive volume.
A failed operation remains in maintenance until explicitly recovered.

The `.receipt.json` records encrypted artifact SHA-256, size, release and schema.
Copy that digest into an independently trusted backup catalog. age protects
ciphertext integrity and confidentiality, but anyone holding its public recipient
can create a different encrypted file. Do not accept a checksum supplied solely
beside an untrusted replacement backup.

After fencing the original server, restore into a **new** private root:

```sh
sudo asterctl restore --root /var/lib/aster-recovery \
  --input /independent/backups/aster-20260912.age \
  --backup-sha256 TRUSTED_BACKUP_SHA256 \
  --identity /secure/offline/aster-recovery.txt \
  --trust-root /media/trusted/initial-root.json \
  --trust-root-sha256 PUBLISHER_ROOT_SHA256 \
  --source-fenced --install-runtime --max-restore-gib 256 --timeout 2h
```

`--install-runtime` is needed on a fresh server without the exact bundled runtime;
omit it only when those versions are already installed. The original server must
remain fenced even when recovery is performed on another host.
Before starting recovery, isolate the destination's incoming traffic/intake and
outbound provider access. `restore` and `continue-restore` automatically start and
resume the restored fleet after their built-in checks, including optional services
selected on the original connected installation. They do not pause for operator
inspection, and pending local work can run. Keep provider credentials and host
egress fenced until financial/archive checks and duplicate-delivery review pass.

The byte limit also reserves that much free capacity before extraction; choose it
above the known restored size. Existing directories are refused. The outer encrypted
archive, file inventory, original signed release and supplied independent trust are
verified before database restore. The inner database stream must also authenticate
through its end before the journal records `database-restored` and recovery can
proceed to application startup. Recovery validates the already
installed release at its recorded original verification time, so expired update
metadata does not strand a historical backup. This exception cannot be used to
install or update to an expired release. Restored browser sessions and pending
OAuth states are revoked before the new writer generation starts.

If recovery stops after the journal records `database-restored`, it can continue
forward without importing the database again or needing the private recovery key:

```sh
sudo asterctl continue-restore --root /var/lib/aster-recovery \
  --input /independent/backups/aster-20260912.age \
  --backup-sha256 TRUSTED_BACKUP_SHA256 \
  --trust-root /media/trusted/initial-root.json \
  --trust-root-sha256 PUBLISHER_ROOT_SHA256 --timeout 2h
```

The original host must remain fenced throughout. The journal's `restore-database`
phase is deliberately refused: after a crash, transaction completion cannot be
proved there. Stop only that destination's fleet with `asterctl stop --root ...`,
retain its files, and restore into a new root. Continuation after a recorded resume
preserves all subsequent writes and sessions.

Keep the old host fenced, verify records and archive hashes, validate access from a
trusted client, and record actual RPO/RTO. The supplied profile is operated recovery;
it does not implement automatic multi-host failover or point-in-time WAL recovery.

After a successful independent restore drill, install a systemd timer:

```sh
sudo asterctl schedule-backups --root /var/lib/aster \
  --output /independent/backups --calendar '*-*-* 02:00:00'
```

Monitor `aster-backup.service`, missing timer executions, the application receipt,
and the independently managed destination. The timer does not delete old backups
or claim that a copy has been restored. Place the CLI at a stable, root-owned path
before scheduling.

## Updates and publisher keys

```sh
sudo asterctl update --root /var/lib/aster --bundle /media/aster/new-release \
  --output /independent/backups/before-update.age --timeout 2h
```

This verifies/stages, drains/seals, takes and hashes a coordinated backup, stops the
old fleet, migrates, reserves the new generation, starts and checks the candidate,
then explicitly resumes. The journal binds the backup's real bytes before any
migration. Model changes arrive only in an explicitly approved signed inventory.
Existing accepted facts are not automatically re-extracted or overwritten.
Updates refuse a PostgreSQL major-version change; it needs a separately qualified
database upgrade procedure. The controller starts the scoped database before
reading lifecycle state when recovering from a stopped fleet or host restart.

Publisher setup uses `init-trust --keys /offline/new-keys`. The two root keys must
move into independent offline custody; generating them in one directory is not
itself a two-person control. Online release signing needs only `targets.pem`,
`snapshot.pem` and `timestamp.pem`. CI uses ephemeral test keys and cannot produce
a production-trusted release.

```sh
asterctl sign --bundle /build/release --keys /protected/release-keys \
  --sequence 42 --expires 2026-10-12T00:00:00Z
```

Metadata versions must advance across the entire channel, including re-signing an
unchanged release to refresh offline media. Expiry is at most 90 days and is checked
against the host clock. No expiry-disable flag exists for installations or updates.
Keep root metadata current and retain its complete cross-signed chain.

For rotation, initialize a fresh key directory, then run an offline ceremony:

```sh
asterctl rotate-trust --previous-root /old-public/root.json \
  --old-root-keys /custodian-a/root-1.pem,/custodian-b/root-2.pem \
  --keys /offline/new-keys
```

The new root must satisfy both old and new thresholds. The tool carries forward
`roots/` beside the previous public root. Copy the resulting public `roots/` chain
into the release-key directory; `sign` includes it in new media. Existing customers
keep their original trusted fingerprint. Test rotation against a retained installed
cache before publishing it.
