# Portfolio and investment history rework

Planning baseline: 10 September 2026, application commit `dc2c654`. The status below records the delivered work; the original product and implementation plan follows it.

## Implementation status — 10 September 2026

The implementation now includes live investment value charts, every retained observation in paginated tables/exports, dated source/version drilldown, ordered Activity, and a shared authenticated history projection used by Portfolio, Investments and Reports. Portfolio supports family/entity/date/currency selection, coverage and same-holdings comparisons. Historical ownership and classifications can be recorded from retained, released evidence; corrections preserve previous versions. Restated history and as-known cutoffs are separate selections. Source-defined exits remove a holding from current totals while preserving its last reported value and history.

Accepted calls/distributions now create linked obligation drafts without posting money. Missing details, duplicate/conflicting notices, partial allocations, settlements, cancellations and reversals retain explicit review steps. Earlier accepted notices have a source-review registration action. The cash view refreshes after changes and retains unsaved form entries while requiring review of a newer financial revision.

Reports have one library and a history snapshot that preserves the selected positions, all observation pages, source references, lifecycle inputs and deterministic results. Later records do not rewrite saved figures. Navigation separates Portfolio, Investments, Cash & commitments, Exposure & stress, Activity and Reports from Documents & review, Connections and Office setup.

`benchmark/history-v1` adds a separate source-based twelve-quarter demonstration: 100 synthetic emails, 97 unique originals, three families, nine mailbox routes and 64 PDFs. Its expected answers were authored before inference and are excluded from the runtime ingestion image. The existing mailroom benchmark remains intact. The local Gemma qualification run is asynchronous; static fixture validation is not a model-accuracy claim, and a partial run must not be reported as complete.

This is an adapter-based delivery, not completion of every future capability below. Storage still uses the encrypted workspace envelope with visible limits of 200 holdings, 4,000 observations, 2,000 lifecycle records and 32 MiB per history input. Saved reporting has its existing 20-snapshot / 8 MiB bound. Canonical financial record tables/backfill, ownership transfers, dependent settlement replay, full cash/FX attribution, new IRR/private-fund multiples and dated look-through reconstruction remain follow-on work. A history value change is not an investment return. The existing production release security gates are unchanged.

The remaining sections retain the original plan and baseline findings for context; they are not a declaration that every milestone is complete.

The main experience should answer five questions: what do we own, what is its latest known value, how has it changed, what explains the change, and what requires a decision? Source verification should be available from the number being investigated. Extraction and engine administration support that experience in the background.

## 1. Findings in the current application

The active synthetic demo has 15 holdings and 27 accepted valuation records. Six holdings have one mark, six have two, and three have three. Marks cover three dates: 31 March has observations for 3 of 15 holdings; 31 May for 9 of 15; 30 June for 15 of 15. It has no cash transactions, settlement postings or reconciliation periods. Those gaps must remain visible when demonstrating financial history.

| Finding | Implication | Existing location |
| --- | --- | --- |
| Investment charts require `usePerformanceAvailable()`, which permits only synthetic sample performance. | Real reported NAV history is hidden despite existing observations. Showing valuation history does not require calculating investment returns. | `components/aster/investments.tsx:417`, `components/aster/primitives.tsx:252` |
| Investment history falls back to eight date/value rows; its start date is hardcoded. | Older information disappears and a row cannot open its exact source. | `components/aster/investments.tsx:239`, `:421` |
| A timeline dominates investment Overview and is repeated in another tab. | Source operations receive more space than financial development. | `components/aster/investments.tsx:341`, `:376` |
| Live events are prepended as accepted; timeline views filter without sorting. | The active demo has nine adjacent effective-date ordering inversions. | `lib/server/accept-facts.ts:172`, `components/aster/timeline.tsx:117` |
| Chart points lose source/version metadata and use categorical date spacing. | Irregular reports look equally spaced, and plotted values cannot be investigated directly. | `components/aster/charts.tsx:35`, `:169` |
| Current portfolio totals and current-holding history are used across the product. | Passing an old date is insufficient to reconstruct the portfolio held on that date. | `lib/finance.ts:318`, `lib/recorded-marks.ts:9` |
| Cash notices create timeline entries and tasks, but no transaction drafts. | Ingestion and the cash ledger remain disconnected. | `lib/server/accept-facts.ts:172–235` |
| Ledger data loads once per mount. | Accepted information can remain absent from the visible ledger until a reload. | `components/aster/ledger-view.tsx:973` |

