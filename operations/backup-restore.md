# Backup and recovery procedure

PostgreSQL holds the authoritative application state, including encrypted originals and extraction JSON. A database dump provides a consistent database snapshot. It does not preserve the encryption/auth keys or create an operational recovery plan. Custom-format dumps are restored with pg_restore. [PostgreSQL dump backup](https://www.postgresql.org/docs/17/backup-dump.html)

Choose an RPO/RTO with the workspace owner. A possible starting schedule is an encrypted nightly logical backup plus a verified pre-upgrade backup; it is a proposed policy, not a configured scheduler. A lower RPO needs an operated physical backup/WAL archive system. Keep off-host copies with restricted deletion/retention and storage encryption.

## Back up

Install a reviewed age binary on the operations host. Put public recipient keys in a file; keep private decryption identities outside the app host where practical. From operations/:

```sh
bash scripts/backup.sh /secure/aster-backups /secure/backup-recipients.txt
```

The script streams a custom-format pg_dump through age and publishes the final name only if the entire pipeline succeeds. No plaintext dump is written to disk. Verify its exit code, file size and cryptographic checksum in your monitoring. Do not log decrypted data.

Protect ENCRYPTION_KEY, BETTER_AUTH_SECRET, MFA recovery material, configuration and database credentials in a separate encrypted recovery set under an independent access policy. A PostgreSQL dump without the original document key cannot decrypt existing documents. Do not regenerate that key during a routine reinstall. Key rotation requires a versioned re-encryption migration and a tested rollback, not replacing a file.

## Restore drill

Restore only a trusted backup. PostgreSQL warns that a dump can execute source-controlled database code during restore; an unknown dump is not a harmless data file. [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)

Initialize the destination cluster's roles first. Use an isolated recovery host for a real incident; the helper below can also make a new drill database on the development cluster. It refuses the production name and existing target names:

```sh
bash scripts/restore-drill.sh /secure/aster-backups/aster-DATE.dump.age /secure/recovery-identity.txt aster_restore_20260908
```

The helper never drops or switches the production database. An error leaves the new target available for diagnosis. Keep failed targets private because they may contain partial sensitive state.

Before cutover, use a separate application instance with the target database and recovered secrets. Check migration version, account/family counts, representative document hashes and successful decryption, extraction provenance, tenant rejection tests, pending-job state, and that the runtime role has no owner/BYPASSRLS privileges. Verify the requested restore point and measure elapsed recovery time. For incident recovery, revoke restored sessions, expire invitations and review credentials before allowing access. Run only one worker fleet against a target queue.

An administrator must explicitly approve and execute cutover after the checks. Retain the pre-cutover snapshot, prevent the old application from writing, update connections, then verify health/login/MFA/document access. Record the backup age, RPO, RTO, release identifier and approver. Clean up drill databases only after independently identifying them; these scripts contain no automatic deletion.

These backup/restore commands have been syntax-checked only in this workspace. No Docker backup, restore, scheduler, off-site store or disaster-recovery drill has been executed.
