# Synthetic multi-office mailroom v1

This is a frozen, fictional inbox workload for testing Aster's collection and extraction pipeline. It contains **100 email receipts across three family offices and nine mailboxes**, with **57 attached PDFs** (60 PDF pages), nested email attachments, and a mixture of plain text and HTML bodies. All names, addresses, accounts and amounts are synthetic. No messages are sent.

| Office | Receipts | Mailboxes |
| --- | ---: | --- |
| Alder House Family Office | 34 | principal, controller, investment |
| Belwick Family Office | 33 | principal, controller, investment |
| Cinder Family Trust Office | 33 | principal, controller, investment |

The 34 content categories include terse NAV notes, tables, untidy exports, image-only scans, capital calls, distributions, forwarding chains, nested `.eml` attachments, consolidations, reviews of earlier reports, revisions, withdrawals, missing currencies/dates, look-through disclosures, unexecuted manager targets, operational news, office invoices, scheduling noise, multiple reporting periods, FX references, amounts in thousands, HTML-only messages, encrypted attachments and hostile quoted instructions. Thirty-three patterns recur across the three offices; the final receipt is a multi-manager attachment pack. This is a varied synthetic regression workload, not 100 independently sampled real-world email types.

## Frozen files and ground truth

- `manifest.json`: per-receipt routing, message IDs, hashes, duplicate groups, counts and source-file checksums.
- `catalog.json`: human-readable office, mailbox and document inventory.
- `gold.json`: 93 explicit source fact observations, representing 72 authored economic event keys, plus review expectations and separate constituent/deal probes.
- `fixtures/emails/`: the **100 inputs** to collection. Each `.eml` contains its own MIME attachments; the harness must not separately ingest the attachment copies as extra receipts.
- `fixtures/attachments/`: the 57 PDF source copies retained for visual inspection and reproducibility, including PDFs contained inside nested emails.
- `build_corpus.py`: deterministic authoring source. It refuses to overwrite an existing frozen corpus.

Gold was authored before inference, without model calls, production extraction results, or prior benchmark answers. It is author-adjudicated and has not been independently human-adjudicated. The six scored fields are kind, investment name, effective date, native amount, currency and due date. Each expected fact also specifies its source page and quote anchors. Explicit table units such as “USD thousands” affect the amount; FX reference rates do not authorize conversion.

The three missing-date cases must preserve a null effective date. The three ambiguous dollar-symbol cases must preserve a null currency. Calls and distribution notices do not prove settlement. Consolidation rows and forwarded notices are repeated observations, not extra holdings or cash flows. Same-date revisions require an explicit correction review.

The three nested-email cases contain a real, readable source fact. An unsupported reader is a measured capability failure; those facts remain in the gold denominator. The three encrypted-PDF cases instead require a clear safe input block: the ingestion input contains no password, no extractable gold fact is expected, and inaccessible source facts are listed separately only to detect fabricated unlock claims. The authoring password is synthetic and exists in the builder to permit source inspection; the harness must not supply it to ingestion.

Constituent weights, undisclosed residuals, unexecuted deal targets and manager contacts are separate capability probes. They are not silently added to or removed from the ordinary six-field fact denominator.

## Deduplication expectations

Each office's `-05` call and `-32` copy have identical bytes and message IDs, routed to different mailbox identities. Each office's `-10` forwarded call has different bytes but the same economic event key. The common `-33` newsletter has identical bytes across all three offices: deduplication must remain tenant-specific and must never share a source document or grant across offices. Collection should retain 100 receipt records, even if the number of new document jobs is lower because of within-office content deduplication.

Extraction metrics should state whether they count receipts, unique tenant documents, or unique economic events. Report both workflow and agentic results for each selected model without silently dropping blocked or failed inputs. See [HARNESS.md](HARNESS.md) for collection and scoring commands.

## Authoring verification

Before the first inference, all 57 PDFs were rendered into 60 page images. Five contact sheets were inspected, together with full-size copies of the legacy export, all three scans, the consolidation table and the amounts-in-thousands table. Intentional untidiness remains legible. All scans contain zero native text characters. Password-protected sources were opened only for authoring inspection.

A second clean build reproduced every fixture, gold file, catalog and manifest byte for byte. The final manifest SHA-256 is `fe390f170d14485a94237c7141db1a61ab6f85d3c64ca87c073b7fe03fda82ad`; gold SHA-256 is `d796e73204e235a8b87cf39ceb0e6347fca1f6a4f8551817aef669c1acb749f0`.

Local review renders and authoring checks are outside the repository in `../validation-mailroom-100/corpus-review/`. They are QA artifacts, not extra ingestion inputs. This version is frozen: report defects against it, and create a new corpus version if any source or gold must change after inference.

To reproduce sources in a new directory with the installed local authoring libraries, run from the app directory:

```sh
PYTHONPATH=/Users/mithuran/Documents/Codex/misc/.tools/pdf-qa \
  ../processor/.runtime/bin/python benchmark/mailroom-v1/build_corpus.py \
  --output ../validation-mailroom-100/reproduction
```

The authoring dependencies are ReportLab 4.4.4, Pillow 11.3.0 and pypdfium2 4.30.0. They are not application runtime dependencies.

## Decoder-only grounding pass

The production document reader was run on all 100 frozen emails before inference. It decoded 94 sources with zero missing gold anchors or source-page mismatches and recovered all three image-only statements through local OCR. It explicitly blocked three nested `.eml` attachments (`Nested message attachments are not supported`) and three encrypted PDFs (`Encrypted PDFs are not accepted`). Those six inputs remain in collection and reporting; the three nested-email facts remain in the extraction denominator. No model was invoked by this check, so these numbers are reader/grounding results rather than extraction accuracy.

The decoded page arrays and errors are retained outside the repository in `../validation-mailroom-100/corpus-decoded/`, with `corpus-grounding.json` recording every input. Eight offline integrity tests verify frozen hashes, counts, synthetic email envelopes, mailbox and tenant duplicate boundaries, gold nulls, and equality between embedded PDFs and their inspection copies:

```sh
../processor/.runtime/bin/python benchmark/mailroom-v1/test_corpus.py
```
