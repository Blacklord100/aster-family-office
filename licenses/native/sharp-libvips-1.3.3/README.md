# Linux sharp native corresponding-source material

The npm package `@img/sharp-libvips-linux-x64@1.3.3` declares
`LGPL-3.0-or-later`. Its `libvips-cpp.so.8.18.6` statically incorporates other
libraries. The Apache-2.0 license in `recipe/LICENSE` covers the packaging
scripts; it does **not** replace those libraries' terms.

The retained recipe is from signed upstream tag `v1.3.3`, commit
`6e5971d333377743163edc3ad9e5d0b897abcbc9`. Individual file hashes and original
URLs are recorded in the provenance files. The source policy covers all 28
versions recorded by that recipe, the pinned glib `gvdb` fallback, and the
checksum-pinned crates in librsvg's original `Cargo.lock`. This deliberately
includes a superset of platform/test dependencies. In particular, proxy-libintl
is recorded upstream but is not built on glibc Linux.

The build recipe's librsvg modifications remove features before
`cargo update --workspace`; all original locked registry source archives are
retained. The collector compares the actual source archive's `Cargo.lock` and
glib's `gvdb.wrap` byte-for-byte with the reviewed metadata. Changed or new
recursive dependencies require a policy update. It also retains all four
upstream patches and the complete build commands, including in-place source
edits. Source archives preserve their original copyright and license files;
the offline verifier additionally extracts those texts for convenient review.

Run on the connected, disposable Linux builder, with the exact app image's
inert `/app` directory already exported:

```sh
python3 tools/release/collect-native-sources.py resolve \
  --runtime-root /work/exported-app --node-lock package-lock.json \
  --image-id sha256:ACTUAL_APP_IMAGE_ID \
  --output /work/compliance/native-sources
python3 tools/release/collect-native-sources.py verify \
  --runtime-root /work/exported-app --node-lock package-lock.json \
  --image-id sha256:ACTUAL_APP_IMAGE_ID \
  --source-root /work/compliance/native-sources
```

Resolution downloads version-specific original sources over HTTPS, verifies
published Cargo checksums and npm SHA512 integrity, then pins every retained
artifact by SHA256 in `source-lock.json`. Native `.so` bytes and the entire npm
package file set must match the exact published registry archive. An independent
offline pass checks all identities, source coverage, recipes, patches and
notices before emitting `receipt.json`. Interrupted/incomplete resolution does
not produce a passing receipt. A new unknown ELF dependency fails the gate.

Some nested crates omit their repository-root notices from the registry archive.
The reviewed `noticeSupplements` policy retains the original notice files from
the exact commit recorded in that crate's `.cargo_vcs_info.json`, with fixed
SHA256 hashes. Verification also requires the exact crate checksum, repository,
version and license expression from `Cargo.toml.orig`. It never substitutes a
generic license template or a file from a mutable branch. Original supplemental
files remain under `supplemental-notices/` and are bound by both the source lock
and receipt. Collection records any other missing notices across the complete
archive inventory, then fails; unresolved cases cannot produce a passing receipt.

For older crates without embedded VCS metadata, the policy can instead retain
an immutable, digest-pinned upstream source archive. Every packaged file must
match its declared upstream subtree, including Windows import libraries and
README files. The only path conversion is `Cargo.toml.orig` to `Cargo.toml`;
the generated manifest must have exactly the same parsed TOML as the original.
Reviewed `notice-provenance/*.json` files retain every path, byte count and
SHA256 mapping. Those mappings and the additional `notice-source-archives/`
originals are checked again during offline verification and release staging.
The current three mappings cover 1,390 i686 files, 1,419 x86_64 files and seven
difflib files, plus each separately validated generated manifest.

Original notices can be embedded in source files. The selectors 0.40.0 policy
pins all 16 original Rust members and their existing 205-byte MPL Exhibit A
headers, along with the crate checksum, VCS commit and repository subtree.
It retains the original complete members unchanged; it does not synthesize a
copyright statement or substitute an unrelated license. The MPL describes
this source-header mechanism in [Exhibit A](https://www.mozilla.org/en-US/MPL/2.0/).
Likewise, r-efi's explicitly reviewed `AUTHORS` files contain its original
copyright holders and full MIT grant; filename guessing alone missed them.

The full inventory run at commit `66b26d2` retained all 379 archives (29 native
and 350 Cargo). A subsequent source-only reread with the reviewed notice policy
resolved eight of its 12 reported omissions. Four original-text gaps remain:

| Crate archive | Declared license | SHA256 |
| --- | --- | --- |
| `block-0.1.6.crate` | MIT | `0d8c1fef690941d3e7788d328517591fecc684c084084702d6ff1641e993699a` |
| `malloc_buf-0.0.6.crate` | MIT | `62bb907fe88d54d8d9ce32a3cceab4218ed2f6b7d35617cafe9adf84e43919cb` |
| `objc-foundation-0.1.1.crate` | MIT | `1add1b659e36c9607c7aab864a76c7a4c2760cd0cd2e120f3fb8b952c7e22bf9` |
| `objc_id-0.1.1.crate` | MIT | `c92d4ddb4bd7b50d730c215ff871754d0da6b2178849f8a2a2ab69712d0c073b` |

Their exact upstream version revisions also omit the original notice text.
These declarations are not replaced with generic MIT templates. The full-graph
gate remains failed until original texts can be obtained or a separately
measured, reviewed Linux build graph establishes a narrower actual scope.
Retaining the full lockfile graph does not imply that all 350 crates are linked
into the Linux library. This source-only reread is not a successful kernel
network-isolated verification, rebuild qualification, or legal approval.

Distribute the **entire output directory**, not merely its receipt or URLs.
The output contains original compressed sources, Cargo crate sources, build
scripts/modifications, original notices, registry provenance and the hash lock.
Retain it for every corresponding binary release. Recipients can unpack those
sources and follow `reviewed-recipe/recipe/README.md` and the included Linux
build recipe to modify/rebuild the shared library. The generated library keeps
the upstream SONAME so the LGPL library can be replaced with a compatible
modified version. The original recipe describes its build-tool dependencies;
the receipt does not assert a bit-for-bit reproducible toolchain or rebuild.

This gate is scoped to the sharp native payload. Its system-library dependency
names are recorded separately; Debian/Ubuntu/runtime-service sources and other
image packages still require their own distribution material. A passing source
receipt is an engineering inventory, not a legal approval or a claim that all
other binary-distribution obligations have been satisfied.

The actual Linux app qualification found a dynamic dependency on
`libresolv.so.2`. Debian lists this resolver library in its
[libc6 package files](https://packages.debian.org/trixie/amd64/libc6/filelist),
whose [source package is glibc](https://packages.debian.org/trixie/libc6).
It is therefore an explicitly reviewed system dependency alongside `libc.so.6`.
This policy addition does not include glibc's corresponding source in the
sharp source bundle. The qualification retains the exact image's available
package metadata and resolver bytes separately for review; unknown ELF
dependencies continue to fail.
