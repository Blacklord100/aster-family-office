#!/usr/bin/env bash
# Run from operations/. Requires Docker Compose and age. No plaintext backup on disk.
set -euo pipefail
umask 077
test "$#" -ge 2 && test "$#" -le 3 || { echo "Usage: $0 DESTINATION AGE_RECIPIENTS_FILE [RECEIPT_FILE]" >&2; exit 1; }
command -v docker >/dev/null
command -v age >/dev/null
command -v openssl >/dev/null
test -r "$2"
mkdir -p "$1"
aster_lock="$1/.backup.lock"
mkdir "$aster_lock" || { echo "Another backup is active or its lock requires operator review." >&2; exit 1; }
aster_backup="$1/aster-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
trap 'rm -f "$aster_backup.partial"; if test -n "${aster_receipt_partial:-}"; then rm -f "$aster_receipt_partial"; fi; rmdir "$aster_lock"' EXIT
test ! -e "$aster_backup"
aster_receipt="${3:-./receipts/backup.json}"
aster_receipt_dir="$(dirname "$aster_receipt")"
# Receipt metadata is mounted read-only into the UID1000 web container.
# Do not broaden an existing private directory: require a dedicated readable path.
(umask 022; mkdir -p "$aster_receipt_dir")
aster_receipt_mode="$(stat -c '%a' "$aster_receipt_dir" 2>/dev/null || stat -f '%Lp' "$aster_receipt_dir")"
if (( (8#$aster_receipt_mode & 0001) == 0 )); then
  echo "Receipt directory must permit container traversal. Provision a dedicated metadata directory with mode 0755; private backups and keys remain separate." >&2
  exit 1
fi
aster_receipt_partial="$(mktemp "$aster_receipt.partial.XXXXXXXX")"
docker compose exec -T postgres pg_dump --username=postgres --dbname=aster --format=custom --no-owner \
  | age --recipients-file "$2" > "$aster_backup.partial"
test -s "$aster_backup.partial"
mv "$aster_backup.partial" "$aster_backup"
aster_checksum="$(openssl dgst -sha256 -r "$aster_backup" | cut -d ' ' -f 1)"
aster_replica=not_configured
if test -n "${ASTER_BACKUP_REPLICA_DIR:-}"; then
  test -d "$ASTER_BACKUP_REPLICA_DIR"
  aster_replica_file="$ASTER_BACKUP_REPLICA_DIR/$(basename "$aster_backup")"
  test ! -e "$aster_replica_file"
  test ! -e "$aster_replica_file.partial"
  cp "$aster_backup" "$aster_replica_file.partial"
  test "$(openssl dgst -sha256 -r "$aster_replica_file.partial" | cut -d ' ' -f 1)" = "$aster_checksum"
  mv "$aster_replica_file.partial" "$aster_replica_file"
  aster_replica=verified
fi
printf '{"result":"passed","kind":"encrypted_backup","at":"%s","sha256":"%s","replica":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$aster_checksum" "$aster_replica" > "$aster_receipt_partial"
chmod 0444 "$aster_receipt_partial"
mv "$aster_receipt_partial" "$aster_receipt"
echo "Encrypted backup and receipt created. Replica: $aster_replica"
