# Aster document processor

Python service for reviewable candidate extraction from TXT, EML and PDF. Workflow and agentic execution return the same versioned schema and independently select a local or explicitly enabled cloud engine. The processor never posts holdings, sends mail, browses arbitrary URLs, runs document-supplied commands or downloads models. Cloud inference is disabled by default and never serves as an implicit fallback. Checked-in corpora and evaluation records are synthetic. See [engine configuration](../operations/engines.md) for encrypted profiles, provider request formats and the separate cloud-processor deployment boundary.

## Run locally

Use Python 3.12. From this directory, create a private runtime and install the pinned dependencies:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
export PROCESSOR_TOKEN="$(python3.12 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=gemma4:e4b-m3
export OLLAMA_TIMEOUT_SECONDS=120
export OCR_ENABLED=true
export MAX_AGENT_STEPS=32
export MAX_MODEL_CALLS=64
export MAX_PAGE_EXTRACTIONS=2
export VISUAL_PAGES_ENABLED=true
.venv/bin/uvicorn service.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --no-access-log --limit-concurrency 8 --timeout-keep-alive 5
```

Start a separately managed Ollama daemon with `OLLAMA_NO_CLOUD=1`, or configure its documented `disable_ollama_cloud` setting and restart that daemon. Use an operator-provisioned local model. The processor checks `/api/show` for a local GGUF model without remote-host/model metadata, rejects model tags containing `cloud`, and never pulls models. Its environment cannot change an already-running daemon's cloud setting. The operations stack additionally supplies an internal processor/Ollama network; there is no cloud fallback.

OCR is enabled by default. PDFium renders scanned pages locally. Linux uses installed Tesseract with its English language data; the Dockerfile supplies both. On macOS, Apple Vision is the local fallback when Tesseract is absent; the pinned PyObjC dependencies install only on Darwin. An unavailable OCR engine produces a warning and no invented text. No OCR model is downloaded at request time.

`GET /healthz` is unauthenticated liveness only, not model/OCR readiness. `PROCESSOR_TOKEN` is mandatory, must contain at least 24 characters, and obvious REPLACE/CHANGEME/TODO placeholders are rejected. Configure the same generated secret in the calling backend and processor; requests use `X-Processor-Key`.

```sh
curl http://127.0.0.1:8000/v1/extract \
  -H "X-Processor-Key: $PROCESSOR_TOKEN" \
  -F file=@corpus/sample-capital-call.txt \
  -F mode=workflow \
  -F document_id=synthetic-example-1