Reuse the strongest existing foundations: versioned `finance.valuations`, exact currency/FX records, encrypted review history, tenant authorization, source previews, explicit settlement/reversal rules, and immutable saved reports. Avoid discarding these records or re-extracting documents merely to reorganize the UI.

## 2. Product structure and responsibilities

| Main destination | User question | Contents |
| --- | --- | --- |
| Portfolio | Where are we now, and how did we get here? | Current position, historical value, changes over the selected period, allocation, freshness, material developments and attention items. |
| Investments | What happened to this investment or manager? | One investment list; individual investment records with charts, history tables, cash flows, documents and exposure. Managers are a view of these same investments. |
| Cash & commitments | What is available, due, expected or settled? | Draft obligations from notices, registered cash balances, payments/receipts, commitment changes and reconciliation. |
| Exposure & stress | Where are we concentrated, and what could affect us? | Existing look-through and simulation capabilities, using the selected position date when historical evidence supports it. |
| Activity | What happened, in date order? | Economic events across the office, scoped to family, investment, manager or event type. |
| Reports | What can we reproduce and share? | Portfolio snapshot, period analysis, reporting schedule and one saved-report library. |

Keep Documents & review, Connections, and Office setup/operations as secondary work areas. Connections retains AI engines and plugins. Office setup owns family/entity/account administration; investment identity and ownership remain visible in investment records. Retire the duplicate holdings table under Register once Investments uses the same authoritative register. Preserve deep links during the transition.

Use one attention system for missing reports, unresolved identities, contradictory marks and cash-account mapping. Show contextual actions from Portfolio and the affected investment; do not create another disconnected queue. Existing assigned exceptions and reporting obligations retain their owners, due dates and history.

## 3. The flagship investment record

The default investment page opens on its financial development. Its first viewport contains the investment identity, current figures and a large history chart. The complete table follows directly beneath the chart. Source details open only when selected.

**Header and context:** investment, manager, asset class, family, legal holder, account/share class, native currency and reporting currency. Identify the investor's position separately from a manager's total fund value. Preserve separate positions when several families own the same fund.

**Current figures:** latest reported NAV/value with the actual valuation date; change from the previous comparable report; commitments and paid-in/distributed capital where known. Display stale or missing data locally. A June report must remain labelled June even when the screen is opened in September. A book value adjusted for subsequent settled capital needs a different label from manager-reported NAV.

**Shared controls:** date range, selected date and currency. Default to all available history for short series; offer useful longer periods and custom dates when supported. Keep scope, range and selected observation in the URL. Chart, table, totals and export use the same selection and data revision.

**Primary chart:** reported NAV/value over actual calendar time. Make every real observation visible and selectable. One observation is a valid chart with one point. Use observed points without implying daily pricing; optionally show a clearly labelled last-known-value step series. Missing coverage remains a gap or an explicit carry-forward state. No smoothed invented monthly/daily history.

**Related chart:** contributions and distributions on a separate aligned cash-flow plot once recorded. A notice is visibly pending and cannot enter the settled series. Net contributed capital may be overlaid on NAV only with complete cash-flow coverage and an explicit definition. Avoid a second vertical axis with unrelated units.

