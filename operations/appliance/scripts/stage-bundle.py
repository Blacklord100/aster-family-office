#!/usr/bin/env python3
"""Stage a complete, unsigned appliance directory; asterctl signs release.json.

Inputs are explicit immutable artifacts. This script never fetches a dependency,
reaches a model server, runs a release binary, or silently creates missing assets.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def relative(value):
    if not isinstance(value, str) or '\\' in value or ':' in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('Invalid asset path')
    p = PurePosixPath(value)
    if p.is_absolute() or not p.parts or any(x in ('', '.', '..') for x in value.split('/')):
        raise ValueError('Asset path must be canonical and relative')
    return p


def checked_file(root, name, expected_hash=None, expected_size=None):
    p = root
    for part in relative(name).parts:
        p = p / part
        if p.is_symlink():
            raise ValueError(f'Symlinks are not allowed in payload inputs: {name}')
    info = p.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError(f'Expected an independent regular file: {name}')
    if expected_size is not None and info.st_size != expected_size:
        raise ValueError(f'Asset length mismatch: {name}')
    if expected_hash is not None and sha256(p) != expected_hash:
        raise ValueError(f'Asset hash mismatch: {name}')
    return p


def copy_file(source, destination, executable=False):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise ValueError(f'Duplicate payload path: {destination.name}')
    shutil.copyfile(source, destination)
    os.chmod(destination, 0o755 if executable else 0o644)


def copy_tree(source, destination):
    count = 0
    for source_file in sorted(source.rglob('*')):
        if source_file.is_symlink():
            raise ValueError('Payload trees must not include symbolic links')
        if source_file.is_dir():
            continue
        name = source_file.relative_to(source).as_posix()
        checked_file(source, name)
        copy_file(source_file, destination / name, executable=bool(source_file.stat().st_mode & 0o111))
        count += 1
    if not count:
        raise ValueError(f'Required payload directory is empty: {source.name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True, type=Path)
    parser.add_argument('--images', required=True, type=Path)
    parser.add_argument('--runtime', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--compliance', required=True, type=Path,
                        help='Reviewed licenses/ and sbom/ directories, including security-gate.json')
    parser.add_argument('--asterctl', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text())
    if spec.get('schemaVersion') != 1 or spec.get('platform') != {'os': 'linux', 'arch': 'amd64'}:
        raise ValueError('Require schemaVersion1 and linux/amd64')
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,79}', spec.get('releaseId', '')):
        raise ValueError('Invalid release ID')
    if spec.get('channel') not in ('stable', 'preview') or not isinstance(spec.get('sequence'), int) or spec['sequence'] < 1:
        raise ValueError('Invalid release channel or sequence')
    schema = spec['schema']
    if not all(isinstance(schema.get(k), int) for k in ('min', 'max', 'target')) or not (1 <= schema['min'] <= schema['target'] <= schema['max']):
        raise ValueError('Invalid schema compatibility range')
    image_inventory = json.loads((args.images / 'inventory.json').read_text())
    if image_inventory['releaseId'] != spec['releaseId'] or image_inventory['platform'] != 'linux/amd64':
        raise ValueError('Image set belongs to another release or platform')
    if {i['service'] for i in image_inventory['images']} != {'app', 'processor', 'postgres', 'ollama', 'caddy'} or len(image_inventory['images']) != 5:
        raise ValueError('The complete five-image set is required')
    runtime = json.loads((args.runtime / 'inventory.json').read_text())
    if any(runtime.get(k) != v for k, v in {'kind': 'ubuntu-deb', 'os': 'ubuntu', 'version': '24.04', 'arch': 'amd64'}.items()):
        raise ValueError('Incorrect runtime target')
    if not {'docker.io', 'docker-compose-v2', 'containerd', 'runc', 'iptables', 'openssl'}.issubset({p['name'] for p in runtime['packages']}):
        raise ValueError('Incomplete runtime package inventory')
    model = json.loads((args.model / 'inventory.json').read_text())
    if model.get('format') != 'ollama-cache-v2' or not re.fullmatch(r'sha256:[0-9a-f]{64}', model['digest']):
        raise ValueError('Expected a digest-pinned complete native Ollama cache')
    required_layers = {'manifest', 'application/vnd.ollama.image.model', 'application/vnd.ollama.image.projector', 'application/vnd.ollama.image.license'}
    if not required_layers.issubset({item['kind'] for item in model['files']}):
        raise ValueError('Missing model manifest, weights, projector or license')
    module_spec = importlib.util.spec_from_file_location('model_export', Path(__file__).with_name('export-model.py'))
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    inspected = module.inspect_model(args.model / 'ollama', model['name'])
    if inspected['digest'] != model['digest'] or inspected['files'] != model['files']:
        raise ValueError('Model inventory omits or changes an original manifest layer')
    gate = json.loads((args.compliance / 'sbom/security-gate.json').read_text())
    if gate.get('result') != 'passed' or gate.get('releaseId') != spec['releaseId']:
        raise ValueError('A passing security receipt for this exact release is required')
    expected_ids = {i['service']: i['imageId'] for i in image_inventory['images']}
    if gate.get('imageIds') != expected_ids:
        raise ValueError('Security receipt does not cover the exact five image IDs')
    # Validate the entire input before creating any output.
    for item in image_inventory['images']:
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', item['imageId']):
            raise ValueError('Invalid image ID')
        checked_file(args.images, item['path'], item['sha256'], item['size'])
    for item in runtime['packages']:
        checked_file(args.runtime, item['path'], item['sha256'], item['size'])
    for item in model['files']:
        checked_file(args.model / 'ollama', item['path'], item['sha256'], item['size'])
    checked_file(args.model, 'Modelfile')
    checked_file(args.asterctl.parent, args.asterctl.name)
    # ELF class64, little-endian, EM_X86_64. A macOS helper is not a Linux installer.
    header = args.asterctl.read_bytes()[:20]
    if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\x3e\x00':
        raise ValueError('asterctl must be a Linux amd64 executable')
    if args.output.exists():
        raise ValueError('Refusing an existing bundle directory')
    args.output.mkdir(parents=True)
    payload = args.output / 'payload'
    copy_tree(args.source / 'operations/appliance/config', payload / 'config')
    for source, target in [('operations/postgres/10-roles.sh', 'postgres/10-roles.sh'),
                           ('operations/scripts/processor-entrypoint.py', 'scripts/processor-entrypoint.py')]:
        copy_file(args.source / source, payload / 'config' / target)
    copy_file(args.asterctl, payload / 'bin/asterctl', executable=True)
    copy_tree(args.compliance / 'licenses', payload / 'licenses')
    for name in ('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'):
        copy_file(args.source / name, payload / 'licenses/project' / name)
    copy_tree(args.source / 'licenses', payload / 'licenses/project/third-party')
    copy_tree(args.compliance / 'sbom', payload / 'sbom')
    for name, root in [('images', args.images), ('runtime', args.runtime), ('models', args.model)]:
        copy_file(root / 'inventory.json', payload / name / 'inventory.json')
    images = []
    for item in image_inventory['images']:
        target = 'payload/images/' + item['path']
        copy_file(args.images / item['path'], args.output / target)
        images.append({k: (target if k == 'path' else item[k]) for k in ('service', 'path', 'reference', 'imageId')})
    packages = []
    for item in runtime['packages']:
        target = 'payload/runtime/' + item['path']
        copy_file(args.runtime / item['path'], args.output / target)
        packages.append({k: (target if k == 'path' else item[k]) for k in ('name', 'version', 'architecture', 'path', 'sha256')})
    model_files = []
    for item in model['files']:
        target = 'payload/models/ollama/' + item['path']
        copy_file(args.model / 'ollama' / item['path'], args.output / target)
        model_files.append(target)
    copy_file(args.model / 'Modelfile', payload / 'models/Modelfile')
    copy_tree(args.source / 'operations/appliance/vm', payload / 'vm')
    copy_file(args.source / 'operations/appliance/README.md', payload / 'docs/README.md')
    copy_file(args.source / 'operations/appliance/cli/README.md', payload / 'docs/operator-cli.md')
    copy_file(args.source / 'operations/appliance/recovery.md', payload / 'docs/recovery.md')
    files = []
    for item in sorted(payload.rglob('*')):
        if item.is_file():
            files.append({'path': item.relative_to(args.output).as_posix(), 'sha256': sha256(item),
                          'size': item.stat().st_size, 'mode': stat.S_IMODE(item.stat().st_mode)})
    manifest = {k: spec[k] for k in ('schemaVersion', 'releaseId', 'productVersion', 'sequence', 'channel', 'platform', 'schema')}
    manifest.update({'createdAt': spec.get('createdAt', datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')),
                     'files': files, 'images': images,
                     'model': {'name': model['name'], 'digest': model['digest'], 'files': model_files, 'modelfile': 'payload/models/Modelfile'},
                     'compose': {'offline': 'payload/config/compose.offline.yaml', 'connected': 'payload/config/compose.connected.yaml'},
                     'runtime': {k: runtime[k] for k in ('kind', 'os', 'version', 'arch')}})
    manifest['runtime']['packages'] = packages
    (args.output / 'release.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'releaseId': spec['releaseId'], 'files': len(files), 'bytes': sum(f['size'] for f in files),
                      'status': 'unsigned; sign with separately held publisher trust before distribution'}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(f'Bundle staging refused: {error}')
