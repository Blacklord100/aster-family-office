#!/usr/bin/env python3
"""Export an existing Ollama model without pulling, modifying, or invoking it.

The original manifest and every referenced layer are included. This intentionally
preserves multimodal projectors, parameters, configuration and license assets.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def inspect_model(root, name):
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*', name):
        raise ValueError('Use an explicit local library model:tag, without a URL or path')
    family, tag = name.split(':')
    manifest_path = Path('manifests/registry.ollama.ai/library') / family / tag
    source = root / manifest_path
    if source.is_symlink() or not source.is_file():
        raise ValueError('Expected a retained regular Ollama manifest')
    manifest = json.loads(source.read_text())
    if manifest.get('schemaVersion') != 2:
        raise ValueError('Unsupported Ollama manifest schema')
    files = [{'path': str(manifest_path), 'sha256': digest(source),
              'size': source.stat().st_size, 'kind': 'manifest'}]
    media_types = []
    for layer in [manifest['config'], *manifest['layers']]:
        layer_digest = layer['digest']
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', layer_digest):
            raise ValueError('Unsupported layer digest')
        path = Path('blobs') / layer_digest.replace(':', '-')
        target = root / path
        if target.is_symlink() or not target.is_file():
            raise ValueError(f'Missing regular model asset: {path}')
        if target.stat().st_size != layer['size'] or digest(target) != layer_digest[7:]:
            raise ValueError(f'Model asset hash/length mismatch: {path}')
        media_types.append(layer['mediaType'])
        files.append({'path': str(path), 'sha256': layer_digest[7:],
                      'size': layer['size'], 'kind': layer['mediaType']})
    required = {'application/vnd.ollama.image.model', 'application/vnd.ollama.image.projector',
                'application/vnd.ollama.image.license'}
    if not required.issubset(media_types):
        raise ValueError('Gemma appliance requires weights, vision projector and exact license')
    return {'version': 1, 'name': name, 'digest': 'sha256:' + files[0]['sha256'],
            'format': 'ollama-cache-v2', 'files': files,
            'totalBytes': sum(f['size'] for f in files),
            'source': 'Existing operator-approved Ollama cache; all files hash verified'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--name', default='gemma4:e4b-it-qat')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--inspect-only', action='store_true')
    args = parser.parse_args()
    inventory = inspect_model(args.source.resolve(), args.name)
    if args.inspect_only:
        print(json.dumps(inventory, indent=2))
        return
    if args.output is None or args.output.exists():
        raise ValueError('Choose a new --output directory (never overwrites a model)')
    free = shutil.disk_usage(args.output.parent.resolve()).free
    if free < inventory['totalBytes'] + 10 * 1024**3:
        raise ValueError('Insufficient disk: preserve 10 GiB after the complete model copy')
    args.output.mkdir(mode=0o755)
    for item in inventory['files']:
        destination = args.output / 'ollama' / item['path']
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.source / item['path'], destination)
        os.chmod(destination, 0o644)
        if digest(destination) != item['sha256']:
            raise ValueError('Copied model failed verification')
    # Informational only: the installer copies the verified native cache, not this
    # lossy Modelfile representation. The original template/parameters remain intact.
    (args.output / 'Modelfile').write_text(f'# Native cache import; never ollama pull\nFROM {args.name}\n')
    (args.output / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
    print(json.dumps({'name': inventory['name'], 'digest': inventory['digest'],
                      'totalBytes': inventory['totalBytes'], 'fileCount': len(inventory['files'])}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(f'Model export refused: {error}')