**History table:** effective date; observation/event type; original amount and currency; reporting-currency amount; change from previous comparable observation; valuation/FX basis; source date; acceptance/revision status; source action. Separate an observations mode from a period summary mode. The period summary adds opening/closing values and settled contributions/distributions only when coverage supports them. Use pagination/export for full history, never a silent eight-row truncation.

**Selection behavior:** selecting a chart point highlights its table row; selecting a row pins that point and opens the evidence drawer. The drawer shows exact document/email, page and quote, original value, any FX conversion, acceptance time and correction history. Source access follows the user's existing family/entity permissions. Every interaction must also work without using a chart or hover.

Secondary sections: Cash flows & commitments, Activity, Documents and Exposure. Reuse the same financial records and Activity component in each scope. A small latest-development preview can appear on Overview, but do not repeat the full timeline there.

## 4. Portfolio history and changes

The portfolio page should combine current totals with historical context and a table of contributing holdings. It should offer the same family/entity/manager filters and a clear reporting-currency selection. Useful default investment-list columns are current reported value, valuation date, previous comparable mark, value change, a small real-observation trend, portfolio weight, commitment exposure and data freshness. Asset-specific columns are selectable; avoid a single huge mandatory table.

Selecting a past date must eventually select the holdings actually owned then, their applicable observations, ownership, classifications and relevant FX—not today's holdings with an older date label. Exited investments remain in historical results. First observation is not acquisition; absence before the first observation is unknown unless an evidenced lifecycle establishes otherwise.

Until that lifecycle is available, explicitly describe aggregate charts as history of the selected current holdings. For the current demo, a March subtotal of three holdings cannot be compared with a June total of fifteen as portfolio growth. Provide known-value coverage counts, an unavailable full-period total where needed, and an optional comparable-holdings view. Do not estimate the percentage of missing NAV when the missing values are unknown.

Add a change explanation between selected dates:

- Beginning and ending value, with the observation dates and coverage.
- Contributions/deposits, withdrawals/distributions and internal transfers, classified relative to the selected scope.
- Valuation movement and FX movement where the inputs support separating them.
- Position additions/exits, ownership changes and changes in data coverage.
- An explicit unexplained or unclassified remainder when a complete decomposition cannot be supported.

A value waterfall must reconcile to its underlying table. It cannot label its residual as investment profit merely because the arithmetic balances. At family-portfolio level, funding a held investment from owned cash is internal. At investment level, the same contribution is an external flow. Performance calculations must know which boundary is being measured.

## 5. Chronology, current knowledge and revisions

Store and display distinct dates with their provenance:

| Date | Meaning |
| --- | --- |
| Effective date | When the financial observation or economic event applies. |
| Report date | When the manager issued the report, if supplied. |
| Message timestamp | Provider-received timestamp or original message date, preserving which it is. An EML Date header is not automatically proof of receipt time. |
| Imported at | When Aster first ingested the retained source. |
| Recorded/accepted at | When the fact became part of the accepted financial record. |
| Due/settled date | Obligation deadline or confirmed cash event date; these remain separate. |

Default Activity to effective date, newest first, with an oldest-first control. Group by calendar date and use stable ties. Offer a separate Received/imported view for newly arrived information. An older report arriving today belongs at its effective date in economic history and at today's intake position in imported activity. Events with no economic date need a visible unknown-date state, not a guessed date.

Default historical views to latest accepted/restated knowledge. A later advanced query may reproduce what was known at a historical cutoff. This requires recorded-time version selection as well as effective dates. Existing ingestion timestamps cannot be backdated to imply earlier knowledge. Previously saved reports remain unchanged and reproducible.

Corrections need first-class presentation: show the current accepted version, preserve previous versions, identify supersession and allow the user to inspect why it changed. Wrong-investment/date retractions and dependent historical replay require explicit domain operations; do not bypass existing correction and settlement safeguards.

## 6. One historical data and calculation layer

