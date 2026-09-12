#!/usr/bin/env python3
"""Resolve candidate official image tags to exact linux/amd64 digests for review.

This is an explicit connected release-engineering step, never an installation
step. Commit/review the output lock and security evidence before distributing it.
"""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request


def resolve(repository, tag):
    token_url = 'https://auth.docker.io/token?' + urllib.parse.urlencode({
        'service': 'registry.docker.io', 'scope': f'repository:{repository}:pull'})
    with urllib.request.urlopen(token_url, timeout=30) as response:
        token = json.load(response)['token']
    req = urllib.request.Request(f'https://registry-1.docker.io/v2/{repository}/manifests/{tag}', headers={
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
    with urllib.request.urlopen(req, timeout=30) as response:
        raw = response.read()
        body = json.loads(raw)
    if 'manifests' in body:
        candidates = [m for m in body['manifests'] if m.get('platform', {}).get('os') == 'linux'
                      and m.get('platform', {}).get('architecture') == 'amd64'
                      and not m.get('platform', {}).get('variant')]
        if len(candidates) != 1:
            raise ValueError('Require exactly one amd64 manifest')
        digest = candidates[0]['digest']
    else:
        digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
    name = repository.removeprefix('library/')
    return f'{name}:{tag}@{digest}'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Refusing to replace a reviewed lock')
    bases = {key: resolve(repo, tag) for key, repo, tag in [
        ('node', 'library/node', '24-trixie-slim'), ('postgres', 'library/postgres', '17-bookworm'),
        ('ollama', 'ollama/ollama', '0.33.3'), ('caddy', 'library/caddy', '2-alpine')]}
    bases.update({
        'nodeRuntime': 'gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79',
        'processorBuild': 'python:3.12.13-slim-trixie@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36',
        'processorRuntime': 'gcr.io/distroless/cc-debian13:nonroot@sha256:c31ff9abcb1910f3ab25c7957bdaf0bfe12a01eb546e8df2282f1c8f682b606c'})
    args.output.write_text(json.dumps({'schemaVersion': 1, 'releaseId': args.release_id,
        'platform': 'linux/amd64', 'bases': bases, 'runtimeBase': resolve('library/ubuntu', '24.04')}, indent=2) + '\n')


if __name__ == '__main__':
    main()
