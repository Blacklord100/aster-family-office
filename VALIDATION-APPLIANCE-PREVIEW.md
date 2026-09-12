# Appliance preview validation

This record distinguishes source/tooling checks from a qualified customer
installation. The appliance remains a preview. No production publisher keys,
complete customer release media or automatic failover service were published by
these checks. Existing native development services and their data were not replaced.

## Application and durable operations

Candidate `921d4e0e46bb3ed3a73988e3e4a59e2348446be6` passed the functional
application steps in [Linux run 34705492977](https://github.com/Blacklord100/aster-family-office/actions/runs/34705492977):

- 815 ordinary application tests; 109 explicitly gated integration cases were
  deferred to their separate invocation.
- All 111 database integration cases across 16 files, using a disposable CI
  PostgreSQL service rather than the development or customer database.
- 655 host processor tests, lint, type checking, production build, migration,
  dependency audit and SBOM generation.

That application job **failed at artifact upload** because the account's GitHub
Actions storage quota was reached. Passing functional steps do not make the
overall job successful. No historic evidence was deleted to conceal or work
around this failure.

The [same candidate's appliance contracts](https://github.com/Blacklord100/aster-family-office/actions/runs/34705492999)
passed real Docker Compose resolution, packaging contracts, controller race tests,
static Linux cross-build and Go vulnerability checks. Later packaging refinements
require their own validation; these receipts are bound to their recorded source.

## Recovery and release checks

Local controller regressions cover current TUF expiry and rollback protection,
root threshold/rotation, manifest and payload tampering, bounded encrypted recovery,
independently pinned ciphertext, lifecycle generation fencing, PostgreSQL major
version refusal and interrupted installation/update/restore reconciliation.
Forward restore continuation never repeats a database import. An ambiguous import
requires stopping that destination and recovering into a new one.

The cross-built Linux controller with SHA256
`18663c73e45f85a8bb6959467400c7c0dcc5d2966172a4a3c81f8c9f8c246295`
passed exact-binary `govulncheck` 1.8.0 with zero reachable vulnerable symbols.
Its SPDX/license inventory identified 14 embedded dependencies and retained their
notices. This is evidence for those bytes; a later executable needs a new receipt.
Raw scanner output and module-only findings remain part of the evidence.

The source-notice collectors passed 29 local regressions. The sharp native source
policy includes the original build recipe, 29 native source archives and 350
checksum-pinned Cargo archives. Its large connected Linux collection has not yet
been performed here. OS/runtime-service corresponding-source material and final
binary-distribution review remain separate obligations. Staged test candidates
include an explicit `distributionReady: false` receipt.

## Model, native security and host qualification

The first [bounded Linux model run](https://github.com/Blacklord100/aster-family-office/actions/runs/34704855444)
stopped at its disk-capacity preflight before inference. It produced no Linux
accuracy or latency measurement. The existing native macOS synthetic demonstration
is separate evidence, documented in [live demo validation](VALIDATION-LIVE-DEMO.md).

The native OCR libraries compiled in the second Linux candidate, but its regression
harness used incompatible C++17/configuration settings. The corrected harness uses
upstream C++20 and generated build configuration. A new compiled-image regression,
offline OCR run, raw scan and exact-image assessment are still required; see
[processor security evidence](operations/processor-release-blockers.md).

The complete qualification runner is a disposable Ubuntu 24.04 amd64 host with
32 GiB RAM and 250 GiB free temporary space for media, retained releases and sealed
recovery copies. No suitable owned runner has been supplied. The development Mac
has 16 GiB RAM and limited free disk; no large VM or duplicate model was created.

The implemented full drill exercises real HTTPS/MFA, both local processing modes,
nonzero reviewed NAV/capital-call facts, duplicate posting, original archive hashes,
cold restart, sealed backup/restore and observed process interruptions during an
update. It has not run on that required host. A same-host drill also cannot establish
independent-host RPO/RTO, automatic failover, full workload capacity or complete
host-level egress isolation. The Packer VM recipe has syntax validation only.

## Source publication

The repeatable full-history scan at `921d4e0` covered 36 reachable commits, with
ten exact previously reviewed false positives and no unresolved credential finding.
The initial data/asset review covered all 128 historical synthetic PDF fixtures and
retained third-party asset notices. See [public source review](PUBLIC_RELEASE_REVIEW.md).
Repeat the source and external GitHub-surface review at publication; a source
release does not waive appliance qualification or binary-distribution obligations.