Use a shared deterministic projection service across Portfolio, Investments, Cash, Activity and Reports. Agents and classical extraction workflows produce candidate facts; accepted equivalent facts produce the same downstream financial results regardless of engine.

Proposed inputs: tenant and authorized scope, position/investment IDs, date range, economic as-of date, optional knowledge cutoff, currency, valuation policy, grouping and metric basis. Proposed outputs: current/as-of positions, observation series, cash-flow series, ordered events, coverage, calculation explanations and source/version references.

Start with adapters over the existing finance, review and source records. Keep view calculations out of React components. Preserve a common query key and workspace/projection revision so every affected view refreshes after ingestion or review without overwriting edits in progress.

The durable model should distinguish investment identity, investor position and effective-dated ownership/account/classification history. Canonical financial records should cover valuation observations, cash-flow obligations, settlement postings, commitment observations/changes, lifecycle events and corrections. Link every record to document, extraction fact, review revision and any predecessor record. Keep monetary values exact, financial payloads encrypted, tenant predicates explicit and caches scoped by permissions and data revision.

Existing `finance.valuations` already provide effective date, recorded time, native amount/currency, EUR value, FX, source and correction lineage. Backfill those facts without inference. Preserve unresolved legacy provenance. Introduce `firstObservedAt` independently from a sourced economic opening date: the demo's legacy opening-date field currently reflects processing order and must not be treated as acquisition evidence.

As history grows, move canonical observations into bounded, paginated encrypted storage rather than indefinitely expanding the single workspace envelope. Run the new projections beside the current ones, compare results by tenant, then switch readers behind a reversible flag. Avoid dual independent financial writers. Keep previous report snapshots and their calculation versions.

## 7. Connect notices to usable financial history

An accepted capital-call/distribution notice should create one linked obligation draft immediately. It can be visible while the cash account, currency conversion, distribution classification or actual settlement is unresolved. This requires a draft model that allows missing fields; do not weaken the validated settlement transaction model.

The user completes or confirms a proposed account/position match from the investment or Cash view. Later bank/custody evidence can be matched to the obligation and reviewed according to policy. Confirmed settlement appends cash/investment postings; reconciliation establishes period coverage. Reprocessing the same source, forwarded emails and report consolidations must not duplicate obligations or settlements.

Each obligation moves through explicit states such as needs details, ready, expected, partially settled, settled or cancelled. Partial settlements and reversals need stable links and a remaining amount. Do not infer zero fees, zero recallability, zero cash or a settled payment from a notice.

## 8. Metrics without hiding useful data

Replace the global sample-performance flag with availability per metric, scope and period. Value history should work even when return metrics are unavailable. Each unavailable metric should name the missing input and link to a relevant action.

| Measure | Prerequisites and presentation |
| --- | --- |
| Latest reported value and valuation history | Accepted observations and source dates. Available with one point. |
| Change between reported values | Comparable observations with dates, currency and scope; label as value change. |
| Paid-in, distributed and unfunded amounts | Source-supported cash-flow/commitment records and completeness state; notices and settlement totals are distinct. |
| Investment result | Comparable beginning/ending marks and complete relevant flows; identify fee and currency basis. |
| Private-fund multiples and investor IRR | Defined investor/fund scope, paid-in/distribution history, terminal value, dates and fee basis. Missing inputs or invalid/nonunique IRR solutions produce an unavailable result. Manager-reported and internally calculated metrics remain separate. |
| Portfolio return | Correct scope-relative flows and adequate valuation/reconciliation coverage. Keep the existing Modified Dietz estimate accurately labelled; enable exact TWR only when its inputs support it. |

