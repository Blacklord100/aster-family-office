# Synthetic document benchmark

`holdout-v1` is the original frozen corpus and contains the runner, scorer and focused tests. `holdout-v1.1` preserves all 13 v1 source files and gold cases, then appends one new image-only scanned statement. The active v1.1 corpus contains 14 documents, 14 expected financial facts, and one separately reported fund-constituent capability probe.

This is a small English diagnostic benchmark, not a production accuracy estimate or a model ranking. The documents and gold were authored together before inference; the gold has not been independently adjudicated by another human. All names, amounts, addresses, issuers and transactions are fictional. Earlier processor evaluation fixtures were not reused. Once this corpus informs extraction changes, it becomes a regression set; use a new untouched version for another holdout claim.

The frozen initial Gemma matrix is preserved as `20260908T192614Z-3115a7d8` under the external results directory below. Both modes returned 6/14 exact source-supported facts (42.9% recall), eight missed facts and one wrongly attributed NAV. Those findings informed the `source-ownership-v1` parser candidate, so **v1/v1.1 are now development regression corpora for that candidate**. The complete candidate matrix `20260908T194944Z-27eeb285` returned 14/14 exact facts with no misses or unsupported facts in both modes. Both 28-attempt matrices, raw replies and measured timings remain preserved; `REGRESSION-COMPARISON.md` and `.json` in the external results directory compare them directly. See [the diagnosis and candidate freeze](DIAGNOSIS.md). This improvement measures the revised shared pipeline on development data, not general model accuracy.

## Corpus and scoring

Each version has a frozen `gold.json` and SHA256 `manifest.json`. The runner refuses changed source or gold bytes. Corpus coverage includes investor NAV tables versus whole-fund size, corrected and withdrawn marks, multiple reporting periods, original currency versus FX references, unknown dollar currency, capital calls, distributions with unknown capital/income split, forwarded and byte-identical emails, irrelevant news, an instruction embedded in an email, undisclosed constituent weights, and an image-only scan.

A supported exact fact must match all six fields (`kind`, `investmentName`, `effectiveDate`, `amount`, `currency`, `dueDate`) and provide a contiguous quote on the correct decoded source page containing the frozen evidence anchors. Decimal strings compare exactly without binary floating-point rounding. A required null differs from an absent field. Name matching tolerates only case and whitespace differences. Extra or duplicate predictions count against precision; missing facts and failures remain in recall denominators. Empty gold cases pass only with a completed output and no returned facts. Relevance classification is scored separately from financial facts.

The correction report estimates additions, removals, individual field edits and evidence repairs needed to match gold. These are deterministic **reviewer-edit proxies**, not measured human corrections, actual review time, or minimum edit distance. Summary wording is not scored. The revision and FX gold also records the expected downstream review boundary, but this runner does not accept facts, post ledger entries or test correction UI behavior.

The underlying-constituent probe expects one disclosed weight of 42.5%, a named constituent with an unknown weight, and a 57.5% unresolved remainder. The current extraction schema cannot represent constituents. The report therefore displays a capability gap and excludes constituent weights from the ordinary fact-recall denominator. Recovering that document's NAV does not establish look-through support. This probe concerns the financial-fact processing schema. The separate Knowledge & managers indexing/proposal review path is exercised by its own API/browser tests (see [intelligence](../operations/intelligence.md)); this benchmark does not score that path.

The three copies of call 07 test extraction consistency across direct, forwarded and byte-identical inputs. The report does not describe that consistency as a successful posting-deduplication test: no application database is used.

## Run without inference

From the application directory, use the existing processor Python runtime:

```bash
/Users/mithuran/Documents/Codex/misc/family-office/processor/.runtime/bin/python benchmark/holdout-v1/run.py --validate-corpus
/Users/mithuran/Documents/Codex/misc/family-office/processor/.runtime/bin/python benchmark/holdout-v1/run.py --gemma-model gemma4:e4b-m3
PYTHONDONTWRITEBYTECODE=1 /Users/mithuran/Documents/Codex/misc/family-office/processor/.runtime/bin/python -m pytest benchmark/holdout-v1/test_benchmark.py -q --basetemp=/Users/mithuran/Documents/Codex/misc/family-office/validation-seven-items/benchmark/pytest-tmp
```

