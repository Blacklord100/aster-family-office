#!/usr/bin/env bash
# Restores a trusted backup into a NEW database; never switches/overwrites production.
# Run from operations/. Failed restore leaves target for diagnosis, never auto-drops it.
set -euo pipefail
test "$#" -eq 3 || { echo "Usage: $0 ENCRYPTED_BACKUP AGE_IDENTITY_FILE NEW_DATABASE" >&2; exit 1; }
command -v docker >/dev/null
command -v age >/dev/null
test -r "$1"
test -r "$2"
[[ "$3" =~ ^aster_restore_[a-z0-9_]+$ ]] || { echo "Use a new aster_restore_ database name." >&2; exit 1; }
# Keep a failed or in-progress restore closed to non-superusers, even before
# database ACLs can be applied. Authentication metadata exists in the dump.
docker compose exec -T postgres createdb --username=postgres --template=template0 --owner=aster_migrator --connection-limit=0 "$3"
docker compose exec -T postgres psql -X --username=postgres --dbname="$3" \
  --set=ON_ERROR_STOP=1 --set=restore_db="$3" <<'SQL'
REVOKE ALL ON DATABASE :"restore_db" FROM PUBLIC;
SQL
age --decrypt --identity "$2" "$1" \
  | docker compose exec -T postgres pg_restore --username=postgres --dbname="$3" \
      --role=aster_migrator --no-owner --exit-on-error --single-transaction
docker compose exec -T postgres psql -X --username=postgres --dbname="$3" \
  --set=ON_ERROR_STOP=1 --set=restore_db="$3" <<'SQL'
REVOKE ALL ON DATABASE :"restore_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"restore_db" TO aster_migrator, aster_runtime;
ALTER DATABASE :"restore_db" CONNECTION LIMIT -1;
SQL
echo "Restored into $3. Verify RLS, counts, document decryption and account recovery before cutover."