```

The shell variable keeps the secret out of the literal command. The application backend owns encrypted storage, tenant authorization, review and posting. This service accepts an authenticated internal caller and does not implement tenant authorization itself.

## Contract

Multipart fields are `file`, `mode` (`workflow` or `agentic`), `document_id` (1-128 ASCII letters, digits, underscore or hyphen) and optional `engine` JSON. The authenticated backend sends its pinned `{name,provider,model,apiKey?}` configuration; the browser does not send secrets directly to this service. Missing `engine` retains the deployment-local default for legacy callers. Cloud selection requires this processor's `ALLOW_CLOUD_ENGINES=true`; invalid/disabled selections return a generic error without echoing credentials. The response's `execution` is `local` or `cloud` and is checked against the job pin by the worker.

Authenticated `GET /v1/models` discovers installed local GGUF metadata only. `POST /v1/engine-test` accepts an engine configuration and runs one bounded synthetic schema request through the same model adapter. It returns `{ok,errorCode}` with no raw provider response. All `/v1/` endpoints authenticate and bound input before body parsing; test bodies are limited to 64 KiB. A successful check establishes connectivity and that schema response only, not extraction accuracy or tool certification.

Authenticated `POST /v1/engine-info` accepts the same engine configuration and returns strict, sanitized metadata and effective processor limits. Its disposable process has a 20-second deadline and shares document concurrency and disconnect cleanup. For a local engine it checks the exact configured alias through bounded `/api/show` metadata, then optionally observes a unique valid digest from bounded `/api/tags`. Missing or malformed capability metadata remains unknown; explicit metadata without vision is unsupported. Deployment image disablement is reported separately. Cloud inspection makes no provider call and reports the current adapters' image-disabled policy. No inspection generates text, sends an image, downloads a model, or pins weights to jobs. The administrator panel resolves an exact active or current saved profile revision before releasing its tenant transaction and requesting metadata; stale selectors fail instead of selecting another revision.

```json
{
  "schemaVersion": 1,
  "documentId": "synthetic-example-1",
  "mode": "workflow",
  "execution": "local",
  "documentType": "capital_call",
  "relevant": true,
  "confidence": 0.75,
  "facts": [
    {
      "kind": "capital_call",
      "investmentName": "Cedar Partners IV",
      "effectiveDate": "2026-08-20",
      "amount": "420000.00",
      "currency": "EUR",
      "dueDate": "2026-09-03",
      "summary": "Synthetic capital call Investment: Cedar Partners IV Notice date: 2026-08-20 Capital call amount: EUR 420,000.00 Due date: 2026-09-03",
      "evidence": {
        "page": 1,
        "quote": "Synthetic capital call\nInvestment: Cedar Partners IV\nNotice date: 2026-08-20\nCapital call amount: EUR 420,000.00\nDue date: 2026-09-03"
      }
    }
  ],
  "warnings": [
    "Candidate facts only: review against the original before any financial posting."
  ],
  "trace": [
    {
      "stage": "rules",
      "status": "ok",
      "detail": "Page 1: 1 source-derived candidates."
    }
  ],
  "model": null
}
```

This example is illustrative. `confidence` is an **uncalibrated synthetic relevance-classifier probability**, not extraction accuracy or financial correctness; actual responses include that warning. `documentType` is `valuation`, `capital_call`, `distribution`, `news`, `mixed` or `unknown`, derived from validated candidates. Trace statuses are `ok`, `skipped`, `warning` and `error`. Unknown dates, amounts and currencies remain null. Money is a plain decimal string; dates use ISO calendar dates. Responses have no extra top-level keys.

A model failure returns a valid response containing previously validated source facts, explicit warnings and an error trace. It does not claim complete coverage or retry through another provider. HTTP outcomes include 401 for failed authentication, 413 for oversized input, 422 for unsupported/malformed input, 503 while busy and 504 for the hard document deadline.

## Execution and source validation

Both modes use the same source-anchored event parser and strict evidence validator. The parser recognizes supported labelled and narrative event wording, explicit natural-language or ISO dates, and unambiguous grouped decimal formats, including European decimal punctuation and correctly grouped Swiss apostrophes. Explicit minus signs are preserved; ambiguous parentheses and unsupported attached numeric suffixes are rejected. Whitespace-normalized PDF line breaks can occur between a currency and its amount. A bare `$` does not imply USD. Ambiguous values remain unknown. No exchange rates, cash flows or performance returns are calculated.

Explicit row-major financial tables use their investment, event date, currency and event-amount headers to bind each row independently. Table amounts cannot fall back into surrounding prose and borrow another fund's identity. Unsupported or ambiguous table rows produce a page-specific coverage warning; neither execution mode silently treats them as a complete read. Literal evidence must still contain the source headers and values within the quote limit. Payment-receipt deadlines are scoped to the current capital call, with administrative and negated deadlines excluded. Illustrations and withdrawals remain exclusions for table rows as well as prose.

**Workflow:** a seeded TF-IDF/logistic model trained on a separate synthetic training corpus estimates coarse relevance. Negated financial topics are excluded from that statistical input; evidence stays unchanged. Source parsing inspects every readable page. A complete labelled notice may bypass model review; unresolved financial or narrative material reaches the selected model in bounded windows, with native layout and an original page image when available and supported. A rejected, unresolved financial candidate can receive a second attempt with concrete validation feedback. Grounded facts override a negative relevance prediction while its raw probability remains unchanged. No pickle or untrusted classifier artifact is loaded; benchmark documents are not training rows.

**Agentic:** the selected model chooses `read_page`, literal `search`, `inspect_layout`, `inspect_image`, `extract`, `review_coverage` or `finish`. It can extract a page directly, choose page order, inspect an image, revisit a page and act on validator feedback. Extraction uses the same document tools and evidence rules as workflow. The current action allowlist is enforced both in the output schema and Python. Extraction is listed before optional diagnostics, with untouched pages first. Finish requires an extraction attempt on every readable page and one further attempt when a rejected candidate has an independently verified repair and the page/model budgets permit it. A failed or unavailable recovery remains an explicit manual-review warning; an empty retry does not erase it. Source facts survive a separate model failure. Structured JSON actions support providers without native tool calling; returned native tool calls are never executed.

`MAX_AGENT_STEPS` now counts planner actions (default 32, range 1–64). `MAX_MODEL_CALLS` caps all structured calls in either mode, including planner calls (default 64, range 1–96). `MAX_PAGE_EXTRACTIONS` caps extraction attempts per page (default 2, range 1–3). Reads/layout inspections are limited to two per page, searches to four per document and coverage audits to two. These ceilings do not extend the independent 590-second document deadline. Tools can read only this decoded document; they do not expose arbitrary files, URLs, code execution, financial posting or mailbox actions.

Model extraction uses source windows of at most 2,800 UTF-8 bytes with up to 350 bytes of overlap, without splitting Unicode codepoints, and prefers a nearby newline boundary. Each has an immutable identifier derived from its page, native character offset and text hash. Models cite that identifier; the application constructs the exact evidence quote. Unknown or wrong-page identifiers are rejected. Strict legacy quote responses remain supported. Auxiliary layout is capped at 2,400 UTF-8 bytes per request, with explicit truncation notices; complete native text remains windowed separately. Planner history/previews are reduced before page identities and coverage state. Unicode is transmitted directly rather than expanded into escape sequences. Remaining windows and unread/unextracted pages are reported when a budget is exhausted. Traces distinguish rules, model context, image requests and validation. Final coverage and usage survive trace truncation. Coverage is not proof that every fact was found.

Every candidate must pass the strict financial schema and source validation. Its contiguous quote must occur on the cited page after whitespace normalization. The investment, event wording and each non-null amount, currency and date must be supported by that quote and compatible with the source event. Source roles are checked against the complete decoded page, including text outside a model window, helping prevent an investor value from borrowing another fund's amount, a due date from becoming a valuation date, or a withdrawn value from being treated as a new current event. Same-period corrections remain distinct from valid historical reporting periods. Quoted instructions to invent or approve values are not financial events.

A genuine model quote may be expanded to the complete native page when that page fits the 3,000-character evidence limit; a fabricated quote is never repaired. Source-ID responses resolve to their exact bounded source block. The application replaces model-written summaries with the verified source excerpt. Exact repeated facts and uniquely supported partial duplicates are consolidated; conflicting amounts/dates are not silently merged.

The validator also has a candidate-directed path for unfamiliar literal owners and financial predicates. A model proposal need not be rediscovered by deterministic enumeration, but its subject, amount, currency, event and dates still need compatible local source roles. Competing owners, whole-fund totals, illustrations and withdrawals remain exclusions. Native spatial layout can support a reordered table only with a complete native-page quote. A vision-only proposal without independently readable text is review-required and cannot become an accepted fact.

Source-derived schema choices share the verifier's eligible evidence scope: the exact source block, or its containing native page when that page has the same identity and fits the existing 3,000-character quote-expansion limit. A different page, noncontained block or longer page cannot broaden the scope. Source IDs remain bound to the original block, and any expanded proposal still requires independent verification. Event-type choices use the same necessary semantic checks as the validator; mixed sources retain every supported type, and uncertain/no-match sources retain the original choices.

The date tool supplies canonical ISO spellings of explicit source dates and constrains model date choices when there are at most 32 distinct dates in the eligible evidence scope. Deadline choices use the same source-role recognition as grounding; without a supported deadline, `dueDate` is null-only. Structural deadline headers conservatively retain the source dates for subsequent row/owner verification. Larger inventories retain the ordinary ISO schema with an explicit hint-limit notice. Currency choices use literal recognized source codes and supported symbols; a bare `$` cannot select USD. An uncertain currency inventory retains the original currency schema. These tools constrain proposals without correcting model outputs; public and internal financial schemas remain strict.

If the source contains no monetary value or numeric/uncertain syntax outside its literal calendar dates, the amount field is JSON null-only. Actual numbers, unsupported numeric formats, percentages, currency symbols and number/scale words retain the ordinary strict decimal schema. This prevents dates or unrelated invented figures from becoming amounts in text-only news; it never converts the string `"null"` into a valid field. Extraction instructions contain no fictional financial amounts or dates.

For rejected model candidates, the evidence tool can suggest another kind or removal of unsupported optional currency/deadline fields only after independently validating that alternative against the complete source page. Owner, amount and effective date are preserved for field-removal witnesses. Already accepted equivalent or fuller facts suppress mandatory recovery. Suggestions do not enter the results: the model must return a new candidate that passes the same validator. The recovery gate considers all verified witnesses even when displayed diagnostics are bounded.

Malformed JSON, unknown response-envelope keys, oversized candidate lists and invalid action schemas fail closed. In a well-formed `facts` envelope of at most 30 items, each fact is independently validated: invalid candidates are rejected and counted while valid candidates continue through the same evidence gate. This does not coerce money, repair dates or fill absent fields. Validation provides source support within implemented parsing rules, not independent confirmation of the document's truth, ownership, gross/net treatment or financial interpretation. Human review remains required.

## Bounds and confidentiality

- Input is limited to 10 MiB per file, plus 128 KiB multipart overhead, before multipart parsing. One document runs at a time; the image uses one Uvicorn worker with concurrency capped at 8. Busy requests receive 503 rather than entering an unbounded queue.
- Combined document limits are 40 pages and 120,000 extracted characters, with a separate equal layout-text budget. TXT uses UTF-8 and form-feed page breaks. EML permits at most 32 MIME parts, 8 attachments, 5 MiB per attachment and 10 MiB decoded content. Nested EML is decoded to depth three by default, with shared budgets across the entire tree; PDF/TXT attachments are also supported. Other formats remain skipped or rejected. Attachment ancestry is retained in page provenance.
- EML prefers a usable plain-text MIME alternative. HTML-only bodies are converted locally, preserving paragraph and table boundaries and decoding entities once. Scripts, styles, embedded active content and explicitly hidden elements are excluded; no browser or remote-resource fetch occurs. HTML conversion is bounded to 1,000,000 input characters, 20,000 elements, 128 nesting levels and the shared text limit. UTF-8/ASCII and a small explicit legacy-encoding allowlist are accepted; unsupported or malformed encodings produce warnings.
- PDFs require a matching signature and valid parse. Encrypted PDFs, top-level active actions/forms/embedded files and page actions are rejected. Parsing runs in a disposable child using the remaining shared document-decoding deadline (75 seconds by default, including nested emails and all attachments); Linux enforces 768 MiB address space, 50 CPU seconds and a 32 MiB output-file limit. This is not a complete PDF sanitizer or antivirus scanner.
- OCR applies only to pages lacking native text, with a shared default budget of four pages across the document and its attachments. PDFium rendering is bounded to a 2,000-pixel edge and 4 million pixels. Each OCR child has a 15-second parent timeout, 12 CPU seconds, a 16 MiB file limit and, on Linux, 512 MiB address space. Tesseract has a 10-second timeout and one OpenMP thread. The PDF OCR pass has a 60-second wall-time budget. OCR failure, missing tools or exhausted coverage produce explicit warnings; no text is inferred from an unreadable page.
- Selective page images use the same original PDF bytes, never a generated illustration. `VISUAL_PAGES_ENABLED` defaults to true; `MAX_VISUAL_PAGES=6` and `MAX_VISUAL_BYTES=8388608` apply across all attachments. Each PNG is at most 4 MiB, 2,000 pixels per edge and 4 million pixels. Image input requires verified capability metadata for the pinned local model. Unsupported models use available text/layout and report the limitation; no model or provider is substituted. Images are not sent through cloud adapters in this implementation. See [document-tool research and measured image probe](../operations/document-tools-research.md).
- Evidence keeps global page numbers. For EML, page 1 is the body and subsequent pages belong to supported attachments. `page_source` traces retain attachment ordinal and local PDF page; OCR sources additionally say `local OCR`. Quotes from OCR require visual review against the original image.
- Local model requests use `num_ctx=16384`, `num_predict=3200`, `think=false`, temperature 0 and seed 42. The adapter rejects text prompts whose combined system, user and schema content exceeds 11,500 UTF-8 bytes before generation, rather than relying on silent source truncation. This conservative text bound is separate from image limits; image tokenization remains model-dependent. The configured HTTP inactivity timeout defaults to 120 seconds and is capped at 180. Independently, each disposable document subprocess has a hard **590-second total wall-clock deadline**, including decoding, OCR and all inference. The API kills its process group on deadline, HTTP disconnect or cancellation and cleans the temporary directory before releasing the slot.
- HTTPX ignores inherited proxy settings (`trust_env=False`), disables redirects and caps response bytes. Local inference uses fixed `/api/show` and `/api/chat` paths at the approved local origin; discovery uses `/api/tags`. Approved local hosts are loopback, `ollama` and `host.docker.internal`. Optional cloud adapters use only the fixed official OpenAI Responses and Anthropic Messages HTTPS endpoints; no caller-supplied URL is accepted. The daemon, host DNS and host administrator remain trusted boundaries; local deployment networking must enforce egress denial.
- Document subprocesses receive a minimal environment, excluding processor authentication, database credentials, unrelated provider credentials and inherited proxy settings. The selected job configuration travels through private stdin. Synthetic engine checks share the processing concurrency slot and have a 140-second hard process deadline; document processing retains its 590-second deadline.
- Outputs are capped at 100 facts, 100 warnings and 100 trace steps, with explicit truncation notices. The processor has no document/result database, telemetry, request-body logging, persistent document cache or cloud SDK. Private temporary PDF/OCR files are removed after processing. Host/core dumps, encrypted swap/storage and independent security assessment remain deployment responsibilities.

## Tests and evaluation evidence

```sh
.venv/bin/python -m pytest -q
.venv/bin/python scripts/evaluate.py
.venv/bin/python scripts/evaluate.py --real-local --limit 1
```

The suite covers both modes against a loopback fake-Ollama server, strict candidate salvage, fabricated/contradictory fields, evidence checks, context and agent coverage, authentication, proxy/cloud/redirect rejection, MIME/size limits, HTML alternatives/entities/tables, PDF active-content rejection, OCR limits and shared attachment budgets. Fake-model replies test orchestration; they are not evidence of LLM extraction accuracy.

New adapter tests mock OpenAI/Anthropic transports and verify fixed endpoints, authorization headers outside prompts, structured-output request formats, refusal/redirect/error handling, strict candidate salvage, disabled-cloud rejection and child-environment secret exclusion. No real cloud account or credential was used. A separate local Gemma synthetic probe validated one allowed planner action in 8.791 seconds; it does not establish document accuracy. End-to-end profile/job checks and target-host readiness are recorded separately in the release validation record.

Native macOS decoding was also checked against the fixed synthetic workflow-lab corpus outside the app repository. The HTML-only funding email produced its visible investment/date/amount text. The image-only Alderholt statement produced 420 OCR characters through Apple Vision, including the correct investment name, date and EUR 4,870,000.00 amount, with OCR provenance and a visual-review warning. The scan's original bytes and benchmark ground truth were unchanged. Portable synthetic scan and native-text fixtures are checked in under `tests/fixtures/`. The real OCR regression uses the checked-in scan by default; `ASTER_OCR_TEST_PDF` can select another trusted synthetic scan. It skips if the fixture or local engine is unavailable.

Earlier actual model evaluations used `qwen3:1.7b` on the GPU. After measured GPU contention and a failed full-document 1.7B CPU preflight on this host, the earlier 44-document regression comparison used the already installed Qwen3 0.6B weights via `qwen3-aster-cpu:0.6b`, an operator-created alias with `PARAMETER num_gpu 0`. Both modes in that comparison shared the same frozen processor and runtime. Changing the weights and execution hardware prevents a controlled speed comparison with earlier runs. This alias is not bundled or downloaded by the app; provision and validate an approved model on each target host. See [the validation record](../VALIDATION.md) for failed attempts, historical results and coverage limits.

The subsequent 100-email, three-office baseline returned 60/90 expected facts in all four Gemma/Qwen and workflow/agentic configurations. That baseline predates the revised document tools, source-ID prompts and validation repairs described above. Keep its artifacts unchanged. The revised comparison is a separate qualification run; a successful synthetic image probe or decoder test is not a completed extraction benchmark. See [the document-tool decision and qualification record](../operations/document-tools-research.md).

The original 22-document realistic benchmark, later format-compatible diagnostic controls and model-contract tests serve different purposes and must remain separately scored. Older checked-in `eval/` results describe the version/model that produced them. Do not treat a synthetic pass, source-rule coverage or one successful scan as a blanket accuracy claim. Independent, authorized real-document evaluation is still needed for entity/date/currency/amount accuracy, abstention, revisions, multi-event layouts, multilingual material and scans.

## Docker

```sh
docker build -t aster-processor:local .
```

The image runs as UID/GID 10001 with CPython 3.12.13, locked Python package versions and English Tesseract. Its digest-pinned Distroless Debian 13 runtime contains no shell, package manager or Perl. The builder uses the same Debian release and Python ABI. The current build candidate compiles upstream Tesseract 5.5.3 and libtiff 4.7.2, with verified source authentication and SHA256 pins. Official CMake options disable OCR archive/URL input, graphical debugging and training tools; local PNG-to-text OCR is preserved. No OCR language data is downloaded at runtime.

This is an application runtime, not a general Python distribution: unused SQLite, Tk GUI/IDLE, curses/readline and native OS-UUID extensions are omitted; UUID4 retains Python's secure random implementation. The complete processor test suite and actual Linux OCR/HTTP subprocess probes must pass in the built image before release. Future dependencies needing an omitted module require a reviewed runtime change and new qualification, not an import-error fallback.

Pillow remains at the locked version 12.3.0, rebuilt from its official PyPI sdist against the same libtiff 4.7.2. Its previous Linux wheel bundled a separate libtiff 4.7.1; that wheel is not installed by this build. The isolated build environment uses hash-pinned setuptools 84.0.0 and pybind11 3.1.0 wheels with no dependency resolution. The source, build dependencies and resulting wheel hashes are recorded. Pillow retains PNG/zlib, JPEG and compressed TIFF. Optional FreeType/RAQM, LittleCMS, WebP, JPEG2000, imagequant, XCB and AVIF integrations are disabled. The processor renders PDF pages to PNG and accepts only PNG/JPEG for model images; it does not use those optional integrations. Its image bounds, decoder validation and PDFium rendering remain unchanged. Independently, libtiff retains Leptonica's existing compression codecs, including JPEG, zlib/deflate, JBIG, LZMA, Zstd, WebP and LERC.

Each build rechecks the libtiff archive's detached OpenPGP signature using Even Rouault's pinned public key (`B1FA7D81EEB8E66399178B9733EBBFC47B3DD87D`). It also verifies Tesseract's signed tag object `6951ffe10ce031374bcd04fe400811da1e7e04ad`, which identifies commit `db0ec62f81b0737fbbe184d8fea40af5738f8eef`, using Stefan Weil's pinned public key (`49236FEA75C95D698EC2B78AE08C21D5677450AD`). That tag signature authenticates the Git object and commit; the generated gzip archive has a separate reviewed SHA256 pin. The public keys, signatures/tag payload and exact URLs/hashes are retained under `/opt/aster/source-provenance`. See [source inventory](runtime/upstream-sources.json) and [build verifier](runtime/fetch-sources.py). Pillow's sdist hash comes from the official PyPI release metadata.

The assembly retains every copied system package's exact version, source identity, copyright and file checksums in Distroless `dpkg/status.d` metadata. The local builds are explicitly identified as `tesseract-ocr` version `5.5.3-1+aster1`, source `tesseract (5.5.3)`, and `libtiff6` version `4.7.2-1+aster1`, source `tiff (4.7.2)`; these are local upstream rebuilds, not official Debian binaries. Build options and sources are recorded in `/opt/aster/runtime-manifest.json`. Existing base packages are replaced as complete payloads when copied from the builder. The native dependency closure rejects the old Debian libtiff payload and puts the fixed shared library in the runtime loader cache. Both Pillow and Leptonica/Tesseract must resolve that library.

CI verifies retained file hashes, installed Pillow extension hashes against its wheel metadata, real Tesseract/system TIFF/Pillow TIFF versions, PNG/JPEG/compressed-TIFF round trips and actual source OCR. It independently requires Trivy to inventory every copied package and every Linux Python package in the lock. Canonical package/source identities and the HIGH/CRITICAL gate remain unchanged. In [run 34403006395](https://github.com/Blacklord100/aster-family-office/actions/runs/34403006395), commit `c9864ee`, the upstream rebuild passed source authentication, runtime probes and all 589 processor tests. Its scan covered all 27 copied native package identities and all 32 locked Python packages. Three HIGH findings (CVE-2026-36849, CVE-2026-52490 and CVE-2026-73066) remain because the Debian advisory entries lack fixed versions; the strict gate is still blocked despite the verified upstream replacements. No vulnerability is ignored, renamed away or treated as resolved merely because a base image scans clean. See [the exact qualification receipt](../validation/linux-qualification-2026-09-09.json).

No persistent document mount is required. A private writable `/tmp` can be `noexec,nosuid,nodev`; executables remain outside it. The operations stack supplies a bounded Python secret-file loader, read-only root filesystem, dropped capabilities, secrets, resource limits and an internal processor/Ollama network. Its separate mailbox worker's provider egress does not attach to this network.

Docker is unavailable on the development host. Native Apple Vision evidence does not validate Linux Tesseract accuracy, container startup, sandbox behavior or egress enforcement. Build/boot and representative OCR checks on the target Linux host remain required.

Runtime references: [official Python 3.12 Trixie build](https://github.com/docker-library/python/blob/master/3.12/slim-trixie/Dockerfile), [supported Distroless images](https://github.com/GoogleContainerTools/distroless#what-images-are-available), [Distroless package metadata](https://github.com/GoogleContainerTools/distroless/blob/main/PACKAGE_METADATA.md), [Tesseract 5.5.3 build options](https://github.com/tesseract-ocr/tesseract/blob/5.5.3/CMakeLists.txt), [libtiff releases](https://download.osgeo.org/libtiff/), and [Pillow source build options](https://pillow.readthedocs.io/en/stable/installation/building-from-source.html).

## Interface references

- [Ollama structured output](https://docs.ollama.com/capabilities/structured-outputs) and [chat API](https://docs.ollama.com/api/chat): schema output is independently validated.
- [Ollama FAQ](https://docs.ollama.com/faq): daemon cloud-disable controls.
- [HTTPX environment variables](https://www.python-httpx.org/environment_variables/): inherited proxies and `trust_env=False`.
- [FastAPI file uploads](https://fastapi.tiangolo.com/tutorial/request-files/): multipart interface.
- [pypdf extraction](https://pypdf.readthedocs.io/en/stable/user/extract-text.html): native-text limitations and memory risks.
- [PDFium Python rendering](https://pypdfium2.readthedocs.io/en/stable/python_api.html), [Tesseract CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html), and [Apple Vision text recognition](https://developer.apple.com/documentation/vision/recognizing-text-in-images): local OCR components.
