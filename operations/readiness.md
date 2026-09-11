# Production readiness record

This file describes the operations package and the native worker lifecycle checks. Broader application checks are reported separately in the repository README. Generated configuration is not evidence of a secure production deployment.

The September 2026 [live folder demo validation](../VALIDATION-LIVE-DEMO.md) adds native folder/demo/MCP integration, actual local Gemma ingestion, desktop/mobile UI checks and a 34-table encrypted recovery drill. Earlier evidence below records the versions and schemas tested at that time; target-host qualification remains required.

## Family-office pilot priorities — 10–11 September 2026

This audit improves the application candidate; it does not approve an installation for confidential client data. Priorities are ordered by the consequence of a failure, rather than by feature count.

| Priority | Requirement | Current disposition |
| --- | --- | --- |
| P0 | Prevent cross-office access and stale privileged screens | Administrative requests explicitly bind the displayed office, abort on identity/scope changes, and clear retained data on denied access. Workspace responses cannot roll back a newer accepted revision. Restricted direct routes are gated before protected components mount. |
| P0 | Runtime database role must not own or bypass the application | Startup rejects direct/inherited ownership, elevated predefined roles, replication privileges and schema/database creation. Restore targets remain closed until restore and access controls complete. Conflicting direct/file database credentials are refused. |
| P0 | Complete native dependency and deployment qualification | **Open release gate:** see [processor findings](processor-release-blockers.md). Full Compose boot, actual host isolation/TLS, load and encrypted recovery qualification remain required on the selected host. |
| P1 | Ingestion must not duplicate records or commit expired work | Shared import deduplication, orphan-job scheduling, consistent mailbox/queue lock order, membership revalidation and final-commit lease fencing are implemented. Disposable PostgreSQL tests exercise the actual compiled workers and rollback paths. |
| P1 | Financial views must agree about which positions are current | Exposure, stress preview, newly saved stress runs, live report previews and live CSV exports use the same sourced lifecycle selection. Closed and future positions are excluded; unknown dates remain explicit. Older saved reports retain their original cohort. Register cash/commitment summaries are labelled as register metrics. |
| P1 | Preserve source facts and require review where evidence is incomplete | The completed expanded Gemma baseline recovered 93 exact facts out of 111 expected (83.78% recall), with 96 returned facts across receipt scoring (96.875% precision). Three accepted distribution facts omitted source-stated payment dates; they were draft notices, with no settled cash. Source grounding now preserves deadlines and corrected NAVs, handles explicitly owned bank balances and emits acquisition notices as news. Automatic demo acceptance defers deadline-bearing cash facts with missing dates. Model-free regression and model inference are separate checks; a held-out client-representative evaluation remains required. |
| P1 | Every ingested source must remain retrievable for cited answers | The history demo now uses its pinned source catalog. Index rate limiting is retryable capacity pressure, so it does not permanently exhaust a source's attempt budget. |
| P2 | Navigation, mobile and operating workflow coherence | History dates survive Portfolio-to-deal navigation; global search includes retained documents/evidence; cash reconciliation tabs fit mobile screens and ledger amounts show exact cents. Consolidated report schedules identify each position’s family; A4 charts fit the page; source dialogs open at their heading on mobile. The audit covers all main routes, secondary tabs, read-only access, administrative forms and auth entry states. |

Before using a real client mailbox, qualify that provider's OAuth/SMTP account, scopes, refresh/revocation and error behavior with authorized synthetic data. Local fixtures validate the adapters and workflow, not a particular provider account. Agree the pilot's supported products, currencies, accounting boundaries and source cadence before intake; the current long-only ledger and supported currencies do not establish coverage for every structured product or derivative. Keep human financial review and reconciliation in the pilot; source-extraction success is not proof of accounting completeness. SSO/SCIM, independent security assessment, operational ownership and agreed recovery objectives remain priorities for broader rollout.

