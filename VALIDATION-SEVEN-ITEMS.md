# Aster 0.4 — seven-item validation

Validation performed locally on 8 September 2026. This release implements the seven agreed application upgrades. It is not a certification of a production installation. Real mailbox authorization, a verified SMTP relay, live cloud credentials, GitHub execution and a selected production host remain external rollout gates.

## Implemented scope

| Item | Delivered behavior | Material boundary |
| --- | --- | --- |
| 1. Investment register and financial history | Families, legal entities, accounts, holdings, native-currency amounts and dated sourced FX; reviewed transactions, explicit settlements, reversals, corrections and append-only valuation history | EUR reporting with EUR/USD/GBP/CHF native records. A notice never initiates a payment. This is not a tax-lot or full accounting general ledger. |
| 2. Source review workbench | Authenticated original and bounded PDF preview beside extracted evidence; per-fact acceptance, deferral, rejection, amendments, matching and append-only review versions | Original extraction remains immutable. Missing effective dates show their receipt-date fallback explicitly. Opening an original does not automatically verify it. |
| 3. Holdings and manager intelligence | Encrypted source index, constituent proposals, reviewed issuer aliases, known or undisclosed weights, accepted exposure links, manager/contact/mandate/deal records and local follow-up drafts | Undisclosed weights remain unknown. Source extraction proposals require review. Drafting never sends a message. |
| 4. Period reporting and simulations | Exact-date source marks, attested statement coverage, cash residuals, guarded Modified Dietz estimates, entity/currency/date liquidity, saved period and stress inputs/results with hashes | Incomplete marks, flows or account restrictions suppress unsupported metrics. Returns are estimates, not annualized TWR/IRR. Stress is hypothetical. Saved inputs survive later live changes. |
| 5. Document-aware Ask | Actual selected local or explicitly enabled cloud engine, scoped retrieval, quote validation, cited answers and deterministic arithmetic; bounded agentic or workflow execution | Answers can abstain. Scope and all touched source grants are rechecked after inference. No unrestricted agent tools or silent provider fallback. |
| 6. Measured extraction benchmark | New synthetic email/native-PDF/scanned-PDF fixtures, frozen gold labels, raw model traces, shared scoring, preserved failing baseline and source-ownership repairs | This small corpus became development/regression data after inspecting the baseline. It cannot establish general production accuracy. |
| 7. MFO access and operations | Family/entity viewer scopes, separately released originals, optional encrypted reset delivery, controlled keyring rotation, reviewed retention, monitoring, recovery tooling and release CI | Deployment configuration alone does not prove SMTP delivery, backups, container isolation or secure hosting. |

## Application and processor checks

- `npm test`: **275 passed, 0 failed, 34 deliberately skipped opt-in tests**. Database suites below were run separately with their required configuration.
- Processor suite: **263 passed**, with two existing dependency deprecation warnings. Model transports in this suite are offline fixtures; actual local inference is recorded separately.
- Benchmark tooling: **23 offline tests passed**.
- TypeScript, lint and production build passed. `npm audit` reported **0 known vulnerabilities** at the time of validation; a refreshed CycloneDX dependency SBOM is retained in `operations/sbom.cdx.json`.
- Real database suites exercised encrypted key rotation/rollback and retention (4), Better Auth reset/queue/session revocation (2), engine persistence (1), MCP authorization (3), worker lifecycle (5) and mailbox synchronization/recovery (6). The first combined lifecycle run failed only its historical 25-table assertion after the schema grew to 30; that assertion was corrected and all six mailbox tests passed on rerun. Initial results remain preserved.
- A native encrypted recovery drill restored and compared **30 tables / 2,789 records**, then authenticated and decrypted **693 application payloads**. It verified 12,027,436 encrypted bytes, including review, engine and intelligence contexts. Temporary recovery assets and the restored database were removed. This was a bounded SQL snapshot drill on the isolated local cluster, not the unexecuted Docker/pg_dump/age target-host procedure.

## Real API and browser exercises

Tests used disposable synthetic identities and organizations with mandatory MFA. They did not change the existing owner's holdings, authentication settings or encryption key.

