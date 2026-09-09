# A source-derived Aster demonstration

The demonstration starts with an empty investment portfolio. It copies the existing frozen mailroom corpus into a new workspace's **Demo mails** directory, connects that directory, and uses the ordinary folder collector, document queue, local processor and financial review/ledger code. There is no preloaded holdings table, answer-key import, simulated progress animation or fabricated model trace.

## Start and present

1. Run the web app, PostgreSQL, local processor, Ollama, document worker and folder worker. Keep the reporting monitor running for calendar/exception monitoring. Native setup is in the project README; folder and container setup is in [local-intake.md](local-intake.md).
2. Privately configure `ASTER_ENABLE_DEMO=true`, an absolute `ASTER_INTAKE_ROOT`, and the installed local model. The native default is `gemma4:e4b-m3`. Restart web and document worker after changing environment settings. Existing explicit engine profiles and jobs already pinned to a model are retained.
3. Sign in with MFA as an office-wide owner or administrator. Open **Connections → Folders → Start a live demo**. A new run creates its own workspace and selects it for that browser. The original office remains unchanged.
4. Show the source connection: 100 synthetic email receipts, 95 unique originals and five duplicate receipts. Their 57 PDF attachments remain inside the MIME emails and are decoded by the processor. Three fictional families and nine mailbox personas are represented; no mailbox login or external provider access is used.
5. Follow **Processing** to inspect the actual pinned engine, model calls, tool trace, source quotes, warnings and decisions. **Overview**, **Investments**, **Timeline**, **Inbox**, **Knowledge & managers**, and **Exposure & stress** update from retained results. Processing is asynchronous and its duration depends on the installed model and machine.
6. Use **Leave demo** to return to the ordinary office. The run continues processing and is retained. **Open previous run** returns to its results; **Start another run** creates a new empty sandbox and new source copies. Rescanning an existing connection safely checks for new bytes without duplicating its economic events.

No user must disclose a real inbox for this presentation. A normal folder can separately receive EML, PDF and TXT files, including new versions. New, modified or arbitrary files require ordinary review; automatic demo publication is restricted to the checksum-verified synthetic corpus inside a server-marked sandbox.

## What is automatic

- The collector retains encrypted original bytes, tracks each file/version receipt, deduplicates exact copies and pins the current engine and workflow mode on each job.
- The local processor reads email bodies and attachments. Agentic mode can read, search, inspect layout/images and revisit source coverage. Workflow mode uses the same extraction/evidence contract with a prescribed sequence. Neither mode silently switches to a cloud engine.
- In the demo only, supported extracted facts are linked to the exact investment identity within the routed family. Newly discovered holdings have unknown valuation, cost basis and commitments until supported data exists. Source NAVs become versioned ledger marks. News and notices become cited timeline items; calls create follow-up tasks. Notices never establish payment or settle cash.
- Automatic decisions are attributed to **Aster demo agent**. It has no sign-in account or user session. Audits identify source verification and automatic publication explicitly; no human preview or approval is fabricated.
- Verified demo originals are locally decoded into the source library. Explicit constituent disclosures can create cited look-through relationships. Undisclosed weights stay unknown; no residual allocation is invented. Identity ambiguity, conflicting disclosures and missing dates remain for review.
- News about an underlying company can attach to its existing parent fund when a unique accepted, dated and source-verified constituent relationship exists within the same family. The company remains the extracted subject; this does not create a direct holding or invent an ownership amount. Ambiguous or unverified relationships remain in review.

The demo declares family/entity routing and inferred asset classes in `Demo setup.md`, beside its source directory. Liquidity remains unknown unless reported. It uses fixed illustrative EUR conversion rates (EUR 1, USD 0.92, GBP 1.18, CHF 1.04), labeled on every converted mark as **synthetic demo scenario FX assumptions, not market rates**. These assumptions are not extracted from manager reports and must not be presented as current exchange rates.

## What remains unknown

The corpus deliberately contains encrypted PDFs, missing fields, competing marks, difficult tables, irrelevant messages and instructions that must be ignored. Such sources can remain blocked or in review while independently supported facts are visible. A completed extraction is not a claim that every financial statement in a document was correct or understood.

Cost basis, commitments, ownership and settled cash-flow history are not inferred from a NAV. Unknown values are labeled, and performance figures stay unavailable until the required source/flow coverage exists. Partial recorded NAV and exposure are distinguished from a complete consolidated portfolio. Source-based reported-value history is separate from a reconciled return series.

The processor includes two generic method notes on every result. These remain visible but do not, by themselves, keep a completed sandbox decision in the review queue. Reading, coverage, model, identity and correction warnings remain actionable.

## Inspect a run as an operator

The read-only status command refuses ordinary offices and prints counts, models, model calls, published facts, family coverage, source indexing, exposure links and failures without printing credentials or full document contents:

```sh
node --conditions=react-server --import tsx --env-file=.env.local scripts/demo-status.ts <demo-organization-uuid>
```

The organization/run UUID is returned by `POST /api/demo` and is available in the authenticated workspace identity. In a built package, use the bundled `dist-ops/demo-status.js` entry point with the deployment's normal secret-loading mechanism.

## Connect external tools

Gmail and Microsoft 365 ingestion already use delegated per-person OAuth, durable cursors, encrypted provider credentials and shared document processing. Follow [mailbox-oauth.md](mailbox-oauth.md); real provider consent and tenant configuration must be exercised before a live rollout. A demo folder does not stand in for a completed provider OAuth test.

The [Aster local plugin](../plugins/aster-local/README.md) exposes ten scoped, audited MCP read tools for portfolio, exposure, source files, processing, reviews, calendar, exceptions and mailbox status. Installation is explicit and does not alter a user's Codex configuration during the application build. A local model in Aster does not prevent a separately connected cloud client from receiving the records that its token permits it to read.

Base container deployment keeps the intake read-only and demo automation off. `compose.demo.yaml` is an explicit synthetic-only override. Shipping containers, target-host permissions, backup restore, network isolation and provider consent require deployment validation; a successful native demonstration is not a production certification.
