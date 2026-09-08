# Exposure and hypothetical stress simulation

The Risk & simulation workspace calculates the effect of explicit assumptions on recorded EUR holding NAV or equity values. Calculations are deterministic TypeScript; they do not call an LLM. A scenario is a sensitivity exercise, not a forecast, historical replay, probability estimate or recommendation.

Implementation: `lib/risk-contract.ts` defines validated inputs and results; `lib/risk-engine.ts` performs the calculations; `data/risk-demo.ts` supplies explicitly synthetic sample fixtures. Workspace persistence is handled by `lib/risk-workspace.ts` and `/api/workspace`. The UI is `components/aster/risk-view.tsx` and `risk-editor.tsx`.

## What is being valued

- The starting value is the sum of the selected holdings’ latest recorded `valueEUR`, rounded to cents. Original-currency values are not converted again.
- Fund NAV and property equity are already net values. A property’s buildings or debt are not added to its recorded equity value. Unfunded commitments are excluded from current portfolio value.
- The model treats each current valuation as an unleveraged, long-only value. It does not infer economic leverage embedded in a fund or property from a net NAV. It cannot calculate leverage amplification, derivatives payoffs, short exposures, duration/convexity, credit migration or default recovery.
- The family selector changes the holdings in the calculation. A scenario template does not fix a family, portfolio value or valuation date.

## Look-through accounting

A `RiskData` graph contains `nodes`, `links` and root `positions`. Each position maps one existing `holdingId` to one root `nodeId`. Nodes are either a fund wrapper or a terminal asset. Links from a fund describe fractional shares of that fund’s NAV; `0.15` means 15%.

For every disclosed link, the child receives its parent allocation multiplied by the link weight. A nested path multiplies its successive weights. Only terminal assets and unresolved residuals enter the consolidated value. A fund’s full NAV is never added on top of the allocations that replace it.

A blank weight is undisclosed. It receives no assumed equal weight and is not assigned the residual. The unallocated portion remains attached to the fund as an unresolved NAV slice. Allocations use integer cents and largest-remainder rounding so every holding reconciles exactly to its original modeled value. Sub-cent distinctions cannot be represented.

Repeated issuer IDs combine exposures along all distinct ownership paths. For example, a direct stake and two funds’ stakes in the same issuer are three real allocations to aggregate, not three duplicates to discard. Duplicate input holdings, duplicate root mappings, duplicate identical parent/child links, cycles and weights above 100% are rejected. A fund wrapper is not counted as an underlying issuer.

Issuer IDs are explicit identities, not fuzzy name matches. Use a stable issuer key consistently across files and funds. Two different IDs remain separate even if their names look alike; the same ID aggregates equity and credit of that issuer. This aggregation does not imply that equity and credit have the same sensitivity.

## Coverage and provenance

Coverage percentages use the selected portfolio’s EUR value as the denominator. The following questions are separate:

| Measure                  | What it establishes                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Look-through resolved    | NAV reaches a terminal asset rather than an unmapped holding or fund remainder.               |
| Issuer known             | An explicit issuer identity is present on that asset.                                         |
| Sector / country known   | The emitted allocation has that classification.                                               |
| Effective currency known | A currency exposure is explicitly supplied; unmapped cash uses its recorded balance currency. |
| Manager known            | A manager is disclosed on the path or in the holding’s reported manager field.                |

These dimensions overlap and must not be added together. A terminal asset may be resolved while its issuer, currency or supporting evidence is unknown. “100% coverage” is not independent verification of the data.

The engine retains the holding valuation source and the node/link source references and as-of dates along every emitted path. It warns about missing provenance, source dates more than 90 days before the analysis date, and future source dates. A source ID can be a supplied report reference; it does not prove the referenced disclosure exists or supports the allocation. The UI distinguishes matched workspace evidence records from unverified references.

Weights from their disclosed as-of date are applied to the latest recorded holding NAV. There is no interpolation, reconciliation to a historical constituent report, or assumption that a stale weight remains accurate. Review the valuation and allocation dates together.

Unknown amounts are the current NAV whose allocation or classification is not disclosed. They are not estimates of the hidden issuer, country or currency. Unresolved NAV still receives an applicable asset-class assumption; it is not silently removed from the stress denominator.

