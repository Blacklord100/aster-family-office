# Aster local document processor

Python service for reviewable candidate extraction from TXT, EML and PDF. Workflow and agentic execution return the same versioned schema. The processor never posts holdings, sends mail, browses, runs document-supplied commands, downloads models or calls a cloud inference API. Checked-in corpora and evaluation records are synthetic.

## Run locally

Use Python 3.12. From this directory, create a private runtime and install the pinned dependencies:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
export PROCESSOR_TOKEN="$(python3.12 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen3:1.7b
export OLLAMA_TIMEOUT_SECONDS=120
export OCR_ENABLED=true
export MAX_AGENT_STEPS=16
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

Multipart fields are `file`, `mode` (`workflow` or `agentic`) and `document_id` (1-128 ASCII letters, digits, underscore or hyphen).

```json
{
  "schemaVersion": 1,
  "documentId": "synthetic-example-1",
  "mode": "workflow",
  "execution": "local",
  "documentType": "capital_call",
  "relevant": true,
  "confidence": 0.75,
  "facts": [{
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
  }],
  "warnings": ["Candidate facts only: review against the original before any financial posting."],
  "trace": [{"stage": "rules", "status": "ok", "detail": "Page 1: 1 source-derived candidates."}],
  "model": null
}
```

This example is illustrative. `confidence` is an **uncalibrated synthetic relevance-classifier probability**, not extraction accuracy or financial correctness; actual responses include that warning. `documentType` is `valuation`, `capital_call`, `distribution`, `news`, `mixed` or `unknown`, derived from validated candidates. Trace statuses are `ok`, `skipped`, `warning` and `error`. Unknown dates, amounts and currencies remain null. Money is a plain decimal string; dates use ISO calendar dates. Responses have no extra top-level keys.

A model failure returns a valid response containing previously validated source facts, explicit warnings and an error trace. It does not claim complete coverage or retry through another provider. HTTP outcomes include 401 for failed authentication, 413 for oversized input, 422 for unsupported/malformed input, 503 while busy and 504 for the hard document deadline.

## Execution and source validation

Both modes use the same source-anchored event parser and strict evidence validator. The parser recognizes supported labelled and narrative event wording, explicit natural-language or ISO dates, and unambiguous grouped decimal formats, including European decimal punctuation and correctly grouped Swiss apostrophes. Explicit minus signs are preserved; ambiguous parentheses and unsupported attached numeric suffixes are rejected. Whitespace-normalized PDF line breaks can occur between a currency and its amount. A bare `$` does not imply USD. Ambiguous values remain unknown. No exchange rates, cash flows or performance returns are calculated.

Explicit row-major financial tables use their investment, event date, currency and event-amount headers to bind each row independently. Table amounts cannot fall back into surrounding prose and borrow another fund's identity. Unsupported or ambiguous table rows produce a page-specific coverage warning; neither execution mode silently treats them as a complete read. Literal evidence must still contain the source headers and values within the quote limit. Payment-receipt deadlines are scoped to the current capital call, with administrative and negated deadlines excluded. Illustrations and withdrawals remain exclusions for table rows as well as prose.

**Workflow:** a seeded TF-IDF/logistic model trained on the separate synthetic training corpus estimates coarse relevance. Shared training/inference preprocessing removes explicitly negated financial-topic terms while preserving later positive clauses; the source used for evidence stays unchanged. Source parsing inspects every readable page, so a hit on an early page cannot suppress later pages. A complete labelled notice may bypass model review; unresolved financial/narrative material is sent to local Ollama in bounded windows. Workflow currently has a shared budget of 16 structured model calls across the document. Strong source facts can override a negative coarse classifier label. No pickle or untrusted model artifact is loaded; holdout wording never enters training.

**Agentic:** the local model chooses among `read_page`, `extract` and `finish`. The permitted action schema contains only currently valid pages/actions. Extraction runs the shared source parser and the local model, so a separately failed model response does not discard already validated source facts. Successful `finish` requires every readable page to have received an extraction attempt. Unavailable, unread or repeated page requests stop with warnings. A budget stop is reported as incomplete; it is not a successful finish.

`MAX_AGENT_STEPS` defaults to 16 and accepts 1-24. It counts **all structured chat calls** in agentic execution, including action decisions and extraction calls, rather than only planning steps. It does not raise the separate workflow budget. The model has no general tool interface and cannot access arbitrary files, network destinations, code, financial posting or mailbox actions.

