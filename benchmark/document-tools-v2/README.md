# Source-tool capability probes

These ten fictional text documents test whether a selected local model can add a source-backed fact that the deterministic extractor does not enumerate. Five contain valuation, funding, distribution or operating-news facts; five exercise withdrawals, illustrations, negation, an office supplier invoice and malicious instructions. The ambiguous dollar symbol deliberately has a null currency.

The sources and expected answers were authored after the extraction repairs and before actual model execution, with owners and figures different from the focused unit tests. This is a development capability set, not an independently adjudicated or unseen population accuracy estimate. The existing 100-email corpus remains unchanged and provides separate regression evidence.

`manifest.json` binds every source and `holdout.json` by SHA-256. Only the runner/scorer reads expected answers; the processor receives the original TXT bytes, selected engine and processing mode. All ten sources yield zero deterministic facts in the repaired revision; the five positive reference witnesses pass candidate-directed grounding. These statements describe source-only checks, not model results.

## Running a controlled probe

First stage an unused directory, without inference:

```sh
python benchmark/document-tools-v2/run_capabilities.py prepare \
  --run /private/local/path/preflight \
  --cases model-only-fair-value model-only-requested-contribution
```

The preparation writes exact originals, decoded one-page source views, an eight-job plan (two sources × two models × two modes), and the source registry for `benchmark/mailroom-v1/record_models.py --preflight`. Start the local recording proxy and processor with the same plan before execution. The models are `gemma4:e4b-m3` and `qwen3-aster-cpu:1.7b`; the runner never installs or substitutes them.

Provide `PROCESSOR_TOKEN` in the process environment, then run:

```sh
python benchmark/document-tools-v2/run_capabilities.py run \
  --run /private/local/path/preflight --execute
```

The fixed processor address is `http://127.0.0.1:8000/v1/extract`. Redirects and environment proxy discovery are disabled. No credential is written into artifacts. Processing source files and classifier training data are fingerprinted before and after each request. The first HTTP result, full extraction response, validation trace, strict score and elapsed time are retained per job. There are no automatic retries, overwrite or silent resume. A context mismatch, unsupported returned fact, critical boundary failure or model context error stops execution for investigation.

Stage a new directory to test additional selected cases. Do not change a running processor revision or reuse a result directory. A fresh run must retain failures from the prior attempt rather than presenting a retry as the original outcome.

## What the evidence verifies

The strict scorer checks six financial fields, source page, a contiguous source quote and authored evidence anchors. Model-only grounding separately requires literal owner/subject attribution, local event and monetary roles, explicit dates/currency and complete-source status checks. It can accept a model proposition even when deterministic enumeration misses the wording, owner label or another period for the same holding.

The processor now supplies source-derived calendar-date options to the model and constrains each date field to their ISO spellings plus null. It does not repair non-ISO output or weaken the public/internal fact schema. More than 32 unique source dates leaves the strict ISO schema unrestricted by enumeration and produces an explicit limit diagnostic. Effective versus due-date roles remain subject to independent verification. Candidate rejection feedback can identify another source-verified event kind; the model must submit a new candidate, and the processor does not silently relabel it.

Geometric layout can support row attribution only when its token inventory matches the native page and the evidence quote includes the complete native page. This prevents a lossy alternate view from omitting a withdrawal or introducing numeric text. Cropped cross-view evidence on long pages still needs explicit span mapping; a model-created transcript is not accepted as an original source.

The probes do not validate financial posting, look-through relationships, summary completeness, real mailbox authentication, whole-host network isolation or production accuracy. Returned facts remain review candidates. Classifier probabilities remain raw uncalibrated TF-IDF/logistic probabilities; independently grounded source facts can keep a mixed operational/investment document relevant even when the classifier alone scores it below 0.5.
