# Mailroom collection and production workflow comparison

This is an operator-run synthetic demonstration, with no test route or authentication bypass in the application. It provisions three clearly labeled synthetic organizations, nine synthetic users and nine mailbox records. The synthetic users have no login credentials or sessions. Existing owners, organizations and engine policies are untouched.

The 100 frozen EML receipts include three exact copies within an office, so the real collector creates **97 encrypted originals and 97 initial jobs**. An identical source delivered to different offices remains separate. The four comparison cells produce **388 unique production jobs and 400 receipt-level result views**:

1. `gemma4:e4b-m3`, workflow.
2. `gemma4:e4b-m3`, agentic.
3. `qwen3-aster-cpu:1.7b`, workflow.
4. `qwen3-aster-cpu:1.7b`, agentic.

The first cell uses jobs created by the normal collector. The remaining cells explicitly create pinned comparison jobs against the same stored originals. No extracted fact is accepted or posted automatically.

## What is real, and what is simulated

`syncMailboxPage` receives its existing optional `fetcher` argument. This fixture adapter replaces Gmail transport only: backfill pages contain four messages, the last two messages per mailbox arrive through history, and replayed IDs are deliberately repeated. No Gmail/OAuth endpoint is contacted. Provider response parsing, cursor persistence, encrypted originals, receipt deduplication, tenant isolation and initial job creation run through the application code.

The normal `scripts/worker.ts` then performs leases, retries, engine-pin validation, processor requests, result validation and encrypted result storage. A bounded loopback recorder on port 8003 forwards the actual request to the existing processor on port 8000. It verifies the expected document, mode and local model before forwarding. Every HTTP request, response, error and duration is retained outside the repository. Raw Ollama transport is not instrumented; model-call counts come from the processor's actual `model_usage` trace.

The worker receives `WORKER_ORGANIZATION_IDS` containing only the three synthetic organizations. This optional operator routing setting accepts 1–100 unique UUIDs and fails closed on malformed/empty values. An absent setting preserves the normal global worker behavior. It is not an authorization boundary; database tenant checks remain authoritative. A real database test verifies that an unrelated job arriving after the first claim remains unleased with zero attempts.

The synthetic mailbox scheduling rows are removed after collection. Their fake credentials cannot later be used by an ordinary mailbox scheduler to contact Gmail. All connector state remains inspectable until retirement.

## Run locally

Use the project's Node 24 runtime, Python processor environment, and isolated Aster PostgreSQL database on loopback port 55439. Existing `.env.local` supplies private database/processor settings; never print or copy it into run artifacts. Models must already be installed as local GGUFs. The harness does not download models or enable cloud execution.

Pause the ordinary document worker before collection; a scoped experiment worker starts during `run`. Keep the processor and selected model files unchanged for the entire comparison. Restore the ordinary worker when the experiment finishes.

```sh
node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts plan

node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts collect --execute \
  --output ../validation-mailroom-v1 \
  --gemma gemma4:e4b-m3 --qwen qwen3-aster-cpu:1.7b

node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts run --execute \
  --output ../validation-mailroom-v1
```

`run` resumes from durable jobs and never repeats a completed or failed job to select a better answer. `--through-cell 0` can stop after the first complete cell. The production worker's normal bounded retries remain enabled; the scorer reports first-attempt and eventual stored outcomes separately.

The collection checks validate exact original bytes, pagination/history completion, replay idempotency, tenant-local content dedupe, cross-office separation and restricted-role row-level security. The initial executed run passed **134 collection assertions**. The independently decoded corpus has 94 decoded EMLs, six explicit input blocks (three nested-message attachments and three password-protected PDFs), zero gold anchor mismatches and three OCR pages. This is a known input capability boundary, not evidence that all emails can be interpreted.

## Inspect, score and retire

While a run is active, read `progress.json` or `current.json`. Each finished job updates the complete `results.json` without including authentication secrets. The output folder contains fictional source content and exact model results; it should still be treated as an internal diagnostic artifact.

