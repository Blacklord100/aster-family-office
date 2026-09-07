#!/bin/sh
set -eu
test -n "${PROCESSOR_TOKEN_FILE:-}" || { echo "PROCESSOR_TOKEN_FILE is required" >&2; exit 1; }
PROCESSOR_TOKEN="$(cat "$PROCESSOR_TOKEN_FILE")"
test "${#PROCESSOR_TOKEN}" -ge 32 || { echo "Processor token must have at least 32 characters" >&2; exit 1; }
export PROCESSOR_TOKEN
unset PROCESSOR_TOKEN_FILE
test "$#" -gt 0 || { echo "Processor command is missing" >&2; exit 1; }
exec "$@"
