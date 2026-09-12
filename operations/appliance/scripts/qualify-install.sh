#!/bin/sh
# Actual install/restart/ingestion/backup/restore in a dedicated disposable runner.
# This is a same-host recovery drill, not independent-host or automatic-HA proof.
set -eu
umask 077
test "$#" = 1
test "$(id -u)" = 0
test "${ASTER_DISPOSABLE_RUNNER:-}" = 1
aster_base=$(realpath "$1")
test -f "$aster_base/bundle/release.json"
test -d "$aster_base/test-signing-keys"
test ! -e "$aster_base/installed"
test ! -e "$aster_base/restored"
aster_cli="$aster_base/asterctl"
aster_trust="$aster_base/test-signing-keys/root.json"
aster_trust_sha=$(cat "$aster_base/test-signing-keys/root.sha256")
mkdir "$aster_base/private" "$aster_base/proof"

aster_compose() {
  aster_target=$1
  shift
  aster_project=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["project"])' "$aster_target/installation.json")
  aster_release=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["releaseId"])' "$aster_target/installation.json")
  docker compose --project-name "$aster_project" --env-file "$aster_target/config/$aster_release.env" \
    --file "$aster_target/releases/$aster_release/payload/config/compose.offline.yaml" "$@"
}
aster_cleanup() {
  for aster_target in "$aster_base/installed" "$aster_base/restored"; do
    if test -f "$aster_target/installation.json"; then
      aster_compose "$aster_target" down --remove-orphans >/dev/null 2>&1 || true
    fi
  done
  # Credentials never enter artifacts; retain only the metadata-only proof.
  rm -rf "$aster_base/private"
}
trap aster_cleanup EXIT
"$aster_cli" recovery-key --output "$aster_base/private/recovery.agekey"
aster_recipient=$(sed -n 's/^# public recipient: //p' "$aster_base/private/recovery.agekey")
python3 - "$aster_base/private" <<'PY'
import json,secrets,sys
from pathlib import Path
p=Path(sys.argv[1]);password='SYNTHETIC appliance '+secrets.token_urlsafe(32)
(p/'password').write_text(password)
(p/'api-state.json').write_text(json.dumps({'email':'owner-appliance@example.invalid','password':password}))
PY
"$aster_cli" install --bundle "$aster_base/bundle" --root "$aster_base/installed" \
  --trust-root "$aster_trust" --trust-root-sha256 "$aster_trust_sha" \
  --hostname aster-qualification.example.invalid --profile offline --tls-mode internal \
  --recovery-recipient "$aster_recipient" --install-runtime --timeout 45m
"$aster_cli" bootstrap --root "$aster_base/installed" --email owner-appliance@example.invalid \
  --name 'Synthetic owner' --organization 'SYNTHETIC appliance qualification' --password-file "$aster_base/private/password"
node operations/appliance/scripts/qualify-api.mjs initial "$aster_base/installed" \
  "$aster_base/private/api-state.json" "$aster_base/proof/initial-api.json"
"$aster_cli" doctor --root "$aster_base/installed" > "$aster_base/proof/doctor-initial.txt"

# Cold container restart from retained data/model/TLS; no builds or pulls.
aster_compose "$aster_base/installed" down
aster_compose "$aster_base/installed" up -d --wait --wait-timeout 300 --pull never --no-build
"$aster_cli" doctor --root "$aster_base/installed" > "$aster_base/proof/doctor-restart.txt"
node operations/appliance/scripts/qualify-api.mjs restored "$aster_base/installed" \
  "$aster_base/private/api-state.json" "$aster_base/proof/restart-api.json"

# A sealed backup coordinates accepted state, pending review, original files and
# mutable CA/model state. The controller supplies its own drain/stop/resume barrier.
"$aster_cli" backup --root "$aster_base/installed" --output "$aster_base/recovery.age" --timeout 60m
aster_backup_sha=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha256"])' "$aster_base/recovery.age.receipt.json")
# Actual original writer fleet is stopped before explicit fencing acknowledgement.
aster_compose "$aster_base/installed" down
"$aster_cli" restore --root "$aster_base/restored" --input "$aster_base/recovery.age" \
  --identity "$aster_base/private/recovery.agekey" --backup-sha256 "$aster_backup_sha" \
  --trust-root "$aster_trust" --trust-root-sha256 "$aster_trust_sha" --source-fenced \
  --max-restore-gib 32 --timeout 60m
"$aster_cli" doctor --root "$aster_base/restored" > "$aster_base/proof/doctor-restored.txt"
node operations/appliance/scripts/qualify-api.mjs restored "$aster_base/restored" \
  "$aster_base/private/api-state.json" "$aster_base/proof/restored-api.json"
"$aster_cli" status --root "$aster_base/restored" > "$aster_base/proof/restored-status.json"
python3 - "$aster_base" <<'PY'
import datetime,json,sys
from pathlib import Path
p=Path(sys.argv[1]);proofs=[json.loads((p/'proof'/name).read_text()) for name in ('initial-api.json','restart-api.json','restored-api.json')]
receipt={'schemaVersion':1,'result':'passed-bounded-installation-recovery-drill',
 'releaseId':json.loads((p/'bundle/release.json').read_text())['releaseId'],
 'topology':'Second private installation directory on one disposable Linux host; original fleet stopped before restore',
 'checks':proofs,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'notYetQualified':['Empty host with every runtime/image/package cache absent and physical network disconnected',
 'Independent spare-host failure-domain recovery and measured RPO/RTO','Source retention purge followed by archive recovery',
 'Power loss at each update/migration boundary and full interrupted-update matrix','Full32GiB workload capacity/latency',
 'Supplied customer PKI rotation and generalized VM first boot','Complete host IPv4/IPv6/DNS/metadata egress capture','Automatic high availability']}
(p/'qualification.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'result':receipt['result'],'releaseId':receipt['releaseId'],'remainingGates':receipt['notYetQualified']}))
PY
