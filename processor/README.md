# Aster local document processor

Functional Python service for candidate extraction from TXT, EML, and PDF. Both execution modes return the identical versioned schema. It never posts holdings, sends mail, browses, runs document commands, downloads models, or calls a cloud inference API. All corpus documents and checked-in evaluation results are synthetic.

## Run locally

Python 3.12 is required. On this workspace the isolated runtime is `.runtime/bin/python` (already installed); no system Python package was changed. For a clean installation:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
export PROCESSOR_TOKEN="$(python3.12 -c 'import secrets; print(secrets.token_urlsafe(32))')"
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export OLLAMA_MODEL=qwen3:1.7b
export OLLAMA_TIMEOUT_SECONDS=120
export OCR_ENABLED=false
.venv/bin/uvicorn service.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --no-access-log --limit-concurrency 8
```

Start a separately managed Ollama daemon with `OLLAMA_NO_CLOUD=1`, or configure its documented `disable_ollama_cloud` setting and restart it. Use an operator-provisioned local model. The processor requires `/api/show` to identify a local GGUF model without remote host/model metadata, rejects model tags containing `cloud`, and never pulls models. There is no cloud fallback. Its own environment cannot change a separately running daemon's cloud setting: production must also enforce daemon configuration and network isolation. The sibling operations stack supplies an internal network and cloud-off daemon.

`GET /healthz` is unauthenticated liveness only; it does not claim model readiness. `PROCESSOR_TOKEN` is mandatory (minimum 24 characters) and missing configuration prevents startup. The backend passes it as `X-Processor-Key`; configure the same generated secret in both services. Obvious REPLACE/CHANGEME/TODO placeholders prevent startup.

```sh
curl http://127.0.0.1:8000/v1/extract \
  -H "X-Processor-Key: $PROCESSOR_TOKEN" \
  -F file=@corpus/sample-capital-call.txt \
  -F mode=workflow \
  -F document_id=synthetic-example-1
```

Do not paste real secrets in shell history. The example uses a shell variable. The application backend owns storage, encryption, tenant access, review and posting; this service accepts a trusted internal caller and does not implement multi-tenant authorization itself.

## Contract

Multipart fields: `file`, `mode` (`workflow` or `agentic`), `document_id` (1–128 ASCII letters/digits/underscore/hyphen).

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
    "effectiveDate": "2026-08-31",
    "amount": "420000.00",
    "currency": "EUR",
    "dueDate": "2026-09-30",
    "summary": "Synthetic capital call Investment: Cedar Partners IV Effective date: 2026-08-31 Amount: EUR 420,000.00 Due date: 2026-09-30",
    "evidence": {"page": 1, "quote": "Synthetic capital call\nInvestment: Cedar Partners IV\nEffective date: 2026-08-31\nAmount: EUR 420,000.00\nDue date: 2026-09-30"}
  }],
  "warnings": ["Candidate facts only: review against the original before any financial posting."],
  "trace": [{"stage": "rules", "status": "ok", "detail": "1 candidates from explicit labelled notices."}],
  "model": null
}
```

The confidence above is illustrative, not a stored model result. Every response also warns that confidence is an **uncalibrated synthetic relevance-classifier probability**, not extraction accuracy. `documentType` is `valuation`, `capital_call`, `distribution`, `news`, `mixed`, or `unknown`, derived from accepted facts. Trace statuses: `ok`, `skipped`, `warning`, `error`. Missing dates, money, and currency are null. Money remains a finite plain decimal string. Responses contain no additional top-level keys. A local-model failure yields a valid result with an error trace/warning and only previously validated candidates; it does not claim success or fall back elsewhere. Bad auth: 401; oversized request/file: 413; unsupported/malformed input: 422; busy processor: 503 (retry with backoff); hard document deadline: 504.

## Execution

**Workflow:** fit TF-IDF (unigrams/bigrams) plus seeded logistic regression to the checked-in 48-document synthetic training corpus in each disposable document worker. Classify coarse financial relevance, run narrow deterministic notice rules, then call local Ollama once for unresolved relevant material. Strong rule matches can override a negative classifier label. No pickle or untrusted model artifact is loaded. `corpus/holdout.json` has separate wording and never enters training.

The rules accept explicit `Investment:`, `Fund:` or `Company:` labels, event labels and ISO dates. Money supports explicit codes followed by comma thousands and decimal dot (for example `EUR 420,000.00`). Locale-ambiguous amounts, currency symbols alone and natural-language dates are not guessed. Unresolved values remain null. Deterministic parsing is deliberately conservative and incomplete.

**Agentic:** the actual local model chooses `read_page`, `extract`, or `finish`. A read makes a bounded source excerpt available in the next decision; extraction uses that page's bounded text. Unavailable/unread/repeated page requests stop execution with warnings. `MAX_AGENT_STEPS` defaults to 6 and is capped at 8 **total chat calls**, including extraction. The model receives no general tool interface. It cannot access arbitrary files, network addresses, code, financial posting, or user mail. There is no hidden simulated answer path.

Both modes use the same strict Pydantic schemas and evidence gate. Quotes must exist on the specified page after whitespace normalization; investment name, supported event wording, and each non-null amount/currency/date must appear in that quote. Explicit name/date labels cannot contradict the candidate. Model summaries are replaced with a verified source excerpt. Invalid schemas fail the model call closed; invalid individual facts are rejected and flagged. These checks prove textual support, **not financial interpretation**. Several values may share a quote; ownership, investor-versus-fund NAV, date meaning, gross/net, currency conventions and document revisions require application review and real benchmark development.

