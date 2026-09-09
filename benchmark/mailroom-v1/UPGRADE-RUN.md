# Preserved comparison of the upgraded extraction pipeline

Operator notes for the September 2026 local workspace. These are explicit run steps, not evidence that the full run has completed. The earlier `../validation-mailroom-v1` results, gold and sources remain intact. New full-run output belongs in `../validation-extraction-v2/mailroom`.

## Preconditions and freeze

Use Node 24.20.0 and the existing Python environment at `../processor/.runtime/bin/python`. Database runtime/migration connections and the processor token come from `.env.local`; never print or copy that file into artifacts. The collector checks that both database URLs point to the isolated `aster` database on loopback port 55439 and that the runtime role cannot bypass RLS.

Complete focused source-grounding, document-tool and actual-model preflight checks before collection. `collect` creates the processing fingerprint, so stop editing all `processor/service/*.py`, `lib/server/*.ts`, contracts, worker and recorder/decoder helpers before that command. New top-level service modules are discovered automatically. The upgraded recorder and decoder helper files are also pinned explicitly. Reporting/scoring helpers remain independently amendable, with their code retained alongside the result.

Pause ordinary Aster document and mailbox workers, if running, and record their restoration commands. A mailbox worker can claim a synthetic schedule before collection removes it; process names alone may miss a worker launched from stdin. Verify the queues have no unrelated active jobs. Do not stop other projects' databases or workers. The comparison runner launches its own document worker scoped to the three new synthetic organizations. The web UI is not required for the benchmark.

The installed tags remain `gemma4:e4b-m3` and `qwen3-aster-cpu:1.7b`. No model downloads or model alias edits are needed. The actual local vision probe is separate from corpus accuracy. Runtime requests use the adapter's configured context bound; model tag metadata can have a different default context.

## Independent source decoding

The no-inference helper preserves text/layout, actual rendered PNGs addressed by SHA-256, original EML hashes, attachment ancestry and page identity. It checks frozen gold anchors without putting gold into any model input. Its output cannot overwrite an existing directory.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/decode_sources.py \
  --output ../validation-extraction-v2/corpus-decoded
```

This export was run on 9 September: 100 receipts, 97 decoded, three encrypted-PDF blocks, 57 page images, three OCR pages, and zero gold page/anchor mismatches. Nested email facts now remain on their existing gold page 3: outer body, nested body, nested PDF. All 94 previously readable documents retained their original evidence text. If decoder dependencies change, preserve this export and use a new directory such as `corpus-decoded-final`; update every command consistently.

`decode-index.json` pins the actual decoder dependencies and lockfile independently of unrelated pipeline changes. The full comparison later freezes every processor module. The scorer and model recorder reject a decoder registry that differs from the frozen run. PNG hash checks distinguish original rendered page evidence from generated descriptions.

## Prepare the fresh production collection

From the app directory, with Node 24 first on `PATH`:

```sh
node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts plan \
  --output ../validation-extraction-v2/mailroom

node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts collect --execute \
  --output ../validation-extraction-v2/mailroom \
  --gemma gemma4:e4b-m3 --qwen qwen3-aster-cpu:1.7b
```

This creates 100 receipts, 97 unique encrypted originals and four cells totaling 388 unique jobs/400 receipt views. No fact is accepted or posted. The collector's fake provider uses the production pagination, incremental cursor, replay, tenant isolation, storage and initial job paths. It sends no actual email and performs no real provider authentication.

## Start the recorder and processor

Finish any preflight requests, then stop the owned preflight recorder/processor before switching their context to this full run. Do not run two listeners on the same port. Start each long-running command in its own supervised terminal/session.

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/record_models.py \
  --run ../validation-extraction-v2/mailroom \
  --decoded ../validation-extraction-v2/corpus-decoded
```

The recorder binds only `127.0.0.1:11436` and forwards only `/api/show` and `/api/chat` to `127.0.0.1:11434`, without proxies or redirects. `state.json` and the runner's `current.json` select the only allowed model/job. Submitted images must hash-match rendered pages of the active original. Image bytes are stored once; exact request bodies are reconstructed from templates and hash references. Raw response bytes are retained. Health is available at `/healthz` without starting inference.

```sh
ASTER_PYTHON=../processor/.runtime/bin/python \
OLLAMA_BASE_URL=http://127.0.0.1:11436 \
MAX_AGENT_STEPS=32 MAX_MODEL_CALLS=64 \
VISUAL_PAGES_ENABLED=true ALLOW_CLOUD_ENGINES=false \
node --env-file=.env.local scripts/processor-dev.mjs
```

`processor-dev.mjs` resolves the Python path before changing the child's directory. The private processor token is inherited from the environment file. The ordinary owner engine setting is not changed. A processor health request is read-only; an engine generation check before the runner sets `current.json` will be refused by the recorder intentionally.

## Execute and observe

```sh
node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts run --execute \
  --output ../validation-extraction-v2/mailroom \
  > ../validation-extraction-v2/mailroom/runner.log 2>&1
```

In a separate session:

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/watch_report.py \
  --run ../validation-extraction-v2/mailroom \
  --decoded ../validation-extraction-v2/corpus-decoded \
  --interval 15
```

The runner processes Gemma workflow, Gemma agentic, Qwen workflow, then Qwen agentic. Resume only the same frozen run; completed and failed outcomes are retained. The observer writes an offline report without model calls. It includes observed tool/vision traces and independently recorded model-call counts, and retains all pending jobs in the denominator.

HTTP 400/413/415/422 now fail on the first worker attempt. Capacity 503 still defers up to its existing limit; shutdown and transient failures retain their prior handling. Therefore the new run may have fewer HTTP attempts than the baseline even before considering extraction improvement. First-attempt and stored-output metrics stay separate.

## Audit, report and retire

After all 388 unique jobs are final and the observer has completed:

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/verify_attempts.py \
  --run ../validation-extraction-v2/mailroom

../processor/.runtime/bin/python benchmark/mailroom-v1/record_models.py \
  --run ../validation-extraction-v2/mailroom --verify

../processor/.runtime/bin/python benchmark/mailroom-v1/write_findings.py \
  --run ../validation-extraction-v2/mailroom

node --conditions=react-server --import tsx --env-file=.env.local \
  benchmark/mailroom-v1/collect.ts retire --execute \
  --output ../validation-extraction-v2/mailroom
```

The processor-request audit proves which original EML bytes and engine pins were submitted. The model recorder audit reconstructs requests byte-for-byte, parses the submitted model and image values, and verifies their identity, counts and page provenance against the frozen plan and independently hashed registry. It also verifies recorded response bytes. The recorder pins its plan identity and registry index before requests begin; the scorer excludes in-flight recorder entries from completed transport counts. Neither audit is an accuracy measure. A record-level model audit can also be used on a partial preflight; it explicitly covers recorded transport only, not completion of the production matrix.

Review full exact grounded recall, unsupported facts, relevance confusion, source blocks, model-specific failures and differences between modes. Tool availability is separate from actual calls, valid image responses and correct financial facts. Confidence remains uncalibrated relevance probability. Compare the unchanged 100-email baseline with the separately authored development capability probes; do not describe either as independent production accuracy.

Stop the owned recorder and restore the processor's normal local Ollama origin before restoring the ordinary document worker. Restore the ordinary mailbox worker after synthetic connections and schedules have been retired. Retire only synthetic accounts/connections; preserve originals, jobs, results and audit evidence. No GitHub push is part of this local benchmark.
