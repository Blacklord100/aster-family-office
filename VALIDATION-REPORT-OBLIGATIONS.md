# Reporting calendar and exception inbox validation

Date: 9 September 2026. Scope: the two mandatory pilot features described in
[reporting operations](operations/report-obligations.md). These results apply to
the local implementation and synthetic data, not to live provider consent,
independently measured model accuracy or a qualified Linux appliance.

## Environment and evidence

Native macOS, Node 24.20.0, Next 16.3.4, local PostgreSQL on loopback 55439,
installed Playwright Chromium. The Browser plugin was unavailable, so the
frontend-testing skill's installed-Playwright fallback was used. The web UI ran
at `http://localhost:3000`, with desktop 1440×1000 and mobile 390×844 viewports.
Authentication used actual password login, TOTP enrollment and verification.

Four synthetic accounts covered office-A owner, analyst, family-scoped viewer
and an unrelated office-B owner. Seven encrypted originals exercised pending,
conflicting, accepted, rejected, failed and unknown-investment cases. Jobs were
seeded directly without model queue entries. No model requests, real mailbox
access, cloud requests or outbound email were required for this validation.

The reproducible local setup, HTTP/browser scripts, JSON reports and screenshots
are outside the repository at `../validation-obligations/`. Private cookie
states are excluded from delivery. The immutable prior extraction benchmark was
not changed or rerun for these features.

## Checks

| Layer | Result |
| --- | --- |
| Application tests | 438 passed, 42 gated tests skipped across 55 files (46 passed, 9 skipped). The new native queue suite was run separately below. |
| Static checks | Global lint and TypeScript passed. |
| Build | Optimized Next build and all service bundles passed. The new API route and report monitor bundle are present. |
| Queue unit tests | 9 passed. |
| Native PostgreSQL queue tests | 7 passed using fresh isolated organizations and the restricted runtime role. |
| Authenticated HTTP API | 39 assertions passed across the main scenario and explicit receipt reinstatement checks. |
| Actual compiled monitor | 6 assertions passed; worker-only snooze wake, unchanged-run idempotence, tenant isolation, heartbeat and clean shutdown. |
| Browser | 39 assertions passed. Zero console errors/warnings, external browser requests or horizontal overflow on the final desktop/mobile flows. |
| Post-restart smoke | 7 assertions passed for authenticated owner/scoped-viewer APIs, page navigation, error handling and isolation. |

Migrations `011-report-obligations.sql` and `012-report-source-index.sql` were
applied locally through the migration role. Runtime and migration roles were
distinct; runtime lacked superuser, BYPASSRLS, role-creation and database-creation
privileges. Native tests exercised forced tenant RLS, concurrent claims, raced
wakes, expired lease fencing, failure retries, shutdown release and function
privileges. The source query's normal PostgreSQL plan used the new composite
index for the tenant/document latest-job lookup. The guarded query also ran
against native PostgreSQL successfully.

The compiled monitor ran with a scope restricted to the synthetic office. An
API-created snooze expired through that worker while the browser was closed.
The encrypted workspace gained one revision and a `snooze_expired` history
entry. A subsequent unchanged evaluation kept that revision. The other office's
queue remained unchanged. SIGTERM completed in 17 ms with no stderr or retained
lease. This establishes native process behavior, not container qualification.

## Behavioral coverage

- Expected period → missed deadline → one assigned exception → original
  inspection → valid late receipt → delivery issue resolved on the same identity
  while financial review stays pending. Portfolio/ledger state did not change.
- Wrong periods, incomplete holding coverage, unavailable originals and foreign
  office references were rejected. Original preview was required before a match.
- Repeated matching, lost-response retries and concurrent stale revisions did
  not create duplicate schedules/receipts or overwrite another reviewer.
- Assignment, priority, snooze/wake, resolution, waiver and reopening retained
  evidence and actor/time history. A changed source-review disposition reopened
  an issue whose earlier resolution no longer applied.
- Corrected reports retained predecessors. Revocation and reinstatement preserved
  the same receipt and kept review separate from delivery.
- Future paused schedule versions preserved historical deadlines and receipts.
  Domain tests cover per-schedule local period boundaries across the date line,
  month/quarter/year/leap boundaries and daylight-saving anomalies.
- Family/entity scope projection checks complete schedule versions, occurrences,
  receipt coverage and historical citations. Unreleased originals, mixed-family
  coverage and unresolved office-wide records remain withheld.
- Source tests cover equivalent facts across models/modes, scientific notation,
  corrupt/unfinished processing, rejected receipt review, obsolete stale policies,
  unrelated disclosure types and stale NAV preservation.
- Bounded catch-up, histories, receipt counts and payload limits fail explicitly.
  The 64 MiB SQL payload guard rejects before any result decoding. Partial source
  scans do not resolve omitted issues.

## Findings fixed during validation

The browser found that changing a schedule's effective date left the old first
period start in the form. Both fields now follow the same natural boundary.
Review links now load the exact requested job, including older jobs outside the
usual recent list, and reject an unavailable selector instead of opening another
source. Source fingerprints exclude generated wording, traces and fact ordering.
Scientific-notation values no longer break conflict detection. Conservative
source status, nested receipt scope, retained historical citations, oversized
payloads, long names/reasons and supersession ancestry have regression coverage.

Two initial QA harness attempts looked for a missing-category record after a
late receipt. The intended behavior changes the same delivery issue to a resolved
late-receipt record. Assertions were corrected to follow the stable issue key;
those initial attempts are retained separately from passing reports.

## Evidence inventory and limits

Key local evidence: `api-qa.json`, `api-reinstate-qa.json`, `worker-qa.json`,
`source-index-plan.json`, `source-query-qa.json`, `ui-qa.json`,
`ui-final-capture.json` and `UI-QA.md`. Final screenshots are
`final-desktop-calendar.png`, `final-mobile-calendar.png`,
`final-desktop-exceptions.png` and `final-mobile-exceptions.png`. Desktop receipt
and mobile calendar/inbox captures were visually inspected by the root agent.

After the final build, authenticated owner and scoped-viewer APIs and both pages
passed a fresh restart smoke check. Guarded cleanup removed only the two owned
synthetic offices, four users and seven originals/jobs, including their related
test history. Four private browser session files were deleted. Independent
database/filesystem checks found no remaining owned records or private session
files; evidence and screenshots remain outside the repository. The local web,
processor, document worker, mailbox worker and new report monitor were restored.

Live consent/backfill, target-host Linux startup, resource/load limits,
network-denied installation, container health and independent restoration remain
release gates. The feature uses reviewed report matching and Aster import time;
it does not infer a verified reporting period or original inbox arrival from an
email header. No production-grade or identical-model-accuracy claim follows from
the synthetic results.
