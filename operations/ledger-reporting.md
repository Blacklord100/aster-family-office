**Register, ledger and custom-period reporting**

The register is a bounded record of reviewed long-only positions and cash. It does not connect to a bank, place trades, initiate settlement, infer FX rates, determine tax treatment or provide a general ledger. Source references are reviewer attestations unless linked to a document already held in Aster; entering a filename does not upload or independently verify that file.

Create a family, then reuse its legal entities and accounts when adding holdings. Legal-holder categories are Holding company, Property SPV, Trust, Foundation, Partnership and Individual. The category is descriptive. The recorded ownership percentage does not change tax treatment or automatically multiply position values: each holding value must already represent the investor’s economic share.

An opening holding records the original-currency amount, explicit EUR conversion, effective date, source, book cost, commitment, manager and optional manager/instrument/share-class identifiers. EUR, USD, GBP and CHF are supported. Amounts have cent precision; a non-EUR rate means EUR per one unit of source currency and requires a dated citation. Conversion uses integer decimal arithmetic and rounds half up to EUR cents. The rate date cannot be after the financial effective date. Posting dates cannot be after the server’s current UTC calendar date.

Existing accounts can be reviewed without creating replacements. “Review account” records currency, explicit restriction status, source, reviewer and review time. Earlier account reviews remain in the encrypted finance record. Existing cash cannot be relabeled into another currency. Missing account metadata remains an unknown restriction in liquidity reports.

**Review and settlement**

A reviewed transaction is an obligation or instruction record. It changes no balance. A separate settlement action confirms activity already seen at the bank; the application never sends the payment. The bank’s effective date may precede the date of review, provided the posting does not precede a later recorded financial mark or posting.

| Kind                    | Cash movement          | Investment movement                                                     | External portfolio flow              |
| ----------------------- | ---------------------- | ----------------------------------------------------------------------- | ------------------------------------ |
| Deposit                 | Increase               | None                                                                    | Positive                             |
| Withdrawal              | Decrease               | None                                                                    | Negative                             |
| Capital call / purchase | Decrease               | Explicit capital increase equal to funded cash                          | None                                 |
| Sale                    | Increase by proceeds   | Explicit carrying value and book cost released                          | None                                 |
| Distribution            | Increase               | Either income with no carrying reduction, or explicit return of capital | None                                 |
| Fee                     | Decrease               | None                                                                    | None; retained in investment results |
| Cash transfer           | Opposite cash postings | None                                                                    | None                                 |

Cash and investment funding must share a legal entity and currency. Transfers are supported only between different cash balances in the same entity and currency. Restricted accounts cannot settle transactions. Overdrafts, negative investment carrying balances and negative commitments are rejected. Cross-currency conversions and cross-entity funding require a future explicit workflow; they are not synthesized as transfers.

Calls may explicitly reduce unfunded commitments. A distribution may explicitly increase them only when the reviewer records it as recallable. No other transaction silently changes commitments. A funded investment is displayed as the last reported mark plus settled capital until a new sourced valuation is reviewed. This capital bridge is not a new manager-reported NAV. Cash book-cost releases use average cost; investment cost releases are entered explicitly. This is not a tax-lot or realized-gains system.

For example, cash of EUR 500 and fund NAV of EUR 1,000 total EUR 1,500. Reviewing a EUR 100 call changes neither figure. Confirming settlement changes cash to EUR 400 and the fund’s bridged carrying value to EUR 1,100. Portfolio value stays EUR 1,500. If explicitly selected, an unfunded commitment of EUR 400 becomes EUR 300. The call reduces liquidity; it does not create a EUR 100 investment loss.

Financial transactions are append-only through the API. An unsettled instruction can be voided; a settled transaction can be reversed once by appending exact opposite postings linked to the original event. Amount edits do not rewrite the original transaction. A same-date valuation correction must state the current EUR value and a reason, including when the native amount, currency or FX basis changes but the EUR total is unchanged. Previous valuation versions remain recorded. Reversals involving later dependent valuations are refused because automatic historical restatement is outside this implementation.

**Cash reconciliation and performance availability**

