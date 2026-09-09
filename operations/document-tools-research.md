# Document tools and local vision: implementation decision

Checked 9 September 2026. This document separates verified adapter behavior from the extraction accuracy that the revised benchmark must measure.

## Decision

Use one document toolkit in both processing modes: original text, layout-preserving text, bounded nested-email traversal, page search, page inspection and selective local vision. Workflow selects tools through explicit routing conditions; the agent can select and revisit useful document views within a step and time budget. Both return the same candidate schema and source-backed review records.

This is an engineering recommendation based on the observed failures. A vision-only replacement would remove useful native text and would make exact financial evidence harder to verify. Better text extraction alone would leave the model unable to inspect visual relationships that flattened text loses. Combining the two gives a recoverable path when one representation fails, while keeping the original bytes authoritative.

| Approach | Useful for | Main limitation | Decision |
|---|---|---|---|
| Native text plus deterministic financial parsing | Clean statements, exact identifiers and amounts | Reading order and table context can disappear | Keep and improve |
| Local OCR and layout-preserving extraction | Scans, columns, rough exports | OCR can alter digits; layout does not supply financial meaning | Shared preprocessing and corroboration |
| Selective vision over actual rendered pages | Row/header association, visual unit labels, difficult tables | Model output can be wrong; latency and image limits matter | Enable for capability-verified local models |
| Vision-only conversion of every page | Potential fallback for documents with unusable text | Requires a new image-grounding contract and separate quality evidence | Do not equate with verified facts |
| Docling layout/TableFormer stage | Structured cells, reading order and table provenance | New model assets, deployment resource costs and qualification | Separate optional benchmark before adoption |

Ollama supports image input in the REST chat API through base64 values in the user message's `images` array. It supports the same JSON-schema `format` with vision. That validates the transport choice, not the accuracy of any financial extraction. [Vision API](https://docs.ollama.com/capabilities/vision), [structured outputs](https://docs.ollama.com/capabilities/structured-outputs)

## Verified installed capabilities

Read-only local inventory on Ollama 0.33.3:

| Selected model | Local metadata | Vision decision |
|---|---|---|
| `gemma4:e4b-m3` | GGUF; completion, vision, audio, tools, thinking | Actual image request succeeded |
| `qwen3-aster-cpu:1.7b` | GGUF; completion, tools, thinking; `num_gpu 0` | Text-only; do not send or silently ignore images |

Gemma digest: `bcfb291b596f262958424fe2775c92e1480f3c05c328d0cbcb2cd05562ebe8ff`. Qwen digest: `73611865ca672e666053cd9212966cfbc47d8c7c959540f3807c5a76d94332c2`. No models were downloaded, replaced or relabeled for this implementation. Model family names are not sufficient evidence of an installed alias's capabilities.

