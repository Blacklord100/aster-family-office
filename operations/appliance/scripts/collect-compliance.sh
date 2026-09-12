#!/bin/sh
# Connected/disposable Linux builder. Output is retained, not silently remediated.
set -eu
test "$#" = 2 || { echo 'usage: collect-compliance.sh IMAGES_DIR NEW_OUTPUT_DIR' >&2; exit 1; }
aster_images=$(realpath "$1")
aster_output=$(realpath -m "$2")
test ! -e "$aster_output"
mkdir -p "$aster_output/licenses" "$aster_output/sbom"
aster_release=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["releaseId"])' "$aster_images/inventory.json")
aster_app_container=''
trap 'if test -n "$aster_app_container"; then docker rm "$aster_app_container" >/dev/null; fi' EXIT
for service in app processor postgres ollama caddy; do
  trivy image --scanners vuln --severity HIGH,CRITICAL --list-all-pkgs --format json \
    --exit-code 0 --output "$aster_output/sbom/$service-scan.json" "aster-$service:$aster_release"
  trivy image --format cyclonedx --output "$aster_output/sbom/$service.cdx.json" "aster-$service:$aster_release"
done
# Raw scan output is deliberately retained; only the independent exact-artifact
# verifier may disposition its narrowly enumerated patched processor findings.
docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint python "aster-processor:$aster_release" \
  -c 'from pathlib import Path; print(Path("/opt/aster/runtime-manifest.json").read_text())' \
  > "$aster_output/sbom/processor-runtime-manifest.json"
docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$(pwd)/processor/runtime/verify-security-runtime.py,dst=/opt/aster/verify-security-runtime.py,readonly" \
  --entrypoint python "aster-processor:$aster_release" /opt/aster/verify-security-runtime.py \
  > "$aster_output/sbom/processor-runtime-security.json"
python3 operations/appliance/scripts/assess-images.py --images "$aster_images" --evidence "$aster_output/sbom"
# Export only the inert runtime package tree. There is no customer state in it.
aster_app_container=$(docker create --entrypoint node "aster-app:$aster_release" -e 'process.exit(0)')
mkdir "$aster_output/runtime-export"
docker cp "$aster_app_container:/app/node_modules" "$aster_output/runtime-export/node_modules"
python3 tools/release/collect-notices.py --node-root . --node-runtime-root "$aster_output/runtime-export" \
  --supplements licenses/npm/sources.json --output "$aster_output/licenses/npm" --require-complete
docker rm "$aster_app_container" >/dev/null
aster_app_container=''
# The processor interpreter enumerates its actual installed distributions.
mkdir "$aster_output/python-export"
chmod 0777 "$aster_output/python-export"
docker run --rm --read-only --network none --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$(pwd)/tools/release/collect-notices.py,dst=/opt/aster/collect-notices.py,readonly" \
  --mount "type=bind,src=$aster_output/python-export,dst=/license-output" \
  --entrypoint python "aster-processor:$aster_release" /opt/aster/collect-notices.py --python \
  --output /license-output/python --require-complete
mv "$aster_output/python-export/python" "$aster_output/licenses/python"
rmdir "$aster_output/python-export"
rm -rf "$aster_output/runtime-export"
# Keep installed OS license/source inventory inside each image and retain its
# CycloneDX package identities. Review THIRD_PARTY_NOTICES source obligations too.
cp "$aster_images/inventory.json" "$aster_output/sbom/images.json"
