# Validation record

Recorded for the portable Next.js/PostgreSQL upgrade on 2026-09-08. All test accounts, documents and portfolios were synthetic. No private mailbox was accessed and no external deployment was performed. These results describe this local build, not a production security certification.

## Automated checks completed

| Suite | Passed | What was exercised |
| --- | ---: | --- |
| Node unit tests | 100 | Financial calculations, recorded marks, fact review, request validation, authentication policy, tenant access, encryption and processor-result handling |
| Better Auth with real PostgreSQL | 4 | Password sign-in, closed public signup, CSRF, secure cookies, per-session TOTP/recovery verification, expiry/revocation, password changes, invitation races and persisted rate limits |
| Application API/database integration | 9 | Restricted-role RLS, upload deduplication, original downloads, real durable processing and acceptance, replay rejection, team role/removal/restoration boundaries, opening history and immutable report snapshots |
| Native worker lifecycle integration | 4 | Shutdown requeue, cancellation/disconnect, stale-result fencing across two workers, terminal retry limits and explicit retry |
| Python processor tests | 42 | Both processing modes, schema/evidence validation, model transport boundaries, token/body limits, PDF/EML handling, deadlines and cleanup |
| **Total** | **159** | **117 Node checks and 42 Python checks, across separate runs** |

The application suite mocks authenticated identity while exercising the actual membership gate, API handlers, database and worker. The separate authentication suite uses Better Auth itself. Worker lifecycle tests use compiled processes and a controlled local processor fixture; they are not model-quality tests. Temporary database records are scoped to generated fixture IDs and removed after each suite.

Lint, TypeScript checks, the final optimized production build and service bundles passed. `npm audit` reported zero vulnerabilities in the installed dependency graph at the time checked. The final build passed a fresh standalone HTTPS browser run and the production PDF checks described below.

## Browser and financial behavior checked

- Password login, authenticator enrollment, new-session MFA challenge, recovery/session revocation, invitation redemption and password change were exercised. A standalone production build behind a local HTTPS proxy at `https://localhost:3443` used a self-signed certificate. Secure/HttpOnly/SameSite=Lax cookies, per-session MFA, nonce CSP without `unsafe-eval`, HSTS and cross-origin rejection were verified. This does not validate a target host's certificates or reverse proxy.
- Desktop 1440×1000 and mobile 390×844 flows showed no observed console/page errors or horizontal overflow on the checked views.
- A native synthetic PDF passed workflow upload, review, holding matching and acceptance. Downloading its original preserved the uploaded bytes. A prose TXT document used the actual local agentic mode and was explicitly reviewed before acceptance.
- Accepted valuations updated holdings, timeline and evidence. Live charts displayed recorded marks with carried-forward steps; incomplete live cash-flow history did not produce investment returns. CSV exported the observed current EUR value exactly.
- A manual opening position created a dated historical mark. An accepted same-date correction changed the live holding from EUR 8,250,000 to EUR 8,400,000 while the earlier saved report's holdings and history remained exactly unchanged. A forty-first report save returned `409 REPORT_LIMIT`, preserving all forty existing snapshots.
- Print handling passed on the final optimized production build through the local HTTPS proxy. The live report rendered to one A4 page; the 21-holding sample rendered to two pages with repeated table headers and all rows/disclosures present. All three rendered pages were visually inspected without clipping. Percentage ticks retained one decimal and did not display negative zero. The disposable QA workspace was restored exactly before cleanup.

Local browser evidence and detailed print results are recorded in [the QA summary](outputs/production-upgrade/QA_SUMMARY.md). Those generated screenshots, PDFs and CSV files are intentionally Git-ignored and are not part of the shipped source package.

## Local-model evidence and limits

The final actual `qwen3:1.7b` run recovered the expected **kind and amount on 8/8 synthetic positive documents in each mode**. Workflow local calls took approximately 3.07–4.02 seconds; agentic calls took 4.07–5.79 seconds. The eight positives do not establish complete financial correctness, relevance generalization, calibration or production accuracy. Scripted-model contract results are reported separately. Earlier failed/smaller-model runs remain visible in [the evaluation record](processor/eval/README.md).

There are **zero OCR runtime/accuracy tests** in this environment. Native-text PDF and bounded EML cases were checked; scanned, multilingual and representative real-office document coverage remains unverified.

## Deployment gates and unfinished capabilities

- Docker was unavailable. Build and boot the full target-host container stack; verify Linux permissions, secret mounting, nonroot execution, sandbox/resource limits, PostgreSQL initialization, effective network egress blocking and the actual TLS/proxy configuration.
- Run monitored backup/restore and decryption drills, establish recovery objectives, test capacity on representative documents and complete an independent security review. Key rotation, retention/deletion, external audit anchoring and operational alerting require further work.
- Validate extraction and matching on a representative, consented corpus before operational reliance. Review remains mandatory; neither processing mode executes payments or settles cash from notices. Posting currently supports EUR; other currencies require an explicit conversion/reconciliation workflow.
- Mailbox OAuth/MCP connectivity, historical multi-person backfill and scheduled Gmail/Graph synchronization are **not implemented**. EML import is file processing, not mailbox access.
- SMTP/password reset, existing-account linking and SSO/SCIM are not configured. This is not a general ledger, tax system or complete custodian reconciliation product.

See [operations/readiness.md](operations/readiness.md) for the target-host checklist and [operations/backup-restore.md](operations/backup-restore.md) for the unexecuted recovery procedures. Normal `npm test` skips the opt-in database and worker suites; their private runtime/maintenance configuration and lifecycle prerequisites are documented in the README and readiness record.
