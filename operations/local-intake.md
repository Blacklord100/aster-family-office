# Local folder intake

Connections → Folders reads real EML, PDF and TXT originals from an administrator-approved directory. The browser selects a tenant-relative directory; it cannot submit an arbitrary filesystem path. A separate worker scans sources, retains encrypted original bytes, and creates jobs in the same pinned-engine queue used by uploads and provider mailbox collection.

Configure an absolute `ASTER_INTAKE_ROOT` on the web service and folder worker. For each workspace, provision `<ASTER_INTAKE_ROOT>/<organization UUID>/<directory>`. The organization directory must use the lowercase UUID. For example, a displayed `Demo mails` source is physically inside that workspace's UUID directory. Family/person subdirectories below a connection are scanned recursively. Source files and directories are never changed or deleted by collection.

The root is an operator-managed mount. Tenant directories, nested directories and files cannot be symlinks; files cannot be hard links. Hidden paths, path traversal and control characters are refused. Use a private directory owned by a trusted ingestion operator, with read access for the application user. Files being copied may fail with `FILE_CHANGED`; finish the copy and rescan. Write to a temporary hidden file and atomically rename it into the directory when complete.

## Run locally

After applying migrations 013 and 014, set `ASTER_INTAKE_ROOT` privately in `.env.local`, restart web, and run:

```sh
npm run folder:dev
```

For built services use `npm run folder:worker`. Both commands require the same database and application encryption configuration as the other workers. `FOLDER_ORGANIZATION_IDS` optionally limits routing to a comma-separated list of workspace UUIDs. The worker needs no model network route, email credentials or message-sending permission. Actual extraction still requires the ordinary document worker, processor and selected engine.

## Lifecycle and limits

- An active administrator connects, pauses, resumes, rescans or disconnects a directory. Collection stops if the connecting administrator's membership is revoked or loses administrator privileges.
- Each path/content version has a durable encrypted receipt. Exact duplicate bytes across files/connections share one retained original and extraction job; receipts preserve coverage. Changed bytes produce a new original. A failed run safely resumes from its last committed batch.
- Retry failed documents creates new jobs using the current engine and processing policy. Earlier failed jobs and their engine pins remain intact. Correct invalid/oversized files before rescanning; unchanged invalid bytes do not create repeated receipts.
- Collection and processing counts are separate. Accepted documents are distinct from financially accepted facts; ordinary sources require the existing review workflow. A demo is labeled and gated by a server-provisioned synthetic workspace.
- Limits: 100 connections per workspace, 10,000 filesystem entries per source, 12 nested directory levels, 10 MiB per original, 100,000 version receipts per connection. Each worker batch reads at most 32 files and 100 MiB; the next batch runs after one second. Completed scans repeat after ten seconds. Limits and unsafe paths produce a visible error instead of silently claiming full coverage.
- A 90-second lease fences concurrent workers and recovers after process death. Pause/disconnect change the generation and remove scheduling. Reconnect retains originals and receipts. Stale workers cannot commit after their lease expires.
- Retention can remove only otherwise-eligible unreviewed originals under the existing reviewed policy. Their receipts remain, preventing an unchanged source from being reimported. Review history, accepted facts and workspace-linked sources remain protected.

Paths and receipt metadata use the application encryption envelope and are included in the key rotation inventory and native restore manifest. The intake filesystem contains plaintext originals; protect and back it up according to the operator's source-handling policy. Database encryption does not encrypt a mounted source directory.

## Packaged deployment and demo

Base Compose includes `folder-worker` on the internal database network and a named `intake_data` volume mounted read-only into web and collection. An operator can populate that volume or provide a narrow bind override at `/run/aster-intake`. The web/worker mount must point to the same intake root. The source volume is not mounted into inference containers.

The application image includes only `catalog.json` and the 100 synthetic original emails from the demo corpus; attached PDFs remain inside their original MIME emails. Benchmark expected-answer files are excluded. Demo automation is disabled in the base deployment.

For an explicitly enabled synthetic demonstration, create a private empty host intake directory writable by container UID 1000, set `ASTER_DEMO_INTAKE_DIR` to its absolute path, then run the reviewed override:

```sh
docker compose -f compose.yaml -f compose.demo.yaml up -d web worker folder-worker
```

The override grants write access to that single directory for sandbox provisioning and enables the demo only on web/document-worker. Folder collection retains read-only access. A new demo run creates a separately marked workspace and verified source copies; financial benchmark answers are not loaded. Do not reuse the demonstration directory for confidential mail. Docker packaging is statically reviewed here; validate the actual target host's permissions, restore and network isolation before release.

`OLLAMA_MODEL` must name the actual approved Gemma weights imported into the local Ollama service, for example the operator's `aster-approved:gguf` alias after its artifact/digest is verified. The demo override passes this alias as `ASTER_DEMO_MODEL`; it does not download a model or assume the native workstation's Gemma tag exists in the offline image. Keep the same alias in web and extraction settings.

Fresh demo jobs interleave the three fictional families using only catalog source identity and per-family file order. Real office queues retain normal scheduling. This does not alter the folder scan/cursor or any financial result; cross-family ambiguous duplicates retain normal scheduling.

## Verification

`lib/server/folder-files.test.ts` exercises traversal, symlink/hard-link and file-substitution defenses, byte preservation, malformed formats and size/depth bounds. The opt-in suite creates a separate temporary database, replays migrations, uses the restricted runtime role, and removes only its own database/files:

```sh
ASTER_FOLDER_INTEGRATION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run lib/server/folder.integration.test.ts
```

It checks tenant isolation, trusted demo markers, encrypted configuration, exact originals, durable duplicates/revisions, pinned jobs, lease fencing, reconnect/retry and revoked membership. It makes no model/provider calls. The normal extraction tests and browser demo verify downstream processing separately.
