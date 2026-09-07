#!/usr/bin/env bash
# Password source enters the private container tmpfs through stdin, never argv/env.
set -euo pipefail
test "$#" -eq 4 || { echo "Usage: $0 PASSWORD_FILE EMAIL NAME ORGANIZATION" >&2; exit 1; }
test -f "$1"
test -r "$1"
docker compose run --rm --no-deps -T \
  -e BOOTSTRAP_PASSWORD_FILE=/tmp/bootstrap-password \
  migrate /bin/sh -eu -c '
    umask 077
    cat > "$BOOTSTRAP_PASSWORD_FILE"
    trap '\''rm -f "$BOOTSTRAP_PASSWORD_FILE"'\'' EXIT
    npm run bootstrap -- --email "$1" --name "$2" --organization "$3"
  ' bootstrap "$2" "$3" "$4" < "$1"
