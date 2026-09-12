# Processor release blockers

## Current processor image qualified — 12 September 2026

Commit `25118b8f74c056a973661542aea67554a7f85a4f` passed both jobs in
[Verify release run 34710535770](https://github.com/Blacklord100/aster-family-office/actions/runs/34710535770).
The qualified processor image is
`sha256:768bb1f0c558c80b0155e909e4c59c6c8bebb042fc397c6b71021baecc0e2b55`.
Its actual Linux build passed **33 native security cases**: 12 network
deserialization, 3 normproto, 3 TIFF, 5 GenericVector, 4 unicharset and 6 intproto
cases, including valid controls. The completed image passed nonroot/read-only
identity checks, authenticated OCR without network or a model, PNG/JPEG/TIFF
round trips, and **625 processor tests in the built runtime**. The web-image and
repository secret scans also passed.

The retained Trivy scan, created `2026-09-12T18:20:50.821589506Z`, still reports
**nine HIGH findings**, all without a scanner `FixedVersion`. It is not a
zero-finding scan. The independent exact-image assessment passed with **zero
unassessed HIGH/CRITICAL findings** and records the following dispositions:

| CVE | Retained package | Exact-image disposition and evidence |
| --- | --- | --- |
| [CVE-2026-36849](https://security-tracker.debian.org/tracker/CVE-2026-36849) | `libtiff6 4.7.2-1+aster1` | Fixed: signed libtiff 4.7.2, verified decoder linkage and malformed-strip regression. |
| [CVE-2026-52490](https://security-tracker.debian.org/tracker/CVE-2026-52490) | `libtiff6 4.7.2-1+aster1` | Not affected: affected `tiffcrop` executable absent from both inventory and actual runtime; signed 4.7.2 also contains the upstream fix. |
| [CVE-2026-73066](https://security-tracker.debian.org/tracker/CVE-2026-73066) | `tesseract-ocr 5.5.3-1+aster3` | Fixed: signed Tesseract 5.5.3 and malformed Convolve/Reconfig deserialization controls. |
| [CVE-2026-88047](https://security-tracker.debian.org/tracker/CVE-2026-88047) | `tesseract-ocr 5.5.3-1+aster3` | Fixed: pinned upstream `1bda507` backport and bounded normproto cases. |
| [CVE-2026-88048](https://security-tracker.debian.org/tracker/CVE-2026-88048) | `tesseract-ocr 5.5.3-1+aster3` | Fixed: pinned upstream `103dc134` backport and mismatched/valid FullyConnected cases. |
| [CVE-2026-88049](https://security-tracker.debian.org/tracker/CVE-2026-88049) | `tesseract-ocr 5.5.3-1+aster3` | Fixed: pinned upstream `b494ac18` backport and malformed/valid LSTM cases. |
| [CVE-2026-88051](https://security-tracker.debian.org/tracker/CVE-2026-88051) | `tesseract-ocr 5.5.3-1+aster3` | Fixed: pinned upstream `56e09ca` backport and GenericVector bounds cases with a valid control. |
| [CVE-2026-88052](https://security-tracker.debian.org/tracker/CVE-2026-88052) | `tesseract-ocr 5.5.3-1+aster3` | Fixed: pinned upstream `2d04d64` backport and duplicate/non-positive unicharset cases with a valid control. |
| [CVE-2026-88053](https://security-tracker.debian.org/tracker/CVE-2026-88053) | `tesseract-ocr 5.5.3-1+aster3` | Fixed: pinned upstream `8b05746` backport plus the required `b27e1bd` initialization hunk; five malformed intproto count cases and a complete valid version-3 control. |

Inventory coverage passed: all 27 retained native package identities appear among
34 scanned OS packages, and all 32 locked Linux Python packages are represented.
The assessment binds the raw scan, source/backport/configuration/harness evidence
and inspected runtime files to the exact image above. An independent local replay
of the retained artifact produced the same assessment. Unknown advisories,
changed severity or package identity, stale scans and missing/mismatched evidence
still fail the gate. Canonical Debian source identities and all raw findings are
preserved; no scanner exclusions or ignored statuses were added.

The seven retained upstream patch records are unsigned official HTTPS downloads,
SHA256-pinned with exact preimage/postimage checks and zero fuzz; they are not
claimed to be signed releases. The Tesseract base tag and libtiff base archive
retain separate signature verification. This run also passed detached original
source collection and its exact-image runtime attestation, retaining the reviewed
Tesseract/libtiff/Pillow originals, build recipe, backports and receipts. That
source closure has a declared component scope; the complete appliance's other
native libraries and OS components have separate distribution gates.

The run retains `processor-image-security` and `processor-custom-sources`
artifacts. The security artifact ZIP has SHA256
`7c95ecc04416ad7e4e699be5f729f25a336146f0386091499cdbf4562c987df6`,
verified against GitHub's artifact digest. The raw scan's canonical digest is
`2b45767716889bedc1c96fd279932ea314faaecabafde827842606dd14118cdf`.
This qualifies this processor image; it does not qualify a subsequent image or
complete the appliance's remaining packaging and full-host recovery checks.

## Historical six-finding baseline and initial candidate — 12 September 2026

The pre-backport baseline was commit `0e0bed07a2867118e75aa00bda110b9bc6a36bdd`,
[CI run 34580076948](https://github.com/Blacklord100/aster-family-office/actions/runs/34580076948).
It passed 801 application tests, 90 database integrations (including 16 archive
cases), 637 host Python tests and 625 built-runtime processor tests. Application
build, migrations, npm audit, web-image scan, repository checkout secret scan and
network-disabled authenticated OCR passed. The processor security gate failed with
**six HIGH findings**, all with no scanner `FixedVersion`: two libtiff and four
Tesseract advisories. Inventory coverage passed: 27/27 retained native identities
within 34 OS packages and 32/32 locked Linux Python packages. This and all dated
candidate sections below retain historical evidence; their counts and blocked
statuses do not describe the qualified image above.

| CVE | Baseline component | Current source evidence and candidate action |
| --- | --- | --- |
| [CVE-2026-36849](https://security-tracker.debian.org/tracker/CVE-2026-36849) | libtiff6 4.7.2-1+aster1 | Signed 4.7.2 already includes the upstream compression-ratio guard. Candidate adds a malformed high-SamplesPerPixel strip regression against the actual shared library. |
| [CVE-2026-52490](https://security-tracker.debian.org/tracker/CVE-2026-52490) | libtiff6 4.7.2-1+aster1 | Signed 4.7.2 includes the fix; the affected tiffcrop program is excluded. Candidate requires inventory and actual runtime absence checks. |
| [CVE-2026-73066](https://security-tracker.debian.org/tracker/CVE-2026-73066) | tesseract-ocr 5.5.3-1+aster1 | Signed 5.5.3 already includes the fix. Candidate exercises malformed Convolve/Reconfig dimensions and valid controls. |
| [CVE-2026-88047](https://security-tracker.debian.org/tracker/CVE-2026-88047) | tesseract-ocr 5.5.3-1+aster1 | Backport upstream [1bda507](https://github.com/tesseract-ocr/tesseract/commit/1bda5079b1c8a7e25f523486837426903d29ce84), with overlong, boundary-length and valid normproto inputs. |
| [CVE-2026-88048](https://security-tracker.debian.org/tracker/CVE-2026-88048) | tesseract-ocr 5.5.3-1+aster1 | Backport upstream [103dc134](https://github.com/tesseract-ocr/tesseract/commit/103dc134eb36411ddc6833ec20aa2c76795bd0ff), with mismatched and valid fully-connected matrices. |
| [CVE-2026-88049](https://security-tracker.debian.org/tracker/CVE-2026-88049) | tesseract-ocr 5.5.3-1+aster1 | Backport upstream [b494ac18](https://github.com/tesseract-ocr/tesseract/commit/b494ac18925f9d9aff9ef5815475de9943ab19bf), with malformed LSTM dimensions and a valid control. |

All six primary Debian records were rechecked on 12 September. The three new
upstream commits are unsigned: their official HTTPS patch bytes are SHA256-pinned,
with exact source preimages and postimages checked and zero patch fuzz. They are
not described as signed upstream releases. The base Tesseract tag and TIFF archive
retain their existing signature verification. Original upstream patch files and
license headers remain under `processor/runtime/source-provenance/`.

The candidate introduces a narrowly scoped exact-image assessment in
[security-policy.json](../processor/runtime/security-policy.json),
[security-assessment.py](../processor/runtime/security-assessment.py), and
[verify-scan.py](../processor/runtime/verify-scan.py). Raw scanner findings are
retained unchanged. Passing requires the scanner's image ID to match the inspected
candidate, a scan no older than 48 hours, complete native/Python inventory, reviewed
source/configuration/harness hashes, all native regression checks, actual runtime
library hashes, and tiffcrop absence. A new CVE, changed severity/version, missing
proof or mismatched image fails closed. Successful assessments record each raw
finding and its exact-image disposition; they do not report a zero-finding scan.

These are candidate build requirements. Local Python verifier tests and exact
backport application do not qualify the compiled Linux artifact. A new CI image
build, native harness, offline OCR, complete processor suite, raw scan and independent
assessment must pass before this candidate receives a cleared release receipt.


## Candidate `edca127` verified 10 September 2026 UTC

[Release run 34529320613](https://github.com/Blacklord100/aster-family-office/actions/runs/34529320613), commit `edca127bf7d44cdd17e0cd966e9ee3d69b7f248d`, passed the complete application job: 769 ordinary tests, all 74 database lifecycle/isolation assertions, 618 host Python tests including runtime checks, lint, typecheck, production build, migrations, zero npm audit vulnerabilities and SBOM generation. Both container builds, nonroot/read-only probes, network-disabled startup/authenticated OCR, 606 built-processor tests, web-image scan and repository secret scan passed.

Its retained processor scan (`2026-09-10T21:04:49.568747112Z`, image `sha256:9a305e91bf2551583c7653724afeffcc922f7ccb8555ba29c6571f7f6bf97d7c`) still reports exactly the same three HIGH findings below, without a `FixedVersion`. Inventory coverage is complete: 27/27 retained native identities and 32/32 locked Linux Python packages. The processor gate remains blocked solely by those findings. This evidence qualifies that commit; subsequent UI refinements have their own build/browser checks and release runs.

## Earlier candidate `c9beb14`

The earlier [release run 34527904114](https://github.com/Blacklord100/aster-family-office/actions/runs/34527904114), commit `c9beb1454063ce5740ab3c2044f4c0770691ac01`, passed both image builds, nonroot/read-only probes, network-disabled app startup and authenticated processor OCR, **606 processor tests in the built runtime without network**, the web-image scan and repository secret scan. The processor image-security gate remained blocked.

The retained scan was created at `2026-09-10T20:50:29.714103455Z` for image `sha256:43dbebebf79f8b6be3de7e2a950faa0d66d42b37d73601b66e33aa855fcca460` (`aster-processor:verify`, Debian 13.6). Independent replay of the package-coverage validator reports exactly the same **three HIGH findings** in the table below: two against `libtiff6 4.7.2-1+aster1`, one against `tesseract-ocr 5.5.3-1+aster1`, each without a `FixedVersion`. All 27 retained native package identities are covered within 34 scanned OS packages, and all 32 locked Linux Python packages are covered. No missing package identity caused the validator failure; its only error is the three outstanding HIGH findings.

The application job separately passed lint, typecheck, unit tests, production build and migrations, then failed the database lifecycle/isolation step. Its subsequent host processor tests, npm audit and SBOM steps were skipped. Container success does not qualify that failed application step. This record applies only to `c9beb14`; later local request-race, ledger UI and recovery follow-ups require their own CI run.

The earlier [run 34447324893](https://github.com/Blacklord100/aster-family-office/actions/runs/34447324893), commit `dc2c654`, passed its then-configured application job and retained the same three processor findings. Primary records checked on 10 September list Debian 13 TIFF as vulnerable for [36849](https://security-tracker.debian.org/tracker/CVE-2026-36849) and [52490](https://security-tracker.debian.org/tracker/CVE-2026-52490), while unstable/testing has fixed packages. The [Tesseract tracker](https://security-tracker.debian.org/tracker/CVE-2026-73066) lists Debian packages as unfixed; the [upstream advisory](https://github.com/tesseract-ocr/tesseract/security/advisories/GHSA-7j76-5rq5-5jg8) identifies 5.5.3 as patched. The new scan contains no different advisories. Switching the production base to a development distribution is not an established remediation.

The local host has no Docker, Trivy, Grype or Syft executable, so no new local Linux image scan was claimed. No findings, statuses, component identities or security gates were suppressed. A new candidate must still pass the qualification requirements below.

## Earlier authenticated build evidence

Verified on 9 September 2026. [CI run 34403006395](https://github.com/Blacklord100/aster-family-office/actions/runs/34403006395), commit `c9864ee`, built and exercised the authenticated upstream replacements. Source authentication, actual native versions, image decoding, OCR and all 589 processor tests passed. The scan still reports **three HIGH advisories** against their canonical Debian identities. These findings remain release blockers; functional tests and an upstream version change do not clear the strict scan gate.

| Retained package | Installed version | CVE                                                                          | Debian scan status |
| ---------------- | ----------------- | ---------------------------------------------------------------------------- | ------------------ |
| `libtiff6`       | `4.7.2-1+aster1` | [CVE-2026-36849](https://security-tracker.debian.org/tracker/CVE-2026-36849) | `will_not_fix`     |
| `libtiff6`       | `4.7.2-1+aster1` | [CVE-2026-52490](https://security-tracker.debian.org/tracker/CVE-2026-52490) | `affected`         |
| `tesseract-ocr`  | `5.5.3-1+aster1`  | [CVE-2026-73066](https://security-tracker.debian.org/tracker/CVE-2026-73066) | `affected`         |

All three scan records have an empty `FixedVersion`; no fixed Debian 13 package was identified. [Trivy’s Debian detector](https://github.com/aquasecurity/trivy/blob/main/pkg/detector/ospkg/debian/debian.go) reports such advisories without comparing installed versions. A local version increment, or a backport retaining Debian source identity, does not establish a clean scan.

## Verified upstream fixes

- **Tesseract 5.5.3:** [official release](https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.3), [advisory](https://github.com/tesseract-ocr/tesseract/security/advisories/GHSA-7j76-5rq5-5jg8), [fix commit](https://github.com/tesseract-ocr/tesseract/commit/2f4d2f4bf45c363785d7bf1da29b6628f8939a72). The [source archive](https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.3.tar.gz) downloaded with SHA256 `9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884`. Independent local verification authenticated [signed tag object](https://api.github.com/repos/tesseract-ocr/tesseract/git/tags/6951ffe10ce031374bcd04fe400811da1e7e04ad) `6951ffe10ce031374bcd04fe400811da1e7e04ad`, targeting commit `db0ec62f81b0737fbbe184d8fea40af5738f8eef`, with Stefan Weil's key fingerprint `49236FEA75C95D698EC2B78AE08C21D5677450AD`. The recomputed Git object hash matched, and a modified commit was rejected. The signature authenticates the tag/commit; the gzip archive has a separate pinned hash.
- **libtiff 4.7.2:** [official release](https://libtiff.gitlab.io/libtiff/releases/v4.7.2.html), [36849 fix](https://gitlab.com/libtiff/libtiff/-/commit/eedba405d3695b52faae65994c5904f228eca0bf), [52490 fix](https://gitlab.com/libtiff/libtiff/-/commit/b04e935cb6242f22cc8b63c99a372cf3ea825e4e). The [source archive](https://download.osgeo.org/libtiff/tiff-4.7.2.tar.xz) downloaded with SHA256 `4996f0c4f93094719b1ca5c6279b20e588773ba8a247533e486416fb662ddb88`. Its [detached signature](https://download.osgeo.org/libtiff/tiff-4.7.2.tar.xz.sig) was locally verified with Even Rouault's fingerprint `B1FA7D81EEB8E66399178B9733EBBFC47B3DD87D`, matching the keys on his publisher GitLab and GitHub profiles. A modified archive was rejected.

Both independent signature checks used OpenPGP.js 6.3.1 with default verification, pinned full fingerprints and negative tampering checks. Publisher HTTPS identities anchor the public keys; this is not an out-of-band LP trust exchange. Archive hashes identify downloaded bytes and are not independently published checksum attestations. The Linux build subsequently reverified the retained signatures with `gpgv` and passed the functional checks above. Security qualification remains blocked.

The locked Pillow 12.3.0 Linux wheel separately bundles libtiff 4.7.1. Replacing the OS library alone would leave that copy in place. The candidate rebuilds the same Pillow version from its official PyPI source archive (SHA256 `3b8182a766685eaa002637e28b4ec8d6b18819a0c71f579bf0dbaa5830297cce`) against the fixed shared libtiff. The Linux build/runtime probes confirmed both decoder paths use 4.7.2 and passed PNG/JPEG/compressed-TIFF round trips.

The [source inventory](../processor/runtime/upstream-sources.json) pins the archives, build tools and retained public verification files. The [build verifier](../processor/runtime/fetch-sources.py) rechecks the exact source hashes and signatures on every build. Local package identities remain `libtiff6` / source `tiff` and `tesseract-ocr` / source `tesseract`; no scanner identity is removed. The existing native macOS demo runtime is separate and has not been replaced by this Linux container candidate.

The [qualification receipt](../validation/linux-qualification-2026-09-09.json) records exact image identity, findings, package coverage and artifact hashes. All 27 copied native package identities were covered within 34 scanned OS packages, as were all 32 locked Python packages; missing coverage was not the validator failure. The sole validator error was the three HIGH findings. Earlier runs 34397825047, 34399925018 and 34401902945 retained the same advisory identities against the original Debian TIFF 4.7.0 and Tesseract 5.5.0 builds.

## Coverage and qualification required

At verification, the [NVD API for 73066](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-73066) returned `Received` with no CPE configurations; its [36849 query](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-36849) returned no records. The official Tesseract advisory API contained a blank package ecosystem, and [OSV’s GHSA lookup](https://api.osv.dev/v1/vulns/GHSA-7j76-5rq5-5jg8) returned 404. Generic upstream scanning therefore cannot yet be assumed complete. [Grype documents](https://oss.anchore.com/docs/guides/vulnerability/ecosystems/) its NVD/CPE fallback for non-OS packages.

Before release:

1. Preserve and repeat authenticated source, native linkage, superseded-payload removal and functional evidence for every new image revision; the exact qualified image and run are recorded at the top.
2. Retain truthful upstream source/SBOM identities and complete dependency inventories; verify every retained native and locked Python component remains covered.
3. Pass the raw scan and independent exact-image assessment with complete reviewed evidence. Require negative controls that reject known vulnerable versions, missing patches and altered runtime files. New or unassessed findings and missing coverage keep the gate blocked; a previous image's receipt cannot qualify a new build.

Do not clear findings through exclusions, ignored statuses, deleted metadata, or version-only relabeling.