The local pilot audit additionally passed 769 ordinary application tests, all 72 environment-gated database cases (74 tests in the aggregate run including two ordinary worker-routing cases), and 606 processor tests. The aggregate fixture runs on a new isolated PostgreSQL cluster and is removed afterward. A combined-run failure exposed test cleanup suppressing authentication cascades; cleanup now disables triggers only for its append-only review rows and explicitly verifies that fixture sessions and queues are removed. The recovery drill continues enforcing foreign keys and reports only bounded stage/table/SQLSTATE diagnostics.

Browser qualification covered 16 application routes, 41 secondary tabs, owner/viewer access, auth entry states, denied and delayed responses, mobile layouts, source/PDF review, and print/CSV exports. The financial flow completed five actual synthetic browser writes (notice registration, source amendment, preparation, settlement and reconciliation), verified exact cent balances, idempotent replay, second-settlement rejection and viewer denial. Source records were seeded for that financial-flow test; it does not claim model ingestion or bank execution. A copied production build also passed local HTTPS/MFA-session, CSP, restricted-runtime database access and local PDF-worker checks. The self-signed proxy and existing synthetic session do not qualify public TLS or a new production login installation. Chromium desktop and 390px evidence does not substitute for Safari/Firefox and complete keyboard/screen-reader testing.

The completed local Gemma rerun processed the 12 repaired diagnostic sources in both modes under the same frozen model/source/scorer fingerprints. Each mode recovered all 21 expected six-field grounded facts, with zero missing or unsupported final facts and zero inference/runtime errors. Workflow median latency was 41.4 seconds (27 chat calls total); agentic median was 56.2 seconds (60 calls). Seven sources in each mode still produced an intermediate model proposal that the source validator rejected; those warnings remain preserved. This is a regression set that informed the fixes, not held-out client accuracy, and it is not a new full 100-email production run. The separate model-free sweep recovered 111/111 expected source-grounded facts across the frozen expanded corpus. Neither test automatically approved or published financial records.

The corrected processor and all four workers are active locally with fresh heartbeats. Source-index recovery completed at 97/97 retained originals, up from 60, without changing the financial portfolio, immutable extraction/review results or accepted-fact hashes. The current folder worker also passed an idle graceful shutdown check. Three legacy distribution notices still need source-reviewed deadline amendments; the fixes do not silently rewrite earlier accepted facts.

## Checks completed here

- Read current official Next.js, Docker, Ollama, PostgreSQL, Caddy and OWASP guidance; links are in architecture.md.
- Parsed Compose YAML and inspected the network/port/secret structure. Statically checked Docker input allowlists: app source/runtime assets, processor Python source and synthetic training corpus, and no local inputs for Caddy/Ollama beyond their Dockerfiles. Local environment files, secrets, database contents and model artifacts are excluded.
- Checked all five shell scripts plus PostgreSQL initializer syntax, and Node entrypoint/healthcheck syntax with Node 24.20.0.
- Validated and formatted the Caddyfile with the locally installed Caddy binary; no Caddy server or public certificate issuance was started. Separately, the standalone production app was checked through a local HTTPS proxy with a self-signed certificate. This does not validate the containerized Caddy/TLS configuration.
- Exercised the secret adapter with synthetic inputs: URL password escaping, maintenance URL aliases, conflicting-source refusal and no secret values in errors.
- Exercised temporary secret generation: 32-byte encryption key, private directory permissions, and refusal to overwrite existing key files. Temporary fixtures were removed.
- Exercised fresh and stale worker-heartbeat checks.
- Ran five opt-in native lifecycle tests against local PostgreSQL with the restricted runtime role, compiled worker processes and an authenticated fake processor bound to 127.0.0.1:8012. Passed shutdown requeue without attempt charge, cancellation with HTTP disconnect, stale-result fencing between two workers after lease expiry, terminal failure after three attempts followed by explicit retry, and bounded busy-processor capacity deferral without charging extraction attempts. Durable backoff was checked before advancing only fixture clocks. Disposable records were removed. This does not replace container load and processor sandbox tests.
- Prepared encrypted streaming backup and non-overwriting restore-drill scripts. An earlier bounded native encrypted SQL recovery drill passed on the isolated development cluster: all 30 then-existing tables restored and compared, with application payloads authenticated and decrypted. The six-case mailbox integration suite also passed, including recovery of a synthetic email, mailbox credentials/cursor and an inactive synthetic engine credential. A separate current-snapshot drill authenticated all four recorded Gemma job pins and seven engine revision payloads using their tenant/record-bound encryption contexts. Temporary databases, encrypted snapshots, recovery keys and disposable fixture organizations were removed. Production Docker/pg_dump/age recovery remains untested.
- Added a separate mailbox worker with provider-only internet access in the Compose topology, optional private provider configuration, and no processor network membership. Verified topology and configuration statically; target-host egress remains untested.
- Did not install Docker, deploy externally, or request public TLS certificates. Official qwen3:0.6b and qwen3:1.7b models were explicitly provisioned separately for local evaluation. The deployment stack never automatically downloads or pulls models.
- Engine adapter checks use mock cloud HTTP transports and a loopback fake Ollama service. They cover fixed provider origins, structured output, refusal/redirect handling, secret redaction, tenant-bound encrypted configuration and bounded capacity deferral. A local Gemma probe validated one synthetic structured planner action; real-document accuracy and provider-specific tool support are separate questions. See [engine configuration](engines.md) and the release validation record for current test counts and end-to-end results.

