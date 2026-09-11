# Original-document archive

Connections → Archive configures a separate, structured copy of retained source files. The document worker's extraction mode and selected model do not control archiving. Every retained PDF, EML or TXT is eligible, including documents whose extraction is cancelled, failed, irrelevant or still awaiting review. Files rejected before retention by the intake size/type limits are not covered.

## Set up a local destination

1. The deployment operator creates a private archive root, owned by the application service account, and sets `ASTER_ARCHIVE_ROOT` to its absolute path. Keep it separate from `ASTER_INTAKE_ROOT`; overlapping roots are refused to prevent an ingestion loop. The root may be an operator-managed mount; descendants must be real private directories, not symlinks.
2. Start the archive worker with `npm run archive:dev` for native development or the included `archive-worker` Compose service. The web service and worker need the same archive mount. PNG/PDF copies use the authenticated deployment-local processor; no LLM is called.
3. An owner or administrator opens Connections → Archive, enters a destination name and a relative folder such as `Compliance/Originals`, then tests the folder and saves it with automatic archiving enabled. The path belongs to the Aster server, not the browser's downloads folder. Each office receives its own UUID directory beneath the approved root.
4. New retained sources are discovered automatically. Choose **Archive existing originals** to include older retained sources. Historical backfill is bounded and continues across worker cycles; it does not re-run extraction or change financial records.
5. Open an archive record or the archive block in a document record to inspect status, files, checksums and the bundle location. **Verify files** reads the actual files and compares their size and SHA-256 with the encrypted receipt in Aster. File downloads verify the requested artifact before returning it.

The Compose package uses the `archive_data` volume at `/run/aster-archive`. To use an operator-chosen host folder, replace this mount on **both** `web` and `archive-worker` with the same private bind mount. Ensure the service UID/GID (1000:1000 in the supplied image) owns the directory, and qualify the filesystem's rename/fsync behavior. Never mount the Docker socket or grant access to the entire host filesystem for this feature.

## Structure and contents

```text
<approved root>/<office UUID>/<chosen folder>/
  r1/2026/09/<family name and stable key>/<investment name and stable key>/<date--source name--document UUID>/
    original.eml
    attachments/001-manager-report.pdf
    email.txt
    email.html
    email.pdf
    email-page-001.png
    manifest.json
```

Standalone PDF/TXT inputs retain `original.pdf` or `original.txt` plus the manifest. Email attachments receive ordered names so equal original filenames cannot overwrite one another. The manifest retains their original names, types, byte sizes and hashes. Nested EML and otherwise unsupported attachment formats are retained as attachment bytes; they are not executed or recursively rendered.

The year/month is the original's **Aster retention date in UTC**, not an asserted message date or financial reporting period. The message's Date and Message-ID remain source metadata. Family/investment grouping uses unique accepted evidence associations at the first archive claim. Unknown or ambiguous associations remain unassigned. This metadata and its actual freeze time are retained for retries; subsequent reviews do not move or rename original bundles.

Changing a destination folder creates a new archive edition (`r2`, etc.). Earlier bundles and receipts remain accessible. Pausing/resuming or changing only the display name preserves the same edition. Pending work for an obsolete destination cannot publish there; explicit backfill copies retained sources into the current edition. There is no automatic deletion of earlier copies.

## Readable email copies

The PNG/PDF is clearly labelled as a **rendered email copy**, not a screenshot of Gmail/Outlook or independent proof of sender authenticity. It presents decoded headers, body text, attachment names and the original EML hash. The original EML retains the exact imported bytes, including MIME structure and message headers. Header fields such as Date and From are source claims; preserving them does not authenticate them. [Internet Message Format, RFC 5322](https://www.rfc-editor.org/rfc/rfc5322.html)

Rendering never fetches remote images, links, scripts or fonts and never invokes the selected AI engine. It uses a separate bounded local subprocess with a 20-second deadline, at most eight pages and 12 MiB of image/PDF artifacts. Long or unusual content carries visible abbreviation or font warnings; the original remains complete. `email.txt`/`email.html` preserve the accepted canonical text even when the PNG/PDF page budget is reached. The renderer input itself has character and byte ceilings, so extremely long bodies can also be abbreviated with an explicit manifest warning. Unsupported invisible/directional controls are shown as Unicode escapes.

If MIME decoding exceeds its safety limits, the original and manifest are still preserved, with an explicit warning that attachment/snapshot derivatives are unavailable. Renderer failures remain visible, retryable archive failures. A busy processor defers work without consuming its failure budget. Never infer that a green extraction status proves successful archival, or that an archived source has approved financial facts.

## Integrity, access and retention

- Files are written privately (0600) into private directories (0700), staged and flushed before publication. Existing bundles are checked and reused only when they match; conflicting files are never silently repaired or replaced.
- The durable queue rechecks the configuring administrator's access, destination edition and current lease at publication. Changed or expired claims cannot mark themselves complete. A database failure after file publication can recover through an idempotent verification on retry.
- The encrypted database receipt records expected artifact hashes, including the manifest hash. Editing both an external file and its manifest does not make verification pass. The archive is an independent plaintext copy protected by the chosen filesystem and its operator; application encryption does not encrypt these exported files.
- Configuration, copies, downloads and verification create audit events. Office isolation applies to API reads and writes. Scoped viewers receive document status only, with archive paths/receipts withheld. Downloads of archives whose original has been purged are restricted to administrators.
- Removing an original through the existing application retention workflow does **not** delete its external archive. The archive job, frozen metadata and encrypted receipt survive that purge. An external-copy retention/deletion policy must therefore be operated separately. Retain database backups and encryption keys as well as the archive volume.
- A successful verification establishes agreement with the retained receipt at that time. This is not WORM/object-lock storage, legal-hold enforcement, an independent timestamp authority or a jurisdiction-specific compliance certification. Privileged host operators can modify or delete files; later verification detects divergence from intact database receipts.

## Dropbox and other storage providers

The shipped provider is local filesystem storage. A **locally synchronized Dropbox folder** can be configured as the operator-managed root, subject to the same ownership/path checks. Dropbox synchronization, remote availability, sharing and retention are then the operator's responsibility. A successful local write does not establish successful cloud synchronization. No real Dropbox account was connected in this implementation.

`archiveStorageProviders` defines the destination test/write/verify interface. A direct Dropbox or other object-storage adapter must add explicit account authorization, encrypted token lifecycle, office/path binding, durable upload receipts, provider revision/content verification and its own integration tests. Dropbox's provider content hash has its own format; it must not be confused with the raw SHA-256 used in this manifest. [Dropbox file access guide](https://developers.dropbox.com/dbx-file-access-guide)

## Operations and verification

Migration `015-document-archive.sql` creates isolated destination/job/replay tables and bounded worker-routing functions. Archive settings, frozen metadata, results and replay receipts are included in application encryption-key rotation and native encrypted recovery inventories. The archive filesystem itself needs a separate backup/restore procedure. Keep the archive worker heartbeat monitored; a loaded web page does not prove unattended copying is active.

The feature's tests cover byte identity, duplicate names, path/permission/link boundaries, tamper detection, fixed-local rendering, resource limits, office access, idempotent retries, destination changes, pause/revocation during rendering, lease expiry, compiled-worker shutdown and receipt recovery after input purge. Local browser qualification uses synthetic sources and compares financial state before/after. The broader image-security and target-host qualification gates in [readiness](readiness.md) remain separate release requirements.
