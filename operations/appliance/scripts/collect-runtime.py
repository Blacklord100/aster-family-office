#!/usr/bin/env python3
"""Collect the signed Ubuntu 24.04 runtime dependency closure in a disposable container.

This connected build step installs nothing on the build host. Ubuntu's signed APT
indexes authenticate the packages. Preserve inventory.json and every .deb as the
exact runtime lock; installing the bundle later requires no repository access.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

SCRIPT = r'''
set -eu
test "$(dpkg --print-architecture)" = amd64
test "$(. /etc/os-release; printf '%s:%s' "$ID" "$VERSION_ID")" = ubuntu:24.04
apt-get update
# An empty dpkg status forces downloading the complete transitive dependency
# closure, even packages already present in the builder's Ubuntu base image.
apt-get -y --download-only --no-install-recommends \
  -o Dir::State::status=/dev/null -o Dir::Cache::archives=/out \
  install "$@"
for file in /out/*.deb; do
  dpkg-deb --show --showformat='${Package}\t${Version}\t${Architecture}\n' "$file" | \
    awk -v file="${file##*/}" '{ print file "\t" $0 }' >> /out/packages.tsv
done
chmod 644 /out/*.deb /out/packages.tsv
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, help='ubuntu:24.04@sha256:...')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--package', action='append', help='Explicit name=version; repeat for all root packages')
    args = parser.parse_args()
    if not re.fullmatch(r'ubuntu:24\.04@sha256:[0-9a-f]{64}', args.base):
        raise ValueError('Require the reviewed Ubuntu 24.04 base digest')
    roots = args.package or ['docker.io', 'docker-compose-v2', 'iptables', 'openssl', 'ca-certificates']
    if any(not re.fullmatch(r'[a-z0-9][a-z0-9.+-]*(=[a-zA-Z0-9:.+~_-]+)?', p) for p in roots):
        raise ValueError('Invalid package request')
    if args.output.exists():
        raise ValueError('Refusing an existing output directory')
    args.output.mkdir(parents=True)
    subprocess.run(['docker', 'run', '--rm', '--platform', 'linux/amd64',
                    '--mount', f'type=bind,src={args.output.resolve()},dst=/out',
                    args.base, 'sh', '-c', SCRIPT, 'runtime-collector', *roots], check=True)
    packages = []
    for line in (args.output / 'packages.tsv').read_text().splitlines():
        filename, name, version, architecture = line.split('\t')
        if architecture not in ('amd64', 'all') or Path(filename).name != filename:
            raise ValueError('Unexpected runtime package platform or path')
        file = args.output / filename
        with file.open('rb') as stream:
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        packages.append({'name': name, 'version': version, 'architecture': architecture,
                         'path': filename, 'sha256': sha, 'size': file.stat().st_size})
    names = {p['name'] for p in packages}
    if not {'docker.io', 'docker-compose-v2', 'containerd', 'runc', 'iptables', 'openssl'}.issubset(names):
        raise ValueError('Incomplete container runtime dependency closure')
    inventory = {'kind': 'ubuntu-deb', 'os': 'ubuntu', 'version': '24.04', 'arch': 'amd64',
                 'baseImage': args.base, 'rootRequests': roots,
                 'packages': sorted(packages, key=lambda p: p['name']),
                 'provenance': 'Ubuntu signed APT indexes; complete empty-status dependency closure'}
    (args.output / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
    print(json.dumps({'packages': len(packages), 'bytes': sum(p['size'] for p in packages)}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f'Runtime collection refused: {error}')
