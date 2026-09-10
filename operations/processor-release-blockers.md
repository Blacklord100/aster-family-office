# Processor release blockers

## Candidate `c9beb14` verified 10 September 2026

The latest completed [release run 34527904114](https://github.com/Blacklord100/aster-family-office/actions/runs/34527904114), commit `c9beb1454063ce5740ab3c2044f4c0770691ac01`, passed both image builds, nonroot/read-only probes, network-disabled app startup and authenticated processor OCR, **606 processor tests in the built runtime without network**, the web-image scan and repository secret scan. The processor image-security gate remains blocked.

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

1. Preserve and repeat the authenticated source, native linkage, superseded-payload removal and functional evidence for each new image revision. The latest built-runtime checks passed for `c9beb14`; the original authenticated-source evidence is retained below.
2. Retain truthful upstream source/SBOM identities and complete Debian dependency inventories; verify every retained component remains covered. Retained runtime inventory coverage passed for `c9beb14`, while the separate application SBOM step was skipped.
3. Resolve the outstanding advisory/coverage qualification and pass the image-security gate. Require scanner canaries that detect the known vulnerable versions, plus explicit evidence for the official fixes. Missing coverage keeps the gate blocked; no release exception is granted by this record.

Do not clear findings through exclusions, ignored statuses, deleted metadata, or version-only relabeling.
