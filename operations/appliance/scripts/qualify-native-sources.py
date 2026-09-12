"""Qualify the existing sharp source collector on a disposable Linux CI host.

The app container is never started. Only its selected public npm package is
retained. Connected resolution and the kernel-isolated offline verifier are
separate commands; no fallback permits verification in the host namespace.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[3]
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
PYTHON = '/usr/bin/python3'
MAX_EXPORT = 2 * 1024**3
MAX_ARTIFACT = 3 * 1024**3
RESERVE = 4 * 1024**3
IMAGE = re.compile(r'^sha256:[0-9a-f]{64}$')
CONTAINER = re.compile(r'^[0-9a-f]{64}$')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, data):
    with path.open('x') as stream:
        json.dump(data, stream, indent=2, sort_keys=True)
        stream.write('\n')


def collector():
    path = ROOT / 'tools/release/collect-native-sources.py'
    spec = importlib.util.spec_from_file_location('qualified_native_sources', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clean_env():
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}


def command(args, timeout=120):
    result = subprocess.run(args, env=clean_env(), capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Public package/build diagnostics only; never dump host environments.
        raise ValueError(f'Command {Path(args[0]).name} failed ({result.returncode}): '
                         + result.stderr[-8192:] + result.stdout[-4096:])
    if len(result.stdout) > 2 * 1024**2:
        raise ValueError('Command metadata exceeds its output budget')
    return result.stdout


def disk_guard(path, required):
    available = shutil.disk_usage(path).free
    if available < required:
        raise ValueError(f'Insufficient disposable disk: {available} bytes available, {required} required')
    return available


def files_inventory(root, limit=MAX_ARTIFACT, allow_links=False):
    result, total = [], 0
    for path in sorted(root.rglob('*')):
        kind = path.lstat().st_mode
        if stat.S_ISLNK(kind) and allow_links:
            continue  # npm .bin links are never followed or retained.
        if stat.S_ISDIR(kind):
            continue
        if not stat.S_ISREG(kind):
            raise ValueError('Nonregular artifact entry: ' + path.relative_to(root).as_posix())
        size = path.stat().st_size
        total += size
        if total > limit or len(result) >= 100000:
            raise ValueError('Runtime/source artifact exceeds its bounded inventory')
        result.append({'path': path.relative_to(root).as_posix(), 'bytes': size, 'sha256': digest(path)})
    return result, total


def inspect_container(identifier, image_id):
    if not CONTAINER.fullmatch(identifier):
        raise ValueError('Unexpected Docker container identity')
    value = json.loads(command(DOCKER + ['inspect', identifier]))
    if (len(value) != 1 or value[0].get('Id') != identifier or value[0].get('Image') != image_id
            or value[0].get('State', {}).get('Status') != 'created'
            or value[0].get('State', {}).get('Running') is not False
            or value[0].get('HostConfig', {}).get('NetworkMode') != 'none'):
        raise ValueError('Export container identity or inert state changed')
    return {'containerId': identifier, 'imageId': image_id, 'state': 'created', 'network': 'none'}


def retain_unverified_package(native, policy, exported, output):
    """Keep bounded diagnostic bytes even when the independent ELF gate rejects.

    This is deliberately not runtime approval. Only runtime_inventory, the npm
    integrity check, and subsequent offline verification can qualify the bytes.
    """
    lock = native.bounded_json(ROOT / 'package-lock.json')
    candidates = [name for name in lock['packages']
                  if name.rsplit('node_modules/', 1)[-1] == policy['package']['name']
                  and (exported / name).exists()]
    if len(candidates) != 1:
        raise ValueError('Expected one exported native package for bounded diagnostics')
    name = candidates[0]
    package = native.checked_file(exported, name + '/package.json').parent
    inventory, byte_count = files_inventory(package, policy['limits']['perSourceBytes'])
    retained = output / 'runtime-export'
    target = retained / name
    target.parent.mkdir(parents=True)
    shutil.copytree(package, target)
    if files_inventory(target, policy['limits']['perSourceBytes'])[0] != inventory:
        raise ValueError('Exported native diagnostic bytes changed during copy')
    shutil.copyfile(ROOT / 'package-lock.json', output / 'package-lock.json')
    elf = []
    for item in inventory:
        path = package / item['path']
        with path.open('rb') as stream:
            header = stream.read(4)
        if header == b'\x7fELF':
            if len(elf) >= 4:
                raise ValueError('Unexpected additional ELF diagnostics')
            elf.append({'path': item['path'], 'sha256': item['sha256'],
                        'dynamicMetadata': command(['/usr/bin/readelf', '-d', str(path)], timeout=15)})
    return {'status': 'unverified-export-only', 'packagePath': name, 'packageFiles': inventory,
            'packageBytes': byte_count, 'elf': elf, 'nodeLockSha256': digest(output / 'package-lock.json')}


def retain_system_diagnostics(container, output):
    """Observe the separate distro dependency without claiming its source closure."""
    directory = output / 'system-dependencies'
    directory.mkdir()
    results = []
    for source, name in (('/var/lib/dpkg/status.d', 'dpkg-status.d'),
                         ('/usr/lib/x86_64-linux-gnu/libresolv.so.2', 'libresolv.so.2')):
        try:
            command(DOCKER + ['cp', '-L', container + ':' + source, str(directory / name)])
            results.append({'imagePath': source, 'retainedPath': name, 'result': 'retained'})
        except ValueError as error:
            # Distroless metadata layouts may change. A missing observation is
            # explicit and cannot be represented as verified OS source material.
            results.append({'imagePath': source, 'result': 'unavailable', 'error': str(error)[-2048:]})
    inventory, total = files_inventory(directory, 16 * 1024**2)
    packages = []
    status = directory / 'dpkg-status.d'
    if status.is_dir():
        for path in sorted(status.iterdir()):
            if path.is_file() and path.stat().st_size <= 128 * 1024:
                value = path.read_text(errors='replace')
                if re.search(r'^Package: libc6$', value, re.M):
                    packages.append({'path': path.relative_to(directory).as_posix(), 'sha256': digest(path),
                                     'version': (re.search(r'^Version: (.+)$', value, re.M).group(1)
                                                 if re.search(r'^Version: (.+)$', value, re.M) else None),
                                     'source': (re.search(r'^Source: (.+)$', value, re.M).group(1)
                                                if re.search(r'^Source: (.+)$', value, re.M) else None)})
    value = {'result': 'separate-system-observation', 'copies': results, 'libc6Metadata': packages,
             'files': inventory, 'bytes': total, 'correspondingSourceCollected': False}
    write_json(directory / 'observation.json', value)
    return value


def prepare(image_id, output):
    if sys.platform != 'linux' or not IMAGE.fullmatch(image_id):
        raise ValueError('Linux and an immutable app image ID are required')
    if output.exists() or output.is_symlink():
        raise ValueError('Qualification requires a new output directory')
    disk_guard(output.parent, MAX_EXPORT + 2 * 1024**3 + RESERVE)
    native = collector()
    policy, _, _ = native.load_policy()
    image = json.loads(command(DOCKER + ['image', 'inspect', image_id]))
    if (len(image) != 1 or image[0].get('Id') != image_id
            or image[0].get('Os') != 'linux' or image[0].get('Architecture') != 'amd64'):
        raise ValueError('Source qualification requires the exact Linux amd64 app image')
    output.mkdir(mode=0o700)
    container = None
    with tempfile.TemporaryDirectory(prefix='aster-native-export-', dir=output.parent) as temporary:
        exported = Path(temporary)
        try:
            container = command(DOCKER + ['create', '--read-only', '--network', 'none', '--cap-drop', 'ALL',
                                         '--security-opt', 'no-new-privileges', '--entrypoint', '/nodejs/bin/node',
                                         image_id, '-e', 'process.exit(0)']).strip()
            before = inspect_container(container, image_id)
            command(DOCKER + ['cp', container + ':/app/node_modules', str(exported / 'node_modules')], timeout=180)
            after = inspect_container(container, image_id)
            _, exported_bytes = files_inventory(exported, MAX_EXPORT, allow_links=True)
            diagnostic = retain_unverified_package(native, policy, exported, output)
            write_json(output / 'export-diagnostics.json', {
                'imageId': image_id, 'containerBefore': before, 'containerAfter': after, **diagnostic})
            retain_system_diagnostics(container, output)
            inspect_container(container, image_id)
            runtime = native.runtime_inventory(exported, ROOT / 'package-lock.json', image_id, policy)
            # Keep only the package whose complete bytes were checked against the
            # immutable export. Other application dependencies are outside this gate.
            retained = output / 'runtime-export'
            if native.runtime_inventory(retained, output / 'package-lock.json', image_id, policy) != runtime:
                raise ValueError('Copied native package differs from the exact image export')
            write_json(output / 'image-export.json', {
                'schemaVersion': 1, 'imageId': image_id, 'platform': 'linux/amd64',
                'containerBefore': before, 'containerAfter': after, 'runtime': runtime,
                'exportedRuntimeBytes': exported_bytes,
                'nodeLockSha256': digest(output / 'package-lock.json'),
                'gitCommit': command(['/usr/bin/git', '-C', str(ROOT), 'rev-parse', 'HEAD']).strip(),
                'trustedInputs': [{'path': name, 'sha256': digest(ROOT / name)} for name in (
                    'tools/release/collect-native-sources.py', 'tools/release/collect-notices.py',
                    'operations/appliance/scripts/qualify-native-sources.py',
                    'operations/Dockerfile.app', 'package-lock.json')],
            })
        finally:
            if container and CONTAINER.fullmatch(container):
                command(DOCKER + ['rm', container])
    return {'result': 'inert-exact-image-exported', 'imageId': image_id}


def bound_export(output):
    native = collector()
    exported = native.bounded_json(native.checked_file(output, 'image-export.json'))
    if not IMAGE.fullmatch(exported['imageId']):
        raise ValueError('Export image identity is invalid')
    if digest(output / 'package-lock.json') != exported['nodeLockSha256'] or (output / 'package-lock.json').read_bytes() != (ROOT / 'package-lock.json').read_bytes():
        raise ValueError('Retained package lock differs from the trusted checkout')
    for item in exported['trustedInputs']:
        if digest(native.checked_file(ROOT, item['path'])) != item['sha256']:
            raise ValueError('Trusted qualification source changed')
    policy, _, _ = native.load_policy()
    actual = native.runtime_inventory(output / 'runtime-export', output / 'package-lock.json', exported['imageId'], policy)
    if actual != exported['runtime']:
        raise ValueError('Retained native bytes differ from the exact-image export')
    return native, exported


def resolve(output):
    disk_guard(output, 2 * 1024**3 + RESERVE)
    native, exported = bound_export(output)
    value = native.resolve(output / 'runtime-export', output / 'package-lock.json', exported['imageId'], output / 'native-sources')
    return {'result': value['status'], 'sources': value['sourceArchiveCount'], 'bytes': value['totalDownloadedBytes']}


def network_proof(host_network, host_mount):
    actual_network = os.readlink('/proc/self/ns/net')
    actual_mount = os.readlink('/proc/self/ns/mnt')
    if (not re.fullmatch(r'net:\[[0-9]+\]', host_network or '') or actual_network == host_network
            or not re.fullmatch(r'mnt:\[[0-9]+\]', host_mount or '') or actual_mount == host_mount):
        raise ValueError('Offline verification requires new kernel network and mount namespaces')
    interfaces = sorted(line.split(':', 1)[0].strip() for line in Path('/proc/net/dev').read_text().splitlines() if ':' in line)
    routes = Path('/proc/net/route').read_text().splitlines()[1:]
    if interfaces != ['lo'] or any(line.strip() for line in routes):
        raise ValueError('Offline verifier has a non-loopback network interface or route')
    return {'hostNetworkNamespace': host_network, 'networkNamespace': actual_network,
            'hostMountNamespace': host_mount, 'mountNamespace': actual_mount,
            'interfaces': interfaces, 'ipv4Routes': [], 'proxyEnvironmentPresent':
            any('proxy' in key.lower() for key in os.environ)}


def readonly_paths(output):
    return [ROOT, output / 'runtime-export', output / 'system-dependencies', output / 'package-lock.json', output / 'image-export.json'] + [
        output / 'native-sources' / name for name in (
            'source-lock.json', 'reviewed-recipe', 'original-sources', 'cargo-sources', 'registry-provenance', 'supplemental-notices')]


def enter_offline(output, host_network, host_mount, uid, gid):
    if os.geteuid() != 0 or uid <= 0 or gid <= 0:
        raise ValueError('Namespace setup requires root and a non-root verifier identity')
    network_proof(host_network, host_mount)
    for path in readonly_paths(output):
        if path.is_symlink() or not path.exists():
            raise ValueError('Missing or symlinked offline material')
        command(['/usr/bin/mount', '--bind', str(path), str(path)])
        command(['/usr/bin/mount', '-o', 'remount,bind,ro', str(path)])
    args = ['/usr/bin/setpriv', '--reuid', str(uid), '--regid', str(gid), '--clear-groups', '--no-new-privs',
            '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'PYTHONDONTWRITEBYTECODE=1',
            PYTHON, str(Path(__file__).resolve()), 'verify-offline', '--output', str(output),
            '--host-network', host_network, '--host-mount', host_mount]
    os.execv(args[0], args)


def readonly_proof(paths, mountinfo):
    mounts = {}
    for line in mountinfo.splitlines():
        fields = line.split()
        name = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        mounts[name] = fields[5].split(',')
    if any('ro' not in mounts.get(str(path), []) for path in paths):
        raise ValueError('Offline original sources, native payload and trusted checkout must be mounted read-only')
    return [str(path) for path in paths]


def verify_offline(output, host_network, host_mount):
    if os.geteuid() == 0:
        raise ValueError('Offline verification must run as an unprivileged user')
    proof = network_proof(host_network, host_mount)
    if proof['proxyEnvironmentPresent']:
        raise ValueError('Offline verifier environment is not clean')
    proof['readOnlyMounts'] = readonly_proof(readonly_paths(output), Path('/proc/self/mountinfo').read_text())
    write_json(output / 'offline-isolation.json', proof)
    native, exported = bound_export(output)
    receipt = native.verify(output / 'runtime-export', output / 'package-lock.json', exported['imageId'], output / 'native-sources')
    material, total = files_inventory(output)
    write_json(output / 'qualification.json', {
        'schemaVersion': 1, 'result': 'exact-image-native-sources-offline-verified',
        'appImageId': exported['imageId'], 'gitCommit': exported['gitCommit'],
        'nativeSourceCount': receipt['nativeSourceCount'], 'cargoSourceCount': receipt['cargoSourceCount'],
        'sourceLockSha256': receipt['sourceLockSha256'],
        'receiptSha256': digest(output / 'native-sources/receipt.json'),
        'retainedFiles': len(material), 'retainedBytes': total, 'files': material,
        'legalApproval': False, 'binaryRebuilt': False, 'distributionReady': False,
        'scope': receipt['scope'],
    })
    return {'result': 'exact-image-native-sources-offline-verified', 'nativeSources': receipt['nativeSourceCount'],
            'cargoSources': receipt['cargoSourceCount'], 'retainedBytes': total}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('preflight', 'prepare', 'resolve', 'enter-offline', 'verify-offline'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--image-id')
    parser.add_argument('--host-network')
    parser.add_argument('--host-mount')
    parser.add_argument('--uid', type=int, default=0)
    parser.add_argument('--gid', type=int, default=0)
    args = parser.parse_args()
    output = args.output.absolute()
    if output.resolve() != output:
        raise ValueError('Qualification output must have a canonical nonsymlink path')
    if args.action == 'preflight':
        value = {'availableBytes': disk_guard(output.parent, 16 * 1024**3), 'requiredBytes': 16 * 1024**3}
    elif args.action == 'prepare':
        value = prepare(args.image_id or '', output)
    elif args.action == 'resolve':
        value = resolve(output)
    elif args.action == 'enter-offline':
        value = enter_offline(output, args.host_network, args.host_mount, args.uid, args.gid)
    else:
        value = verify_offline(output, args.host_network, args.host_mount)
    print(json.dumps(value))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('Native source qualification refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