```sh
node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts export --execute \
  --output ../validation-mailroom-v1

../processor/.runtime/bin/python benchmark/mailroom-v1/score.py \
  --run ../validation-mailroom-v1 \
  --decoded ../validation-mailroom-100/corpus-decoded

node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts retire --execute \
  --output ../validation-mailroom-v1
```

Retirement refuses pending jobs, disconnects only synthetic mailboxes, removes their synthetic credentials/cursors and revokes their memberships/sessions. Originals, jobs, results, receipt history and audit evidence remain preserved. No original owner access changes.

`scorecard.json` retains all planned receipts, including pending/failed attempts. Primary metrics count unique tenant/original jobs; secondary metrics show mailbox receipt coverage. An exact fact requires all six financial fields, the correct source page, a contiguous quote and the required gold anchors. Unsupported facts, omissions, ambiguous-currency violations, observed model calls, decode errors, explicit safe input blocks and deterministic review-edit proxies are separate fields. Review proxies are not observed human review time. No claim about automatic ledger reconciliation, total exposure or posting deduplication follows from extraction accuracy alone.

The corpus is synthetic and was authored with its gold labels. Gemma and Qwen differ in size, quantization and CPU/GPU routing. These measurements are useful operational diagnostics, not independently validated production accuracy or hardware-normalized model rankings.

## Reproducibility and verification

`state.json` pins the corpus manifest, installed model inventory and hashes of every processor service module, all server modules, worker, contracts and collector. The runner stops if processing source or model inventory changes. Reports and scoring code can be improved offline without rerunning models; retain their hashes with a published scorecard.

```sh
python benchmark/mailroom-v1/test_score.py
ASTER_WORKER_SCOPE_INTEGRATION=1 node --env-file=.env.local \
  node_modules/vitest/vitest.mjs run lib/server/worker-scope.test.ts
```

The scorer tests cover missing planned cells, a first failed HTTP attempt followed by a valid stored result, exact grounded matching, model-call uncertainty, ambiguous currency and refusal to score a run against a different manifest. The scope test provisions and removes only its own synthetic queue fixtures.

## Observe the long run without starting inference

The optional observer watches changes to `results.json`, snapshots the scoring inputs, then runs scoring and HTML/CSV rendering sequentially in a temporary staging folder. It publishes each completed artifact atomically only after both commands succeed. A scoring or rendering error preserves the last good report and records the error in `observer-status.json`. The observer never contacts the database, processor, mailbox provider or model runtime.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/watch_report.py \
  --run ../validation-mailroom-v1 \
  --decoded ../validation-mailroom-100/corpus-decoded \
  --interval 15
```

Read `observer-status.json` for compact completed-job diagnostics and the full planned denominator. `recallOnFinishedJobsOnly` includes finished failures, and is explicitly a partial diagnostic until every cell finishes; it must not be presented as final accuracy. Artifact hashes identify the last fully published generation. `observer-events.json` atomically retains the latest 200 observer events.

The observer exits when all 388 unique jobs have final outcomes, on SIGTERM/SIGINT, or when `RUN/observer.stop` exists. It does not cancel or alter the experiment. `--once` produces at most one generation; `--command-timeout` bounds each child command to 5–120 seconds (default 60). The polling interval is bounded to 1–60 seconds. A private exclusive `observer.pid.lock` prevents duplicates. A crash may leave this lock behind: inspect its recorded PID/host before removing a stale lock; the observer never steals it automatically.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/test_watch_report.py
```

These offline tests verify partial/full denominators, exclusive lock ownership and preservation of the prior report when rendering fails. They do not launch a long-running observer.

## Generate measured findings after completion

`write_findings.py` creates an atomic `RUN/findings.md` linked to the portable HTML report and CSV. It reads preserved files only and refuses to produce final findings unless all 388 distinct unique jobs have final outcomes and all 400 planned receipt views are present. It reports grounded extraction, first attempts versus stored outcomes, retries, relevance confusion counts with unavailable results separated, categories, explicit input boundaries, warnings, model provenance and unscored capabilities. It does not select a model automatically.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/write_findings.py \
  --run ../validation-mailroom-v1
