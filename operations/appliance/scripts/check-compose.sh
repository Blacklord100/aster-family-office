#!/bin/sh
# No containers are started. All paths and secret files are disposable/synthetic.
set -eu
aster_test=$(mktemp -d)
trap 'rm -rf "$aster_test"' EXIT
export ASTER_DATA_ROOT="$aster_test/data" ASTER_RELEASE_ROOT="$aster_test/release"
export ASTER_PROJECT_NAME=aster-synthetic-config ASTER_RELEASE_ID=synthetic-config
export ASTER_WRITER_GENERATION=1 ASTER_SCHEMA_MIN=16 ASTER_SCHEMA_MAX=16
export ASTER_DOMAIN=aster.synthetic.invalid BETTER_AUTH_URL=https://aster.synthetic.invalid ASTER_TLS_MODE=internal
export ASTER_IMAGE=aster-app:synthetic PROCESSOR_IMAGE=aster-processor:synthetic POSTGRES_IMAGE=aster-postgres:synthetic
export OLLAMA_IMAGE=aster-ollama:synthetic CADDY_IMAGE=aster-caddy:synthetic OLLAMA_MODEL=synthetic:not-pulled
mkdir -p "$ASTER_DATA_ROOT/secrets"
for name in postgres_password migration_password runtime_password better_auth_secret encryption_key encryption_keyring processor_token mailbox_providers mailbox_broker_token smtp_settings; do
  printf 'SYNTHETIC-NOT-USED\n' > "$ASTER_DATA_ROOT/secrets/$name"
done
for mode in offline connected; do
  docker compose --file "operations/appliance/config/compose.$mode.yaml" \
    --profile maintenance --profile mailbox --profile delivery config --quiet
done
