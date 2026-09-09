#!/usr/bin/env bash
# Password source enters the private container tmpfs through stdin, never argv/env.
set -euo pipefail
test "$#" -eq 4 || { echo "Usage: $0 PASSWORD_FILE EMAIL NAME ORGANIZATION" >&2; exit 1; }
test -f "$1"
test -r "$1"
docker compose run --rm --no-deps -T \
  migrate node /opt/aster/bootstrap-stdin.mjs "$2" "$3" "$4" < "$1"