Model extraction uses source windows of at most 2,800 characters with 350-character overlap, preferring a nearby newline boundary. Every window retains its original page number. Remaining windows and unread/unextracted pages are explicitly reported when a budget is exhausted. Traces distinguish source-rule coverage from complete model-window coverage. These are processing-coverage checks, not proof that every fact was found.

Every candidate must pass the strict financial schema and source validation. Its contiguous quote must occur on the cited page after whitespace normalization. The investment, event wording and each non-null amount, currency and date must be supported by that quote and compatible with the source event. Source roles are checked against the complete decoded page, including text outside a model window, helping prevent an investor value from borrowing another fund's amount, a due date from becoming a valuation date, or a withdrawn value from being treated as a new current event. Same-period corrections remain distinct from valid historical reporting periods. Quoted instructions to invent or approve values are not financial events.

A genuine model quote may be expanded to its bounded source block before revalidation; a fabricated quote is never repaired. The application replaces model-written summaries with the verified source excerpt. Exact repeated facts and uniquely supported partial duplicates are consolidated; conflicting amounts/dates are not silently merged.

Malformed JSON, unknown response-envelope keys, oversized candidate lists and invalid action schemas fail closed. In a well-formed `facts` envelope of at most 30 items, each fact is independently validated: invalid candidates are rejected and counted while valid candidates continue through the same evidence gate. This does not coerce money, repair dates or fill absent fields. Validation provides source support within implemented parsing rules, not independent confirmation of the document's truth, ownership, gross/net treatment or financial interpretation. Human review remains required.

## Bounds and confidentiality

- Input is limited to 10 MiB per file, plus 128 KiB multipart overhead, before multipart parsing. One document runs at a time; the image uses one Uvicorn worker with concurrency capped at 8. Busy requests receive 503 rather than entering an unbounded queue.
- Combined document limits are 40 pages and 120,000 extracted characters. TXT uses UTF-8 and form-feed page breaks. EML permits at most 32 MIME parts, 8 attachments, 5 MiB per attachment and 10 MiB decoded content. Only PDF/TXT attachments are opened; nested email attachments and active formats are rejected or skipped.
- EML prefers a usable plain-text MIME alternative. HTML-only bodies are converted locally, preserving paragraph and table boundaries and decoding entities once. Scripts, styles, embedded active content and explicitly hidden elements are excluded; no browser or remote-resource fetch occurs. HTML conversion is bounded to 1,000,000 input characters, 20,000 elements, 128 nesting levels and the shared text limit. UTF-8/ASCII and a small explicit legacy-encoding allowlist are accepted; unsupported or malformed encodings produce warnings.
- PDFs require a matching signature and valid parse. Encrypted PDFs, top-level active actions/forms/embedded files and page actions are rejected. Parsing runs in a disposable child with a 75-second parent deadline; Linux enforces 768 MiB address space, 50 CPU seconds and a 32 MiB output-file limit. This is not a complete PDF sanitizer or antivirus scanner.
- OCR applies only to pages lacking native text, with a shared default budget of four pages across the document and its attachments. PDFium rendering is bounded to a 2,000-pixel edge and 4 million pixels. Each OCR child has a 15-second parent timeout, 12 CPU seconds, a 16 MiB file limit and, on Linux, 512 MiB address space. Tesseract has a 10-second timeout and one OpenMP thread. The PDF OCR pass has a 60-second wall-time budget. OCR failure, missing tools or exhausted coverage produce explicit warnings; no text is inferred from an unreadable page.
- Evidence keeps global page numbers. For EML, page 1 is the body and subsequent pages belong to supported attachments. `page_source` traces retain attachment ordinal and local PDF page; OCR sources additionally say `local OCR`. Quotes from OCR require visual review against the original image.
- Local model requests use `num_ctx=8192`, `num_predict=3200`, `think=false`, temperature 0 and seed 42. The configured HTTP inactivity timeout defaults to 120 seconds and is capped at 180. Independently, each disposable document subprocess has a hard **590-second total wall-clock deadline**, including decoding, OCR and all inference. The API kills its process group on deadline, HTTP disconnect or cancellation and cleans the temporary directory before releasing the slot.
- HTTPX ignores inherited proxy settings (`trust_env=False`), disables redirects, caps response bytes and uses only fixed `/api/show` and `/api/chat` paths at the approved local origin. Approved hosts are loopback, `ollama` and `host.docker.internal`. The daemon, host DNS and host administrator remain trusted boundaries; deployment networking must enforce egress denial.
- Outputs are capped at 100 facts, 100 warnings and 100 trace steps, with explicit truncation notices. The processor has no document/result database, telemetry, request-body logging, persistent document cache or cloud SDK. Private temporary PDF/OCR files are removed after processing. Host/core dumps, encrypted swap/storage and independent security assessment remain deployment responsibilities.

