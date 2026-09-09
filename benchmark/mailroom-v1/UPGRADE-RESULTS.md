# Completed comparison of the upgraded extraction pipeline

Completed 9 September 2026: **all four configurations recovered 90/90 expected fact observations, with zero unsupported persisted facts**. The extraction run stayed pinned to **ab7c919**, with unchanged original messages, gold and baseline results. The final scorecard is dated **13:07:07 UTC**; processor and model-transport audits passed at **13:08:17–18 UTC**. This is a completed synthetic regression comparison, not production qualification. This report was prepared in the isolated engine-inspection worktree.

## Completed results and denominators

The actual collector processed 100 synthetic receipts across three offices and nine inboxes into 97 unique tenant/source jobs per configuration. Identical receipts within an office share an encrypted original and job; cross-office identity remains separate. The full plan contains 388 jobs and 400 receipt views. Real Gmail delivery, OAuth and internet access were replaced by deterministic local provider responses; production pagination, cursors, replay, storage and tenant boundaries were exercised. No financial posting was automatically approved.

| Configuration | Finalized jobs | Readable results | Exact/gold facts | Readable relevance | Unsupported persisted facts | Explicit encrypted blocks |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Gemma workflow | 97/97 | 94 | **90/90** | **94/94** | 0 | 3 |
| Gemma agentic | 97/97 | 94 | **90/90** | **94/94** | 0 | 3 |
| Qwen workflow | 97/97 | 94 | **90/90** | **94/94** | 0 | 3 |
| Qwen agentic | 97/97 | 94 | **90/90** | **94/94** | 0 | 3 |

Each cell has 93/93 fact observations in the 100-receipt view, with 97 readable receipts and three blocks. The primary 90 observations are per unique tenant/source job, not 90 distinct economic events: they represent 72 events. Across the four cells, 376 jobs await review and 12 are blocked. Blocked inputs return HTTP 422, remain failed jobs, return no facts and are not counted as successful extraction. Nested EMLs now decode within explicit budgets; encrypted PDFs remain unsupported.

The preserved [baseline](RESULTS.md) scored **60/90** in all four configurations, with three nested-email failures plus three encrypted-PDF failures per cell. All upgraded cells recover the previously missed 30 observations and the nested sources. First processor-HTTP and stored-output results agree in every cell, with no scored fact/relevance disagreement between modes. Internal model retries can occur within one HTTP attempt.

Local evidence: [final audited snapshot](../../../validation-extraction-v2/upgrade-results-final-snapshot.json), [preserved earlier three-cell snapshot](../../../validation-extraction-v2/upgrade-results-three-cell-snapshot.json), [final summary](../../../validation-extraction-v2/mailroom/summary.json), [scored rows](../../../validation-extraction-v2/mailroom/scorecard.json), [denominator audit](../../../validation-extraction-v2/mailroom-denominator-audit.md), [run procedure](UPGRADE-RUN.md). Generated evidence paths are sibling workspace artifacts, not shipped application assets.

## What improved, and what the result does not prove

The repair combines bounded nested-email decoding, table row/owner/header-unit handling, operational-news classification, correction/withdrawal exclusions and permanent-input failure handling. Both modes share original text, separate native layout, literal search, selected source-page images and independent source evidence checks. Agentic mode chooses document actions and order; workflow uses a fixed sequence with bounded recovery. Both are hybrid systems containing source rules and an LLM, rather than independent implementations of extraction correctness.

**The source-rule floor on this corpus is already 90/90.** The independent no-inference replay recovers all 90 expected observations, and source tools contributed that floor in each completed cell. Models frequently rediscovered those observations; deduplication kept one supported result. This main corpus therefore verifies the repaired combined pipeline and integration. It does not show that the LLM alone discovered 90 facts, or that agent/vision calls caused the recall gain. [Source-only replay](../../../validation-extraction-v2/evidence-repair-role-schema-denominators.json).

The separate ten-source development probes deliberately have **zero deterministic discoveries**. At final-v4, each of the four configurations recovered five positive facts and passed five negative controls: **20/20 positive observations, 20/20 negative controls, 40/40 relevance, zero unsupported outputs**. That is evidence of source-backed model contribution beyond the rules. These authored fixtures were used during development; earlier versions scored 11, 18 and 18 of the 20 positive observations before reaching 20. The preserved history is tuning evidence, not an untouched holdout or a population accuracy estimate. [Final probes](../../../validation-extraction-v2/capabilities-final-v4/summary.json), [history](../../../validation-extraction-v2/capabilities-final-v4/same-source-history.json).

## Raw mistakes are rejected, not absent

