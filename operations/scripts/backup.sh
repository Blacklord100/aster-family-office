#!/usr/bin/env bash
# Run from operations/. Requires Docker Compose and age. No plaintext backup on disk.
set -euo pipefail
umask 077
test "$#" -eq 2 || { echo "Usage: $0 DESTINATION AGE_RECIPIENTS_FILE" >&2; exit 1; }
command -v docker >/dev/null
command -v age >/dev/null
test -r "$2"
mkdir -p "$1"
aster_backup="$1/aster-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
test ! -e "$aster_backup"
trap 'rm -f "$aster_backup.partial"' EXIT
docker compose exec -T postgres pg_dump --username=postgres --dbname=aster --format=custom --no-owner \
  | age --recipients-file "$2" > "$aster_backup.partial"
test -s "$aster_backup.partial"
mv "$aster_backup.partial" "$aster_backup"
echo "Encrypted backup created: $aster_backup"
