#!/bin/sh
# Run from the hypervisor console after assigning customer network/storage policy.
set -eu
umask 077
test "$(id -u)" = 0 || { echo 'Run from the root console.' >&2; exit 1; }
if test -e /var/lib/aster/installation.json; then
  echo 'An installation already exists; use asterctl status/update.' >&2
  exit 1
fi
printf 'Internal DNS hostname (no URL): '
IFS= read -r aster_hostname
printf 'Customer age recovery recipient (public age1... key): '
IFS= read -r aster_recipient
case "$aster_hostname" in ''|*[!a-zA-Z0-9.-]*) echo 'Invalid hostname.' >&2; exit 1;; esac
case "$aster_recipient" in age1*) ;; *) echo 'Invalid recovery recipient.' >&2; exit 1;; esac
aster_root_hash=$(cat /etc/aster/trusted-root.sha256)
exec /usr/local/bin/asterctl install \
  --bundle /opt/aster/media --root /var/lib/aster \
  --trust-root /etc/aster/trusted-root.json --trust-root-sha256 "$aster_root_hash" \
  --hostname "$aster_hostname" --profile offline --tls-mode internal \
  --recovery-recipient "$aster_recipient" --install-runtime
