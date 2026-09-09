# Completed local mailroom baseline

Run `e331d0d1-fdab-4c1d-ba9d-b3c08df820cd` completed on 9 September 2026. The full four-cell comparison is complete; no case was discarded or rerun to select a better result.

100 synthetic receipts across three offices and nine inboxes yielded 97 unique encrypted originals. All 134 live collection assertions passed. Four processing configurations produced 388 final jobs, with 436 preserved HTTP attempts; every recorded request and response passed the exact-byte/engine-pin audit. Processing source and model inventory stayed unchanged.

| Configuration | Exact/gold | Unsupported | Model calls | Median request | P95 request |
| --- | ---: | ---: | ---: | ---: | ---: |
| gemma4:e4b-m3 / workflow | 60/90 | 0 | 93 | 17.79s | 47.88s |
| gemma4:e4b-m3 / agentic | 60/90 | 0 | 526 | 39.20s | 93.14s |
| qwen3-aster-cpu:1.7b / workflow | 60/90 | 0 | 93 | 15.72s | 33.51s |
| qwen3-aster-cpu:1.7b / agentic | 60/90 | 0 | 526 | 35.23s | 70.21s |

Each cell has 91 usable outcomes and six input failures: three unsupported nested emails and three password-protected PDFs. Thirty expected facts are missed per configuration. All four return identical full fact objects, relevance and confidence. Agentic processing adds no exact facts on this corpus. Qwen produces more rejected evidence candidates; identical final output does not imply identical raw candidate quality.

Prioritize table/row attribution and header units, terse owners and negation scope, bounded nested MIME, operational news/relevance and permanent-input retry classification. Do not infer unattended production readiness from 100% precision after validation: grounded recall is 66.7%. The benchmark is synthetic and repeated across offices, with author-labelled gold.

Both modes receive decoded text, including Apple Vision OCR. Direct multimodal capability is not compared. Gemma uses this Mac’s GPU; Qwen uses a CPU alias with different size/quantization. Timings exclude queue/retry waits and are observational. Look-through graph completeness, accepted ledger postings and stress-test accuracy are separate validation tasks.

The final report passed 30 desktop/mobile checks, with no external requests or browser errors. Project checks passed 277 tests (35 opt-in skips), typecheck, lint and service builds. Dedicated corpus, scorer, observer, findings, request-audit and bundle controls passed; the worker-scope check included a live database late-job test.

Synthetic connections/access have been retired; originals/results/audit remain. The ordinary worker was restored with an empty queue and a healthy heartbeat; app readiness returned HTTP 200. No GitHub push was performed.

[Harness and commands](HARNESS.md) · [Machine-readable metrics and fingerprints](baseline-results.json) · [Offline LP delivery plan](../../operations/offline-lp-packaging.md)

Generated local evidence: `family-office/validation-mailroom-v1/report.html`, `findings.md`, `assessment.md`, `email-results.csv` and `aster-100-email-demo.zip`. The ZIP opens offline and includes the 100 source emails and 57 inspection PDFs. It is an inspection package, not the proposed Linux VM installer.

Inspection ZIP SHA-256: `abcb6d03039f706f9fcd63d47fedd86d5b19fa93d9fb5a512ace156f72c77f23`.
