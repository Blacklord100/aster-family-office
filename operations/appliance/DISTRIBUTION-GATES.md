# Remaining appliance distribution gates

Review date: 2026-09-12. **`distributionReady: false` remains required.** The
packager produces an internal signed test candidate. A successful build, a clean
security assessment or publication of Aster's source does not establish that the
complete binary appliance is ready for public distribution.

This document identifies missing evidence and the smallest implementation needed
to obtain it. This review inspected repository code, upstream recipes and small
OCI metadata responses. It did not download image layers or new source archives,
inventory an extracted Ollama CPU runtime, or qualify a target server. Existing
collectors must still produce passing receipts for the exact candidate; their
presence in the repository is not an executed result.

The applicable license of each shipped component determines its requirements.
Some components require notices, some require corresponding source and build
material, and some have separate redistribution terms. Do not treat a wrapper's
license as covering bundled libraries. Source collection is a conservative
engineering policy; a complete source directory alone does not constitute final
license approval. Preserve the independent source, security and qualification
gates in `docs/distribution-status.json`.

## Existing coverage and concrete gaps

The exact base references are in [image-lock.json](image-lock.json). Resolve the
installed package and binary versions from those artifacts, rather than inferring
them from a moving tag such as `postgres:17-bookworm` or `caddy:2-alpine`.

| Distributed artifact | Existing implementation or evidence | Material still needed for this candidate |
| --- | --- | --- |
| Ubuntu 24.04 host runtime `.deb` set | [collect-runtime.py](scripts/collect-runtime.py) uses signed APT indexes and an empty package status to download dependencies; the inventory records binary package names, versions, architectures, hashes and lengths. | Retain authenticated repository/index evidence and map every exact binary to its source package/version. Collect the `.dsc`, all referenced original archives and Debian patches/build material. The current provenance string is not a retained authenticity chain. |
| Debian/Ubuntu content in all five saved images | Exact image IDs, saved-image hashes, package SBOMs and raw vulnerability scans. Processor assembly also retains package metadata and native file hashes. | Cover every distributed layer, including bytes hidden by later layers. Retain source-package mappings, source archives, notices and image-build recipes for the exact versions. A merged filesystem scan alone cannot account for all bytes in a saved layered image. |
| App Node runtime and native npm dependencies | Distroless Node 24/Debian 13 is pinned; npm notice collection selects the actual runtime tree. | Bind the actual Node executable to its exact upstream source, bundled dependencies, notices and Distroless build recipe. Inventory other native npm payloads outside the sharp-specific gate instead of assuming JavaScript package metadata describes them. |
| sharp/libvips | [collect-native-sources.py](../../tools/release/collect-native-sources.py) implements exact app-image/native-file verification with a reviewed closure of 29 native archives and 350 Cargo archives, recipes, patches and notices. | Require a successful exact-candidate resolve/verify receipt and retained material. This gate covers sharp/libvips; it does not cover all OS packages, other npm native modules or Python wheels, and it does not prove a reproducible rebuild. |
| Processor CPython runtime | The pinned Python 3.12.13 builder supplies the interpreter copied into the assembled runtime. | Retain exact CPython source, applicable bundled dependency notices/source, upstream image recipe and interpreter/native hashes. Copied `/usr/local` binaries are not necessarily represented by Debian's package inventory. |
| Custom processor Tesseract, libtiff and Pillow | [upstream-sources.json](../../processor/runtime/upstream-sources.json) pins Tesseract 5.5.3, libtiff 4.7.2 and Pillow 12.3.0. The separate Docker `source-evidence` target now exports the original archives, pinned build wheels, authentication material, every reviewed backport, build recipe, compiler configuration, package inventory and regression evidence. The [collector](scripts/collect-processor-sources.py) compares reviewed inputs and checks the export digest marker, runtime manifest and installed native/Pillow files inside the exact processor image; staging checks this evidence again against the raw security manifest. Only the small marker enters the service image. | Require the actual candidate's passing export, exact-image attestation and retained-source CI artifact; synthetic tests do not establish that the Linux build passed. Map supporting codecs, Leptonica, the retained OCR language data, CPython, distro packages and other wheels separately. This bounded export does not establish reproducible compilation or complete distribution clearance. |
| Processor binary wheels | Exact installed Python distributions have collected license texts; [requirements.lock.txt](../../processor/requirements.lock.txt) pins versions. | Record the exact Linux wheel filenames/hashes and native files, then cover vendored dependencies. In particular inspect NumPy 2.5.3, SciPy 1.18.1, scikit-learn 1.9.0 and pypdfium2 5.13.0 for BLAS/compiler-runtime/PDFium material, and inspect other native extensions such as pydantic-core. A version pin or package license alone is insufficient evidence of bundled native coverage. |
| Caddy and Alpine packages | The official image is pinned by digest; image security/SBOM gates run on its exact ID. | Resolve the actual Alpine package origin/version/revision and retained APKBUILD/source material. Bind the Caddy executable's Go build information, modules, notices, source and build recipe to that binary. The separate Aster controller collector does not cover Caddy. |
| PostgreSQL and its Debian packages | The official PostgreSQL 17 image is pinned and scanned. | Resolve installed PostgreSQL and dependency packages to their actual repository and source versions, including PGDG where the artifact establishes it. Retain the exact upstream/container recipe and sources/notices. Do not assume the tag establishes a point release or that every file belongs to the base Debian suite. |
| Ollama Go/native/GPU payload | The exact official 0.33.3 base is pinned; the compressed metadata measurement below is available. | Export and inventory every file and native dependency. Retain Go/module and llama.cpp/compatibility source, copied compiler-runtime libraries, notices and build recipes. Review separately licensed GPU redistributables actually shipped. Choosing CPU execution does not remove their bytes from the release. |
| Standalone `asterctl` | [collect-controller.py](scripts/collect-controller.py) binds embedded Go modules, notices, SPDX and binary vulnerability evidence to the exact executable. | Require the candidate's matching receipt and retain its build/source inputs. This is not a substitute for equivalent inventory of other Go executables in the media. |
| Optional generalized VM image | A [VM recipe](vm/README.md) exists. | Inventory the exact cloud image, kernel, boot components, guest packages and any firmware; retain applicable source/notices and provenance. The appliance runtime `.deb` closure does not cover an entire guest OS. Unavailable source is not permission to redistribute a firmware or other separately licensed payload. |

