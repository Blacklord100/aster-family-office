# Validation record

Recorded for the portable Next.js/PostgreSQL upgrade on 2026-09-08. All test accounts, documents and portfolios were synthetic. No private mailbox was accessed and no external deployment was performed. These results describe this local build, not a production security certification.

## Automated checks completed

| Suite | Passed | What was exercised |
| --- | ---: | --- |
| Node unit tests | 110 | Financial calculations, recorded marks, fact review, request validation, authentication policy, tenant access, encryption and processor-result handling |
| Better Auth with real PostgreSQL | 4 | Password sign-in, closed public signup, CSRF, secure cookies, per-session TOTP/recovery verification, expiry/revocation, password changes, invitation races and persisted rate limits |
| Application API/database integration | 9 | Restricted-role RLS, upload deduplication, original downloads, real durable processing and acceptance, replay rejection, team role/removal/restoration boundaries, opening history and immutable report snapshots |
| Native worker lifecycle integration | 4 | Shutdown requeue, cancellation/disconnect, stale-result fencing across two workers, terminal retry limits and explicit retry |
| Python processor tests | 42 | Both processing modes, schema/evidence validation, model transport boundaries, token/body limits, PDF/EML handling, deadlines and cleanup |
| Mailbox integration with real PostgreSQL | 6 | Both provider OAuth contracts with synthetic responses, session-bound state, encrypted credentials, deduplication, cursor persistence, stale leases, retries, refresh, disconnect and isolated encrypted recovery |
| MCP integration with official SDK and real PostgreSQL | 3 | Client negotiation, scope-filtered tools, original bytes, RLS, expiry, role/MFA checks and revocation |
| **Total** | **178** | **136 Node checks and 42 Python checks, across separate runs** |

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

The earlier upgrade did not exercise OCR. The extraction correction below adds synthetic native OCR checks; multilingual and representative real-office document coverage remains unverified.

## Deployment gates and unfinished capabilities

- Docker was unavailable. Build and boot the full target-host container stack; verify Linux permissions, secret mounting, nonroot execution, sandbox/resource limits, PostgreSQL initialization, effective network egress blocking and the actual TLS/proxy configuration.
- Run monitored backup/restore and decryption drills, establish recovery objectives, test capacity on representative documents and complete an independent security review. Key rotation, retention/deletion, external audit anchoring and operational alerting require further work.
- Validate extraction and matching on a representative, consented corpus before operational reliance. Review remains mandatory; neither processing mode executes payments or settles cash from notices. Posting currently supports EUR; other currencies require an explicit conversion/reconciliation workflow.
- Read-only Gmail/Microsoft OAuth, multi-account backfill, Gmail history, Graph folder delta polling and scoped MCP access are implemented. Real provider app credentials, consent/backfill trials and target-host deployment are still unverified. No real mailbox is connected.
- SMTP/password reset, existing-account linking and SSO/SCIM are not configured. This is not a general ledger, tax system or complete custodian reconciliation product.

See [operations/readiness.md](operations/readiness.md) for the target-host checklist and [operations/backup-restore.md](operations/backup-restore.md) for the unexecuted recovery procedures. Normal `npm test` skips the opt-in database and worker suites; their private runtime/maintenance configuration and lifecycle prerequisites are documented in the README and readiness record.

## Connector upgrade evidence

The final optimized build also passed a fresh standalone HTTPS check through a self-signed local proxy: password plus MFA, Secure/HttpOnly/SameSite cookies, nonce CSP, mailbox API/origin rejection, and browser-created MCP access all passed. This does not validate a public TLS deployment.

The Connections screen uses real provider readiness and database metadata. Desktop/mobile browser checks exercised provider setup guidance, a real MFA-authenticated access-token create/use/revoke flow against the MCP endpoint, and mailbox resume/schedule/pause/disconnect against the real API with an explicitly synthetic mailbox. No browser/page errors or mobile horizontal overflow were observed in the final checks. An earlier layout-only fixture pass was followed by the actual API check. Screenshots in `outputs/connectors/` are local ignored QA artifacts.

The mailbox integration suite exercises real SQL/crypto/scheduler logic with synthetic Google/Microsoft responses; it does not contact provider accounts. A bounded native encrypted recovery drill rebuilt a separate temporary database, restored all 22 tables, compared every record and decrypted source/workspace/mailbox payloads, then removed its database and files. This is separate from the unexecuted production Docker/pg_dump/age backup procedure. Provider request bounds, no-redirect behavior, cursor host/path checks and scope rejection have focused tests. The Compose provider worker topology and secret adapter were checked statically, including malformed-secret redaction and startup without provider credentials.

