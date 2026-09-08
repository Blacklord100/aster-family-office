# Production readiness record

This file describes the operations package and the native worker lifecycle checks. Broader application checks are reported separately in the repository README. Generated configuration is not evidence of a secure production deployment.

## Checks completed here

- Read current official Next.js, Docker, Ollama, PostgreSQL, Caddy and OWASP guidance; links are in architecture.md.
- Parsed Compose YAML and inspected the network/port/secret structure. Statically checked Docker input allowlists: app source/runtime assets, processor Python source and synthetic training corpus, and no local inputs for Caddy/Ollama beyond their Dockerfiles. Local environment files, secrets, database contents and model artifacts are excluded.
- Checked all five shell scripts plus PostgreSQL initializer syntax, and Node entrypoint/healthcheck syntax with Node 24.20.0.
- Validated and formatted the Caddyfile with the locally installed Caddy binary; no Caddy server or public certificate issuance was started. Separately, the standalone production app was checked through a local HTTPS proxy with a self-signed certificate. This does not validate the containerized Caddy/TLS configuration.
- Exercised the secret adapter with synthetic inputs: URL password escaping, maintenance URL aliases, conflicting-source refusal and no secret values in errors.
- Exercised temporary secret generation: 32-byte encryption key, private directory permissions, and refusal to overwrite existing key files. Temporary fixtures were removed.
- Exercised fresh and stale worker-heartbeat checks.
- Ran five opt-in native lifecycle tests against local PostgreSQL with the restricted runtime role, compiled worker processes and an authenticated fake processor bound to 127.0.0.1:8012. Passed shutdown requeue without attempt charge, cancellation with HTTP disconnect, stale-result fencing between two workers after lease expiry, terminal failure after three attempts followed by explicit retry, and bounded busy-processor capacity deferral without charging extraction attempts. Durable backoff was checked before advancing only fixture clocks. Disposable records were removed. This does not replace container load and processor sandbox tests.
- Prepared encrypted streaming backup and non-overwriting restore-drill scripts. The current bounded native encrypted SQL recovery drill passed on the isolated development cluster: all 30 tables restored and compared, with application payloads authenticated and decrypted. The six-case mailbox integration suite also passed, including recovery of a synthetic email, mailbox credentials/cursor and an inactive synthetic engine credential. A separate current-snapshot drill authenticated all four recorded Gemma job pins and seven engine revision payloads using their tenant/record-bound encryption contexts. Temporary databases, encrypted snapshots, recovery keys and disposable fixture organizations were removed. Production Docker/pg_dump/age recovery remains untested.
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

The opt-in suite is `lib/server/worker-lifecycle.integration.test.ts`. Use a local migrated disposable PostgreSQL database with `DATABASE_URL` set to its restricted runtime role and `MIGRATION_DATABASE_URL` set to a fixture-cleanup administrator. Provide private `ENCRYPTION_KEY` and `PROCESSOR_TOKEN` values. Pause other workers and uploads first; the suite refuses other queued work, owns port 8012 temporarily, and never calls the real model. Build the current worker, then run:

```sh
npm run build:services
ASTER_WORKER_INTEGRATION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run lib/server/worker-lifecycle.integration.test.ts
```

Restart the normal worker afterward. Ordinary `npm test` skips this opt-in suite.

## Limits

Docker is absent here. Container build, Compose interpolation/merge validation by Docker, Linux permissions, startup, TLS, network egress blocking, PostgreSQL 17 container initialization, processor sandboxing, Ollama imports, backups and recovery remain untested in containers. The separate standalone local HTTPS check used a self-signed certificate; public certificate issuance and container TLS remain unverified. No external destination has been selected or provisioned. This is a reviewable deployment package, not a claim that production is ready.

Cloud provider adapters have not been tested with live credentials. Provider account/model availability, costs, latency, retention controls and extraction accuracy remain unverified; the default stack does not provision cloud egress. Previous immutable lab reports cover their recorded source/runtime versions, not the new selectable-engine adapters.

## Version 0.4 application controls

Implemented controls and their exact local evidence are described in [access-recovery-maintenance.md](access-recovery-maintenance.md) and [VALIDATION-SEVEN-ITEMS.md](../VALIDATION-SEVEN-ITEMS.md). The new release CI is prepared but has not executed on GitHub while the repository remains local. Target-host gates above remain open until exercised against the selected deployment.
