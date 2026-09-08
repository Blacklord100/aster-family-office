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
- Queries cover at most the newest 40 accessible indexed documents and 100,000 decoded characters, retrieving at most 12 passages of 1,800 characters. Indexing allows up to 40 pages/120,000 characters per original. Coverage, truncation and decoder warnings are shown. Unindexed originals are excluded.
- The current API allows 20 questions and 30 index operations per user/workspace/hour. All requests share the processor's one-slot disposable subprocess sandbox and 590-second deadline. Busy processors return a visible error; there are no automatic retries. Ask cancellation propagates to the processor.

Scoped viewers cannot open the office-wide intelligence library, edit relationship records or index sources. Read-only Ask uses permitted holdings plus originals explicitly released by an administrator. Source grants are checked before decryption and after inference; session/membership scope is revalidated before returning an answer. Scoped cloud queries currently fail closed. The family selector narrows recorded calculations; document retrieval uses the user's explicit source grants, which may cover more than the selected family.

## Validation limits

Pure and mocked-provider tests cover issuer aliases, explicit/unknown weights, invalid graphs, source/date preservation, later-page retrieval, cents arithmetic, tenant/grant boundaries, quote and engine substitution, final permission changes, model failure and bounded tool loops. A real local TXT decode endpoint test confirms page preservation without invoking a model. Full rendered and live selected-model validation are recorded separately by the release validation process. This guide does not claim production deployment, cloud accuracy or comprehensive extraction coverage. Historical evaluation reports retain their original source/runtime scope.
