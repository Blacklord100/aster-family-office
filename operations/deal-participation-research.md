# Shared deals and family exposure

Research and implementation decisions, 10 September 2026.

## The questions the interface should answer

1. Which visible families participate in the same investment, and through which entity and account?
2. How much of the NAV recorded for that deal belongs to each family?
3. How concentrated is that deal within each family's selected portfolio?
4. What ownership percentage is actually documented, and what is its denominator?
5. Which managers bring exposure to the same underlying issuer?
6. Under one stress scenario, which families lose the most in money and as a percentage of their visible NAV?

These questions require different denominators. A family's EUR 6m position can be 60% of the EUR 10m NAV recorded across visible participants, yet represent only 6% of all issued Class A units. Neither percentage establishes its share of another class or of the entire company's equity. A 60% recorded participation also does not mean 60% of that family's wealth.

## Research informing the design

Addepar describes portfolios through entities and ownership hierarchies, including accounts, legal entities and securities. This supports preserving an investor's legal path rather than treating a holding's name as its identity. [Addepar API introduction](https://developers.addepar.com/docs/welcome)

Addepar's ownership map presents entity relationships with ownership percentage and value, while its security filtering can surface total exposure to a company. These are useful precedents for pairing explicit participation with separate issuer look-through. Our family heatmap and source drilldowns are implementation choices, not claims about Addepar's precise calculation methodology. [Addepar product update, April 2023](https://addepar.com/blog/inside-addepar-april-2023)

ILPA publishes distinct performance-template methodologies and associated contribution/distribution reporting resources. Their separation reinforces the need for documented cash flows before presenting performance ratios. This change therefore adds NAV participation, not inferred paid-in capital, commitments, distributions, IRR or TVPI. [ILPA Performance Template](https://ilpa.org/industry-guidance/templates-standards-model-documents/ilpa-templates-hub/ilpa-performance-template/)

## Implemented views

| Location | View | Decision it supports |
| --- | --- | --- |
| Investments → Deals & families | Shared deal cards, family badges and stacked recorded-NAV participation | Identify participants and relative recorded deal size at a glance |
| Investment detail | Family/entity/account breakdown with NAV, recorded share, portfolio weight and separate sourced ownership | Check the investor's route, proportions and evidence |
| Portfolio → Families × deals | Family/deal matrix; switch between NAV and portfolio weight, select a cell, export the complete selection | Compare concentration across families without confusing money with portfolio importance |
| Risk → Total exposure | Direct and indirect issuer exposure by family; unknown exposure remains separate | Spot combined exposure hidden inside manager vehicles |
| Risk → Total exposure | Manager × issuer matrix with paths | Identify managers concentrating on the same underlying issuers |
| Risk → Simulation | Same-scenario loss by family in EUR and percentage | Compare family sensitivity under identical assumptions |

## Calculation and evidence rules

- Canonical identity contains the documented name, manager, legal vehicle, share class and round, plus an optional identifier. Equal names do not create a link.
- Every position belongs to its existing family, entity and account. Linking never transfers a holding, multiplies its economic NAV by ownership, or changes financial records.
- A link, unlink or ownership declaration retains its source document hash, quote, page, effective date, recording time and reviewer. Corrections append a new record.
- Recorded deal shares use visible known NAV. Incomplete valuation coverage is disclosed. An unknown mark is not a zero position.
- Portfolio weights require a complete denominator for the selected family/entity scope. Filtering to a deal or a comparable cohort does not shrink the family denominator to that deal or cohort.
- Actual ownership requires a separate sourced percentage and explicit denominator label. Percentages with different denominators are never summed into a purported total ownership.
- Participation follows Portfolio's date, currency, cohort and knowledge cutoff. The history and participation API read one database snapshot; the UI waits for matching workspace revisions.
- Native non-EUR views require corresponding source-currency values. The implementation does not fabricate exchange rates.
- Family access restrictions apply before grouping. Restricted responses contain no other family names, participant counts, hidden denominator amounts or write receipts.
- Source withdrawal or changed retained content makes the affected mapping unavailable; it cannot resurrect a superseded mapping.
- Stress and issuer look-through use current recorded EUR values and existing terminal exposure paths. They are distinct from the historical participation projection. Unknown marks and underlying allocations remain visible.

## Operating the feature

Open Investments, find an unlinked position and choose **Link position**. Register its canonical deal or select an existing one only after verifying the legal vehicle, class and round. Open the retained source, check the quote and effective date, and save the reviewed link. Repeat for the other families' positions. Use **Record actual ownership** only when the source provides the percentage and its denominator.

The Portfolio matrix, investment cards and detail breakdown then use those records automatically. The matrix exports all authorized selected deals and unlinked positions, not just the visible page, with original numeric values, source references, scope and revision. Dates and missing data remain explicit.

Existing demo funds are not retroactively grouped by similar names. Validation adds six new, explicitly synthetic positions in an isolated QA organization: two common vehicles across three families, with one showing 60/30/10 recorded NAV shares versus 6/3/1 issued-unit ownership. Those fixtures are manually reviewed known-answer records; they are not an extraction benchmark and are not inserted into customer workspaces.

## Deliberate next steps

The next useful additions are dated underlying-issuer disclosures for historical look-through, sourced target allocations with rebalancing gaps, and reconciled cash-flow attribution. They need complete evidence and rules for partial coverage before their charts can be reliable. A multi-hop ownership graph can then show a selected path without replacing the more scannable matrix and tables.

The shared investment catalog remains bounded to 200 identities and 2,000 append-only participation records per encrypted workspace. Moving this registry and the existing history into dedicated financial tables is a separate capacity migration, not silently performed by this feature.

## Validation for this change

- Full suite: 727 tests passed; 65 environment-gated tests skipped. Lint, TypeScript checks and the production application/service build passed.
- Five tests against a fresh disposable PostgreSQL cluster passed, including authenticated participation writes, scoped reads, rejected cross-origin/read-only writes, idempotent retries, retained hashes, encrypted storage and unchanged financial observations.
- Playwright with the existing Chromium binary tested desktop 1440×1100 and mobile 390×844. The Browser plugin was unavailable. Real retained-source preview, canonical creation, first position link and independent ownership entry were exercised through the UI; remaining known-answer fixture positions were linked through the authenticated API after inspecting their source bytes.
- Browser checks covered date/currency changes, preserving comparison dates across participant navigation, incomplete native-currency valuations, full-selection CSV export, source drilldowns, network-error recovery, forbidden-response clearing, scoped-family isolation, matrix pagination, scenario controls and contained mobile scrolling. The new views produced no unexpected browser errors.
- Participation correction/unlink rules are covered by domain/API tests; those two editor submission paths were not separately exercised in the browser. Positive multi-manager graph screenshots use an explicitly labeled browser-only response fixture. The real synthetic workspace and restricted-user risk flows were tested separately.

This validates the feature and its stated bounds. It is not a claim that the separate production release/security gates or a full local-model extraction benchmark have been completed by this change.