| Completed configuration | Raw fact-item occurrences | Schema rejected | Grounding rejected | Grounding-approved occurrences |
| --- | ---: | ---: | ---: | ---: |
| Gemma workflow | 137 | 0 | 39 | 98 |
| Gemma agentic | 122 | 0 | 31 | 91 |
| Qwen workflow | 104 | 12 | 14 | 78 |
| Qwen agentic | 166 | 18 | 16 | 132 |

These are repeated proposal occurrences, including duplicates and retries, not unique mistakes, additional accepted facts or raw model accuracy. Gemma attributed a whole-fund amount to an investor and repeated a withdrawn NAV on retry; the validator excluded both. Qwen sometimes repaired a currency-prefixed amount after schema rejection, but also repeated invalid formatting on another source. Qwen agentic proposed a withdrawn NAV that grounding rejected. The source rules had already covered the legitimate observations. A correct final review candidate does not establish that every intermediate model response or prose summary was correct. [Raw-behavior analysis and original response links](../../../validation-extraction-v2/model-behavior-notes.md).

## Tool use and observed cost

| Completed configuration | Recorded chat calls | Image-bearing chats | Model-covered/source-readable pages | Median processor request | P95 processor request |
| --- | ---: | ---: | ---: | ---: | ---: |
| Gemma workflow | 125 | 64 | 118/154 | 17.186s | 60.256s |
| Gemma agentic | 420 | 57 | 154/154 | 42.271s | 73.503s |
| Qwen workflow | 125 | 0 | 118/154 | 13.419s | 30.611s |
| Qwen agentic | 604 | 0 | 154/154 | 39.150s | 86.040s |

All source rules inspected the 154 readable pages. Both workflows made seven bounded page revisits. Gemma agentic used 154 extraction replies plus 266 planner actions, including 18 reads and 94 finishes. Qwen agentic used 255 extraction replies plus 349 planner actions: 255 extracts and 94 finishes. Broader model coverage and repeated extraction did not add final facts on this corpus. Available tools need not be selected: literal search, separate layout inspection and coverage-review actions were available but neither completed agent run used them.

Gemma accepts actual bounded source images; the installed Qwen CPU alias advertises no vision and explicitly uses text/layout. Image counts include repeat submissions and do not measure vision accuracy or incremental benefit. Image-only proposals without independent readable evidence cannot become trusted facts. First-request durations include decode/model work and failed inputs, but exclude queue/retry waiting. Models differ in size, quantization and CPU/GPU configuration; local UI/build activity overlapped part of the run. These are observational timings, not hardware-normalized rankings.

## Audit and release implications

All **388 processor requests and responses** passed exact original-byte and engine-pin verification, with zero missing/mismatched records or processor retries. The model audit verified **1,632 recorded requests, including 1,274 chats and 121 image-bearing chats**, with zero errors. It reconstructed actual request bodies and checked model identity and image provenance against independently decoded original pages. An independent consistency audit passed **5,829 checks and 1,576 strict scoring replays**, with zero issues. Integrity and consistency checks do not establish customer production accuracy. [Processor audit](../../../validation-extraction-v2/mailroom/attempt-integrity.json), [model/image audit](../../../validation-extraction-v2/mailroom/model-attempt-integrity.json), [consistency audit](../../../validation-extraction-v2/final-report-consistency-audit.json).

The engine-inspection feature was tested at isolated revision **05ed07b** and integrated into main through **0af1882** with identical tested code, after the benchmark source freeze ended. The benchmark itself remains an ab7c919 result. Actual desktop/mobile browser QA exercised synthetic password/TOTP login and installed Gemma/Qwen metadata. The panel distinguishes advertised vision, deployment disablement and testing; its digest is **observed, not pinned to jobs**. Model/tool limits remain deployment settings, without per-profile overrides. Full checks passed **588 Python tests, 326 Node tests with 35 integration skips, lint, TypeScript, production Next build and service bundles**; main build/TypeScript/service bundles passed again after integration. [UI QA](../../../validation-extraction-v2/engine-panel-qa/QA.md), [validation](../../../validation-extraction-v2/engine-panel-validation.md).

All nine synthetic connections were retired and verified inactive; owned benchmark services were stopped. Ordinary-service restoration belongs to the operator handoff. [Retirement audit](../../../validation-extraction-v2/mailroom/retirement-integrity.json). The main source-only result, model-only development probes and this full collection run remain distinct evidence layers. These observations do not qualify multilingual customer documents, economic posting dedupe, look-through completeness, stress tests, real mailbox OAuth or a Linux offline appliance. Those are production qualification limits, not unfinished extraction fixes. See the [offline qualification plan](../../operations/offline-lp-packaging.md).