## Required on the target host

- [ ] Build all image stages using the release lockfile and pinned image digests; scan dependencies/images and retain an SBOM.
- [ ] Run `docker compose config --quiet`; boot the complete stack, migrate and bootstrap an empty PostgreSQL 17 volume.
- [ ] Verify effective nonroot UIDs, secret-file readability, postgres volume/socket ownership, read-only filesystem and tmpfs behavior. Check official image changes before upgrading.
- [ ] Verify application readiness, worker heartbeat while idle and under the longest bounded job, graceful stop, durable retry and duplicate-job behavior.
- [ ] Confirm only intended ingress ports are published. No 5432/8000/11434 host bindings; no Docker socket, host network or added privilege.
- [ ] Inspect network membership. Processor and Ollama must have only local-confidential; worker only internal networks.
- [ ] If cloud engines are explicitly enabled, provision and verify the separate cloud processor rather than adding egress to local-confidential. Test the deployment flag, distinct endpoint, HTTPS/authentication, administrator acknowledgement and disabled-cloud rejection. Verify the actual network topology; separate origins alone do not establish isolation.
- [ ] With authorized synthetic data, verify each configured cloud account/model's authentication, structured schema support, refusal/limit behavior, latency, billing limits and retention/region controls. Mock HTTP tests do not establish these. OpenAI `store:false` is not a blanket zero-retention guarantee.
- [ ] Verify engine profile revisions, key rotation/retention, tenant/read-only permissions and new-job/retry pins. Confirm a changed model tag does not get mistaken for an immutable model artifact digest. Verify local Gemma/Qwen OCR/document and bounded-planner behavior on representative inputs.
- [ ] From the processor, verify direct external-IP and hostname HTTP/HTTPS requests fail, cloud metadata endpoints cannot be reached, and controlled host services cannot proxy traffic. Review DNS/host firewall policy and monitor egress. Do not test by sending actual documents to a cloud endpoint.
- [ ] Inspect Ollama startup for cloud-disabled confirmation. Verify the selected model's local provenance/checksum, no cloud model or fallback, and explicit missing-model errors.
- [ ] Exercise classical mode with Ollama stopped: local classification/rules and an explicit warning when model fallback is unavailable; exercise both modes with an approved local model. Verify bounded steps, source evidence, timeout and malformed-output handling.
- [ ] Tune CPU/RAM/pids/upload bounds on representative documents and scanned PDFs. The supplied hardware limits are unbenchmarked.
- [ ] Verify end-to-end TLS, exact canonical origin, Secure/HttpOnly/SameSite cookies, CSRF rejection and spoofed X-Real-IP replacement.
- [ ] Verify initial owner, password policy, login throttling, MFA enrollment/challenge/recovery, logout/revocation, invite expiration and disabled public signup and optional configured password-reset delivery.
- [ ] Test every document/job/report endpoint across two unrelated tenants using aster_runtime, including guessed IDs, source downloads, failed jobs and exports. Never use migrator credentials for isolation tests.
- [ ] Review SQL grants, RLS policies, security-definer functions, queue metadata and audit retention. Confirm append-only audit restrictions remain effective under the actual runtime role.
- [ ] Test encrypted original and extraction storage, ciphertext tamper detection, key backup, controlled re-encryption and restore/decryption on an isolated target.
- [ ] Verify logs/errors/metrics contain no plaintext documents, credentials, session tokens or one-time invite links.
- [ ] Operate the included health/job/mailbox/backup monitor with a named owner; integrate host storage, authentication abuse and certificate-expiry alerts. Verify the real SMTP relay and delivery worker if recovery is enabled.
- [ ] Run the backup and restore drill, measure RPO/RTO, verify independent recovery access, and record the result.
- [ ] Complete an independent threat-model review/security assessment and document accepted residual risks.

