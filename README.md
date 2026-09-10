# Aster

A portable family-office workspace with a Linear/Notion-inspired interface, PostgreSQL, invitation-only authentication, mandatory production MFA, and two document-processing modes with independently selected engines. Local execution is the deployment default. This application no longer depends on ChatGPT Sites, Cloudflare D1 or Vinext.

## Current release: 0.4

The [live folder demonstration](operations/live-demo.md) starts with an empty workspace and processes 100 synthetic emails, including 57 PDF attachments, for three fictional families. Gemma4 is the local default. Source-backed facts populate holdings, reported marks, timelines, tasks and cited look-through relationships; unsupported values remain unknown. Connections includes a durable folder collector and the [installable Aster MCP plugin](plugins/aster-local/README.md). See [the live demo validation record](VALIDATION-LIVE-DEMO.md) for the current application, browser, inference and recovery checks.

The reporting calendar and unified exception inbox add versioned expectations, source-backed receipt matching, separate delivery/review status, assigned exceptions, snooze and disposition history, and an unattended local monitor. See [reporting operations](operations/report-obligations.md) and [their validation record](VALIDATION-REPORT-OBLIGATIONS.md).

The seven-item expansion adds a sourced investment register and transaction ledger, per-fact review history, document/manager intelligence, custom-period reconciliation and liquidity reporting, immutable stress-run inputs/results, real selected-engine document answers, a new synthetic model benchmark and operational access/recovery/retention controls. See [access and maintenance](operations/access-recovery-maintenance.md), [intelligence](operations/intelligence.md), and [the release validation record](VALIDATION-SEVEN-ITEMS.md). Earlier validation files remain historical evidence of their recorded versions.

The [100-email mailroom demonstration](benchmark/mailroom-v1/README.md) supplies three fictional offices, nine inboxes, messy originals and a reproducible four-configuration local-model comparison. See [the collection harness](benchmark/mailroom-v1/HARNESS.md) for execution and preserved scoring, and [the offline LP packaging plan](operations/offline-lp-packaging.md) for the proposed disconnected appliance. The offline appliance is a delivery plan, not a deployed or certified installation.

The preserved [original baseline](benchmark/mailroom-v1/RESULTS.md) records all 388 processing outcomes before the extraction fixes: each configuration recovered 60/90 expected facts. The earlier [live Gemma folder run](VALIDATION-LIVE-DEMO.md) recovered 90/90 exact grounded facts on that corpus, accepted 72 and deferred 18 for review. The expanded history corpus subsequently exposed missed corrections, payment deadlines, bank facts and acquisition news; the [readiness record](operations/readiness.md) tracks those findings and their fixes. Synthetic combined rules/model results are not an independent estimate of client-document accuracy.

## What is implemented

- Organization membership and owner/admin/analyst/viewer permissions, enforced at APIs; PostgreSQL row-level security for workspace, documents, jobs, facts and audit records.
- Better Auth email/password sign-in, TOTP enrollment and per-session verification, single-use recovery codes, eight-hour sessions, session revocation and hashed one-time invitations. Public signup is closed.
- AES-256-GCM encryption for original files, extraction results and workspace payloads, bound to the organization and record. Restricted runtime database credentials are separate from migration credentials.
- Multiple independently authorized Google/Microsoft accounts, encrypted OAuth credentials, PKCE, durable history/delta cursors, pause/disconnect and a separate collection worker.
- Scoped, expiring read-only MCP tokens for portfolios, original documents and connection status.
- PDF/TXT/EML import with visible HTML email decoding, supported attachments and bounded local OCR; retained originals, content deduplication, durable PostgreSQL job leases, bounded retries, cancellation and processor deadlines.
- **Classical workflow:** fitted TF-IDF/logistic relevance classification, deterministic extraction and optional selected-model extraction for unresolved relevant fields.
- **Agentic:** bounded selected-model planning and document-reading actions. No arbitrary commands or unrestricted tool execution.
- Tenant-isolated encrypted engine profiles for installed local Ollama models or explicitly enabled OpenAI Responses/Anthropic Messages providers. Profile revisions and queued job configurations are pinned independently from workflow mode; provider secrets never appear in profile DTOs.
- Shared source validation for dates, amounts, investment/event roles, corrections and repeated facts; a versioned output schema, quoted evidence, reviewer-to-holding matching, accepted-event timeline, valuation updates and capital-call tasks. Switching modes changes new jobs; accepted records are retained.
- Holdings, allocation views, recorded marks, liquidity, commitments, immutable report snapshots, CSV and print/PDF reports. Sample returns remain available only for a wholly synthetic dataset; incomplete live cash-flow histories do not generate invented performance metrics.
- Nested look-through exposure with explicit issuer identities, cross-manager overlap, undisclosed NAV and dated evidence. Deterministic stress scenarios combine valuation, sector/issuer and effective-currency assumptions, with separate capital-call cash demand and saved scenario templates. See [simulation methodology and limits](operations/risk-simulation.md).
- Organization settings, team invitations, role changes, access removal/restoration, audit activity, private account security and responsive desktop/mobile navigation.