Asset class follows the nearest disclosed node class, then the holding class. A missing node class generates a warning about that inherited assumption. Issuer identity and effective currency are never inferred from a fund name or denomination. A currency specified on a fund applies only to that fund’s emitted unresolved remainder; it is not inherited by its children.

Manager attribution uses the nearest disclosed manager on a path, falling back to the holding’s reported manager. This reported field may describe a custodian. Blank, Unknown, Unspecified and similar placeholders remain unknown. Parent and child managers are not both added for the same NAV slice. “Shared companies across managers” is overlap within these disclosed attributed manager identities, not proof of the managers’ total economic overlap.

## Shock precedence and signs

The scenario schema uses decimal returns: `-0.20` is a 20% decline, `0.10` is a 10% gain. The UI inputs use percentages. For each terminal or unresolved slice:

1. Use its issuer override if one is present.
2. Otherwise use its sector override if one is present.
3. Otherwise use its asset-class shock if one is present.
4. Otherwise apply a zero valuation shock.
5. Multiply by the effective-currency factor when that currency is known.

The formula is:

```text
afterEUR = beforeEUR × (1 + selectedValuationShock) × (1 + currencyShock)
lossEUR = beforeEUR − afterEUR
```

Overrides replace the lower-priority assumption; they do not add to it. An explicit zero override also replaces a lower-priority negative shock. For example, a −30% issuer override and −10% USD/EUR shock give `0.70 × 0.90 = 0.63`, or a 37% combined decline. Adding −30% and −10% would be incorrect.

Unknown currencies receive no FX adjustment and remain visibly unresolved; this does not mean they are hedged. Known EUR exposure has no EUR/EUR FX shock. Equity and credit of the same issuer retain their distinct asset-class assumptions unless an explicit issuer override is supplied. Sector and issuer keys are exact matches. A saved override can have no affected holdings after a portfolio or scope change; review its identities when reopening a template.

Each valuation or currency component is bounded from −100% to +300%. These are input bounds, not expected market ranges. Two +300% factors compound to sixteen times the starting value. After-values cannot be negative. Positive `lossEUR` is a loss; a negative number is a gain. An empty or zero-value starting portfolio has no percentage return, so its percentage is undefined rather than an invented 0%.

## Worked example

Assume a €1,000 fund and a €200 direct holding. All classified investments in this example are public equities.

The fund allocates 60% to a nested sleeve and 20% directly to issuer A, leaving €200 unresolved. The sleeve allocates 50% to A and 25% to B, leaving €150 unresolved. The separate direct holding is also A.

| Consolidated slice        | Calculation                   | Starting EUR |
| ------------------------- | ----------------------------- | -----------: |
| A through the sleeve      | 1,000 × 60% × 50%             |          300 |
| A through the parent fund | 1,000 × 20%                   |          200 |
| A directly held           | Recorded holding value        |          200 |
| B through the sleeve      | 1,000 × 60% × 25%             |          150 |
| Unresolved sleeve NAV     | 600 × 25%                     |          150 |
| Unresolved parent NAV     | 1,000 × 20%                   |          200 |
| **Total**                 | Parent NAV is not added again |    **1,200** |

Issuer A totals €700 across three paths and two holdings. B totals €150. Issuer and look-through unresolved amounts are both €350 in this example, although those two measures need not generally be equal.

Now assume public equities −10%, Technology −20%, issuer A −30%, and USD/EUR −10%. A is explicitly Technology/USD. B is Industrials/EUR. The unresolved slices have the parent equity class but unknown sector and currency.

| Slice           | Applied assumptions              | After EUR | Loss EUR |
| --------------- | -------------------------------- | --------: | -------: |
| A, all paths    | Issuer −30%, then USD −10%       |       441 |      259 |
| B               | Public equities −10%; EUR        |       135 |       15 |
| Unresolved €350 | Public equities −10%; FX unknown |       315 |       35 |
| **Total**       |                                  |   **891** |  **309** |

The modeled loss is €309, or 25.75% of €1,200. The unknown €350 remains visible; the calculation does not claim that its undisclosed companies or currencies have the same behavior as the reported asset-class proxy.

## Capital calls and liquidity

