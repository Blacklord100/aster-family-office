# Aster

A portable family-office workspace with a Linear/Notion-inspired interface, PostgreSQL, invitation-only authentication, mandatory production MFA, and two local document-processing modes. This application no longer depends on ChatGPT Sites, Cloudflare D1 or Vinext.

## What is implemented

- Organization membership and owner/admin/analyst/viewer permissions, enforced at APIs; PostgreSQL row-level security for workspace, documents, jobs, facts and audit records.
- Better Auth email/password sign-in, TOTP enrollment and per-session verification, single-use recovery codes, eight-hour sessions, session revocation and hashed one-time invitations. Public signup is closed.
- AES-256-GCM encryption for original files, extraction results and workspace payloads, bound to the organization and record. Restricted runtime database credentials are separate from migration credentials.
- Multiple independently authorized Google/Microsoft accounts, encrypted OAuth credentials, PKCE, durable history/delta cursors, pause/disconnect and a separate collection worker.
- Scoped, expiring read-only MCP tokens for portfolios, original documents and connection status.
- PDF/TXT/EML import, retained original downloads, content deduplication, durable PostgreSQL job leases, bounded retries, cancellation and processor deadlines.
- **Classical workflow:** fitted TF-IDF/logistic relevance classification, deterministic extraction and optional local Ollama extraction for unresolved relevant fields.
- **Agentic:** bounded local-model planning and document-reading actions. No arbitrary commands or unrestricted tool execution.
- A common versioned output schema, quoted source evidence, reviewer-to-holding matching, accepted-event timeline, valuation updates and capital-call tasks. Switching modes changes new jobs; accepted records are retained.
- Holdings, allocation views, recorded marks, liquidity, commitments, immutable report snapshots, CSV and print/PDF reports. Sample returns remain available only for a wholly synthetic dataset; incomplete live cash-flow histories do not generate invented performance metrics.
- Organization settings, team invitations, role changes, access removal/restoration, audit activity, private account security and responsive desktop/mobile navigation.

Both modes run locally in this build. Processing mode and data location are separate concerns. There is no external-provider fallback. A common schema does **not** guarantee identical extracted facts or accuracy; see [the measured local evaluation](processor/eval/README.md).

## Run on your own infrastructure

Use [operations/README.md](operations/README.md) for the single-repository Docker Compose setup, private processor/Ollama network, optional Caddy TLS, secret provisioning and backup procedures. Build context is this repository. No external deployment runs automatically.

The [readiness record](operations/readiness.md) separates checks completed here from checks required on the target host. Docker is not installed on this development machine; container startup, Linux permissions, enforced egress restrictions and backup/restore drills remain to be exercised there.

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

Set `OLLAMA_MODEL` to an installed, reviewed local model. The development helper selects `qwen3:1.7b`, tested here; the application does not download it automatically. The original 27B model exceeded this machine's memory budget. See [processor/README.md](processor/README.md) for limits, OCR and model configuration.

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

See [VALIDATION.md](VALIDATION.md) for the actual build, browser, database and local-inference evidence from this upgrade.

## Boundaries before a live office rollout

- Read-only Gmail and Microsoft OAuth, per-account historical backfill, scheduled synchronization and scoped MCP access are implemented. Real provider credentials and live consent/backfill tests are still required; no mailbox is connected by default. See [mailbox setup](operations/mailbox-oauth.md) and [assistant access](operations/agent-access.md).
- EUR valuation posting is supported. Other currencies need an explicit conversion/reconciliation workflow. Notices never execute payments, settle cash or automatically change commitments.
- The ledger retains sources and accepted events; it is not a general-ledger, tax or custodian reconciliation system. A previously accepted amount cannot be restored by replaying an older fact; that needs a deliberate correction/version workflow.
- Relevance training and local-model evaluation use a tiny synthetic corpus. Workflow is the default. Validate models on a representative, consented document corpus before relying on them.
- Email delivery/password reset, existing-account linking, SSO/SCIM, data retention/deletion, key rotation, external audit anchoring and a complete accounting reconciliation model need additional integration and operational decisions. The current workspace supports up to 40 saved report snapshots; reaching the limit rejects new saves and preserves existing reports.
- Container deployment, monitored backups/restore, alerting, production capacity tests and independent security review remain release gates. This is a tested application and a reviewable deployment foundation, not certification that a production installation is secure.