- Register/settlement API: **10 checks**. A reviewed capital call had no financial effect until explicit settlement; settlement and reversal changed/restored cash, investment value and commitments. Duplicate requests, stale revisions and viewer writes were refused.
- Review/access/operations API: **22 final checks**. A reviewer amendment preserved the extraction and prior history; whole-document review was required before client release; scoped access and grant revocation were enforced.
- Reporting API: **21 checks**. Reconciled source values produced the expected estimate; missing evidence suppressed results; immutable period/stress saves, concurrency and read-only behavior were exercised.
- Intelligence API: **12 checks**, followed by **6 source-date/proposal/graph checks**. Two real Gemma Ask requests returned validated citations: workflow used one call (15.614 s), agentic used four calls (43.937 s). These are observed local timings, not a controlled performance comparison.
- Browser: **19 register/review/operations checks**, **19 reporting checks**, **9 intelligence checks**, and **9 fully hydrated identity/navigation checks** across desktop and mobile Chromium. Reporting snapshots retained their original return after live marks changed; saved stress labels retained their pinned scenario. The reporting mobile tab overflow found during QA was corrected.
- Exact release production smoke: **14 checks** through an isolated loopback HTTPS proxy on build `cBfpTKPh7QSaQMur6cCD7`. MFA, Secure/HttpOnly cookies, authenticated identity and role navigation, desktop/mobile rendering, Operations/access settings, PDF canvas/text and strict document-worker CSP passed with zero runtime errors. The proxy used a self-signed local certificate; this does not validate public TLS or containerized Caddy. The temporary runtime, keys, certificate, log and production browser session were removed.
- PDF preview: **13 browser security checks** and **6 included unit tests**. Local canvas/text rendering, page navigation, cancellation, the 40-page cap and a 20-second deadline passed. An active-content fixture produced no script execution or external requests. The PDF worker has a separate `connect-src 'none'` policy; originals remain authenticated and sandboxed. Earlier blank native-iframe and incompatible worker-wrapper attempts remain in the evidence directory.

## Gemma extraction comparison

The same 14-document corpus, gold, model digest, runner/scorer, Python version and settings were used for both matrices. All 56 attempts completed; only the shared source-ownership parser changed between them. The repair recognizes explicit investment/event grammar and prevents a later underlying issuer from inheriting an earlier fund NAV. It retains the existing evidence validator.

| Per mode | Initial workflow | Initial agentic | Repaired workflow | Repaired agentic |
| --- | ---: | ---: | ---: | ---: |
| Exact supported facts | 6/14 | 6/14 | 14/14 | 14/14 |
| Missed facts | 8 | 8 | 0 | 0 |
| Unsupported facts | 1 | 1 | 0 | 0 |
| Fact-perfect documents | 7/14 | 7/14 | 14/14 | 14/14 |
| Observed median duration | 25.45 s | 40.68 s | 22.52 s | 39.19 s |

The unsupported fact was a fund NAV assigned to an underlying company. Repaired output preserves correct ownership, both historical periods, source amounts and dates, unknown dollar currency and empty withdrawal/instruction guards. Both image-only scan attempts recovered the exact CHF mark with OCR evidence.

Combined document time increased from 16.38 to 17.59 minutes. The runs were sequential and subject to local cache/contention effects; there is no controlled speed or model-ranking claim. Because baseline inspection informed the repair, the repaired matrix is development regression evidence, **not an untouched holdout**. See [benchmark methodology](benchmark/README.md) and [diagnosis](benchmark/DIAGNOSIS.md). Raw baseline/candidate attempts and the direct comparison remain preserved outside the repository.

## Operational evidence

The current monitor reported healthy local processor and document-worker heartbeats, zero pending/failed deliveries and **backup evidence unreported**, correctly exiting with attention status. No production backup receipt was fabricated from the local recovery drill.

Synthetic secret adapters and shell syntax passed seven checks. Four mocked backup permission/failure checks proved that existing files and a failed pipeline do not leave a stale lock, overwrite a backup or publish a success receipt, and that receipt metadata is container-readable while dumps remain private. They did not execute Docker or age. A real PostgreSQL contention exercise verified the maintenance CLI's five-second advisory-lock timeout (5,083 ms observed) without rotating existing keys. Seven delivery-monitor unit tests cover a stopped worker, expiry, failed items and malformed/future evidence.

The new GitHub workflow, Compose topology, delivery network separation and secret mounts were inspected locally. Docker is absent on this host; image builds/scans, Linux runtime permissions, actual egress enforcement and GitHub Actions execution remain unverified here. No SMTP worker contacted a relay and no cloud provider was called.

## Evidence and rollout

Generated API results, screenshots, raw inference traces, before/after attempts, test reports and local runtime evidence are retained outside the repository in `../validation-seven-items/`. Private QA credentials and runtime TLS material are not release artifacts. All three synthetic QA identities were retired after browser verification: active memberships, credentials, authenticators and sessions were removed, former sessions were refused, and the private credential file was deleted. Source/review/audit evidence remains preserved, and cleanup left every non-fixture workspace payload unchanged.

Repository fixtures under `benchmark/` are synthetic and reproducible; earlier `VALIDATION*.md` and lab reports remain historical records of their own source versions.

Before admitting a real office, complete the target-host checks in [operations/readiness.md](operations/readiness.md): actual Gmail/Microsoft consent/backfill, an authorized SMTP delivery test if enabled, container startup/TLS/network isolation, independent encrypted backup restoration with measured recovery objectives, monitoring ownership and a security review. Validate extraction on a new representative, consented corpus. GitHub authentication/repository creation and push remain deferred at the user's request.
