# Three-office mailroom evaluation plan

This experiment uses 100 fictional email receipts across three offices and nine mailboxes. It exercises the existing mailbox collector, original storage, durable processing queue and selected-engine processor. A deterministic fake Gmail transport supplies fixture pages and MIME bytes; it does not authenticate to Google or prove real OAuth/provider behavior.

The corpus and gold labels are frozen before inference. The first complete matrix is retained even if it exposes defects. A later fix, if undertaken, gets a separate source revision and regression result. Neither selecting the best attempt nor silently replacing failed cases is allowed.

## Fixed matrix

1. Gemma4 `gemma4:e4b-m3`, classical workflow.
2. The same Gemma4 model, bounded agentic workflow.
3. Qwen3 `qwen3-aster-cpu:1.7b`, classical workflow.
4. The same Qwen3 model, bounded agentic workflow.

Model digests, code revision, limits, job engine pins and machine metadata are retained. Gemma uses the existing local GPU configuration; this Qwen alias explicitly uses the CPU. Observed time and resource demand are operational measurements on this host, not a controlled speed ranking of model families. The machine has 16 GiB unified memory and eight logical CPUs. No new model is downloaded, cloud engine called or local inference service reset.

## Separate denominators

- **Receipts:** expected 100 inbox items, even when two mailboxes receive identical MIME. Preserve all mailbox/source mappings.
- **Unique originals:** count tenant plus source content hash. Identical content within one office should share an original; identical bytes across offices must remain tenant-separated. This number may be below 100.
- **Jobs:** four configurations per unique original, with immutable model/mode pins and every actual HTTP attempt retained. Receipt-level results can point to the same job; do not count those as independent model trials.
- **Facts:** all frozen expected financial facts remain in the denominator. Missing results and timeouts cannot disappear from recall. Cases expecting an unreadable attachment or explicit abstention are also reported separately as input/safety outcomes.
- **Documents:** report exact-match documents, partially correct documents, unsupported additions, expected review/decoding blocks and unexpected failures separately. A schema-valid or completed response is not necessarily correct.

## Measurements

| Layer | Checks and recorded evidence |
| --- | --- |
| Collection | Per-office/mailbox receipt counts; pagination, backfill/history cursor transitions, replay stability, same-ID replay, same-MIME deduplication and tenant separation |
| Decoding | Email body, HTML text, native PDF, image-only OCR, forwarded/nested email and multiple attachments; page provenance, warnings and input errors |
| Relevance | Relevant versus irrelevant classification against the frozen rubric; empty financial facts do not automatically mean irrelevant |
| Extraction | Exact kind, investment owner, effective date, native amount, currency and due date, with contiguous evidence on the indicated decoded page |
| Consolidations | Investor share versus total fund NAV; manager summary versus underlying marks; corrections and withdrawn values; no unsupported double counting |
| Review boundaries | Unknown currency/date/weight or unavailable source remains explicit; notices do not prove settlement; distributions do not invent capital/income splits |
| Resilience | Queue status, attempts, errors, warnings, durable retries and bounded deadlines; distinguish first-attempt behavior from eventual job outcome |
| Runtime | Wall time, request timing, median/tail/max, throughput and actual model calls where observable; rule-only cases are marked separately |

The ordinary financial extraction schema does not model every constituent, contact or allocation relationship. Such capability probes must be labeled separately from financial-fact precision/recall. The separate Knowledge & managers proposal path is not implicitly covered by a passing mail extraction result.

## Interpretation

Report precision and recall together: returning fewer facts can reduce unsupported output while increasing missed information. Review-edit counts, if reported, are deterministic proxies, not measured analyst minutes. One synthetic English-heavy corpus and one run per configuration do not establish performance on real client documents, multilingual collections, poor scans or other model sizes. Gold is synthetic author labeling with source inspection, not independent human adjudication.

Keep source documents and failed outcomes in the delivered results. Explain concrete examples of what succeeded and failed, including amount ownership, outdated report chains, double-counting risks and unreadable documents. State explicitly whether an apparent collection success still left usable data missing.

## Data handling

Only new, explicitly labeled synthetic organizations and accounts are used. Existing owner holdings, memberships, keys, model defaults and sessions remain unchanged. No accepted financial postings or outbound messages are created by this experiment. After processing, pause the fake connections and retire temporary authentication material while retaining encrypted originals, results and audit evidence for inspection.