Primary upstream starting points for the image-specific adapters are
[Distroless build sources](https://github.com/GoogleContainerTools/distroless),
[official Python image sources](https://github.com/docker-library/python),
[official PostgreSQL image sources](https://github.com/docker-library/postgres)
and [official Caddy image sources](https://github.com/caddyserver/caddy-docker).
These links identify maintainers' repositories; the collector must resolve and
retain the exact revision that corresponds to each pinned artifact. A link to a
repository's current branch is not the release's source lock.

The processor's already reviewed archive URLs include the
[Tesseract 5.5.3 archive](https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.3.tar.gz),
[libtiff 4.7.2 archive](https://download.osgeo.org/libtiff/tiff-4.7.2.tar.xz)
and [Pillow 12.3.0 release metadata](https://pypi.org/pypi/Pillow/12.3.0/json).
Use the exact hashes and authentication records in the local source lock;
downloading a similarly named archive is not sufficient.

## Measured Ollama base and CPU-only investigation

The pinned Linux/amd64 base is
`ollama/ollama:0.33.3@sha256:57a73f11f75b32b97b59b003f351445c9c2a8af4b9d586ecdc928dee6150ef26`.
Its config is
`sha256:2a5d0462221131b2313d838e99c30cf4190a5207236f065b246acd11ae718e85`.
The following values were read from the registry's
[pinned OCI manifest](https://registry-1.docker.io/v2/ollama/ollama/manifests/sha256:57a73f11f75b32b97b59b003f351445c9c2a8af4b9d586ecdc928dee6150ef26)
and associated
[image config/history](https://registry-1.docker.io/v2/ollama/ollama/blobs/sha256:2a5d0462221131b2313d838e99c30cf4190a5207236f065b246acd11ae718e85).
The registry endpoints require a normal anonymous pull token. Pair each layer
descriptor with the next non-empty history entry; metadata-only entries add no
filesystem layer.

| Image-history operation | Compressed layer bytes | Layer digest |
| --- | ---: | --- |
| Ubuntu root filesystem `ADD` | 29,752,807 | `sha256:0926a8eb0e608a5c6888d1cd5594184bdf3ed3aa311dba5b42a547caefdc6f2e` |
| APT dependency installation | 104,777,105 | `sha256:f1413ea002f145532d999c9e349e182582ceb82ca8f985c446fa3b5e2985eb5e` |
| `COPY /bin /usr/bin` | 14,160,353 | `sha256:f750184dbf249fe789e2ea69958896aee958d6e5de22bbb91c542e20e3caa420` |
| `COPY /lib/ollama /usr/lib/ollama` | 3,556,831,597 | `sha256:243048af197289a213ffd4e13554bce3ab6fdf6a8bd4cc003914f4bcb956bb02` |
| **Total compressed layer bytes** | **3,705,521,862** | |

These are compressed OCI layer sizes, excluding config/manifest overhead. They
are not extracted file sizes, complete Aster image sizes, source-archive sizes or
a measurement of the CPU subset. No per-file CPU/GPU breakdown was measured.
Other images' and the runtime source set's byte totals must come from the exact
builder inventory; this review did not acquire those artifacts or estimate them.

The [upstream v0.33.3 Dockerfile](https://raw.githubusercontent.com/ollama/ollama/v0.33.3/Dockerfile)
assembles amd64 CPU, CUDA 12, CUDA 13, Vulkan and MLX stages. Its Ubuntu 24.04 final
stage installs `ca-certificates`, `libvulkan1` and `libopenblas0`, then copies the
binary and library trees above. The CPU build also copies available `libgomp` and
`libomp` libraries from its AlmaLinux/GCC toolchain. These are recipe observations,
not proof of the exact files present in the pinned image.

The [native installation recipe](https://raw.githubusercontent.com/ollama/ollama/v0.33.3/llama/server/CMakeLists.txt)
includes `llama-server`, shared ggml/llama libraries, `mtmd` for multimodal support,
CPU dispatch modules and associated notices. Some targets are conditional. Its
[CPU build settings](https://raw.githubusercontent.com/ollama/ollama/v0.33.3/llama/server/CMakePresets.json),
`$ORIGIN` paths and dynamic dependencies must be checked against the actual compiled files. The
[llama.cpp version input](https://raw.githubusercontent.com/ollama/ollama/v0.33.3/LLAMA_CPP_VERSION)
names `b10760`; a future source lock must resolve that input to the exact source
commit/archive and retain Ollama's compatibility material.

A smaller CPU-only image is a **design inference**, not a verified implementation.
A separate final stage based on a pinned Ubuntu image could copy selected,
byte-identical CPU payload from the pinned official Ollama donor. The final saved
image would then omit the donor's GPU layers. Deleting GPU files in a later layer
of the existing image would still redistribute their earlier layers.

Before writing a `COPY` allowlist, export the donor without starting its service.
Record file types, symlinks, hashes, ELF `NEEDED`/interpreter/RPATH information and
Go build information. Inspect ELF metadata with a trusted tool such as `readelf`;
do not use `ldd` to discover dependencies by executing unreviewed payloads. Resolve
the complete CPU, vision and dispatch closure, including copied toolchain
libraries that Ubuntu's package inventory does not own. Record exact upstream
notice/source mappings before deciding which files can be omitted.

Any resulting image needs its own layer inventory, proof that excluded GPU bytes
are absent, byte-for-byte checks for preserved official binaries, source and
security receipts, and bounded text/vision execution. A correct slim image may
reduce distribution scope, but it does not by itself close that scope or qualify
the complete appliance. No guessed CPU path list or replacement model server is
part of this change.

## Smallest correct collector and verifier

This work can run on the existing disposable connected Linux release builder,
followed by independent verification with networking disabled. It does not need
a new service. Implement it in bounded stages so the missing material is visible
before attempting full collection.

1. **Inventory exact distributed bytes.** Bind the input lock to every saved image
   ID and tar hash, every `.deb` hash, the controller and model assets, and the
   optional VM digest. Enumerate all shipped image layers as well as the merged
   filesystem. The processor's current `FROM scratch` assembly avoids retaining
   replaced runtime-base files in lower final layers; do not assume other images
   have that property. Record non-package files and unresolved ownership explicitly.
2. **Resolve exact distro sources.** For Debian/Ubuntu binaries, record the
   `Source` package/version, including cases where they differ from the binary
   name/version. Retain verified `InRelease` or signed `Release` data, index hashes,
   the relevant binary and `Sources` records, `.dsc` and every referenced original
   archive/patch component. Debian's
   [source-package format](https://www.debian.org/doc/debian-policy/ch-source.html)
   identifies the source and build material to preserve. Use an authenticated
   archive/snapshot if an exact version has left current repositories; never
   substitute the latest source. For Alpine, map the exact APK to its source
   origin/revision and authenticated repository metadata, then retain the matching
   aports recipe, patches and checksum-bound inputs. The
   [Alpine package index](https://pkgs.alpinelinux.org/packages) is a primary lookup
   entry point, not a replacement for the retained source lock. Do not execute an
   arbitrary downloaded APKBUILD on the host.
3. **Cover non-package payloads.** Add a reviewed, hash-bound supplement catalog
   for Node/CPython, custom OCR sources, native wheels, Caddy and Ollama. Retain
   upstream source archives, patches, notices and build recipes matched to the
   actual binaries and bundled dependencies. Extend the existing Go collector
   pattern to other Go executables; it cannot infer native dependency coverage.
   Identify separately licensed payloads and stop for unresolved terms instead
   of treating a source URL or wrapper license as approval. Record the build
   toolchain needed to reproduce the recipe, distinguishing unshipped build tools
   from runtime bytes actually distributed.
4. **Bound and verify collection.** Use explicit host allowlists and byte, file,
   archive expansion and time limits. Retain authentication evidence; fail on
   missing, ambiguous or changed inputs. The offline verifier must rehash every
   retained artifact, validate safe paths/types, prove exact inventory coverage
   and bind the source lock to the candidate's image/package/native identities.
   Missing coverage must remain a failing gate, with a machine-readable gap list.
5. **Bind the evidence into staged media.** Retain the source lock, archives,
   recipes, notices, raw inventories and verifier receipt under a signed payload
   directory such as `licenses/runtime-sources`. Revalidate copied bytes before
   writing `release.json`, as the current staging gate does for existing evidence.
   Report exact source bytes and coverage counts. Keep `distributionReady: false`
   until source/material coverage, final applicable-license review, security and
   the target qualification below have all been explicitly accepted.

Successful source verification establishes retained material and its relationship
to the candidate. It does not establish reproducible compilation, security
absence, model accuracy or permission under every component's terms.

## Target-server qualification remains independent

The initial full-workload target is Ubuntu 24.04 amd64 with 8 CPU cores and 32 GiB
RAM. The complete disposable build/recovery drill requires at least 250 GiB free
disk. Resource, capacity and recovery claims need measurements from the actual
candidate and host; the macOS demo and a low-context standalone model smoke do
not qualify that workload.

Retain receipts against the exact source revision, images, model, media and host
inventory for the following gates:

- Fresh installation with an empty cache using only verified offline media; no
  hidden downloads. Probe container and host boundaries, including external DNS,
  direct IPv4/IPv6, proxies and metadata routes, under the intended LAN policy.
- HTTPS hostname/trust and both supported certificate modes where offered; fresh
  owner setup, MFA, scope isolation and session behavior. Retain customer-PKI
  renewal/rotation evidence where that mode is deployed.
- Actual local-model text and vision execution; known nonzero synthetic financial
  EML/PDF extraction through both processing modes, original-source review,
  acceptance, deduplication and exact archived-file hashes. An empty or zero-fact
  control alone cannot satisfy the financial ingestion gate.
- Cold restart, writer drain/seal, complete backup and restore of database,
  originals, CA/model state and audit history. Observe interrupted update and
  continuation; reject wrong trust roots, changed payloads, incompatible schemas,
  unauthorized rollback and insufficient capacity.
- Independent spare-host recovery and measured RPO/RTO. Same-host recovery and
  observed controller SIGKILL phases are useful bounded evidence; they do not
  establish physical power-loss behavior, every interruption boundary or HA.
- Sustained resource/capacity and latency measurements under a representative
  portfolio workload. Qualify a generalized VM's first boot, guest inventory and
  hypervisor separately if VM media is offered.

The [qualification section](README.md#qualification-and-current-limits),
[recovery scope](recovery.md) and [VM guide](vm/README.md) describe implemented
helpers and their limits. A helper that has not run is a pending test, not a passing
receipt. Public binary release remains blocked until the exact candidate clears
the applicable gates; publishing reviewed application source is a separate action.
