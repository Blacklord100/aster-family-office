"""Build-time-only assembly of a CPython 3.12/OCR runtime with scan metadata.

Only trusted image/package ELF files are passed to ldd. Nothing in a document,
model response or runtime request can invoke this script or choose its paths.
"""
from collections import defaultdict, deque
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys

ROOT = Path('/runtime')
BASE = Path('/runtime-base')
STATUS = Path('/var/lib/dpkg/status')
OMITTED_MODULES = ['sqlite3', '_sqlite3', 'curses', '_curses', 'readline', '_uuid', 'tkinter', '_tkinter', 'idlelib']
# These are not needed by document decoding or inference. Fail closed if a
# future native dependency unexpectedly reintroduces one of their packages.
EXCLUDED_PACKAGES = {'perl-base', 'libsqlite3-0', 'libncursesw6', 'libtinfo6',
                     'libuuid1', 'libacl1', 'libarchive13t64', 'libtiff6'}
CUSTOM_PACKAGES = {
    '/opt/tesseract': {'id': 'tesseract-ocr:aster', 'name': 'tesseract-ocr',
                       'version': '5.5.3', 'revision': 2, 'source': 'tesseract', 'license': 'tesseract-5.5.3/LICENSE'},
    '/opt/libtiff': {'id': 'libtiff6:aster', 'name': 'libtiff6',
                   'version': '4.7.2', 'source': 'tiff', 'license': 'tiff-4.7.2/LICENSE.md'},
}


def fields(stanza):
    return dict(re.findall(r'^([A-Za-z][A-Za-z0-9-]*): (.*)$', stanza, re.MULTILINE))


def canonical(path):
    # Resolve merged-/usr directory aliases, but preserve the last symlink.
    path = Path(path)
    return path.parent.resolve() / path.name


def elf(path):
    if not path.is_file():
        return False
    with path.open('rb') as handle:
        return handle.read(4) == b'\x7fELF'


def linked_files(path):
    result = subprocess.run(['ldd', str(path)], capture_output=True, text=True,
                            env={**os.environ, 'LC_ALL': 'C',
                                 'LD_LIBRARY_PATH': '/opt/libtiff/lib:/opt/tesseract/lib:/usr/local/lib'}, check=False)
    output = result.stdout + result.stderr
    if 'not found' in output or (result.returncode and not any(
            marker in output for marker in ['statically linked', 'not a dynamic executable'])):
        raise RuntimeError(f'Unresolved native dependency for {path}: {output}')
    return [Path(value) for value in re.findall(r'(?:=>\s+|^\s*)(/[^\s]+)', output, re.MULTILINE)]