## Extraction correction — 2026-09-08

The earlier upgrade checks above remain historical evidence. This correction adds source-anchored date and amount normalization, financial role and entity checks, correction/withdrawal handling, safe partial-candidate deduplication, visible HTML email decoding, and bounded local OCR. Wrapped fund names can resolve only to exact whitespace-flexible occurrences of independently labeled full source names. Adjacent call amounts require matching entity and event context. Illustrative financial headings and explicit withdrawals remain exclusions even when omitted from a short model quote. Financial topics inside explicit negations are removed from classifier features; the existing training corpus and original source text remain unchanged.

Workflow and agentic execution share validation; the agent still chooses its actual local tools. Source rules inspect every readable workflow page, agent completion requires an extraction attempt on every readable page, and model-window/budget limits are reported. Validation uses the complete decoded page so a later withdrawal cannot be hidden by a short model window. Wholly and partially unreadable sources receive distinct UI alerts instead of negative investment classifications.

The changed application passed 110 Node unit tests, TypeScript, lint, the optimized Next.js build and service bundling. The final processor passed 208 tests, including actual local Apple Vision OCR with checked-in synthetic PDF fixtures; the dependency consistency check passed. Mocked model responses test contracts, not model quality. Ten independent adversarial probes passed after the identified currency, illustration, withdrawal and instruction false positives were fixed. Additional regressions cover Swiss grouping, unsupported numeric suffixes, negative signs and ambiguous accounting parentheses.

Focused authenticated browser checks used the real synthetic processing queue on desktop 1440×1000 and mobile 390×844, with no observed page/console errors or horizontal overflow. Explicitly intercepted whole-source and mixed cover-email/unreadable-attachment fixtures separately checked that the new alerts replace the irrelevant-document label. Screenshots and logs are in the ignored `outputs/extraction-upgrade/` folder. Native OCR checks do not establish Linux Tesseract or multilingual accuracy; Docker remains unavailable and untested.

### Preserved attempts and generalization

The original 22-document benchmark, four format controls, gold labels, and original raw outcomes remain unchanged in the sibling `workflow-lab/`. The first correction run was interrupted for additional numeric and PDF-layout fixes: its nine timed records and a separate final snapshot of ten jobs are retained, with no facts accepted.

Candidate 2 completed 76 actual HTTP jobs. Both modes recovered 24/24 exact baseline facts and 4/4 control facts. Its independent twelve-document holdout was materially weaker: 5/13 exact facts, one extra, eight missing, and 4/12 complete documents in each mode. All 30 ingestion and 699 review checks passed; 76 original downloads matched. This result is retained in its own report rather than replaced by later improvement. Candidate 2 and the interrupted candidate 1 generated identities were retired while preserving their results and synthetic portfolios.

Those twelve documents then became regression cases for candidate 3. Generic name/context/negation fixes passed exact actual-byte checks on all 38 used documents before another freeze. A separate six-document, seven-fact holdout was authored independently and withheld from implementation work. Source digests are captured for every processor module and checked at the end of each cohort. The original scorer and six-field exact-match rules remain unchanged. Review gates exclude incomplete and non-EUR valuation posting, and notices never settle cash.

Candidate 3 completed 88 actual HTTP jobs with identical processor fingerprints across all four cohorts. Both modes recovered 24/24 original facts, 4/4 format controls and 13/13 previously held-out regression facts. The new six-document holdout scored 4/7 exact facts with three extra/wrong candidates and three misses in each mode: a funding-arrival deadline was missed, and a two-fund distribution table lost date/entity context. The test review rejected those incorrect jobs. All 40 ingestion and 916 review checks passed; all 88 original downloads matched. There were no model/transport failures. The completed report, raw results and earlier attempts remain preserved; generated candidate-3 access was retired after report verification.

The six additional examples then became used regressions for candidate 4, alongside the other 38 documents. Candidate 4 has no new held-out corpus: its final scores measure correction and regression coverage, not independent generalization. Both failed held-out evaluations remain visible rather than being replaced by later successful regression scores.

