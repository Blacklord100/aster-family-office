#!/bin/sh
# Disposable Packer image only. Refuse to sanitize an initialized Aster system.
set -eu
test "$(id -u)" = 0
test -f /opt/aster/media/release.json
test ! -e /var/lib/aster
test "$(hostname)" = aster-build
# The cloud-image contains no application database, model cache, encryption key,
# private CA, administrator or login password. Do not call install in the builder.
systemctl disable apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
systemctl disable systemd-timesyncd.service 2>/dev/null || true
cloud-init clean --logs --machine-id
rm -f /etc/ssh/ssh_host_* /var/lib/systemd/random-seed
rm -f /tmp/asterctl /tmp/aster-root.json /tmp/first-boot.sh
rm -f /home/aster-builder/.ssh/authorized_keys /root/.ssh/authorized_keys
rm -f /home/aster-builder/.bash_history /root/.bash_history
# Keep the account locked and remove its sudo rule before redistribution. The
# builder's live SSH connection may finish, but its key cannot open a new session.
passwd -l aster-builder
# Packer removes the final build sudo rule immediately before shutdown.
printf '\nAster appliance: use the hypervisor console and your own console administrator.\nRun sudo aster-first-boot after configuring LAN, time and storage.\n' > /etc/issue
truncate -s 0 /etc/machine-id
find /var/log -type f -exec truncate -s 0 {} \;
sync
