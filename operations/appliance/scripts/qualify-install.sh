#!/bin/sh
# Actual install/restart/ingestion/backup/restore in a dedicated disposable runner.
# This is a same-host recovery drill, not independent-host or automatic-HA proof.
set -eu
umask 077
test "$#" = 1
test "$(id -u)" = 0
test "${ASTER_DISPOSABLE_RUNNER:-}" = 1
aster_node=${ASTER_QUALIFICATION_NODE:?Exact setup-node executable must be preserved through sudo}
python3 - "$aster_node" <<'PY'
import os,stat,sys
from pathlib import Path
p=Path(sys.argv[1])
if not p.is_absolute() or p.is_symlink() or not stat.S_ISREG(p.stat().st_mode) or not os.access(p,os.X_OK):
 raise ValueError('Qualification Node path must be an absolute regular executable')
PY
aster_base=$(realpath "$1")
test -f "$aster_base/bundle/release.json"
test -d "$aster_base/test-signing-keys"
test ! -e "$aster_base/installed"
test ! -e "$aster_base/restored"
aster_cli="$aster_base/asterctl"
aster_trust="$aster_base/test-signing-keys/root.json"
aster_trust_sha=$(cat "$aster_base/test-signing-keys/root.sha256")
mkdir "$aster_base/private" "$aster_base/proof"

aster_cleanup() {
  aster_cleanup_result=0
  for aster_target in "$aster_base/installed" "$aster_base/restored"; do
    if test -f "$aster_target/installation.json" || test -f "$aster_target/journal.json"; then
      "$aster_cli" stop --root "$aster_target" >/dev/null 2>&1 || aster_cleanup_result=1
    fi
  done
  # Credentials never enter artifacts; retain only the metadata-only proof.
  rm -rf "$aster_base/private"
  return "$aster_cleanup_result"
}
trap 'aster_result=$?; aster_cleanup || aster_result=1; exit "$aster_result"' EXIT
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
"$aster_node" operations/appliance/scripts/qualify-api.mjs initial "$aster_base/installed" \
  "$aster_base/private/api-state.json" "$aster_base/proof/initial-api.json"
"$aster_cli" doctor --root "$aster_base/installed" > "$aster_base/proof/doctor-initial.txt"

# Cold container restart from retained data/model/TLS; no builds or pulls.
"$aster_cli" stop --root "$aster_base/installed"
"$aster_cli" resume --root "$aster_base/installed"
"$aster_cli" doctor --root "$aster_base/installed" > "$aster_base/proof/doctor-restart.txt"
"$aster_node" operations/appliance/scripts/qualify-api.mjs restart "$aster_base/installed" \
  "$aster_base/private/api-state.json" "$aster_base/proof/restart-api.json"

# A sealed backup coordinates accepted state, pending review, original files and
# mutable CA/model state. The controller supplies its own drain/stop/resume barrier.
"$aster_cli" backup --root "$aster_base/installed" --output "$aster_base/recovery.age" --timeout 60m
aster_backup_sha=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha256"])' "$aster_base/recovery.age.receipt.json")
# Actual original writer fleet is stopped before explicit fencing acknowledgement.
"$aster_cli" stop --root "$aster_base/installed"
"$aster_cli" restore --root "$aster_base/restored" --input "$aster_base/recovery.age" \
  --identity "$aster_base/private/recovery.agekey" --backup-sha256 "$aster_backup_sha" \
  --trust-root "$aster_trust" --trust-root-sha256 "$aster_trust_sha" --source-fenced \
  --max-restore-gib 32 --timeout 60m
"$aster_cli" doctor --root "$aster_base/restored" > "$aster_base/proof/doctor-restored.txt"
"$aster_node" operations/appliance/scripts/qualify-api.mjs restored "$aster_base/restored" \
  "$aster_base/private/api-state.json" "$aster_base/proof/restored-api.json"
"$aster_cli" status --root "$aster_base/restored" > "$aster_base/proof/restored-status.json"
python3 operations/appliance/scripts/qualify-updates.py --base "$aster_base"
python3 - "$aster_base" <<'PY'
import datetime,json,sys
from pathlib import Path
p=Path(sys.argv[1]);proofs=[json.loads((p/'proof'/name).read_text()) for name in ('initial-api.json','restart-api.json','restored-api.json','update-interruption.json')]
receipt={'schemaVersion':1,'result':'passed-bounded-installation-recovery-drill',
 'distributionReady':False,
 'releaseId':json.loads((p/'bundle/release.json').read_text())['releaseId'],
 'topology':'Second private installation directory on one disposable Linux host; original fleet stopped before restore',
 'checks':proofs,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'notYetQualified':['Empty host with every runtime/image/package cache absent and physical network disconnected',
 'Independent spare-host failure-domain recovery and measured RPO/RTO','Source retention purge followed by archive recovery',
 'Physical power loss, interruption inside a migration and remaining update boundaries','Full32GiB workload capacity/latency',
 'Supplied customer PKI rotation and generalized VM first boot','Complete host IPv4/IPv6/DNS/metadata egress capture','Automatic high availability',
 'Corresponding-source closure for OS packages and runtime-service images; final binary distribution review']}
(p/'qualification.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'result':receipt['result'],'releaseId':receipt['releaseId'],'remainingGates':receipt['notYetQualified']}))
PY