Google documents Gemma 4 image understanding, document/chart/OCR use cases and function calling. Ollama's model listing also identifies image support for E4B. These are vendor capability descriptions, not Aster's measured corpus results. [Google model card](https://ai.google.dev/gemma/docs/core/model_card_4), [Ollama Gemma 4 listing](https://ollama.com/library/gemma4)

The isolated synthetic probe used an actual 1,200 × 520 PNG, two fictional investment rows, separate currency and NAV columns, and a reporting-date heading. The prompt and schema contained none of the target names, dates or amounts. `LocalOllama.structured(..., images=[...])` returned both rows exactly, with plain decimal amounts and ISO dates, in one call taking 15.81 seconds including metadata verification. This establishes image transport and a simple visual reading capability; it is not a general document accuracy estimate. The image, authored ground truth, requests, responses, inventory, script and result are retained in `../../validation-extraction-v2/vision-probe/` outside the original baseline artifacts.

## Adapter contract implemented

`LocalOllama.structured(schema, prompt, output_schema=None, images=None)` preserves existing text behavior and schema validation. `verify_local()` obtains metadata for the exact selected model, rejects remote/non-GGUF models, and exposes `supports_vision` only after verification. Missing or malformed capability metadata is not treated as vision support. An image request also verifies the model if the lifecycle has not done so yet.

Image input must be a list of raw base64 PNG/JPEG bytes produced from the authorized document. The adapter never resolves filenames, URLs or data URLs. It rejects invalid/truncated images, multi-frame images, more than four images, more than 4 MiB per image or 8 MiB per request, dimensions above 4,096 pixels per edge, and more than eight million pixels per image. The document renderer applies its own tighter shared document budget. These limits protect resource usage; the caller still owns authorization and source selection.

A text-only local model raises `model_vision_not_supported`. Cloud adapters expose `supports_vision=False` and reject images with `provider_vision_not_enabled`; this change adds no cloud image-delivery path. The selected engine remains pinned. Unsupported vision should appear as a coverage/tool limitation, not a successful visual review or a reason to silently change engines. Existing local HTTP bounds, no redirects, no environment proxies, schema errors and independent valid-candidate recovery remain in place.

The adapter tests cover actual image-byte forwarding to the pinned loopback endpoint, metadata verification, text-only/malformed/remote capability rejection, image format/dimension/size limits, truncated content, cloud image rejection and unchanged text calls. Existing engine and pipeline regression controls also passed. The live probe is separate from the mocked contract tests.

## More useful freedom for agents and workflow

Ollama supports tool declarations, tool results and multi-turn loops. The application executes tools and can restrict dispatch to named functions; a model's tool call is not itself an execution permission. [Tool calling](https://docs.ollama.com/capabilities/tool-calling)

For this application, useful freedom means choosing a relevant page, searching a fund name, inspecting a table's layout, reviewing its image, extracting a candidate and reconsidering it after concrete validation feedback. These operations can be represented as a strict action schema as well as native provider tool calls. The financial posting API, shell, arbitrary URLs and unrelated tenant documents are unnecessary for interpreting an already-authorized report.

Recommended routing:

1. Decode the envelope and supported attachments once. Retain attachment ancestry, original page identity, source text and optional layout/image representations. Surface unreadable or bounded-out inputs explicitly.
2. Establish relevance from investment evidence, not merely the presence of an amount. Avoid routing office operating invoices into investment reporting solely because their language resembles an expense notice.
3. Create stable source blocks and give the model their identifiers. The application assembles original evidence quotes instead of asking the model to reproduce long quotations without error.
4. Read difficult source text with the selected model. Use layout or vision to resolve columns, headers and context when available. Preserve reporting dates versus payment/due dates, investor NAV versus whole-fund totals, and native currency versus translated comparison values.
5. Validate amounts, dates, owners and units against the cited source; do not require the entire candidate to be regenerated by the deterministic extractor. Treat unresolved disagreement or image-only values without corroborated evidence as review-required coverage gaps.
6. Track tool choice, page coverage, rejections and attempted calls. Finish when pages are covered or an explicit bounded limitation remains. Repeated failed tool requests should return actionable feedback and stop consuming the same budget pointlessly.

Workflow can use the same tools under reproducible conditions, such as a difficult table with no complete grounded result. Agentic mode may choose the sequence. More calls or the presence of vision is not itself an accuracy improvement; the unchanged 100-email corpus and fresh independently authored fixtures must decide that.

## Docling and offline follow-through

Docling's document representation includes tables, optional bounding boxes, provenance, reading order and separate body/furniture content. This makes it a sensible future interchange format for difficult PDFs. It still needs Aster's distinctions between position values, fund totals, reporting dates, units and proposed investments. [Document representation](https://docling-project.github.io/docling/concepts/docling_document/)

The standard pipeline permits table structure/cell matching options. Its models otherwise download on first use; offline releases must prefetch the exact selected artifacts and configure `artifacts_path` or `DOCLING_ARTIFACTS_PATH`. Remote services require explicit enablement. Artifact completeness and host network denial must be tested separately. [Docling options](https://docling-project.github.io/docling/usage/advanced_options/)

No Docling dependency or model download is introduced here. The implemented adapter uses the already-installed vision-capable model and existing image dependencies. Qualify Docling separately on CPU/Linux appliance hardware, including OCR language assets, table accuracy, peak memory, startup without internet and model licenses. The detailed [optional layout-stage proposal](offline-document-layout.md) and [LP packaging plan](offline-lp-packaging.md) specify that release path.

The revised evaluation must report exact grounded recall, unsupported facts, relevance mistakes, unreadable documents, model/tool calls and elapsed time by engine and mode. Distinguish a parser fix from a model's added candidate, vision's actual use from availability, and mock controls from live inference. Keep the previous 60/90 result and its source hashes intact as a baseline.