## Bounds and confidentiality

- 10 MiB file; 10 MiB plus 128 KiB total multipart body, enforced before multipart parsing/authenticated payload handling. One document processes at a time; run one worker. Uvicorn concurrency is capped at 8 in the image.
- 40 combined pages, 120,000 extracted characters. TXT is UTF-8 with form-feed page breaks. EML uses plain text only; HTML is skipped, no remote resources loaded. Maximum 32 MIME parts, 8 attachments, 5 MiB per attachment and 10 MiB decoded content. Only TXT/PDF attachments are processed. Nested emails and active attachment formats are not opened.
- PDF `%PDF-` signature plus parser validation, encrypted PDFs rejected, active top-level actions/forms/embedded files rejected. Parsing runs in a child process with a 75-second parent deadline; Linux also enforces 768 MiB address space, CPU and output-file limits. Native extraction cannot read images.
- Optional `OCR_ENABLED=true` uses installed local `pdftoppm`/Tesseract, English only, at most 4 blank-text pages, image dimension 2000 pixels, per-command 12-second timeout. OCR text evidence is explicitly flagged for visual review. Partial OCR coverage is reported. OCR binaries are present in Docker, absent from this host's original environment; no host OCR accuracy claim.
- For EML, evidence page 1 is the email body; subsequent global page numbers follow supported attachment pages. `page_source` traces map the global page to body/attachment ordinal. The app must use this map when displaying the original.
- Model context: at most 18,000 text characters per extraction, 9,000 per page; planning previews/read excerpts are smaller. Truncation and unvisited pages are reported. `num_ctx=8192`, `num_predict=1600`, `think=false`, seeded temperature 0. Local HTTP inactivity timeout is configured at 120 seconds (maximum 180). Independently, the API gives each disposable document subprocess a hard **590-second total wall-clock deadline**, including decoding, OCR and all agent calls, then kills its entire process group and returns 504. Busy requests return 503 instead of waiting in an unbounded queue. An HTTP disconnect or request cancellation kills the local document worker process group; the parent cleans its temporary directory before releasing the slot. Timeouts do not trigger a remote retry.
- HTTPX ignores proxy/environment settings (`trust_env=False`), disables redirects, limits response bytes, and uses only fixed `/api/show` and `/api/chat` at the configured approved local origin. Approved hosts are loopback, `ollama`, and `host.docker.internal`; DNS and the daemon remain operator-controlled trust boundaries. Production egress denial is supplied by the operations network, not merely these application checks.
- No document/result database, telemetry, request-body logs, persistent model cache or cloud SDK in the processor. PDF temporary files are private and deleted after each call. Disable host/core dumps and use encrypted swap/storage at deployment level; a Python process cannot guarantee memory erasure. This is not an antivirus scanner or a full PDF sanitizer. Keep the parser/OCR image patched and sandbox it without egress.

## Tests and evaluations

```sh
.runtime/bin/python -m pytest -q
.runtime/bin/python scripts/evaluate.py
.runtime/bin/python scripts/evaluate.py --real-local --limit 1
```

The test suite exercises both modes against a real loopback fake-Ollama contract server, invalid JSON/schema, fabricated fields, exact evidence, proxy ignoring, cloud/redirect rejection, agent budgets, HTTP authentication, EML attachment behavior, MIME/size limits and PDF encryption/active-content rejection. The fake server scripts golden replies: its coverage is an orchestration test, **not an LLM accuracy benchmark**.

`eval/synthetic-contract.json` reports held-out relevance accuracy and extraction document coverage. `eval/real-local.json` records actual local model runs and wall time when `--real-local` is used. Tiny synthetic evaluations provide engineering smoke evidence only. Required next evaluation: an authorized, independently labelled real-document set with entity/date/currency/amount accuracy, rejected/abstained cases, investor-versus-fund amounts, multi-event tables, revisions, malformed inputs, multilingual layouts and scanned pages. All candidate posting remains under application review.

## Docker

```sh
docker build -t aster-processor:local .
```

Image runs as UID/GID 10001. No persistent mounts are needed. A writable private `/tmp` is required and can be `noexec,nosuid,nodev`; Python/OCR executables live outside it. Use the sibling operations Compose stack for read-only root filesystem, dropped capabilities, secrets, memory/process limits, internal networking and cloud-off Ollama. Docker is unavailable on the current host; image build/OCR runtime remain deployment checks.

## Interface references

- [Ollama structured output](https://docs.ollama.com/capabilities/structured-outputs): schema in `format`, then independently validate the response.
- [Ollama chat API](https://docs.ollama.com/api/chat): nonstreaming chat and bounded inference options.
- [Ollama FAQ](https://docs.ollama.com/faq): server-side cloud disable controls.
- [HTTPX environment variables](https://www.python-httpx.org/environment_variables/): `trust_env=False` bypasses inherited proxies.
- [FastAPI file uploads](https://fastapi.tiangolo.com/tutorial/request-files/): multipart upload interface.
- [pypdf extraction](https://pypdf.readthedocs.io/en/stable/user/extract-text.html): native text limitations and content-stream memory risks.