Capital-call stress is a separate, illustrative funding calculation:

```text
assumedCallsEUR = currentUnfundedCommitmentEUR × capitalCallRate
cashAfterCallsEUR = cashAfterValuationAndFXShocksEUR − assumedCallsEUR
shortfallEUR = max(0, −cashAfterCallsEUR)
```

The call rate runs from 0% to 100%. It is applied to current EUR commitments as a single hypothetical funding event after valuation shocks. There is no forecast of contractual call schedules or commitment FX changes.

Only holdings recorded as Cash count toward cash available in this calculation. Cash found inside a fund is not treated as cash the family can withdraw. No sale proceeds, distributions, financing, fees, taxes or minimum reserve are assumed.

For a separate example, €100 of recorded USD cash with a −10% USD/EUR assumption leaves €90. If €400 of unfunded commitments is 50% called, the assumed demand is €200. Cash headroom is −€110 and the shortfall is €110. The €200 call is not an additional investment loss. The valuation report remains unchanged when only the call rate changes.

This is indicative aggregate headroom. Summing selected families’ or entities’ cash does not establish that it can legally or operationally fund another entity’s obligations. Account restrictions, ownership, cash accessibility, currency funding requirements and permitted transfers must be checked separately. Narrow the selected scope where useful; the current family filter is not an entity-level funding analysis.

No cash transfer, capital call, holding mark or funded investment is posted by running the model. A capital call ordinarily moves value from available cash to invested capital; the simulator does not invent the funded investment’s immediate NAV or subtract the call from portfolio value as if it were a loss.

## Mapping and saving assumptions

Use **Manage exposures → Map a holding** for a direct asset or one-level fund allocation. Enter explicit asset/issuer identities, disclosed weights, classifications, and source/as-of details when available. Blank fields stay unknown. Reuse the same issuer ID across relevant funds and direct holdings. Effective currency means the economic currency exposure after known hedges; a share class’s denomination alone is insufficient.

Saving a manual mapping replaces that holding’s root mapping, while preserving reachable mappings used by other holdings. The form starts with new rows; inspect the existing JSON before replacing a complex mapping. Nested funds and explicit manager IDs are supported through **Import JSON**. Import replaces the entire workspace graph, including other families, and must be reviewed as a complete replacement.

The graph must reference holdings in the current workspace. Graph bounds are 400 nodes, 800 links, 200 root mappings, 20 levels and 20,000 expanded traversal paths. The request has an additional 64 KB save limit, so a graph can reach the byte limit before those count limits. Synthetic flags are rejected in a live workspace. Removing a synthetic flag does not verify data: the operator remains responsible for using evidence for the actual holdings.

The built-in hypothetical presets are Broad market drawdown, Private capital squeeze, EUR currency headwind and Technology sector reset. Their labels and parameters are illustrative assumptions; no event probability, frequency or time horizon is attached.

**Saved scenario templates** store validated assumptions and a name, not portfolio results, a selected family or a historical snapshot. Reopening recalculates against the current holdings, current mappings and selected family. Up to 20 templates are stored per workspace. Write actions require workspace write permissions; viewers can inspect and run local assumptions but cannot save workspace changes. Saving or deleting a template and saving a graph do not change accepted holdings, valuations, commitments or performance history.

## Operating limits

The current feature does not establish audited constituent data, verified issuer mastering, market-data freshness, legally available liquidity, scenario approval history, an immutable result snapshot, or reproducible historical portfolio snapshots. A recorded source is a provenance reference, not an automatic verification or assurance statement.

Before using outputs in consequential decisions, reconcile the accepted holding values and commitments, review stale and missing allocations, verify issuer identities and economic-currency assumptions, and check actual funding restrictions. An unknown allocation can materially change the result. Do not interpret a zero applied shock, missing override match, high coverage percentage or absence of structural warnings as evidence that an investment is safe.

Domain validation is covered by 19 tests in `lib/risk-engine.test.ts`, including nested/overlapping allocations, unknown weights and currency, invalid graphs, bounds, cent rounding, source dates, issuer/sector/class precedence, favorable and adverse shocks, and the separation of call cash demand from valuation losses. Those checks establish the stated implementation behavior; they do not validate market assumptions or classify the model as institutionally approved.
