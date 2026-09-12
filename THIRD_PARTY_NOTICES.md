# Third-party materials and distribution inventory

The Aster license covers original project contributions. Dependencies and externally
supplied materials keep their own terms. This file is an inventory guide; it is not
a substitute for the actual license texts or required corresponding source.

| Layer | Version/source inventory | Required distribution evidence |
| --- | --- | --- |
| JavaScript application and development tools | package-lock.json; release npm CycloneDX SBOM | Package licenses, copyright/NOTICE files and applicable bundled asset notices |
| Python processor | processor/requirements.lock.txt | Installed distribution metadata and complete bundled license files, including vendored native libraries |
| Native OCR and image libraries | processor/runtime/upstream-sources.json; image runtime-manifest.json | Exact upstream licenses, retained modifications and source archive identity |
| Linux/runtime services | Pinned Dockerfiles, Compose images and image SBOMs | OS and service notices, corresponding source or valid source offers where required |
| Local model/runtime packs | Signed release/model pack manifest | Exact weight/tokenizer/template/projector identities, original licenses and required attribution |

Tesseract security patch files retain their upstream authorship and Apache-2.0
notices. The libtiff and Pillow source archives have separate licenses. The processor
image assembly retains Debian package copyright/license files and copies upstream
native licenses; their presence is checked as part of the runtime inventory.

Use `python3 tools/release/collect-notices.py --help` to collect installed npm or
Python license files and a machine-readable inventory without network access.
Run the Python collector inside the exact built processor image to include the
installed platform's native-wheel notices. Missing license texts or unknown terms
remain explicit review items. Include the collector output, runtime inventories,
image SBOMs and reviewed model/OS license bundles with each downloadable release.

The source tree does not include model weights. A locally configured model alias
does not establish artifact identity or redistribution permission. Audit the exact
model pack and optional GPU/runtime components before bundling them. The repository
must not claim that the Apache-2.0 project license covers customer documents or
third-party code whose terms require separate compliance.

The bundled Geist and Geist Mono font notices are in `licenses/geist/`. Reviewed
exact-version npm supplements are in `licenses/npm/sources.json`, with retained
upstream URLs and SHA256 values. Pass this file using the collector's `--supplements`
option. For a copied production app image, use `--node-root` for the matching full
Linux npm installation and `--node-runtime-root` for its exported `/app` directory;
this selects exact shipped package identities while collecting full upstream notices.
The standalone Next tree alone omits separate worker dependencies.

Packages such as sharp-libvips contain separately licensed native libraries. A
packaging repository's Apache license does not replace the bundled libraries' LGPL
terms or source obligations. Retain each exact native dependency inventory and the
corresponding source/build material required by its terms before binary distribution.

Source fixtures under benchmark/ and processor/tests/fixtures are development
examples; publication still requires a provenance/data review. Never include
operator .env files, secrets, live volumes, archives, backups or private validation
directories in source or appliance release media.
