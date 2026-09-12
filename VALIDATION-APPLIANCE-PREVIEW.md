# Appliance preview validation

This record distinguishes source/tooling checks from a qualified customer
installation. The appliance remains a preview. No production publisher keys,
complete customer release media or automatic failover service were published by
these checks. Existing native development services and their data were not replaced.

## Application and durable operations

The later candidate `59aab5bb948cca0825d23a717c320ab93e037d1b` passed both
[application/container verification](https://github.com/Blacklord100/aster-family-office/actions/runs/34714077978)
and [appliance packaging contracts](https://github.com/Blacklord100/aster-family-office/actions/runs/34714078024).
Its separate actual ingress test failed before relay execution with systemd
`217/USER`; the [retained ingress record](operations/appliance/UNIX-INGRESS-QUALIFICATION.md)
describes that defect and the account-provisioning follow-up. Passing the general
checks did not establish working host ingress.

Candidate `a6b4a3f2a4f21a9ce66449c7e96901b02d39a808` passed both complete jobs
in [Linux run 34712254758](https://github.com/Blacklord100/aster-family-office/actions/runs/34712254758).
Its application job passed:

- 844 ordinary application tests; 109 explicitly gated integration cases were
  deferred to their separate invocation.
- All 111 database integration cases across 16 files, using a disposable CI
  PostgreSQL service rather than the development or customer database.
- 676 host processor tests and 16 subtests, lint, type checking, production build,
  migration, dependency audit and SBOM generation.

Its SBOM artifact upload also passed. The earlier candidate `921d4e0` passed
functional steps but failed at artifact upload because the private account's
Actions storage quota was reached. Source publication resolved that storage
restriction for the later public run; no historic evidence was deleted.

The [appliance contracts at `a6b4a3f`](https://github.com/Blacklord100/aster-family-office/actions/runs/34712254773)
passed real Docker Compose resolution, 68 Python packaging/probe tests, six profile
tests, controller race tests, a static Linux build and Go vulnerability checks.
The actual controller initialized test trust, signed a synthetic candidate,
verified externally pinned TUF metadata, packed the media, unpacked it through
the safe Go reader and verified all 110 payload files again. Synthetic packaging
does not substitute for installing the complete appliance on a target server.
The bounded-model and full-assembly jobs were explicitly skipped in this contracts
run; its successful result does not report either qualification as executed.

The candidate includes persisted initial selection of connected mailbox/delivery
services and an authenticated internal mailbox OAuth broker. Twenty-four broker
and transport tests cover fixed provider destinations, origin/client-ID binding, token and
body checks, scope restrictions, concurrency, lifecycle/shutdown/disconnect
cancellation and fail-closed transport. Four store-admission tests prove disabled
or invalid transport creates no OAuth state. All nine existing mailbox integration
cases also passed against a newly created disposable PostgreSQL cluster with the
final broker source. Web retains its session-bound one-use state and encrypted
credential persistence; the broker has no separate replay cache. These tests do not
establish customer-provider OAuth authorization or actual connected appliance routing.

## Recovery and release checks

Local controller regressions cover current TUF expiry and rollback protection,
root threshold/rotation, manifest and payload tampering, bounded encrypted recovery,
independently pinned ciphertext, lifecycle generation fencing, PostgreSQL major
version refusal and interrupted installation/update/restore reconciliation.
Forward restore continuation never repeats a database import. An ambiguous import
requires stopping that destination and recovering into a new one.

The cross-built Linux controller with SHA256
`118de736a0d95c93de06052cf1dca53efec4d175bbb1a7972b6719fda2e5f145`
passed exact-binary `govulncheck` 1.8.0 with zero reachable vulnerable symbols.
Its SPDX/license inventory identified 14 embedded dependencies and retained their
notices. This is evidence for those bytes; a later executable needs a new receipt.
Raw scanner output and module-only findings remain part of the evidence. This
17,379,231-byte executable was built on Linux from `a6b4a3f`; its evidence is
retained in that run's `appliance-controller-evidence` artifact.
The downloaded 160,432-byte artifact matched GitHub's archive SHA256
`6e4837a495a06ea7f946284aa8b9ff2ebbe4ea0907d25892c21618fb115fb9e9`.
Independent local verification rehashed all 54 receipt-bound files and 47 retained
license texts, checked the notice/SPDX receipt links and reparsed the raw binary
scan with zero reachable findings. The artifact contains evidence, not the
executable itself; the exact-binary binding comes from the recorded CI collection.

Source-notice and tamper checks are included in the packaging regressions.
The sharp native source policy includes the original build recipe, 29 native
source archives and 350 checksum-pinned Cargo archives. The
[Linux collection at `66b26d2`](https://github.com/Blacklord100/aster-family-office/actions/runs/34713572531)
retained all 379 archives and stopped with 12 original-notice gaps. A subsequent
source-only reread with reviewed provenance resolved eight, checking 738 original
notice records, all 2,816 older-source file mappings and 16 unchanged MPL source
headers. Four original-text gaps remain in `block` 0.1.6, `malloc_buf` 0.0.6,
`objc-foundation` 0.1.1 and `objc_id` 0.1.1. Their SPDX declarations are retained;
missing originals are not replaced with generic templates. The
[native source record](licenses/native/sharp-libvips-1.3.3/README.md) lists exact
identities and scope. The full graph still fails, and independent kernel-isolated
verification has not passed. OS/runtime-service corresponding-source material and final
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

The complete [Linux verification at `a6b4a3f`](https://github.com/Blacklord100/aster-family-office/actions/runs/34712254758)
passed both application and container jobs. The processor passed all 33 native
security cases, 625 tests inside the network-disabled image, authenticated offline
OCR and PNG/JPEG/TIFF roundtrips. Its exact image was
`sha256:ec4a22d21cb5981e36a284e13d72dc0333e6ed9ec10f406451f797bf59649cc7`.
The app image
`sha256:96426ac3dd6b92c59c8fb6a9b4d147ade30197b9d4fdbf45cf47d3184a91480f`
passed runtime identity, filesystem, import/startup and fail-closed HTTP probes
without an external network, database or model. Both image builds and the
deployment composition checks passed.

The raw image scan retains nine HIGH findings. The independent, exact-image
assessment accounts for all nine through reviewed source fixes or the absence of
the affected program: eight fixed, one not affected, zero unassessed. This is not
a zero-finding raw scan or a waiver for another image. Unknown findings, changed
package identities and missing build/runtime proof still fail. The full evidence
and historical failures are in [processor security evidence](operations/processor-release-blockers.md).

That run also passed custom processor source export and attestation, retaining
46 material files and 53,051,770 bytes tied to its exact image. The earlier
[run at `25118b8`](https://github.com/Blacklord100/aster-family-office/actions/runs/34710535770)
had its downloaded artifact independently reverified offline: 46 retained material files,
53,051,770 bytes, three original archives, two build dependencies and seven reviewed
backports, including the hidden Docker build configuration. The exact-image receipt
covers 113 installed files (110 Pillow files and three native binaries/libraries).
The retained runtime manifest and native hashes match the security artifact.
This closes the executed source-export gate for these three custom builds only;
OS packages, other wheels and service-image material remain separate gates.

The corrected [Caddy probe at `0609b61`](https://github.com/Blacklord100/aster-family-office/actions/runs/34712792503)
confirmed nonroot startup, TLS 1.3, the exact synthetic response and CA/hostname
verification on the private bridge. Both loopback/random bindings and the actual
`0.0.0.0:80/443` configuration lacked effective Docker publications. Wrong SNI was
actively rejected during TLS, which the initial probe classified too narrowly;
the untrusted-root negative control passed. These are genuine failed ingress
results, not deployment qualification. The repair uses protected Caddy Unix
listeners and a systemd socket-activated relay with its own private network and
filesystem. Its hosted proof is separate and remains pending until executed.
See [Caddy ingress qualification](operations/appliance/CADDY-INGRESS-QUALIFICATION.md).

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