Align the private-fund metric dictionary and cash-flow categories with the [ILPA Performance Template](https://ilpa.org/industry-guidance/templates-standards-model-documents/ilpa-templates-hub/ilpa-performance-template/), which relates performance metrics to contribution/distribution data. Define basis before offering TVPI/DPI/RVPI or comparisons. Use [GIPS asset-owner methodology](https://www.gipsstandards.org/standards/gips-standards-for-asset-owners/gips-standards-handbook-for-asset-owners/) as a reference for time-weighted versus money-weighted methods and external-flow treatment; adopting calculation references is not a compliance claim.

Benchmarks, fee attribution and historical look-through are later capabilities gated by appropriate source coverage, dates and licensing. Do not apply today's constituent weights to past dates and label the output historical exposure.

## 9. Delivery sequence

| Milestone | Deliverable | Completion gate |
| --- | --- | --- |
| 1. Useful investment history | Shared observation adapter; live NAV charts independent of returns; complete chart/table/source investment record; explicitly sorted Activity; consistent refresh; provenance and coverage labels. | Any existing holding exposes every retained mark and its source. One-point histories work. Late reports and corrections appear correctly. |
| 2. Connected cash history | Obligation drafts from accepted notices, unresolved-field actions, cash-account matching, settlement/reversal and reconciliation flow; longitudinal synthetic sources. | A notice becomes a visible draft without changing cash. Confirmed evidence posts once and changes the relevant investment/portfolio views consistently. |
| 3. Historical portfolio reconstruction | Effective-dated lifecycle and classifications, canonical encrypted record storage/backfill, historical projection/replay, scope-relative flows and currency policies. | As-of results include exited holdings, exclude future events and distinguish restated history from knowledge available at the time. Unknown acquisition/history remains unknown. |
| 4. Consolidated portfolio and reporting experience | Portfolio history/change analysis, contextual metrics, shared reports/exports, simplified navigation, attention actions and qualified historical exposure. | Chart, table, headline figures and saved/exported results agree for identical scope/date/revision. Relevant return metrics become available from evidence, independently of extraction engine. |

Milestone 1 is the first end-to-end demonstration: open an investment, understand its current value and history, select a change, inspect the original evidence. Backend foundations for later milestones can proceed in parallel, but do not announce full historical portfolio reconstruction before its completion gate.

## 10. Demo and acceptance scenarios

Keep the current 100-email extraction benchmark and its recorded results intact. Create a separate longitudinal demo with three families, multiple entities/currencies, at least twelve quarters of fund observations, an investment entry and exit, cash statements, calls/distributions, partial settlement, a missed report, a late report, a correction and a deliberate duplicate. Author expected observations, balances and calculation results before ingestion. Label all generated source records synthetic. Never insert made-up history directly into a chart to imply ingestion succeeded.

Acceptance scenarios:

1. Import a March valuation in September: it appears at March on the chart and economic timeline, and September in imported activity.
2. Correct that valuation: the current history changes exactly once, its earlier version remains inspectable, and a previously saved report remains unchanged.
3. Receive a call: show an obligation immediately, preserve unchanged cash; settle once from confirmed evidence, preserve scope-relative flow treatment, and reconcile the resulting balances.
4. Load one, many or no observations: show a truthful point series, paginated full history or actionable empty state respectively. Unknown periods do not become zeros.
5. Add information for previously unvalued holdings: disclose the change in coverage; do not present it as investment performance.
6. Reconstruct a date before a later acquisition and after an exit: include the correct economic positions only when lifecycle evidence exists; otherwise disclose missing lifecycle coverage.
7. Switch family, entity, investment, currency, period or knowledge cutoff: every figure, chart, table, source link and export uses that same scope with no cross-family disclosure.
8. Process equivalent evidence through agentic and classical paths: accepted financial records and projections agree; model trace remains available in source provenance.
9. Exercise keyboard/mobile chart selection, table drilldown, loading errors, retries and background refresh. Preserve a user's unsaved review draft.
10. Run representative multi-family history at scale; keep queries paginated, decrypted payloads bounded, request cancellation and permission-aware caching verified.

The release review should assess whether a manager can explain an investment's development and verify the relevant number without first visiting Documents or understanding an engine trace.