```

An optional `--allow-partial` produces a prominently stamped progress report; it does not change the denominator or turn unfinished work into a final claim. Re-running the generator replaces `findings.md`, so add human conclusions after the final generation or keep them in a separate document.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/test_findings.py
```

These offline controls verify the complete plan, partial-result refusal without overwriting an existing report, relevance confusion/unavailable counts, explicit partial stamps and atomic artifact creation.

Latency summaries include median, P95 and maximum observed processor HTTP duration. P95 uses the nearest-rank method: sort the `n` observed durations and select rank `ceil(0.95 × n)`, counted from 1, without interpolation. Missing durations are excluded; failed HTTP request durations remain included. First-attempt summaries use the first recorded request per job; stored-outcome summaries use the last recorded request per job. These measurements exclude queue waiting and retry delays and are not end-to-end email latency.

## Audit exact request bytes after completion

`verify_attempts.py` independently parses every preserved multipart request, including retries. It verifies the original EML file part against the frozen corpus SHA-256 and byte size, request/response bytes against their recorded hashes/sizes, and mode, document ID and local engine/model against the planned job and attempt metadata. Unexpected or duplicate form fields/headers are rejected. The file body is compared as exact bytes; nested MIME is never reserialized.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/verify_attempts.py \
  --run ../validation-mailroom-v1
```

The default refuses a partial plan. `--allow-partial` is available for explicitly labeled development audits. The atomic `attempt-integrity.json` contains counts, hashes and mismatch codes, never source payloads or authentication contents. Failed HTTP response bodies remain byte-verified even if they are plain text. A recorded transport/proxy failure without a response payload is explicitly counted as unavailable; it is not silently dropped or described as a verified response. A missing request payload or a final job without any recorded request is a provenance gap and fails the audit.

This proves which immutable original bytes were included in each recorded processor request. It does not prove that every request caused a model call: deterministic workflow notices and input failures are accounted for separately by the processing results.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/test_verify_attempts.py
```

Offline controls cover exact binary MIME preservation, modified originals, incorrect mode/cloud pins, tampered request/response metadata hashes, duplicate fields/parameters, explicit missing responses and plain-text HTTP failure bodies.

## Finish the portable inspection bundle

Wait for the observer to finish all 388 jobs. Its final scorecard and HTML/CSV generation must complete before the request audit, final findings and bundle are produced, in that order. The renderer can also be run manually against the final scorecard:

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/render_report.py \
  --run ../validation-mailroom-v1
../processor/.runtime/bin/python benchmark/mailroom-v1/verify_attempts.py \
  --run ../validation-mailroom-v1
../processor/.runtime/bin/python benchmark/mailroom-v1/write_findings.py \
  --run ../validation-mailroom-v1
../processor/.runtime/bin/python benchmark/mailroom-v1/bundle_demo.py \
  --run ../validation-mailroom-v1
```

The bundle refuses unfinished jobs, a missing/incomplete/failing request audit, mismatched or stale report artifacts, unsafe input paths and an existing output archive. It requires all 388 distinct final jobs and 400 receipt views, with a complete passing audit. If regenerating the scorecard, regenerate the report and findings before bundling. Optional human interpretation belongs in `assessment.md` or can be appended after the final findings generation.

`aster-100-email-demo.zip` is a portable **inspection package, not an application installer**. It contains the fictional corpus, measured results, request-audit summary, offline HTML/CSV and relevant operator documents. It excludes environment files, databases, credentials and raw processor request bodies. Existing archives are preserved; use `--output` with a new filename for another version.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/test_bundle_demo.py
```

The four small offline controls cover detailed completeness, unsafe paths/symlinks, no-overwrite publication and rejection of an audit from another run.
