# Live folder demonstration validation — 9 September 2026

This record covers the native, source-derived demo and its application changes. It does not certify a production deployment. The previous benchmark reports remain immutable historical results; the live run uses the current processor and actual local Gemma inference.

## Implemented and exercised

- New runs start with zero holdings in a separate, server-marked synthetic workspace. The existing office is preserved. Three fictional families and nine mailbox personas are declared for routing.
- The application copies 100 frozen EML files, including 57 embedded PDF attachments, into a private `Demo mails` folder. The durable collector retained 95 distinct original documents and five duplicate receipts. Nothing was read from a real email provider.
- Agentic jobs pin `gemma4:e4b-m3` through the local Ollama profile. The installed model digest is `bcfb291b596f262958424fe2775c92e1480f3c05c328d0cbcb2cd05562ebe8ff` (7.5B, Q4_0). Existing explicit engine profiles are preserved. There is no cloud fallback.
- The explicitly named Aster demo agent publishes independently supported facts only from exact checksum-verified corpus originals. Ordinary offices and arbitrary or modified files retain human review. Original evidence, extracted facts, versioned decisions and audit attribution remain visible. Notices create obligations/tasks, not settled cash.
- Source indexing and dated constituent disclosures populate searchable evidence and look-through links. Missing weights remain unknown. Financial metrics, saved reports, exports, risk and MCP distinguish reported values, incomplete coverage and inferred asset classes.
- The email viewer renders bounded plain text and retained PDF attachments. It does not load remote email images, execute HTML or follow tracking links. Preview audit records distinguish email metadata from the exact attachment bytes opened.
- The installable Aster client plugin exposes ten authenticated, scoped, audited read tools. Installation does not change the operator's client settings, issue a token or enable a cloud engine.

## Application checks

| Check | Result |
| --- | --- |
| Application unit/component/route tests | 594 passed; 59 opt-in tests skipped in this command |
| Python processor suite | 589 passed; two dependency deprecation warnings |
| Production Next build and service bundles | Passed |
| TypeScript and lint | Passed |
| Full npm dependency audit, including development dependencies | Zero known vulnerabilities reported |
| Native isolated folder/search database suites | Eight passed |
| Native isolated demo lifecycle/publication suite | Six passed |
| Native isolated MCP protocol/access suite | Six passed with the official SDK |
| Native isolated mailbox/recovery suite | Six passed, including all 34 current tables |
| Container inventory and trust-store regressions | Nine passed; missing packages, invalid trust or high/critical findings fail validation |
| UI route audit | 14 routes at desktop and mobile sizes; no detected overflow or console errors |
| Interaction audit | 17 primary interactions, demo start/leave/reopen, source counts, chart and report checks passed |
| Email/PDF browser checks | Original rendering, attachment expansion, tracking canary and tenant/family-scope denial passed |
| Financial provenance browser checks | Seven passed, including liquidity, inferred allocation, print and CSV |

Native suites use the restricted runtime database role and isolated/disposable fixtures. They are recorded separately from the default test command; skipped tests are not counted as passes. Browser checks used generated synthetic QA identities with normal MFA sessions. The retained source-derived demo is separate from the static UI fixtures.

Linux run 34399925018 passed all 38 database test assertions but failed on a fixture shutdown race. The three affected fixture suites now use bounded, non-forced database cleanup: all 18 tests in those suites passed in isolated native databases, and nine cleanup regressions passed. Those disposable databases were removed; the live offices were untouched. The next Linux run must verify the complete database job after this fix.

## Recovery and encryption

The latest bounded native encrypted SQL recovery drill passed for all 34 tables: 6,381 records restored and compared, with 3,109 encrypted application fields authenticated and decrypted. This included the folder connection and all 100 folder receipts. The disposable database, snapshot and temporary recovery key were removed. These are counts at that snapshot time. Five regression tests cover waiting for the restore connection to close, refusing unsafe database names and surfacing a failed close before deletion.

A rotation **dry-run** during native validation authenticated all then-configured encrypted fields, including folder receipts, and changed zero records. No running encryption keys or audit signatures were replaced. This verifies the native maintenance paths; production streaming `pg_dump`/`age`, scheduled backups and target-host recovery remain separate qualification work.

## Live extraction evaluation

