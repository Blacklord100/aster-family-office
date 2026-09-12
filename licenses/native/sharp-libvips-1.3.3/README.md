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
