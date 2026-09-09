# Sourced intelligence and Ask Aster

Intelligence adds an encrypted decoded-source index, reviewed constituent proposals, explicit issuer aliases, relationship/mandate/deal records and saved follow-up drafts. Drafts are stored in the workspace; there is no send action or provider messaging call.

## Source library and review

Upload originals through Processing, then select **Index** in Intelligence. `/api/intelligence/index` sends the original only to the fixed local processor `/v1/knowledge/decode`. Existing PDF/email/HTML/OCR limits and page/attachment provenance apply. No model is needed for indexing, no remote HTML resources are fetched, and warnings remain visible. The index contains authenticated AES-256-GCM ciphertext in `app_intelligence_documents.payload`, using AAD `intelligence-index:<organizationId>:<documentId>`. Keep it in backup, restore and key-rotation inventories alongside originals and workspace data.

Migration `010-intelligence.sql` depends on the application tables and the `(id, organization_id)` document uniqueness introduced in migration 008. The migrator must grant the runtime role the same tenant-scoped access as other `app_` tables. No migration or service restart is performed automatically by the UI.

Constituent proposals currently recognize explicit portfolio-company / underlying-investment sections and delimited company + percentage or undisclosed-weight rows. They are a conservative parser, not a general financial-document accuracy claim. Unsupported prose/layouts can yield no proposals. Each proposal retains the original checksum, exact quote, page, source/attachment label and any supported quoted date. An administrator chooses the canonical issuer and accepts the mapping into the validated risk graph. Unknown weights are omitted from graph weights and remain unresolved. Existing mappings are not silently replaced, totals above 100% are rejected, and holdings/NAV are not changed. Acceptance creates a matching evidence record for the Risk source inspector.

Names are normalized for case/punctuation only. Legal suffixes and share classes remain distinct. Different names merge only through an administrator-reviewed alias; explicit issuer identities already in the risk graph can be reused. Relationship and prospective-deal records are manual workspace records, not inferred facts. Deal overlap covers disclosed mapped issuers only and cannot establish absence of hidden overlap.

## Read-only Ask Aster

`POST /api/intelligence/ask` accepts `{question, familyId, mode?}`. The server resolves the active engine/profile revision for that request and sends only a bounded set of accessible source passages and deterministic recorded-value totals to `/v1/knowledge`.

- Workflow makes one structured model selection over retrieved passages.
- Agentic mode makes at most four structured calls. Its only tools search/read the supplied passage set and return an answer. There is no arbitrary network, code, SQL, messaging or financial action tool.
- Responses render exact source excerpts and selected deterministic calculations. Both processor and web server reject unsupported or foreign quotations. They do not rely on model-generated arithmetic or free-form financial claims.
- Local/cloud execution is independent of mode. The existing active-profile/deployment cloud gates apply; no fallback engine is used. Cloud credentials stay server-side and are passed only to the separate configured cloud processor. Live cloud performance, retention and extraction accuracy require separate account-specific validation.
- Queries scan at most the newest 500 accessible indexed documents, 32 MiB of encrypted index payloads and 8,000,000 decoded characters. All scanned pages participate in relevance ranking; only the best 12 passages, at most 1,800 characters each, enter the answer engine. This includes every source in the 100-file demo when fully indexed, including older reports. Indexing allows up to 40 pages/120,000 characters per original. Coverage reports actual scanned bytes/characters and marks truncation only when sources or content are omitted. Unindexed originals are excluded.
- The current API allows 20 questions and 30 index operations per user/workspace/hour. Only the server-only demo actor in a marked sandbox, with a source-verification audit and exact immutable-corpus checksum, receives 120 index operations/hour. All requests share the processor's one-slot disposable subprocess sandbox and 590-second deadline. Interactive busy requests return a visible error. Demo indexing retries are bounded separately; Ask cancellation propagates to the processor.

Scoped viewers cannot open the office-wide intelligence library, edit relationship records or index sources. Read-only Ask uses permitted holdings plus originals explicitly released by an administrator. Source grants are checked before decryption and after inference; session/membership scope is revalidated before returning an answer. Scoped cloud queries currently fail closed. The family selector narrows recorded calculations; document retrieval uses the user's explicit source grants, which may cover more than the selected family.

## Verified synthetic demonstrations

Completed, verified demo originals are decoded and indexed automatically after extraction, with a bounded idle catch-up for process restarts. Source payload hashes must match the immutable synthetic corpus; the model's answer alone cannot authorize indexing or relationship publication. The system actor has no login session and cannot be selected in a browser request.

Constituent attribution requires a unique exact parent investment named on the same decoded page and the source's routed family. Explicit, dated, warning-free synthetic disclosure rows may populate the demo risk graph and source library automatically. Unknown weights remain unknown; an unresolved 72% is never assigned to another named company. Conflicting weights, ambiguous identities, OCR or decode warnings remain proposals for review. Evidence records retain the exact document/page/quote, open the retained original and carry the demo-source marker. Ordinary office sources retain their existing review rules.

## Validation limits

Pure and mocked-provider tests cover issuer aliases, explicit/unknown weights, invalid graphs, source/date preservation, later-page retrieval, cents arithmetic, tenant/grant boundaries, quote and engine substitution, final permission changes, model failure and bounded tool loops. A real local TXT decode endpoint test confirms page preservation without invoking a model. Full rendered and live selected-model validation are recorded separately by the release validation process. This guide does not claim production deployment, cloud accuracy or comprehensive extraction coverage. Historical evaluation reports retain their original source/runtime scope.