The completed run produced **90/90 exact grounded facts**, **92/92 correct relevance decisions**, zero unsupported facts and zero cross-family routing errors. All 95 unique originals finished: 92 returned usable Gemma results and three deliberately encrypted PDFs remained explicit input failures. The stored processor traces record **414 local model calls**. Evaluation uses a read-only consistent database snapshot and the unchanged strict frozen benchmark scorer. The answer key is consumed only by the offline evaluator, outside the runtime and intake directories; it is never supplied to the model or used to populate holdings.

The [whitelisted evaluation summary](validation/live-demo-gemma-2026-09-09.json) was captured at 2026-09-09 19:31:00.948 UTC after the news-link review. Its SHA256 is `f57c064b522e38ef1791462695a5b7f31b4f27edbd2752be3c90859d944186cd`. Raw database snapshots, review envelopes and operator receipts remain outside the repository; the shared summary contains counts, model/corpus identity, hashes and evaluation limitations.

| Fictional family | Exact facts | Holdings populated |
| --- | --- | --- |
| Alder House | 32/32 | 5 |
| Belwick | 29/29 | 5 |
| Cinder Trust | 29/29 | 5 |

The final portfolio contains 15 source-valued holdings, 27 dated NAV marks, 66 source citations, 54 timeline events, 12 tasks and 12 verified constituent relationships. Three constituent weights are explicitly 28%; the other nine remain unknown. The reported NAV subtotal is EUR 18,000,527.65 using the clearly declared synthetic FX assumptions. No notice was treated as settled cash.

Of the 90 extracted facts, 72 are accepted and 18 remain deferred: nine competing valuations, six missing date/currency cases and three reading/OCR exceptions. Job status is separate from fact status: 47 jobs are accepted, 35 await review, ten are irrelevant/rejected and three failed. Some jobs retain actionable source warnings despite supported facts being published.

Six underlying-company news items were linked to their existing same-family parent funds after independently validating their accepted, dated constituent disclosures and current exposure links. A bounded explicit retry used the ordinary versioned review operation. All six decisions advanced from revision 1 to 2; the original decisions remain in history. The stored source and extraction ciphertext hashes for all 95 jobs were unchanged, every other review revision was unchanged, and no additional model call was made. Ambiguous, future-dated, cross-family or unverified relationships remain in review.

The completed demo is available to the existing office owner through **Connections → Folders → Previous demo run**. Its source folder and publication history remain intact. Temporary QA memberships, sessions, credentials and tokens were revoked; the existing owner's credentials, MFA, sessions and original-office data were preserved.

An exact fact requires all six fields, the correct page, a contiguous original-source quote and the required evidence anchors. Duplicate byte-identical originals count once in the combined workspace. The 95 originals have 90 expected accessible fact observations. Deliberately encrypted inputs have no accessible expected facts and remain explicit failures.

The run exercises combined deterministic source rules and actual local model calls. Its synthetic, author-labeled corpus is not an independent estimate of client-document accuracy. This run tests Gemma agentic mode; prior four-configuration comparisons remain separately recorded. A common output contract does not guarantee identical facts across models or modes.

## Remaining deployment qualification

Gmail/Microsoft adapters and their workers are implemented, but no real provider consent, tenant configuration or historical backfill was exercised here. The MCP package was validated and tested against the server; it was not activated in a real external client with a production token.

Docker is unavailable on this development host. The [release workflow](.github/workflows/verify.yml) qualifies Linux image builds, non-root/read-only controls, network-disabled startup and OCR, the processor regression suite, and high/critical vulnerability gates. The processor scan additionally checks that every retained native package and locked Python dependency is present in the scanner inventory. Exact commit results are available in [GitHub release checks](https://github.com/Blacklord100/aster-family-office/actions/workflows/verify.yml); a clean base-image scan is not a passing application-image result.

In [run 34399925018](https://github.com/Blacklord100/aster-family-office/actions/runs/34399925018), both images built, their runtime probes passed, and all 589 processor tests passed inside the network-disabled image. The complete web image passed its high/critical scan. The processor image retained three high-severity dependency findings, which intentionally block release. [The processor release-blocker record](operations/processor-release-blockers.md) identifies the affected versions, upstream fixes and outstanding scanner-coverage qualification. No finding has been suppressed or relabeled to obtain a passing release.

The complete LP deployment still requires target-host permission and egress checks, hardware capacity testing, public TLS and production streaming backup/restore qualification. The native source intake contains plaintext synthetic files before encrypted retention; host storage protections remain an operator responsibility. Use [the deployment readiness record](operations/readiness.md) and [offline LP packaging plan](operations/offline-lp-packaging.md) for the remaining installation work.
