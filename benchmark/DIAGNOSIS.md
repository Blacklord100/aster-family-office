# Frozen-run diagnosis and regression plan

The original Gemma matrix `20260908T192614Z-3115a7d8` completed all 28 attempts with unchanged source/gold, model inventory, benchmark code and processor. Both modes recovered 6/14 exact supported facts (42.9% recall), missed eight facts and returned one unsupported wrong-entity NAV. This diagnosis informed a later processor revision; the corpus is now a development regression set, not fresh holdout evidence for that revision. Original raw replies and scores remain unchanged.

## Confirmed recall gap: source-anchored investment names

In the frozen run `20260908T192614Z-3115a7d8`, `capital-call`, `distribution`, `forwarded-call`, `identical-call-copy`, `multiple-periods`, and `ambiguous-currency` return no accepted extraction facts in both modes. The preserved raw replies contain candidates matching all six gold financial fields and the scorer's contiguous quote/page/anchor checks. The final pipeline rejects candidates with `event_kind_not_supported`. The read-only comparison is recorded in that run's `pipeline-miss-analysis.json`; it does not substitute raw model candidates for final pipeline results.

Read-only diagnostic calls on the decoded source confirm `has_event_semantics(...) == True`, `name_mentions(...) == []`, and `source_events(...) == []` for the capital-call and distribution originals. The problem is independently anchored name discovery, not absent event semantics or invented model evidence.

Current name patterns in `processor/service/source_events.py` support valuation/NAV-first forms and selected name-first verbs, but omit these literal source constructions:

- `The capital call for Fennel Ridge Growth VII is EUR ...`
- `Brackenmere Secondaries IX reports a distribution of CHF ...`
- `Alderwick Bridge Fund reports a distribution of $...` (the model correctly leaves currency null).
- `Kestrel Orchard Opportunities II: investor NAV as of ...` on each of two reporting-period pages.

`processor/service/grounding.py:verify_fact` correctly refuses to accept a model-supplied entity unless the source parser independently recognizes that entity and event. Preserve that boundary.

## Confirmed attribution defect: later issuer borrows earlier fund NAV

Both `unknown-constituent-weights` attempts return EUR 6,250,400 under **Ravenport Sensor Systems Ltd**, an underlying company. The source explicitly assigns that NAV to **Tamarind Select Ventures I**. The trace identifies the wrong fact as a source-rules candidate; the model's correctly named, contiguous source-supported fund candidate is rejected.

Read-only source diagnostics find one recognized name, `Ravenport Sensor Systems Ltd` at offsets 362–390. The returned valuation event is at offsets 0–199, before that name. `name_mentions` misses the earlier `<Fund>: investor NAV` clause, and `_name_for` falls back to the only distinct recognized name anywhere on the page. This is an unsupported cross-entity attribution, not merely a recall loss. A correct source quote covering a whole page does not repair a wrong entity/amount association.

Adding the omitted fund grammar is necessary but insufficient: remove or tightly constrain backward attribution to an unrelated later name. A genuinely explicit event-first construction can bind a following name inside its own bounded clause; an unrelated table name must not label an earlier event. Preserve conservative failure when the owner of a monetary fact cannot be identified.

## Candidate change after the frozen matrix completes

1. Add bounded grammatical anchors for explicit event-first `capital call/drawdown/distribution for <proper investment name>` clauses, name-first `<proper investment name> reports [a/the] distribution/capital call/NAV` clauses, and `<proper investment name>: investor NAV` clauses. Keep source spans and exact offsets; do not allow a model hint to create a name.
2. Retain all current amount-role, currency, effective/due-date, quote-contiguity, negation, withdrawal and multi-entity checks. Do not bypass `verify_fact` or broadly accept any proper-noun phrase on the page.
3. Independently tighten `_name_for` so an unrecognized earlier event cannot inherit the only recognized later issuer's name across unrelated clauses or table sections. Test the parser without the new fund-name grammar as well, to prove that attribution safety does not depend on recall being perfect.
4. If further failed cases expose a separate issue, isolate it with its own minimal source-only regression before changing the parser. Do not change frozen benchmark gold to fit results.

## Required neighboring guards

- New positive forms with EUR, CHF and an ambiguous `$` currency; missing fields remain null.
- Effective date and later payment/due date in separate sentences; no promotion of delivery date to financial effective date.
- Investor NAV versus manager fund size; commitment amount versus amount called.
- Two named funds with different amounts and deadlines; no cross-fund role borrowing.
- An earlier unrecognized fund NAV and a later underlying issuer table; no backward attribution, including when only one issuer name is recognized.
- A merely mentioned fund name, negated call/distribution, a withdrawn mark, and an instruction to invent a value; these must remain unsupported.
- A corrected same-date mark and two valid different reporting periods; preserve the distinction.
- Direct, forwarded and identical email copies; stable economic fields with no duplicate fact within one extraction.
- Exact quote required; a fabricated quote or abbreviated quote omitting event roles must still fail.

After tests pass, freeze the candidate processor digest. Rerun affected cases in both modes plus neighboring guards, preserving every raw response, result and timeout alongside the unchanged baseline run. Describe the result as a regression comparison: the corpus will have informed the implementation and is no longer a fresh holdout for that candidate revision. Keep the untouched v1/v1.1 gold and original matrix as historical evidence.

## Candidate freeze

Candidate `source-ownership-v1` implements the three bounded name constructions in `processor/service/source_events.py`, removes both later-local and global single-name backward borrowing, and extends the existing negative-predicate guard across an explicit event-first owner name. The final evidence validator, pipeline, model prompts and source/gold files are unchanged. An amount-first construction without an already anchored owner now conservatively requires manual source review rather than borrowing a later name.

The 24 new tests in `processor/tests/test_grounding_ownership_regressions.py` cover these source-only behaviors and neighboring ownership, deadline, commitment, native/unknown currency, negation, retraction, duplicate, multipage and quote boundaries. The complete Python suite passed: 263 tests, zero failures/skips, two pre-existing dependency deprecation warnings, 16.89 seconds.

Frozen processor digest: `4f5fb8d74d821a7bdf85b955cc258a3708ee613747f2627d33c8ac3f8f4efb7c`. Metadata, source/test snapshots and the captured full Python test log are preserved outside the repository under `validation-seven-items/benchmark/candidate-source-ownership-v1`.

The complete same-model/settings development regression `20260908T194944Z-27eeb285` ran only after that freeze. All 28 attempts completed: each mode returned 14/14 exact supported facts, 14/14 fact-perfect documents, zero missed or unsupported facts, and no execution/inference errors. The NAV remains assigned to the fund, the ambiguous dollar currency remains null, both historical periods remain present, and both scan attempts recover the exact CHF NAV with local OCR provenance.

Candidate median document latency was 22.52s workflow and 39.19s agentic, versus baseline 25.45s and 40.68s. Total document time increased from 16.38 to 17.59 minutes, and candidate maxima were 90.46s/91.93s; this is observed sequential timing, not a controlled speed result. Both full matrices made 73 model chat calls. End checks confirmed the same frozen inputs, scorer/runner, model digest, Python version and settings across the comparison, with only `source_events.py` changed among processor files. The external `REGRESSION-COMPARISON.md` and `.json` preserve the before/after table, per-case results and evidence paths. These development results do not erase the baseline attribution failure or support a new holdout claim.
