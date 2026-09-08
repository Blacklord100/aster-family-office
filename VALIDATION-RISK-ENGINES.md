# Exposure, stress and selectable engines — validation

Validated on 8 September 2026 against the local Aster application, its restricted PostgreSQL runtime role and explicitly synthetic workspaces. This release adds deterministic risk calculations and selectable inference providers. It does not certify a production deployment or establish a model accuracy ranking.

## Financial calculations and UI

- 19 risk-engine tests cover nested ownership, repeated issuer paths, unknown weights, reconciliation to cents, graph limits, cycles, invalid dates, unknown managers, shock precedence, multiplicative FX, equity/credit distinctions, gains, zero NAV and capital calls separated from valuation changes.
- Four workspace tests verify scenario persistence, portfolio preservation, foreign holding rejection and bounded inputs.
- Eleven real HTTP checks verify durable mappings/templates, unchanged financial records, tenant isolation, viewer restrictions and invalid graph rejection.
- Twelve risk browser interactions verify the scenario lifecycle, family filtering, manual 40% look-through, rejected overallocations, undisclosed weights and viewer controls. Additional desktop/mobile checks verify rendered results, scenario editing, coverage and layout at 390px. No runtime or console errors were observed.
- Eighteen engine browser checks verify local discovery, profile creation and revisions, explicit activation, retention of an older active revision after editing, workflow selection, default restoration, deletion, credential clearing, form validation and viewer restrictions. These browser checks performed no model inference. The runtime returned nine installed model tags during this check; this inventory can change.

The risk engine is a bounded long-only valuation sensitivity model. It does not infer undisclosed allocations, model leverage amplification or derivatives, calculate VaR/probabilities, or replay historical crises. Aggregated cash assumes availability across the selected entities; transfer restrictions and timing require separate review. See [methodology](operations/risk-simulation.md).

## Actual Gemma document processing

Installed `gemma4:e4b-m3` ran through the real HTTP upload, encrypted durable queue, document worker, processor and local Ollama runtime. Two previously used synthetic regression fixtures were processed in both modes:

| Fixture | Expected fact | Workflow | Agentic |
| --- | --- | --- | --- |
| Cedarstone valuation PDF | EUR 12,450,000.00 NAV, 2026-06-30 | Exact; 1 model call | Exact; 4 model calls |
| Birchwater capital-call email | EUR 275,000.00, effective 2026-08-20, due 2026-09-03 | Exact; 1 model call | Exact; 4 model calls |

All four jobs reached review with the expected financial fields and no extra final facts. Every result recorded actual Gemma use and local execution. The email runs each rejected an unsupported event candidate through the evidence validator. Exact final pipeline results do not establish that every intermediate model or parser candidate was correct.

All jobs were queued with Gemma before restoring the workspace's deployment default. Their recorded configuration remained on the original Gemma profile revision throughout execution. No facts were accepted into the portfolio by this check. Profile/model identifiers are pinned; mutable tags do not provide immutable model-weight replay.

The fixtures are `doc-001` and `doc-002` from the preserved candidate-5 baseline manifest. Their hashes were verified before upload. They are used regression inputs, not a new holdout. Full results were fetched with each selected job ID; unselected list rows intentionally omit extraction payloads. Original earlier evaluation reports were preserved.

## Engine and runtime boundaries

- Sixteen live engine API checks cover administrator/viewer permissions, revisions, explicit activation, foreign profile denial, secret-free DTOs, disabled-cloud refusal, model discovery and a synthetic Gemma schema check.
- Tenant database integration verifies encrypted profile revisions and job configuration contexts.
- Five native worker lifecycle tests verify shutdown/requeue, cancellation/disconnect, stale-result fencing, bounded failure retries and capacity deferral. No real model is used by that suite.
- All six mailbox integration tests pass, including native encrypted recovery across the current 25-table schema. Restored records were compared and encrypted engine revisions/job pins were authenticated with their tenant/record-bound contexts; a separate snapshot drill verified all four recorded Gemma pins and six engine revisions. Temporary recovery databases, snapshots, keys and fixture organizations were removed. This is native development recovery evidence, not a Docker or production backup drill.
- The full Node suite passes 146 tests; environment-gated suites are run separately. The full Python processor suite passes 225 tests. Two existing dependency deprecation warnings remain in the Python test client.
- Type checking, lint and the Next.js/service production build pass.

Cloud request shapes, structured output validation, malformed/refused responses, fixed destinations, redirect/proxy rejection and safe errors were tested with mocked OpenAI/Anthropic transports. No real cloud credentials or documents were sent. Live provider authentication, model availability, billing, retention policies and extraction accuracy remain unverified. Cloud activation requires an explicitly configured separate processor and administrator acknowledgment. See [engine operations](operations/engines.md).

Machine-readable HTTP/browser results, synthetic job outputs and screenshots are retained locally under the ignored `outputs/risk-engine-upgrade/` directory. Both temporary test users were retired after verification: three memberships revoked, sessions/password credentials/MFA records removed, and both old sessions returned HTTP 401. Synthetic portfolio and job evidence remains preserved. No real mailbox was connected or user portfolio changed. Container deployment, target-host egress enforcement, load testing and production backup operations remain deployment checks in [readiness](operations/readiness.md).
