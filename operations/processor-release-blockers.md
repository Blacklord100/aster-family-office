# Processor release blockers

Research verified on 9 September 2026. CI run **34397825047** built the processor image; its retained `processor-image-scan.json` reports **three HIGH vulnerabilities**. These remain release blockers. Functional tests passing does not clear this security gate.

| Retained package | Installed version | CVE                                                                          | Debian scan status |
| ---------------- | ----------------- | ---------------------------------------------------------------------------- | ------------------ |
| `libtiff6`       | `4.7.0-3+deb13u3` | [CVE-2026-36849](https://security-tracker.debian.org/tracker/CVE-2026-36849) | `will_not_fix`     |
| `libtiff6`       | `4.7.0-3+deb13u3` | [CVE-2026-52490](https://security-tracker.debian.org/tracker/CVE-2026-52490) | `affected`         |
| `tesseract-ocr`  | `5.5.0-1+aster1`  | [CVE-2026-73066](https://security-tracker.debian.org/tracker/CVE-2026-73066) | `affected`         |

All three scan records have an empty `FixedVersion`; no fixed Debian 13 package was identified. [Trivy’s Debian detector](https://github.com/aquasecurity/trivy/blob/main/pkg/detector/ospkg/debian/debian.go) reports such advisories without comparing installed versions. A local version increment, or a backport retaining Debian source identity, does not establish a clean scan.

## Verified upstream fixes

- **Tesseract 5.5.3:** [official release](https://github.com/tesseract-ocr/tesseract/releases/tag/5.5.3), [advisory](https://github.com/tesseract-ocr/tesseract/security/advisories/GHSA-7j76-5rq5-5jg8), [fix commit](https://github.com/tesseract-ocr/tesseract/commit/2f4d2f4bf45c363785d7bf1da29b6628f8939a72). The [source archive](https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.3.tar.gz) downloaded with SHA256 `9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884`. GitHub’s [tag API](https://api.github.com/repos/tesseract-ocr/tesseract/git/tags/6951ffe10ce031374bcd04fe400811da1e7e04ad) reports a valid signature and commit `db0ec62f81b0737fbbe184d8fea40af5738f8eef`; independent local signature verification remains required.
- **libtiff 4.7.2:** [official release](https://libtiff.gitlab.io/libtiff/releases/v4.7.2.html), [36849 fix](https://gitlab.com/libtiff/libtiff/-/commit/eedba405d3695b52faae65994c5904f228eca0bf), [52490 fix](https://gitlab.com/libtiff/libtiff/-/commit/b04e935cb6242f22cc8b63c99a372cf3ea825e4e). The [source archive](https://download.osgeo.org/libtiff/tiff-4.7.2.tar.xz) downloaded with SHA256 `4996f0c4f93094719b1ca5c6279b20e588773ba8a247533e486416fb662ddb88`. Its [detached signature](https://download.osgeo.org/libtiff/tiff-4.7.2.tar.xz.sig) exists but was not locally verified.

These hashes identify downloaded bytes; they are not independently published checksum attestations. No upstream replacement has been qualified by this research.

## Coverage and qualification required

At verification, the [NVD API for 73066](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-73066) returned `Received` with no CPE configurations; its [36849 query](https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2026-36849) returned no records. The official Tesseract advisory API contained a blank package ecosystem, and [OSV’s GHSA lookup](https://api.osv.dev/v1/vulns/GHSA-7j76-5rq5-5jg8) returned 404. Generic upstream scanning therefore cannot yet be assumed complete. [Grype documents](https://oss.anchore.com/docs/guides/vulnerability/ecosystems/) its NVD/CPE fallback for non-OS packages.

Before release:

1. Authenticate fixed upstream sources, build the actual replacements, and prove their hashes, versions, dependency resolution, and removal of superseded payloads.
2. Retain truthful upstream source/SBOM identities and complete Debian dependency inventories; verify every retained component remains covered.
3. Run Linux runtime, OCR, regression, and image-security qualification. Require scanner canaries that detect the known vulnerable versions, plus explicit evidence for the official fixes. Missing coverage keeps the gate blocked.

Do not clear findings through exclusions, ignored statuses, deleted metadata, or version-only relabeling.
