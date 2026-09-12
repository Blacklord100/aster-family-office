# Backup and recovery procedure

PostgreSQL holds the authoritative application state, including encrypted originals and extraction JSON. A database dump provides a consistent database snapshot. It does not preserve the encryption/auth keys or create an operational recovery plan. Custom-format dumps are restored with pg_restore. [PostgreSQL dump backup](https://www.postgresql.org/docs/17/backup-dump.html)

Choose an RPO/RTO with the workspace owner. A possible starting schedule is an encrypted nightly logical backup plus a verified pre-upgrade backup; it is a proposed policy, not a configured scheduler. A lower RPO needs an operated physical backup/WAL archive system. Keep off-host copies with restricted deletion/retention and storage encryption.

## Back up

Install a reviewed age binary on the operations host. Put public recipient keys in a file; keep private decryption identities outside the app host where practical. From operations/:

```sh
bash scripts/backup.sh /secure/aster-backups /secure/backup-recipients.txt
```

The script streams a custom-format pg_dump through age and publishes the final name only if the entire pipeline succeeds. It also writes a checksum/time receipt and can verify an encrypted copy to ASTER_BACKUP_REPLICA_DIR. No plaintext dump is written to disk. Verify its exit code, file size and cryptographic checksum in your monitoring. Do not log decrypted data.

Protect ENCRYPTION_KEY, BETTER_AUTH_SECRET, MFA recovery material, configuration and database credentials in a separate encrypted recovery set under an independent access policy. A PostgreSQL dump without the original document key cannot decrypt existing documents. Do not regenerate that key during a routine reinstall. Use the controlled [keyring maintenance procedure](access-recovery-maintenance.md); keep all keys needed by retained backups and the legacy audit chain.

## Restore drill

Restore only a trusted backup. PostgreSQL warns that a dump can execute source-controlled database code during restore; an unknown dump is not a harmless data file. [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)

Initialize the destination cluster's roles first. Use an isolated recovery host for a real incident; the helper below can also make a new drill database on the development cluster. It refuses the production name and existing target names:

```sh
bash scripts/restore-drill.sh /secure/aster-backups/aster-DATE.dump.age /secure/recovery-identity.txt aster_restore_20260908
```

The helper never drops or switches the production database. It creates the new target with `CONNECTION LIMIT 0`, which prevents non-superusers connecting while sensitive authentication/application records are being restored, and revokes PUBLIC database privileges before replay. Only a successful restore followed by the explicit migrator/runtime grants reopens normal connections. An error leaves the new target closed to non-superusers for administrator diagnosis. [PostgreSQL connection limits](https://www.postgresql.org/docs/17/sql-createdatabase.html)

Before cutover, use a separate application instance with the target database and recovered secrets. Check migration version, account/family counts, representative document hashes and successful decryption, extraction provenance, tenant rejection tests, pending-job state, and that the runtime role has no owner/BYPASSRLS privileges. Verify the requested restore point and measure elapsed recovery time. For incident recovery, revoke restored sessions, expire invitations and review credentials before allowing access. Run only one worker fleet against a target queue.

An administrator must explicitly approve and execute cutover after the checks. Retain the pre-cutover snapshot, prevent the old application from writing, update connections, then verify health/login/MFA/document access. Record the backup age, RPO, RTO, release identifier and approver. Clean up drill databases only after independently identifying them; these scripts contain no automatic deletion.

Seven mocked-transport tests verify backup permissions, pipeline failure cleanup, restore access-control ordering, and that failed creation/decryption/restore never reopens or drops a database. These tests do not exercise Docker, pg_dump, age encryption or an actual target-host restore. Production streaming backup, scheduler, off-site storage and disaster recovery remain separate deployment gates.

## Bounded native development drill

After `npm run build:services`, `ASTER_NATIVE_RECOVERY_DRILL=1 node --env-file=.env.local operations/scripts/native-recovery-drill.mjs` runs from the app root against only the isolated local database on 127.0.0.1:55439. It takes a consistent SQL snapshot, encrypts it with AES-256-GCM, reads the encrypted file back, rebuilds a separate temporary database from reviewed migrations, restores all40 current application/auth/migration tables, including durable update lifecycle control and replay receipts, compares every record, and verifies decryption of every application encryption context, including review history, engine revisions, intelligence indexes, folder connections/receipts and operational settings. It removes the temporary database, encrypted snapshot and temporary recovery key afterward. It refuses unknown schemas or databases above 100 MiB.

This drill passed locally, including while a synthetic imported email and encrypted provider credentials/cursor were present. It is an application recovery check, not a streaming production backup utility or a test of the Docker/pg_dump/age procedures above. Run those procedures separately on the chosen target host and measure its recovery objectives.

Integration qualification can instead opt into `ASTER_DISPOSABLE_INTEGRATION=1` with both database URLs pointing to the same generated `aster_fixture_<16 hexadecimal characters>` database on 127.0.0.1, using a port other than 55439. The native recovery opt-in remains required. Mismatched targets, remote hosts, connection-option overrides and attempts to reuse the development port in disposable mode are refused. Temporary recovery databases remain closed to non-superusers throughout this drill and are removed only after their dedicated connection closes.

The backup receipt contains only time/checksum/replication metadata. It is written as mode 0444 for the read-only web mount. Use a dedicated receipt directory with mode 0755; the helper creates a new directory with these permissions but refuses to broaden an existing private one. Backup dumps and key material retain private permissions.