Validation decodes the originals, checks gold anchors, and records the scan's OCR outcome, without model calls. Native-text source/gold disagreements fail validation. Scan OCR misses are recorded rather than changing gold or excluding the scan. The scan has no native text and was visually reviewed against its manually specified CHF 482,617.09 NAV at 30 June 2026.

The default runner invocation only prints a plan and makes zero network requests. It requires `--execute` for actual inference.

## Run actual selected local models

Coordinate with other users of the local inference service first. No reset, unload, service restart, application profile activation, owner account or private portfolio is needed. The exact installed Gemma tag is `gemma4:e4b-m3`; the optional Qwen tag is `qwen3-aster-cpu:0.6b`.

Scan smoke run, both modes, in a separate preserved run directory:

```bash
PYTHONDONTWRITEBYTECODE=1 /Users/mithuran/Documents/Codex/misc/family-office/processor/.runtime/bin/python benchmark/holdout-v1/run.py --corpus benchmark/holdout-v1.1 --gemma-model gemma4:e4b-m3 --case scanned-nav --repeat 1 --execute
```

Full Gemma matrix: all 14 documents, workflow and agentic, one repetition each:

```bash
PYTHONDONTWRITEBYTECODE=1 /Users/mithuran/Documents/Codex/misc/family-office/processor/.runtime/bin/python benchmark/holdout-v1/run.py --corpus benchmark/holdout-v1.1 --gemma-model gemma4:e4b-m3 --repeat 1 --execute
```

Add `--qwen-model qwen3-aster-cpu:0.6b` for a second explicitly selected local model. No cloud adapter or credentials are accepted by this benchmark; no cloud quality claim is supported. `--mode workflow` or `--mode agentic` limits a smoke run; `--case` may be repeated. Every repetition is kept; no best-of selection or hidden retry is performed.

Requests have a 120-second timeout by default, agentic mode has at most 16 structured calls, and each document/mode child is terminated at 900 seconds. The full 28-attempt Gemma matrix therefore has a hard document-timeout ceiling of seven hours, plus bounded inventory/decode overhead; actual observed timings should be reported instead of this worst-case bound. Calls are sequential, so model cache state and local contention affect latency. Native-text workflow cases satisfied by source rules may make zero model calls; those cases are explicitly identified and do not measure model reasoning.

## Preserved results

Every run receives a new directory under:

`/Users/mithuran/Documents/Codex/misc/family-office/validation-seven-items/benchmark`

No outputs are written into the application repository. Each run contains:

- `run.json`: immutable source/gold manifest, exact requested model and GGUF digest, processor file hashes, benchmark code hashes, Python version, complete plan and timeout settings.
- Per-attempt folders: decoded pages, exact extraction, execution metadata, score, captured stdout/stderr, and every local `/api/show` and `/api/chat` request with raw response bytes and timing metadata. Partial response bytes survive timeouts. Synthetic prompts and actual responses are preserved even when malformed or rejected.
- `results.json`: all attempted results, including failures, timeouts and partial pipeline output.
- `summary.json`: per-mode precision/recall, missing and unsupported facts, critical boundary failures, correction proxies, timing, actual model-call counts, OCR outcomes and capability gaps. Unrun planned attempts are listed explicitly.

Raw replies can include unsupported model claims. They are diagnostic records, not accepted financial evidence. The runner calls the production decoder and processing pipeline directly with the selected local engine; it records transport without changing prompts, validation, model options or orchestration. It never supplies gold to that pipeline. This tests processing behavior rather than HTTP queueing, tenancy, document acceptance or deployment capacity. Those require separate integration tests.

The single scan measures OCR on one clean printed page with mild blur. It does not support a general OCR claim for handwriting, poor scans, multilingual text or large attachments.
