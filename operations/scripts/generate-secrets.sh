#!/bin/sh
# Never overwrite/rotate keys. Back up encryption_key separately before use.
set -eu
umask 077
aster_secret_dir="${1:-./secrets}"
command -v openssl >/dev/null
if test -e "$aster_secret_dir"; then
  echo "Refusing existing destination. Choose a new secrets directory." >&2
  exit 1
fi
mkdir -m 700 "$aster_secret_dir"
for name in postgres_password migration_password runtime_password better_auth_secret processor_token; do
  openssl rand -hex 32 > "$aster_secret_dir/$name"
done
openssl rand -base64 32 > "$aster_secret_dir/encryption_key"
# Compose file secrets preserve host UID. Host parent remains owner-only 0700;
# file readability lets the explicitly granted container UIDs read their mounts.
# Use a managed secret store with explicit UID grants for stronger deployments.
chmod 0444 "$aster_secret_dir/"*
echo "Created secret files in a private directory. No values printed."