Reconcile every registered cash holding in an entity together for a stated period. The reviewer supplies the original-currency and EUR closing statement balances, a source reference and an attestation that account statements and external flows have been checked. Closing balances must match the ledger. A zero net difference alone does not establish completeness: equal missing deposits and withdrawals could offset, so the attestation remains necessary.

Coverage stores its statement balances and immutable event/valuation cursors. Later postings or cash marks affecting that period invalidate its freshness. Unrelated reviews and later-period activity do not invalidate an earlier period. Scoped exports remap those cursors when unrelated entries are removed. Reconciliation does not manufacture comparable investment marks or mark unknown historical flows as zero.

Custom-period performance requires an accepted sourced mark for every selected holding on both exact requested dates. Synthetic evidence, interpolated history, stale marks carried forward and assumed zero opening positions are not accepted. Opening/closing cash must reconcile in its original currency:

`unexplained cash difference = closing native cash − opening native cash − recorded native movements`

Only complete current cash-flow attestations and zero unexplained native cash differences permit a return estimate. Otherwise the report shows known subtotals and specific gaps, with unavailable totals/returns where coverage is incomplete. EUR FX remeasurement remains part of EUR investment performance; it is not treated as an external deposit.

The available estimate is Modified Dietz with end-of-day flow weights: `(closing value − opening value − net external flows) / (opening value + sum(weight × external flow))`. A flow’s weight is the fraction of calendar days remaining after its effective date. The opening date is an end-of-day mark; flows after that date through the closing date are included. This is a period estimate, not annualized performance or exact time-weighted return. Large flows and volatile values can reduce its accuracy. Methodology reference: [GIPS Standards Handbook for Asset Owners](https://www.gipsstandards.org/standards/gips-standards-for-asset-owners/gips-standards-handbook-for-asset-owners/). The application does not claim GIPS compliance.

For 1–10 September, opening EUR 1,500, closing EUR 1,700 and a reconciled EUR 100 deposit on 5 September produce EUR 100 of investment result. The deposit weight is 5/9, so the estimate is `100 / (1,500 + 100 × 5/9) = 6.4286%`. Without the statement coverage or with an unexplained cash difference, the same marks produce an unavailable return.

**Liquidity and saved runs**

Dated liquidity groups recorded cash and currently reviewed unsettled obligations by legal entity and currency. It includes overdue obligations. Restricted balances and incoming amounts directed to restricted accounts are excluded from projected available cash. Unknown restrictions, unavailable historical balances or newly restricted outgoing obligations suppress availability. The projection assumes stated inflows arrive; it is not a funding guarantee. It does not reconstruct which obligations were known at a historical date, forecast unrecorded calls or establish that accounts can actually transfer money between them.

Period snapshots preserve their query, scoped portfolio and finance inputs, result, reviewer/time and source workspace revision. Stress snapshots preserve selected holdings, evidence, reachable saved look-through graph, exact scenario and full deterministic exposure/stress results. Changes to holdings, mappings or scenario templates do not recalculate saved results. Source and result content hashes are checked when snapshots are read. These checks establish consistency of the saved content, not independent financial verification or external certification. PDF/document bytes are not embedded in the JSON export.

Snapshot writes use workspace revision checks and idempotency keys. The API appends snapshots; it has no edit/delete operation. Storage is bounded to 20 snapshots and 8 MiB of reporting payload per workspace. Full-input saved snapshots are withheld from scoped viewers; those viewers can calculate fresh custom periods from their released records. All persisted financial/snapshot state uses the existing encrypted workspace envelope and tenant authorization. Browser mutations use the existing same-origin and role checks.

The implementation remains limited to reviewed records supplied by users. It lacks automatic banking reconciliation, historical restatement across dependent postings, debt/derivative and margin accounting, FX trades, tax lots, independently verified complete account coverage, exact TWR/IRR and signed external report certification. Stress runs remain hypothetical deterministic shocks with explicit unresolved exposure, not historical replay, VaR, probabilities or forecasts. See [risk simulation assumptions](risk-simulation.md) for their shock precedence and capital-call treatment.
