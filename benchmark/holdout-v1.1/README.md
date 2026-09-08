# Frozen corpus v1.1

This append-only corpus version preserves every v1 document and gold case unchanged and adds `scanned-nav`: one new image-only PDF, manually specified and visually reviewed before inference. `manifest.json` records the v1 parent manifest digest and all current source/gold hashes.

The benchmark runner, scorer, and tests live in `../holdout-v1`; usage and limitations are in `../README.md`. Model results must not be used to edit this frozen gold. Publish a new version for any adjudicated change.