## Tests and evaluation evidence

```sh
.venv/bin/python -m pytest -q
.venv/bin/python scripts/evaluate.py
.venv/bin/python scripts/evaluate.py --real-local --limit 1
```

The suite covers both modes against a loopback fake-Ollama server, strict candidate salvage, fabricated/contradictory fields, evidence checks, context and agent coverage, authentication, proxy/cloud/redirect rejection, MIME/size limits, HTML alternatives/entities/tables, PDF active-content rejection, OCR limits and shared attachment budgets. Fake-model replies test orchestration; they are not evidence of LLM extraction accuracy.

Native macOS decoding was also checked against the fixed synthetic workflow-lab corpus outside the app repository. The HTML-only funding email produced its visible investment/date/amount text. The image-only Alderholt statement produced 420 OCR characters through Apple Vision, including the correct investment name, date and EUR 4,870,000.00 amount, with OCR provenance and a visual-review warning. The scan's original bytes and benchmark ground truth were unchanged. Portable synthetic scan and native-text fixtures are checked in under `tests/fixtures/`. The real OCR regression uses the checked-in scan by default; `ASTER_OCR_TEST_PDF` can select another trusted synthetic scan. It skips if the fixture or local engine is unavailable.

Earlier actual model evaluations used `qwen3:1.7b` on the GPU. After measured GPU contention and a failed full-document 1.7B CPU preflight on this host, the final 44-document regression comparison uses the already installed Qwen3 0.6B weights via `qwen3-aster-cpu:0.6b`, an operator-created alias with `PARAMETER num_gpu 0`. Both modes share the same frozen processor and runtime. Changing the weights and execution hardware prevents a controlled speed comparison with earlier runs. This alias is not bundled or downloaded by the app; provision and validate an approved model on each target host. See [the validation record](../VALIDATION.md) for failed attempts, final results and coverage limits.

The original 22-document realistic benchmark, later format-compatible diagnostic controls and model-contract tests serve different purposes and must remain separately scored. Older checked-in `eval/` results describe the version/model that produced them. Do not treat a synthetic pass, source-rule coverage or one successful scan as a blanket accuracy claim. Independent, authorized real-document evaluation is still needed for entity/date/currency/amount accuracy, abstention, revisions, multi-event layouts, multilingual material and scans.

## Docker

```sh
docker build -t aster-processor:local .
```

The image runs as UID/GID 10001, installs English Tesseract and pinned PDFium/Pillow, and needs no persistent document mount. A private writable `/tmp` can be `noexec,nosuid,nodev`; executables remain outside it. The operations stack supplies read-only root filesystem, dropped capabilities, secrets, resource limits and an internal processor/Ollama network. Its separate mailbox worker's provider egress does not attach to this network.

Docker is unavailable on the development host. Native Apple Vision evidence does not validate Linux Tesseract accuracy, container startup, sandbox behavior or egress enforcement. Build/boot and representative OCR checks on the target Linux host remain required.

## Interface references

- [Ollama structured output](https://docs.ollama.com/capabilities/structured-outputs) and [chat API](https://docs.ollama.com/api/chat): schema output is independently validated.
- [Ollama FAQ](https://docs.ollama.com/faq): daemon cloud-disable controls.
- [HTTPX environment variables](https://www.python-httpx.org/environment_variables/): inherited proxies and `trust_env=False`.
- [FastAPI file uploads](https://fastapi.tiangolo.com/tutorial/request-files/): multipart interface.
- [pypdf extraction](https://pypdf.readthedocs.io/en/stable/user/extract-text.html): native-text limitations and memory risks.
- [PDFium Python rendering](https://pypdfium2.readthedocs.io/en/stable/python_api.html), [Tesseract CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html), and [Apple Vision text recognition](https://developer.apple.com/documentation/vision/recognizing-text-in-images): local OCR components.
