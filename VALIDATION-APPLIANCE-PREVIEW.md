# Appliance preview validation

This record distinguishes source/tooling checks from a qualified customer
installation. The appliance remains a preview. No production publisher keys,
complete customer release media or automatic failover service were published by
these checks. Existing native development services and their data were not replaced.

## Application and durable operations

Candidate `931e88cccbfeb1e924c167e24041c10a91c78485` passed the complete
application job in [Linux run 34709926916](https://github.com/Blacklord100/aster-family-office/actions/runs/34709926916):

- 815 ordinary application tests; 109 explicitly gated integration cases were
  deferred to their separate invocation.
- All 111 database integration cases across 16 files, using a disposable CI
  PostgreSQL service rather than the development or customer database.
- 673 host processor tests and 14 subtests, lint, type checking, production build,
  migration, dependency audit and SBOM generation.

Its SBOM artifact upload also passed. The earlier candidate `921d4e0` passed
functional steps but failed at artifact upload because the private account's
Actions storage quota was reached. Source publication resolved that storage
restriction for the later public run; no historic evidence was deleted.

The [appliance contracts at `931e88c`](https://github.com/Blacklord100/aster-family-office/actions/runs/34709927001)
passed real Docker Compose resolution, 42 Python packaging tests, five profile
tests, controller race tests, a static Linux build and Go vulnerability checks.
The actual controller initialized test trust, signed a synthetic candidate,
verified externally pinned TUF metadata, packed the media, unpacked it through
the safe Go reader and verified all 110 payload files again. Synthetic packaging
does not substitute for installing the complete appliance on a target server.

## Recovery and release checks

Local controller regressions cover current TUF expiry and rollback protection,
root threshold/rotation, manifest and payload tampering, bounded encrypted recovery,
independently pinned ciphertext, lifecycle generation fencing, PostgreSQL major
version refusal and interrupted installation/update/restore reconciliation.
Forward restore continuation never repeats a database import. An ambiguous import
requires stopping that destination and recovering into a new one.

The cross-built Linux controller with SHA256
`829ea07362f085ef9a5bbca6609d33bdbd81472eba427b590b10ceb8b8401509`
passed exact-binary `govulncheck` 1.8.0 with zero reachable vulnerable symbols.
Its SPDX/license inventory identified 14 embedded dependencies and retained their
notices. This is evidence for those bytes; a later executable needs a new receipt.
Raw scanner output and module-only findings remain part of the evidence. This
17,354,559-byte executable was built on Linux from `931e88c`; its evidence is
retained in that run's `appliance-controller-evidence` artifact.

Source-notice and tamper checks are included in the 42 packaging regressions.
The sharp native source policy includes the original build recipe, 29 native
source archives and 350
checksum-pinned Cargo archives. Its large connected Linux collection has not yet
been performed here. OS/runtime-service corresponding-source material and final
binary-distribution review remain separate obligations. Staged test candidates
include an explicit `distributionReady: false` receipt.

## Model, native security and host qualification

The first [bounded Linux model run](https://github.com/Blacklord100/aster-family-office/actions/runs/34704855444)
stopped at its disk-capacity preflight before inference. It produced no Linux
accuracy or latency measurement. The existing native macOS synthetic demonstration
is separate evidence, documented in [live demo validation](VALIDATION-LIVE-DEMO.md).

The [bounded run at `0ac2b19`](https://github.com/Blacklord100/aster-family-office/actions/runs/34709097583)
passed exact-model identity, text and vision execution on Linux amd64 with
Ollama 0.33.3. Text returned `SYNTHETIC` in 7.475 seconds; vision identified the
known red square in 11.906 seconds. The runner had four CPU cores and about
15.6 GiB visible memory; the model had a 12 GiB cap, with no OOM kill. The service
remained nonroot, read-only and on its sole internal bridge, with no published
ports. The client bypassed proxies, refused redirects and rechecked the admitted
container/image/network identity around every request.

Both requests asked for 512 context tokens. The retained vision runner log shows
an effective context of 2,048, so these timings do not qualify a 512-token runtime
memory profile. They establish bounded startup/inference only, not financial
extraction accuracy, throughput, full-context capacity or full-host egress isolation.
The exact image was
`sha256:f77c3010bf4c1f834ab9e209e357be2545fe741edf6f995d7fd63febefa7a433`;
the model digest was
`sha256:ee665637121887cf3befff38abbb1be4ee117c7db867d97a67e29049ecd7e15f`.

The preceding [run at `b214384`](https://github.com/Blacklord100/aster-family-office/actions/runs/34708057717)
downloaded the exact six-file Gemma pack and started Ollama 0.33.3 successfully
as UID 10001 on a read-only filesystem. Its retained logs show one model, CPU
execution and a 12 GiB memory limit, with no OOM. The test client could not reach
the host-published port on the internal bridge, so it never performed inference.
The successful later run uses the inspected internal container IP directly,
as supported on a Linux Docker host, with no published port, proxy or redirects.

The complete [Linux verification at `25118b8`](https://github.com/Blacklord100/aster-family-office/actions/runs/34710535770)
passed both application and container jobs. The processor passed all 33 native
security cases, 625 tests inside the network-disabled image, authenticated offline
OCR and PNG/JPEG/TIFF roundtrips. Its exact image was
`sha256:768bb1f0c558c80b0155e909e4c59c6c8bebb042fc397c6b71021baecc0e2b55`.

The raw image scan retains nine HIGH findings. The independent, exact-image
assessment accounts for all nine through reviewed source fixes or the absence of
the affected program: eight fixed, one not affected, zero unassessed. This is not
a zero-finding raw scan or a waiver for another image. Unknown findings, changed
package identities and missing build/runtime proof still fail. The full evidence
and historical failures are in [processor security evidence](operations/processor-release-blockers.md).

That run also passed custom processor source export and attestation. Its downloaded
artifact was independently reverified offline: 46 retained material files,
53,051,770 bytes, three original archives, two build dependencies and seven reviewed
backports, including the hidden Docker build configuration. The exact-image receipt
covers 113 installed files (110 Pillow files and three native binaries/libraries).
The retained runtime manifest and native hashes match the security artifact.
This closes the executed source-export gate for these three custom builds only;
OS packages, other wheels and service-image material remain separate gates.

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

The repeatable full-history scan at `25118b8` covered 42 reachable commits, with
ten exact previously reviewed false positives and no unresolved credential finding.
The initial data/asset review covered all 128 historical synthetic PDF fixtures and
retained third-party asset notices. See [public source review](PUBLIC_RELEASE_REVIEW.md).
The source was made public under Apache-2.0 at `80a24d6`. Private vulnerability
reporting, Dependabot security updates, secret scanning, push protection and branch
checks are enabled; the branch protection retains an administrator exemption.
Repeat the source review for subsequent releases. Source publication does not
waive appliance qualification or binary-distribution obligations.