The final table parser binds explicit headers and row fields, prevents unsupported or malformed tables from falling back into unrelated prose amounts, and surfaces coverage warnings in both modes. Payment-receipt deadlines exclude negation and other funds. Every non-null candidate field must match one event within its literal quote, as well as the full decoded page; dates cannot be borrowed from another quoted row. A scan-count regression verifies repeated incomplete headers are consumed linearly.

Before the final actual run, all 44 used documents passed exact deterministic checks on their real decoded bytes. The independent boundary audit recovered eight of nine cases exactly; the ninth, an ambiguously flattened wrapped fund name, safely abstained with an explicit warning and left two expected facts unrecovered. That coverage limit remains in the evidence. All nine malformed-table/deadline safety replays passed. Unsupported or ambiguous layouts, table row limits and the contiguous 3,000-character evidence limit still require manual source review.

### Runtime interruption and final comparison conditions

Candidate 4 actual ingestion was interrupted after local inference timed out. Its one measured workflow record (122.026 seconds) and separate snapshot of two terminal jobs remain preserved. Source rules retained the supported fact in both jobs, with explicit model-failure warnings; neither job was accepted. The generated access was retired. This is an interrupted attempt, not a completed quality or latency evaluation.

Read-only measurements on this Apple M3 host showed heavy WindowServer GPU use, while the local model's weights and GPU offload settings matched earlier successful runs. The source of that contention remains unconfirmed. Unloading and restarting Ollama did not restore GPU throughput, and a full-document preflight with the same 1.7B weights on the CPU also timed out. Those failed diagnostics remain in the lab.

Candidate 5 retains exactly the same processor source as candidate 4 and uses the already installed Qwen3 0.6B weights through the local CPU alias `qwen3-aster-cpu:0.6b`, with an 8,192-token context. Both modes use that runtime. No model was downloaded and no cloud fallback was attempted. All 44 documents are used regressions; no new held-out evaluation is claimed. Historical comparisons change software, model size and execution hardware, so they cannot isolate an accuracy or speed improvement from any one change.

### Completed candidate-5 results

The final comparison completed 88 actual HTTP jobs, with identical processor fingerprints across all four cohorts and no runtime/model failures. Both modes recovered 48/48 expected facts and completed 44/44 documents. Exact matching requires event kind, investment name, effective date, amount, currency and due date to match the unchanged gold labels.

| Used regression cohort | Exact facts, each mode | Extra / missing, each mode | Complete documents, each mode | Workflow median | Agentic median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original benchmark | 24/24 | 0 / 0 | 22/22 | 10.233s | 18.910s |
| Format controls | 4/4 | 0 / 0 | 4/4 | 12.282s | 17.383s |
| First formerly held-out set | 13/13 | 0 / 0 | 12/12 | 12.265s | 22.989s |
| Second formerly held-out set | 7/7 | 0 / 0 | 6/6 | 11.777s | 20.959s |

All 40 ingestion checks and 956 review checks passed. All 88 original downloads matched their source hashes. Review accepted 70 jobs and excluded or rejected 18; 84 facts were applied and 12 explicitly excluded, with zero duplicate applications. Eight duplicate-upload checks reused the existing jobs. The review harness uses gold labels to decide which synthetic jobs are safe to accept; these checks verify application posting behavior, not autonomous detection of every incorrect extraction. Notices did not settle cash or change costs/commitments. Non-EUR valuation posting and incomplete candidates remained excluded.

Both modes checked all 48 readable source pages. Full-model page coverage was 44/48 for workflow and 48/48 for agentic. Recorded structured model calls were 44 for workflow and 188 for agentic; three workflow documents lacked a usage counter and remain unknown rather than being counted as zero. Agentic execution did not improve exact output on these used inputs and had a higher median upload-to-result time in every cohort.

The local model still emitted 14 schema-invalid candidates in each mode, plus candidates rejected for unsupported source evidence. Validation discarded those candidates while the full pipeline retained the exact source-derived facts. The result measures the complete pipeline, not standalone LLM accuracy. The ambiguous wrapped-table boundary case described above remains a manual-review coverage limitation.

The sibling `workflow-lab/fixed-run/runs/candidate-5/` retains raw results, scores, review checks, aggregate, diagnostic provenance and the final interactive report. Its `source-build.json` maps the recorded working-tree processor hashes and historical base commit to the delivered source commit without rewriting the raw metadata. Earlier failed attempts, sources and gold labels remain preserved. Application verification logs and desktop/mobile evidence are copied into the public lab with hashes; one log copy redacts only the local workspace prefix.
