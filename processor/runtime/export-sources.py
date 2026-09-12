"""Export only reviewed custom OCR/Pillow build inputs; never fetch or extract.

The bulky export is a separate Docker target. The service image retains only its
digest marker, so an independent exact-image check can authenticate that export.
This does not cover distro packages, CPython, other wheels or supporting codecs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat

TYPE = 'aster-processor-custom-sources-v1'
MARKER = 'opt/aster/custom-source-manifest.sha256'
RUNTIME_MANIFEST = 'opt/aster/runtime-manifest.json'
MAX_FILE = 128 * 1024**2
MAX_TOTAL = 512 * 1024**2
MAX_FILES = 2048
RECIPE_TOP = ('Dockerfile', '.dockerignore', 'requirements.lock.txt')
RECIPE_RUNTIME = ('upstream-sources.json', 'security-policy.json', 'export-sources.py',
                  'assemble.py', 'fetch-sources.py', 'apply-security-backports.py',
                  'check-native-build.py', 'qualify-security-build.py', 'security-regression.cc',
                  'verify-security-runtime.py', 'verify-scan.py', 'security-assessment.py')
BUILD_EVIDENCE = ('native-build.json', 'security-build.json', 'security-backports.json',
                  'tiff-build/CMakeCache.txt', 'tesseract-build/CMakeCache.txt')


def relative(value):
    if (not isinstance(value, str) or not value or len(value) > 512 or '\\' in value
            or any(ord(c) < 32 for c in value) or PurePosixPath(value).is_absolute()
            or any(p in ('', '.', '..') for p in value.split('/'))):
        raise ValueError('Unsafe source evidence path')
    return value


def regular(root, name):
    relative(name)
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Source evidence root must be a regular directory')
    current = root
    for part in name.split('/'):
        current = current / part
        if current.is_symlink():
            raise ValueError('Source evidence symlinks are forbidden')
    info = current.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 <= info.st_size <= MAX_FILE:
        raise ValueError('Source evidence must be a bounded independent regular file')
    return current


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def record(root, name):
    path = regular(root, name)
    return {'path': name, 'sha256': sha(path), 'bytes': path.stat().st_size}


def files(root):
    names, total = [], 0
    if Path(root).is_symlink() or not Path(root).is_dir():
        raise ValueError('Missing regular evidence directory')
    for path in sorted(Path(root).rglob('*')):
        if path.is_symlink():
            raise ValueError('Source evidence symlinks are forbidden')
        if path.is_dir():
            continue
        name = path.relative_to(root).as_posix()
        info = record(root, name)
        total += info['bytes']
        names.append(info)
        if len(names) > MAX_FILES or total > MAX_TOTAL:
            raise ValueError('Source evidence exceeds its inventory/byte limit')
    return names


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate source evidence JSON key')
            result[key] = value
        return result
    if path.stat().st_size > 4 * 1024**2:
        raise ValueError('Source evidence JSON is too large')
    return json.loads(path.read_text(), object_pairs_hook=unique)


def recipe_files(root):
    result = [record(root, name) for name in RECIPE_TOP]
    runtime = Path(root) / 'runtime'
    for name in RECIPE_RUNTIME:
        regular(runtime, name)
    for path in sorted(runtime.iterdir()):
        if path.name == 'source-provenance':
            result += [{**item, 'path': 'runtime/source-provenance/' + item['path']}
                       for item in files(path)]
        elif path.name.endswith(('.py', '.cc', '.sha256')) or path.name in ('upstream-sources.json', 'security-policy.json'):
            result.append(record(root, 'runtime/' + path.name))
    return sorted(result, key=lambda item: item['path'])


def source_records(lock):
    result = []
    for name in ('tesseract', 'libtiff', 'pillow'):
        result.append({'component': name, 'kind': 'original-source', **lock[name]})
    result += [{'component': 'pillow-build', 'kind': 'build-dependency', **item}
               for item in lock['buildDependencies']]
    seen = set()
    for item in result:
        name = item['filename']
        if (not re.fullmatch(r'[A-Za-z0-9_.-]{1,160}', name) or name in seen
                or not re.fullmatch(r'[0-9a-f]{64}', item['sha256'])):
            raise ValueError('Invalid or duplicated locked source archive')
        seen.add(name)
    return result


def runtime_file(root, name):
    """Resolve only confined image paths, including absolute in-image symlinks."""
    parts = list(PurePosixPath(relative(name)).parts)
    resolved, hops = [], 0
    while parts:
        part = parts.pop(0)
        if part == '..':
            if not resolved:
                raise ValueError('Runtime symlink escapes its image')
            resolved.pop()
            continue
        if part == '.':
            continue
        path = Path(root).joinpath(*resolved, part)
        if path.is_symlink():
            hops += 1
            if hops > 20:
                raise ValueError('Runtime symlink loop')
            target = PurePosixPath(os.readlink(path))
            if target.is_absolute():
                resolved = []
                parts = list(target.parts[1:]) + parts
            else:
                parts = list(target.parts) + parts
        else:
            resolved.append(part)
    return regular(root, '/'.join(resolved))


def installed_files(root, manifest):
    expected = manifest['securityBuild']['nativeFiles']
    required = {'/opt/tesseract/bin/tesseract', '/opt/tesseract/lib/libtesseract.so.5.5',
                '/opt/libtiff/lib/libtiff.so.6'}
    if set(expected) != required:
        raise ValueError('Unexpected qualified custom native file coverage')
    names = {name.lstrip('/') for name in required}
    pillow = Path(root) / 'usr/local/lib/python3.12/site-packages/PIL'
    pillow_files = files(pillow)
    if not any(item['path'].startswith('_imaging.') and item['path'].endswith('.so') for item in pillow_files):
        raise ValueError('Pillow native image extension is missing')
    names.update('usr/local/lib/python3.12/site-packages/PIL/' + item['path'] for item in pillow_files)
    result = []
    for name in sorted(names):
        path = runtime_file(root, name)
        digest = sha(path)
        if '/' + name in expected and digest != expected['/' + name]:
            raise ValueError('Runtime differs from qualified native build')
        result.append({'path': '/' + name, 'sha256': digest, 'bytes': path.stat().st_size})
    return result


def export(build, runtime, recipe, output, package_status):
    if output.exists() or output.is_symlink():
        raise ValueError('Refusing an existing source export')
    lock = read_json(regular(recipe, 'runtime/upstream-sources.json'))
    if regular(build, 'upstream-sources.json').read_bytes() != regular(recipe, 'runtime/upstream-sources.json').read_bytes():
        raise ValueError('Builder source lock differs from retained recipe')
    inputs = []
    for item in source_records(lock):
        source = regular(build / 'sources', item['filename'])
        if sha(source) != item['sha256']:
            raise ValueError('Original source or build wheel differs from reviewed checksum')
        inputs.append((source, 'archives/' + item['filename']))
    for item in lock['provenanceFiles'] + lock['securityBackports']:
        path = regular(recipe, 'runtime/source-provenance/' + item['filename'])
        if sha(path) != item['sha256'] or path.read_bytes() != regular(build / 'source-provenance', item['filename']).read_bytes():
            raise ValueError('Authentication material or backport differs from reviewed checksum')
    inputs += [(regular(recipe, item['path']), 'recipe/' + item['path']) for item in recipe_files(recipe)]
    inputs += [(regular(build, name), 'build/' + name) for name in BUILD_EVIDENCE]
    inputs += [(regular(package_status.parent, package_status.name), 'build/dpkg-status'),
               (regular(runtime, RUNTIME_MANIFEST), 'build/runtime-manifest.json')]
    runtime_manifest = read_json(regular(runtime, RUNTIME_MANIFEST))
    if runtime_manifest['securityBuild'] != read_json(regular(build, 'security-build.json')):
        raise ValueError('Runtime security evidence differs from retained build')
    identities = installed_files(runtime, runtime_manifest)
    if sum(path.stat().st_size for path, _ in inputs) > MAX_TOTAL or len(inputs) > MAX_FILES:
        raise ValueError('Source export exceeds its byte/file limit')
    output.mkdir(parents=True)
    for source, name in inputs:
        before = sha(source), source.stat().st_size
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o644)
        if (sha(target), target.stat().st_size) != before:
            raise ValueError('Source material changed during export')
    manifest = {'schemaVersion': 1, 'type': TYPE, 'scope': ['tesseract', 'libtiff', 'pillow'],
                'sources': source_records(lock), 'installedFiles': identities,
                'runtimeManifestSha256': sha(regular(runtime, RUNTIME_MANIFEST)), 'files': files(output),
                'limits': {'otherDistroPackages': False, 'otherWheels': False, 'reproducibleBuild': False}}
    (output / 'source-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    marker = Path(runtime) / MARKER
    marker.write_text(sha(output / 'source-manifest.json') + '\n')
    marker.chmod(0o644)
    return manifest


def attest(root, source_manifest):
    manifest = read_json(source_manifest)
    digest = sha(source_manifest)
    if (manifest.get('schemaVersion') != 1 or manifest.get('type') != TYPE
            or regular(root, MARKER).read_text().strip() != digest):
        raise ValueError('Source export is not bound to this processor image')
    runtime_path = regular(root, RUNTIME_MANIFEST)
    if sha(runtime_path) != manifest['runtimeManifestSha256']:
        raise ValueError('Source export runtime manifest differs from exact image')
    actual = installed_files(root, read_json(runtime_path))
    if actual != manifest['installedFiles']:
        raise ValueError('Installed custom processor files differ from source export')
    return {'schemaVersion': 1, 'type': TYPE + '-attestation', 'sourceManifestSha256': digest,
            'runtimeManifestSha256': sha(runtime_path), 'installedFiles': actual, 'result': 'verified'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    build = sub.add_parser('export')
    build.add_argument('--build-root', type=Path, default=Path('/build'))
    build.add_argument('--runtime-root', type=Path, default=Path('/runtime'))
    build.add_argument('--recipe-root', type=Path, default=Path('/build/recipe'))
    build.add_argument('--output', type=Path, default=Path('/source-evidence'))
    build.add_argument('--package-status', type=Path, default=Path('/var/lib/dpkg/status'))
    verify = sub.add_parser('attest')
    verify.add_argument('--runtime-root', type=Path, default=Path('/'))
    verify.add_argument('--manifest', type=Path, required=True)
    args = parser.parse_args()
    result = (export(args.build_root, args.runtime_root, args.recipe_root, args.output, args.package_status)
              if args.command == 'export' else attest(args.runtime_root, args.manifest))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
