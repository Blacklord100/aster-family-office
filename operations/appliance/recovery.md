# Recovery-host profile

This first appliance profile supports an operated recovery host and coordinated
encrypted backups. It does **not** claim automatic high availability, zero data
loss, five-minute RPO or one-hour RTO. Record the office's required loss/outage
targets, then measure them on two independent hosts and storage failure domains.
Two simultaneously writable Compose stacks are not a redundancy solution.

## Recovery set and scheduling

Keep the same signed release/model/runtime media and independently trusted root on
a spare supported host. Store encrypted backups outside the primary installation
and on an independent protected destination. Keep the age recovery identity off
the server and separate from the encrypted backups; the server needs only its
public recipient. Back up the primary's database, original-document archive,
unimported intake, deployment metadata, authentication/encryption keys, private
TLS trust material and the release inventory. A model may be restored from the
verified retained media. Do not count an unverified file copy as a successful
restore, and do not leave keys only inside a failed primary's disk.

Use `asterctl schedule-backups` only after an initial actual `backup` and isolated
`restore` drill. The first implementation drains and seals writers for a
coordinated recovery point. It preserves archive bytes whose encrypted database
source has already been purged. The interruption window and backup throughput must
be measured at realistic retention volume. A failed backup must leave a failed
receipt and actionable maintenance state, never a success timestamp.

The coordinated backup also stops Caddy and Ollama while copying mutable TLS/model
state. HTTPS and inference are briefly unavailable during that interval. Size the
maintenance window from the measured backup duration and test restart before
resuming writes.

The application operations status can show the last receipt; operators must also
monitor missing scheduled executions and independent destination capacity. Protect
backup retention against primary compromise or accidental deletion using offline,
immutable or separately administered copies. Test recovery keys and permissions
on a second host before accepting the office's recovery objectives.

## Manual primary-loss procedure

1. Declare the incident and prevent the old primary from accepting traffic or
   writes. Fence its power/network/storage through the hypervisor or physical
   management plane; removing DNS alone is insufficient. Record who fenced it.
2. Verify the spare host, clock, runtime/platform, trusted publisher root, retained
   release and backup hashes. Place the spare on an isolated network with mail,
   delivery and cloud routes disabled during the recovery drill. Fence external
   credential use and incoming client/intake traffic before starting recovery;
   copied credentials must not reach real providers during validation.
3. Restore with the offline age identity and explicit old-primary-fenced
   acknowledgement. Restore to a new private installation root; never overwrite
   unrelated files or merge independent databases. Keep the recovery journal and
   the original backup intact.
   Supply `--trust-root`, its independently authenticated `--trust-root-sha256`,
   and `--backup-sha256` from the separately trusted backup catalog/receipt.
   Recipient encryption authenticates ciphertext integrity, not who created it;
   never trust a publisher root found only inside an encrypted backup. Recovery
   of a historical release uses its pinned verification receipt and the original
   TUF verification time; ordinary updates still enforce current expiry.
   `restore` and `continue-restore` start the restored fleet and automatically
   resume its writer generation after their built-in checks. They do not pause
   for manual financial inspection. The original connected installation's selected
   mailbox/delivery services are preserved. Pending local work can run after this point;
   keep the destination isolated until the following checks are complete.
4. Verify database decryption, accepted financial history, family/entity access
   boundaries, archive receipt/file hashes (including purged originals), intake and
   pending work, secrets/TLS/model identity and schema/writer generation. Confirm
   restored sessions are revoked according to the controller's recovery policy.
5. Check account/MFA recovery through customer controls. Validate HTTPS from a
   separately trusted client and confirm that only the recovered fleet is writable.
   Permit mail/delivery access only after duplicate-delivery checks and operator
   approval for the real office. Do not issue a second resume merely because this
   checklist has reached this step.
6. Move the service address, measure data loss and elapsed restoration time, and
   retain the restore receipt. Keep the old primary fenced until it is rebuilt
   from the current approved state. Never let an old writer rejoin by changing DNS.

Each drill should include a queued document, a reviewed correction, an archived
email with a PDF attachment, an archived source purged from input retention and a
scoped viewer. Check financial record IDs and exact values, not just row counts or
an HTTP200 response. For inference-node loss, the existing portfolio should remain
readable while jobs wait for the exact approved replacement model.

## PITR and automatic failover are separate qualifications

PostgreSQL WAL/PITR with pgBackRest, replicated archive/intake storage and automatic
primary election are not delivered merely by this Compose profile. If the office
needs a lower RPO than the measured sealed-backup interval, add an operated,
monitored WAL/PITR design and test restore consistency with immutable archive
receipts before making that commitment.

AutomaticHA requires redundant ingress/app instances, a maintained PostgreSQL
failover controller such as Patroni, independent quorum and reliable fencing,
recoverable replicated document/intake storage, and qualified inference capacity.
Test partition, lost quorum, corrupt storage, primary return and archive lag.
Asynchronous replication has a loss window; synchronous acknowledgement changes
write availability. Until the complete profile passes, label the existing option
**manual recovery host**, not automatic failover.

References: [PostgreSQL warm standby](https://www.postgresql.org/docs/17/warm-standby.html),
[pgBackRest PITR](https://pgbackrest.org/user-guide.html#pitr),
[Patroni watchdog/fencing](https://patroni.readthedocs.io/en/latest/watchdog.html).