## Repeating the native worker checks

The opt-in suite is `lib/server/worker-lifecycle.integration.test.ts`. Integration fixtures now require a positively identified **disposable** PostgreSQL cluster. Do not load `.env.local` or use the live development database for these tests.

For a local fixture, provision an isolated loopback cluster on a random port other than 55439, with a database named `aster_fixture_` followed by 16 lowercase hexadecimal characters. Set `ASTER_DISPOSABLE_INTEGRATION=1`, `DATABASE_URL` to its restricted runtime role, and `MIGRATION_DATABASE_URL` to its fixture administrator. Both URLs must refer to the same fixture, with no query or fragment. Generate fresh test-only `ENCRYPTION_KEY` and `PROCESSOR_TOKEN` values, apply migrations, and set the explicitly required integration flags. Destroy the entire fixture after the run. The guard does not make production credentials safe for testing.

The suite owns port 8012 temporarily and uses an authenticated fake processor; it does not call the live model. Build services first, then run in the isolated fixture environment:

```sh
npm run build:services
ASTER_WORKER_INTEGRATION=1 node node_modules/vitest/vitest.mjs run lib/server/worker-lifecycle.integration.test.ts
```

The [release workflow](../.github/workflows/verify.yml) provisions its own PostgreSQL service with exact synthetic credentials and runs all database integration suites serially. Ordinary `npm test` intentionally skips environment-gated suites; its pass count alone is not evidence that those integrations ran.

## Limits

Docker is absent on the development host. GitHub CI has since built both Linux application images, validated Compose interpolation including the demo override, exercised non-root/read-only controls and network-disabled startup/OCR, and run all 606 processor tests inside the image. It also exercised database integration against a PostgreSQL 17 service. The web image passed its high/critical vulnerability gate; [processor dependency findings](processor-release-blockers.md) still block release. These checks do not exercise the complete Compose installation, its production PostgreSQL initializer, public TLS, effective target-host egress blocking, Ollama imports or production streaming backup/restore. The separate standalone local HTTPS check used a self-signed certificate. No external deployment destination has been selected or provisioned.

Cloud provider adapters have not been tested with live credentials. Provider account/model availability, costs, latency, retention controls and extraction accuracy remain unverified; the default stack does not provision cloud egress. Previous immutable lab reports cover their recorded source/runtime versions, not the new selectable-engine adapters.

## Version 0.4 application controls

Implemented controls and their earlier local evidence are described in [access-recovery-maintenance.md](access-recovery-maintenance.md) and [VALIDATION-SEVEN-ITEMS.md](../VALIDATION-SEVEN-ITEMS.md). The current [live demo validation](../VALIDATION-LIVE-DEMO.md) records the latest native and GitHub CI results. Target-host gates above remain open until exercised against the selected deployment.