def configure_trust(root, defaults):
    """Connect OpenSSL's compiled defaults to the existing Distroless CA store."""
    bundle_path = '/etc/ssl/certs/ca-certificates.crt'
    bundle = root / bundle_path.lstrip('/')
    # Validate the actual retained CA bytes, without downloading/replacing trust.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=str(bundle))
    if not context.get_ca_certs():
        raise RuntimeError('The pinned runtime base has no usable CA certificates')
    aliases = []
    for expected, retained in [(defaults.openssl_cafile, bundle_path),
                               (defaults.openssl_capath, '/etc/ssl/certs')]:
        if not expected or not Path(expected).is_absolute():
            raise RuntimeError('The builder has an unsupported OpenSSL trust-store default')
        if expected == retained:
            continue
        target = root / Path(expected).relative_to('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():
            target.unlink()
        elif target.exists():
            raise RuntimeError(f'Unexpected existing OpenSSL trust-store path: {expected}')
        target.symlink_to(retained)
        aliases.append({'path': expected, 'symlink': retained})
    return {'bundle': bundle_path, 'sha256': hashlib.sha256(bundle.read_bytes()).hexdigest(), 'aliases': aliases}


def main():
    if sys.version_info[:3] != (3, 12, 13) or sys.platform != 'linux':
        raise RuntimeError('The runtime must be assembled by the pinned Linux CPython 3.12.13 builder')
    shutil.copytree(BASE, ROOT, symlinks=True)
    stanzas, package_paths, owners = {}, {}, {}
    for stanza in STATUS.read_text().split('\n\n'):
        info = fields(stanza)
        if info.get('Status') != 'install ok installed':
            continue
        name, arch = info['Package'], info['Architecture']
        package_id = f'{name}:{arch}'
        candidates = [Path(f'/var/lib/dpkg/info/{package_id}.list'), Path(f'/var/lib/dpkg/info/{name}.list')]
        listing = next((path for path in candidates if path.is_file()), None)
        if listing is None:
            raise RuntimeError(f'Installed package has no file inventory: {package_id}')
        paths = [canonical(path) for path in listing.read_text().splitlines() if path.startswith('/')]
        stanzas[package_id] = stanza
        package_paths[package_id] = paths
        for path in paths:
            if not path.is_dir() or path.is_symlink():
                owners[str(path)] = package_id

    copied = defaultdict(set)
    queue, scanned = deque(), set()
    expanded_base = set()
    base_status = {}
    for path in (ROOT / 'var/lib/dpkg/status.d').iterdir():
        if path.name.endswith('.md5sums'):
            continue
        info = fields(path.read_text())
        if info.get('Package'):
            base_status[info['Package']] = path

    def copy_file(source, package_id=None, destination=None):
        source = canonical(source)
        destination = Path(destination) if destination else source
        target = ROOT / destination.relative_to('/')
        if not source.exists() and not source.is_symlink():
            raise RuntimeError(f'Required runtime input is missing: {source}')
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():
            target.unlink()
        if source.is_symlink():
            if target.is_dir():
                # Only an empty directory left by a replaced package may turn
                # into a symlink. Never recursively erase another package.
                target.rmdir()
            target.symlink_to(os.readlink(source))
            resolved = source.resolve(strict=True)
            # Relocated language data is a regular file; native symlinks keep
            # their original destinations and need that exact target too.
            if destination != source:
                raise RuntimeError('Relocated runtime inputs cannot be symlinks')
            if not resolved.is_dir():
                copy_file(resolved, package_id)
        else:
            shutil.copy2(source, target)
            if elf(source):
                queue.append(source)
        if package_id:
            copied[package_id].add(str(destination))

    def add_system_file(path):
        path = canonical(path)
        package_id = owners.get(str(path)) or owners.get(str(path.resolve()))
        if not package_id:
            raise RuntimeError(f'System dependency has no Debian ownership metadata: {path}')
        info = fields(stanzas[package_id])
        name = info['Package']
        if name in EXCLUDED_PACKAGES:
            raise RuntimeError(f'Unexpected dependency on intentionally excluded package: {name}')
        # A base package may have been updated by apt. Replace its whole payload,
        # not only one .so followed by misleading metadata for older base bytes.
        if name in base_status and package_id not in expanded_base:
            expanded_base.add(package_id)
            old_status = base_status[name]
            old_sums = old_status.with_name(old_status.name + '.md5sums')
            if not old_sums.is_file():
                raise RuntimeError(f'Base package lacks a file inventory: {name}')
            for line in old_sums.read_text().splitlines():
                relative = line.split('  ', 1)[-1].lstrip('/')
                old_file = ROOT / relative
                if old_file.is_file() or old_file.is_symlink():
                    old_file.unlink()
            old_sums.unlink()
            old_status.unlink()
            for member in package_paths[package_id]:
                if member.is_file() or member.is_symlink():
                    copy_file(member, package_id)
        copy_file(path, package_id)

    # Ship the same interpreter, standard library and locked wheel metadata.
    # Optional GUI/terminal/SQLite/OS-UUID extensions are intentionally absent;
    # uuid.py retains its secure os.urandom-backed UUID4 implementation.
    def omit(directory, names):
        ignored = {'__pycache__'} & set(names)
        if Path(directory) == Path('/usr/local/lib/python3.12'):
            ignored.update({'sqlite3', 'curses', 'tkinter', 'idlelib'} & set(names))
        if Path(directory).name == 'lib-dynload':
            ignored.update(name for name in names if name.split('.')[0] in
                           {'_sqlite3', '_curses', '_curses_panel', 'readline', '_uuid', '_tkinter'})
        if Path(directory).name == 'site-packages':
            ignored.update(name for name in names if name == 'pip' or name.startswith('pip-') and name.endswith('.dist-info'))
        return ignored

    prefix = Path('/usr/local/lib/python3.12')
    shutil.copytree(prefix, ROOT / prefix.relative_to('/'), symlinks=True, ignore=omit)
    for path in (ROOT / prefix.relative_to('/')).rglob('*'):
        if elf(path):
            queue.append(Path('/') / path.relative_to(ROOT))
    for name in ['python', 'python3', 'python3.12', 'uvicorn']:
        copy_file(Path('/usr/local/bin') / name)
    for path in Path('/usr/local/lib').glob('libpython*.so*'):
        copy_file(path)

    for custom_prefix, package in CUSTOM_PACKAGES.items():
        if package['name'] in base_status:
            raise RuntimeError(f'Unexpected old OCR package in the pinned base: {package["name"]}')
        for path in Path(custom_prefix).rglob('*'):
            if path.is_file() or path.is_symlink():
                # Headers, static archives, cmake/pkg-config files and manuals
                # are builder inputs, not runtime functionality.
                relative = path.relative_to(custom_prefix)
                if relative.parts[0] == 'bin' and path.name != 'tesseract':
                    continue
                if relative.parts[0] == 'include' or path.suffix == '.a' or any(
                        part in {'cmake', 'pkgconfig', 'man'} for part in relative.parts):
                    continue
                copy_file(path, package['id'])
    language = Path('/usr/share/tesseract-ocr/5/tessdata/eng.traineddata')
    language_owner = owners.get(str(language))
    if not language_owner:
        raise RuntimeError('English traineddata must have Debian package metadata')
    copy_file(language, language_owner, '/opt/tesseract/share/tessdata/eng.traineddata')

    while queue:
        path = queue.popleft().resolve()
        if path in scanned:
            continue
        scanned.add(path)
        for dependency in linked_files(path):
            custom_owner = next((package['id'] for prefix, package in CUSTOM_PACKAGES.items()
                                 if str(dependency).startswith(prefix + '/')), None)
            if custom_owner:
                copy_file(dependency, custom_owner)
            elif str(dependency).startswith('/usr/local/'):
                # Native wheel RPATHs may contain '..'; normalize before copying.
                copy_file(dependency)
            else:
                add_system_file(dependency)

    architecture = subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip()
    for package in CUSTOM_PACKAGES.values():
        # These are truthful local upstream rebuilds, not official Debian
        # binaries. Keep canonical source names so existing CVEs remain visible.
        stanzas[package['id']] = '\n'.join([
            f'Package: {package["name"]}', 'Status: install ok installed',
            f'Version: {package["version"]}-1+aster{package.get("revision", 1)}',
            f'Source: {package["source"]} ({package["version"]})',
            f'Architecture: {architecture}', 'Maintainer: Aster local processor build',
            'Description: Local rebuild of authenticated upstream source; not a Debian binary package',
            'X-Aster-Provenance: /opt/aster/runtime-manifest.json',
        ])
    # Preserve license notices as well as source/version identity for each OS
    # package. Their status.d metadata follows the Distroless scanner standard.
    for package_id in list(copied):
        info = fields(stanzas[package_id])
        custom = next((package for package in CUSTOM_PACKAGES.values() if package['id'] == package_id), None)
        copyright_path = (Path('/build/sources') / custom['license'] if custom
                          else Path('/usr/share/doc') / info['Package'] / 'copyright')
        if not copyright_path.is_file():
            raise RuntimeError(f'Missing copyright for runtime package: {package_id}')
        copy_file(copyright_path.resolve(), package_id, f'/usr/share/doc/{info["Package"]}/copyright')

    package_manifest = []
    status_dir = ROOT / 'var/lib/dpkg/status.d'
    for package_id, members in sorted(copied.items()):
        info = fields(stanzas[package_id])
        status_path = status_dir / info['Package']
        status_path.write_text(stanzas[package_id].strip() + '\n')
        file_records, sums = [], []
        for value in sorted(members):
            target = ROOT / value.lstrip('/')
            if target.is_symlink():
                file_records.append({'path': value, 'symlink': os.readlink(target)})
            else:
                data = target.read_bytes()
                file_records.append({'path': value, 'sha256': hashlib.sha256(data).hexdigest()})
                sums.append(f'{hashlib.md5(data, usedforsecurity=False).hexdigest()}  {value.lstrip("/")}')
        status_path.with_name(status_path.name + '.md5sums').write_text('\n'.join(sums) + '\n')
        package_manifest.append({'name': info['Package'], 'version': info['Version'],
                                 'source': info.get('Source', info['Package']),
                                 'architecture': info['Architecture'],
                                 'metadataPath': '/' + str(status_path.relative_to(ROOT)),
                                 'files': file_records})

    # Sanitized child processes do not inherit LD_LIBRARY_PATH. Build an actual
    # loader cache for the merged image instead of relying on that environment.
    machine_lib = subprocess.check_output(['gcc', '-print-multiarch'], text=True).strip()
    (ROOT / 'etc/ld.so.conf').write_text(f'/opt/libtiff/lib\n/opt/tesseract/lib\n/usr/local/lib\n/usr/lib/{machine_lib}\n')
    subprocess.run(['ldconfig', '-r', str(ROOT)], check=True)
    trust_store = configure_trust(ROOT, ssl.get_default_verify_paths())
    with (ROOT / 'etc/passwd').open('a') as handle:
        handle.write('processor:x:10001:10001:Document processor:/nonexistent:/sbin/nologin\n')
    with (ROOT / 'etc/group').open('a') as handle:
        handle.write('processor:x:10001:\n')
    (ROOT / 'opt/aster').mkdir(parents=True, exist_ok=True)
    sources = json.loads(Path('/build/upstream-sources.json').read_text())
    native = json.loads(Path('/build/native-build.json').read_text())
    provenance = []
    evidence_dir = ROOT / 'opt/aster/source-provenance'
    evidence_dir.mkdir()
    for source in [Path('/build/upstream-sources.json'), Path('/build/security-build.json'),
                   *sorted(Path('/build/source-provenance').iterdir())]:
        target = evidence_dir / source.name
        shutil.copy2(source, target)
        provenance.append({'path': '/' + str(target.relative_to(ROOT)),
                           'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})

    def source_details(name):
        source = sources[name]
        return {'sourceArchives': [{key: source[key] for key in ['filename', 'sha256', 'url']}],
                'authentication': source['authentication']}

    manifest = {'schemaVersion': 1,
                'python': {'version': '3.12.13', 'omittedModules': OMITTED_MODULES,
                           'binarySha256': hashlib.sha256((ROOT / 'usr/local/bin/python3.12').read_bytes()).hexdigest()},
                'tesseract': {'version': '5.5.3', 'packageVersion': '5.5.3-1+aster2',
                              'sourceVersion': '5.5.3', **source_details('tesseract'),
                              'compiledDataPrefix': '/opt/tesseract/share',
                              'options': {'archive': False, 'curl': False, 'graphics': False, 'training': False}},
                'libtiff': {'version': '4.7.2', 'packageVersion': '4.7.2-1+aster1',
                            'sourceVersion': '4.7.2', **source_details('libtiff'), **native['libtiff']},
                'pillow': {**native['pillow'], **source_details('pillow'),
                           'buildDependencies': sources['buildDependencies']},
                'sourceProvenance': provenance,
                'securityBuild': json.loads(Path('/build/security-build.json').read_text()),
                'runtimeConfiguration': {'trustStore': trust_store},
                'systemPackages': package_manifest}
    (ROOT / 'opt/aster/runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'runtimePackages': len(package_manifest), 'nativeLibrariesChecked': len(scanned),
                      'python': manifest['python']['version'], 'tesseract': manifest['tesseract']['version']}))


if __name__ == '__main__':
    main()
