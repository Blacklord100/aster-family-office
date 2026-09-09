# Reporting calendar and unified exception inbox

Open **Reporting calendar** to define expected reports and **Exceptions** to work
the resulting gaps alongside extraction failures, pending financial review,
unresolved investment/constituent identity, conflicting valuations and stale
disclosures. These are persistent, tenant-scoped records; the local model and
agentic pipelines feed the same existing extraction/review contract.

## Set up an expectation

An owner or administrator selects registered holdings, a report type, an active
reviewer, cadence and first period. Supported cadences are monthly, quarterly,
annual and one-off. Deadlines are expressed as calendar days after period end,
an IANA timezone and local time, with an optional elapsed-hour grace period.
The server derives family scope from the holdings. Consolidated reports can
cover multiple holdings, but every holding needs explicit supported coverage.

Started periods are materialized automatically, including their future due
dates. A September monthly period can therefore appear as an October deadline.
Future, unstarted periods are created when their period begins. A future schedule
version starts at a natural period boundary and cannot rewrite an existing
occurrence. Pausing a schedule applies at that boundary; use a reasoned waiver
or cancellation for an already-created occurrence. The history retains the
original rule, owner, timezone, deadline and disposition.

Repeated local times use the earlier instant. Nonexistent local times advance
by the clock-change gap. Grace periods measure elapsed hours after the resolved
deadline. Calendar tests include leap years, month/quarter/year boundaries,
European and US daylight-saving changes, half-hour shifts and a skipped day.

## Record a report

Open the retained original, inspect its coverage, and choose **Match receipt**.
Confirm the exact report type, period and holdings and record the supporting
reason. An unknown or wrong period cannot silently satisfy an expectation.
Matching is reviewed attestation: model labels or email subjects alone do not
establish coverage. Originals must belong to the same office, and the server
requires an original-preview/download audit event for the reviewer.

**Arrival means import into Aster.** It is distinct from an email's Date header,
the disclosure-as-of date, processing time and review time. Historical backfills
therefore do not establish the original inbox arrival date. The calendar keeps
first/latest import times and lateness against the configured deadline.

A receipt clears only the delivery gap. Processing may still be blocked or
failed, and facts may still be pending, deferred or rejected. Financial acceptance,
valuation corrections and settlement continue through their existing review
controls. Matching a receipt never posts money, replaces a valuation or confirms
settlement. The latest processing attempt is shown conservatively; changing the
model or mode does not silently approve its result.

Identical document matches are idempotent. A corrected source can explicitly
supersede its predecessor while retaining both originals and their history.
Revoke an incorrect match with a reason; reinstate an accidental revocation
explicitly. Matching another period requires a separate reviewed occurrence.
Different document bytes are retained as distinct receipts even if their content
looks similar; a reviewer establishes any replacement relationship.

## Work exceptions

Filter by family, holding, category, priority, assignee and status. Open the
original or its existing review workbench, assign/reassign an active reviewer,
change priority, or snooze with a wake time and reason. Resolve or waive with
supporting evidence. The original issue, actor, time, evidence and disposition
remain in history. Snoozing or waiving never implies an accepted report.

Underlying issue identities are stable across evaluations and mode changes.
Repeated evaluation preserves explicit assignments, priority and valid snoozes.
Relevant changed economic evidence can reopen a resolved issue. The monitor
wakes expired snoozes and catches up missed periods after restart. A valid late
receipt retains lateness history on the same delivery issue. Missing delivery
and failed processing remain different categories.

Staleness follows an explicit age policy. NAV freshness uses the registered
holding's valuation date. Other disclosure freshness uses the explicit as-of
date of an accepted matching receipt of that report type. Recent unrelated
emails cannot refresh either date. Proposed valuation conflicts compare the
same holding, currency and effective date; they require existing correction
review, not automatic replacement.

## Access and operation

Owners/admins configure schedules. Analysts can match receipts and work
exceptions. Viewers are read-only. Family/entity-scoped viewers receive only
complete permitted records whose original sources, including those referenced
in history, have been explicitly released. Mixed-family consolidations and
unresolved office-wide sources are withheld. Source release does not broaden
their portfolio scope.

Writes lock the encrypted workspace and require its current revision. Conflicting
reviewer edits return a conflict rather than silently retrying. An idempotency
ledger makes lost-response retries safe. Schedule/receipt/exception details stay
inside the existing authenticated workspace ciphertext; mutation digests and
minimal identifiers enter the signed audit chain. Referenced originals remain
protected by the existing retention check. Demo reset cannot erase reporting
history.

Run the [report monitor](report-obligations-monitor.md) for unattended updates.
It needs PostgreSQL and encryption keys, with no model, cloud, SMTP or mailbox
dependency. Page reads also evaluate current conditions. A delayed or failing
tenant monitor is surfaced in the UI; an open page alone does not prove that
unattended monitoring is running. No outbound reminder is sent.

## Explicit limits

- Each scan covers 2,000 recent source documents plus every retained receipt and
  current exception source, with a maximum of 5,000 retained sources. Incomplete
  scan coverage is visible and cannot clear omitted issues. Unlinked older
  sources beyond the scan are not claimed as covered. A database-side 64 MiB
  aggregate result/review payload guard rejects oversized batches before they
  are transferred or decoded; partitioning is required before monitoring resumes.
- The encrypted reporting state and request ledger are bounded to 16 MiB, with
  at most 2,000 schedules, 50,000 occurrences/exceptions and 25,000 mutation
  receipts. Each occurrence retains at most 100 receipt/revision records.
  Catch-up is all-or-nothing, limited to 5,000 new occurrences per
  evaluation and a 30-year date span. Exceeding a limit fails explicitly; history
  is not silently pruned. A larger deployment needs partitioned storage.
- Source-specific pending issues come from the existing extraction/review
  contract. Statement-row matching and unmatched-transaction exceptions remain
  a separate planned increment. This release does not create a custodian feed.
- Original provider arrival timestamps, automatic verified period matching,
  holiday/business-day calendars, outbound reminders and escalation policies
  are not implemented by these two features.
- Native tests do not qualify a Linux appliance, live provider consent,
  production load or a disconnected installation. Those delivery gates remain
  in the [readiness record](readiness.md).

See [validation](../VALIDATION-REPORT-OBLIGATIONS.md) for the synthetic integration
and browser evidence, and the existing [ledger/reporting controls](ledger-reporting.md)
for financial review, reconciliation and saved snapshots.