Both modes use the deployment-local engine by default. Cloud execution requires deployment opt-in, a separately configured cloud-capable processor and explicit administrator egress acknowledgement. There is no provider fallback. See [engine configuration](operations/engines.md) for profile revisions, key handling, retries and provider limits. A common schema does **not** guarantee identical extracted facts or accuracy; see [the validation record](VALIDATION.md) for the measured results and their limits.

The new risk and engine panels, including actual Gemma runs in both modes, are covered in the [risk/engine validation record](VALIDATION-RISK-ENGINES.md).

## Run on your own infrastructure

Use [operations/README.md](operations/README.md) for the single-repository Docker Compose setup, private processor/Ollama network, optional Caddy TLS, secret provisioning and backup procedures. Build context is this repository. No external deployment runs automatically.

The [readiness record](operations/readiness.md) separates checks completed here from checks required on the target host. Docker is not installed on this development machine. GitHub CI has built and exercised the Linux application/processor images, non-root controls and network-disabled startup/OCR. The processor security gate and the complete target-host deployment, enforced egress restrictions and production backup/restore qualification remain open.

## Local development

Requires Node 24+, Python 3.12 and a local Ollama runtime for model-assisted extraction. No cloud API key is required.

```sh
npm ci
npm run db:local
```

The development-only database helper creates an isolated PostgreSQL cluster on 127.0.0.1:55439, random credentials and a private `.env.local`. It does not touch other local databases. In another terminal:

```sh
npm run db:migrate:dev
npm run build:services
npm run dev
npm run worker:dev
```

Run the web server and worker in separate terminals. Optional mailbox collection runs in another terminal with `npm run mailbox:dev` after provider configuration. The app uses http://localhost:3000. Production requires HTTPS and does not permit the development origin.

Create the processor environment once:

```sh
python3.12 -m venv processor/.venv
processor/.venv/bin/pip install -r processor/requirements.lock.txt
npm run processor:dev
```

Set `OLLAMA_MODEL` to an installed, reviewed local model. The development helper defaults to `gemma4:e4b-m3`; the application does not download it automatically or replace existing explicit profiles. Earlier evaluations used Qwen weights on the GPU. The earlier 0.3 extraction regression used the already installed Qwen3 0.6B weights through `qwen3-aster-cpu:0.6b`, a local alias with `PARAMETER num_gpu 0`, after this host developed severe GPU contention. This is a measured local fallback, not a general model recommendation or a controlled speed comparison. The original 27B model exceeded this machine's memory budget. The 0.4 comparison uses the already installed Gemma model; see [benchmark results](benchmark/README.md). See [processor/README.md](processor/README.md) for limits, OCR and model configuration, and [VALIDATION.md](VALIDATION.md) for the preserved evaluation attempts.

Provision the first owner explicitly with a private mode-0600 password file (15–128 characters). There are no built-in production credentials:

```sh
BOOTSTRAP_PASSWORD_FILE=/absolute/private/password-file npm run bootstrap:dev -- --email owner@example.com --name "Office Owner" --organization "Family Office"
```

Store the password securely and remove its provisioning file. Sign in and enroll an authenticator before opening the workspace. The bootstrap command refuses to run once an owner exists. Owners invite colleagues from Workspace settings; no invitation email is sent automatically. Optional sample data can be loaded into an empty workspace when `ASTER_ALLOW_SAMPLE_DATA=true`; live records cannot be reset.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm audit
```

Real PostgreSQL suites are explicit opt-ins. `AUTH_TEST_DATABASE_URL` and `APP_TEST_DATABASE_URL` must use the restricted runtime role on a migrated disposable database; cleanup of append-only audit fixtures additionally requires the explicitly configured test maintenance URL. Application-worker tests need the processor and worker running with matching encryption key and processor token. Test fixtures use generated IDs and example.invalid emails.

See [VALIDATION-LIVE-DEMO.md](VALIDATION-LIVE-DEMO.md) for the current build, browser, database and local-inference evidence; earlier validation records retain their historical results.

## Boundaries before a live office rollout

- Read-only Gmail and Microsoft OAuth, per-account historical backfill, scheduled synchronization and scoped MCP access are implemented. Real provider credentials and live consent/backfill tests are still required; no mailbox is connected by default. See [mailbox setup](operations/mailbox-oauth.md) and [assistant access](operations/agent-access.md).
- The register supports EUR/USD/GBP/CHF native amounts with explicitly sourced and dated FX into EUR. Reviewed obligations and confirmed settlements are separate; reversals and valuation corrections preserve prior records. Notices never execute payments.
- Cash-flow reconciliation uses explicit statement coverage and closing balances. It is not a tax, full accounting general-ledger or direct custodian-feed system. Custom-period returns remain unavailable where source marks or reconciled flow coverage are incomplete.
- Relevance training and local-model evaluation use a tiny synthetic corpus. Workflow is the default. Validate models on a representative, consented document corpus before relying on them.
- Optional encrypted password-reset delivery, reviewed retention and controlled key rotation are implemented. A real SMTP relay, production recovery procedure, existing-account linking, SSO/SCIM and external audit anchoring still need deployment/product decisions. Earlier reports allow 40 snapshots; new full-input period/stress snapshots allow 20 and an 8 MiB state bound. Limits reject new saves and preserve existing records.
- Container deployment, monitored backups/restore, alerting, production capacity tests and independent security review remain release gates. This is a tested application and a reviewable deployment foundation, not certification that a production installation is secure.
