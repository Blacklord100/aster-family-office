"""Resolve and independently verify corresponding-source material for sharp's Linux payload.

Resolution is connected and Linux-only. Verification is offline. Neither mode
executes an npm library or upstream build script. Original sources are retained,
including license/copyright text, Cargo crates, build recipes and modifications.
This scope excludes the OS/system-library source obligations of other packages.
"""
import argparse
import base64
import configparser
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
POLICY_ROOT = ROOT / 'licenses/native/sharp-libvips-1.3.3'
IDENTIFIER = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$')
DIGEST = re.compile(r'^[a-f0-9]{64}$')
IMAGE_ID = re.compile(r'^sha256:[a-f0-9]{64}$')
MAX_METADATA = 2 * 1024 * 1024
MAX_LICENSE_BYTES = 100 * 1024 * 1024
HOSTS = {'github.com', 'codeload.github.com', 'release-assets.githubusercontent.com',
         'objects.githubusercontent.com', 'gitlab.com', 'gitlab.freedesktop.org',
         'download.gnome.org', 'master.gnome.org', 'ftp.gnome.org', 'cairographics.org',
         'storage.googleapis.com', 'static.crates.io', 'registry.npmjs.org'}

license_spec = importlib.util.spec_from_file_location('notice_inventory', Path(__file__).with_name('collect-notices.py'))
notices = importlib.util.module_from_spec(license_spec)
license_spec.loader.exec_module(notices)


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def relative(value):
    path = PurePosixPath(value)
    if (not value or path.is_absolute() or '\\' in value or ':' in value or
            any(part in {'', '.', '..'} for part in value.split('/')) or
            any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError('Noncanonical source material path')
    return path


def checked_file(root, value):
    path = root
    for part in relative(value).parts:
        path /= part
        if path.is_symlink():
            raise ValueError('Source material paths must not contain symlinks')
    if not path.is_file():
        raise ValueError('Missing regular source material: ' + value)
    return path


def checked_directory(root, value):
    path = root
    for part in relative(value).parts:
        path /= part
        if path.is_symlink() or not path.is_dir():
            raise ValueError('Source output directory must be an existing regular directory')
    return path


def bounded_json(path):
    if path.stat().st_size > MAX_METADATA:
        raise ValueError('Source metadata exceeds its byte limit')
    return json.loads(path.read_text())


def load_policy(root=POLICY_ROOT):
    policy = bounded_json(root / 'source-policy.json')
    if policy.get('schemaVersion') != 1 or policy.get('type') != 'aster-sharp-native-source-policy-v1':
        raise ValueError('Unknown native source policy')
    recipes = bounded_json(root / 'recipe-provenance.json')
    metadata = bounded_json(root / 'metadata-provenance.json')
    material = []
    for inventory, prefix in ((recipes, 'recipe/'), (metadata, '')):
        for item in inventory['files']:
            name = prefix + item['path']
            path = checked_file(root, name)
            if path.stat().st_size != item['bytes'] or sha(path) != item['sha256']:
                raise ValueError('Reviewed native source recipe or metadata changed: ' + name)
            material.append({'path': name, 'sha256': item['sha256'], 'bytes': item['bytes']})
    for name in ('recipe-provenance.json', 'metadata-provenance.json', 'source-policy.json', 'README.md'):
        path = root / name
        material.append({'path': name, 'sha256': sha(path), 'bytes': path.stat().st_size})
    properties = {}
    for line in (root / 'recipe/versions.properties').read_text().splitlines():
        key, value = line.split('=', 1)
        properties[key.removeprefix('VERSION_').lower().replace('_', '-')] = value
    if properties != policy['versions']:
        raise ValueError('Reviewed recipe and native version coverage differ')
    sources = {item['name']: item for item in policy['sources']}
    if len(sources) != len(policy['sources']) or set(sources) != set(properties) | {'gvdb'}:
        raise ValueError('Native source policy omits or duplicates a dependency')
    for name, version in properties.items():
        if sources[name]['version'] != version:
            raise ValueError('Source archive version differs from native inventory')
    gvdb = configparser.ConfigParser()
    gvdb.read(root / 'metadata/glib-gvdb.wrap')
    if gvdb['wrap-git']['revision'] != sources['gvdb']['version']:
        raise ValueError('glib fallback source revision is not covered')
    cargo = tomllib.loads((root / 'metadata/librsvg-Cargo.lock').read_text())
    crates = []
    for item in cargo['package']:
        if 'source' not in item:
            continue  # Workspace source is retained in the original librsvg archive.
        if (item['source'] != 'registry+https://github.com/rust-lang/crates.io-index' or
                not DIGEST.fullmatch(item.get('checksum', '')) or
                not IDENTIFIER.fullmatch(item['name']) or not IDENTIFIER.fullmatch(item['version'])):
            raise ValueError('Unreviewed transitive Cargo source or checksum')
        crates.append({'name': item['name'], 'version': item['version'], 'sha256': item['checksum'],
                       'url': f'https://static.crates.io/crates/{item["name"]}/{item["name"]}-{item["version"]}.crate'})
    if not crates or len(crates) > 1000 or len({(x['name'], x['version']) for x in crates}) != len(crates):
        raise ValueError('Invalid transitive Cargo dependency coverage')
    return policy, material, crates


def runtime_inventory(root, lock_path, image_id, policy):
    if not IMAGE_ID.fullmatch(image_id):
        raise ValueError('Exact app image ID is required')
    root = root.resolve(strict=True)
    lock = bounded_json(lock_path)
    matches = []
    for name, entry in lock['packages'].items():
        if name.rsplit('node_modules/', 1)[-1] != policy['package']['name']:
            continue
        path = root / name
        if path.exists():
            checked_file(root, name + '/package.json')
            matches.append((name, path, entry))
    if len(matches) != 1:
        raise ValueError('Expected exactly one exported Linux x64 sharp-libvips package')
    name, path, entry = matches[0]
    actual = bounded_json(path / 'package.json')
    if (actual.get('name') != policy['package']['name'] or actual.get('version') != policy['package']['version'] or
            entry.get('version') != actual['version'] or actual.get('license') != policy['package']['declaredLicense']):
        raise ValueError('Exported sharp package identity or LGPL terms differ from reviewed policy')
    versions = bounded_json(checked_file(root, name + '/versions.json'))
    if versions != policy['versions']:
        raise ValueError('Native version inventory differs from corresponding source coverage')
    if not entry.get('integrity', '').startswith('sha512-') or not entry.get('resolved', '').startswith('https://registry.npmjs.org/'):
        raise ValueError('Exact published npm archive identity is missing')
    files, libraries = [], []
    for item in sorted(path.rglob('*')):
        if item.is_symlink():
            raise ValueError('Export native package must contain only regular files/directories')
        if item.is_dir():
            continue
        if not item.is_file() or item.stat().st_size > policy['limits']['perSourceBytes']:
            raise ValueError('Unsafe or oversized native package file')
        rel = item.relative_to(path).as_posix()
        record = {'path': rel, 'sha256': sha(item), 'bytes': item.stat().st_size}
        files.append(record)
        with item.open('rb') as stream:
            header = stream.read(20)
        if header[:4] == b'\x7fELF':
            if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\x3e\x00':
                raise ValueError('Native library is not Linux amd64 ELF')
            # Inspect ELF metadata; never execute the library (including ldd).
            result = subprocess.run(['/usr/bin/readelf', '-d', str(item)], check=True,
                                    capture_output=True, text=True, timeout=15)
            if len(result.stdout) > MAX_METADATA:
                raise ValueError('ELF dependency metadata exceeds its limit')
            needed = sorted(re.findall(r'\(NEEDED\).*?\[([^\]]+)\]', result.stdout))
            unknown = set(needed) - set(policy['systemLibraries'])
            if unknown:
                raise ValueError('Native ELF adds unreviewed shared dependency: ' + ', '.join(sorted(unknown)))
            libraries.append({**record, 'neededSystemLibraries': needed})
    if len(files) > 10000 or len(libraries) != 1 or libraries[0]['path'] != policy['package']['library']:
        raise ValueError('Native binary file set differs from reviewed single shared-library payload')
    return {'appImageId': image_id, 'packagePath': name,
            'runtimePackage': {'name': actual['name'], 'version': actual['version'], 'license': actual['license'],
                               'registryArchive': entry['resolved'], 'integrity': entry['integrity']},
            'versions': versions, 'packageFiles': files, 'nativeFiles': libraries}


class HTTPSOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.username or parsed.password or
            parsed.port not in (None, 443) or parsed.fragment):
        raise ValueError('Unreviewed source download origin or protocol')


def download(url, path, limit, expected_sha=None, expected_integrity=None):
    validate_url(url)
    opener = urllib.request.build_opener(HTTPSOnly())
    started = time.monotonic()
    for attempt in range(3):
        try:
            digest, sri, count = hashlib.sha256(), hashlib.sha512(), 0
            with opener.open(urllib.request.Request(url, headers={'User-Agent': 'Aster-source-inventory/1'}), timeout=45) as response:
                validate_url(response.url)
                with path.open('xb') as output:
                    while data := response.read(1024 * 1024):
                        count += len(data)
                        if count > limit or time.monotonic() - started > 300:
                            raise ValueError('Source download exceeds its configured byte limit')
                        digest.update(data); sri.update(data); output.write(data)
            actual = digest.hexdigest()
            if expected_sha and actual != expected_sha:
                raise ValueError('Published source checksum mismatch')
            if expected_integrity and 'sha512-' + base64.b64encode(sri.digest()).decode() != expected_integrity:
                raise ValueError('Published npm archive integrity mismatch')
            return {'sha256': actual, 'bytes': count}
        except (urllib.error.URLError, TimeoutError):
            if path.exists():
                path.unlink()  # Only this invocation's new partial download.
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def inspect_archive(path, policy, capture=()):
    """Read bounded members without extracting executable content or links."""
    texts, captured, seen = [], {}, set()
    total = count = 0
    with tarfile.open(path, 'r:*') as archive:
        for member in archive:
            count += 1
            name = member.name.removeprefix('./').rstrip('/')
            if not name:
                continue
            relative(name)
            if name in seen:
                raise ValueError('Duplicate source archive path')
            seen.add(name)
            total += member.size
            if (count > policy['limits']['archiveMembers'] or member.size < 0 or
                    total > policy['limits']['expandedSourceBytes']):
                raise ValueError('Source archive exceeds its expanded inventory limits')
            if not member.isfile():
                continue  # Retained inside original archive; never materialize links/devices.
            # All expected sources contain one top-level package directory.
            subpath = '/'.join(name.split('/')[1:])
            is_notice = notices.license_path(PurePosixPath(subpath)) or PurePosixPath(subpath).name.upper() in {'FTL.TXT', 'GPLV2.TXT'}
            if is_notice or subpath in capture:
                if member.size > MAX_METADATA:
                    raise ValueError('Source notice/metadata exceeds its limit')
                data = archive.extractfile(member).read(MAX_METADATA + 1)
                if len(data) != member.size:
                    raise ValueError('Truncated source metadata member')
                if is_notice:
                    texts.append((name, data))
                if subpath in capture:
                    if subpath in captured:
                        raise ValueError('Ambiguous source metadata path')
                    captured[subpath] = data
    if not texts:
        raise ValueError('Source archive has no original license/notice text: ' + path.name)
    if set(capture) != set(captured):
        raise ValueError('Source archive is missing required recursive dependency metadata')
    return texts, captured


def verify_npm_archive(path, runtime):
    expected = {item['path']: item for item in runtime['packageFiles']}
    seen = set()
    digest = hashlib.sha512()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    if 'sha512-' + base64.b64encode(digest.digest()).decode() != runtime['runtimePackage']['integrity']:
        raise ValueError('Retained npm package fails published integrity')
    with tarfile.open(path, 'r:*') as archive:
        for member in archive:
            if member.isdir():
                continue
            if not member.isfile() or not member.name.startswith('package/'):
                raise ValueError('Published native package contains an unsupported archive entry')
            name = member.name.removeprefix('package/')
            relative(name)
            if name not in expected or name in seen or member.size != expected[name]['bytes']:
                raise ValueError('Runtime package file set differs from registry artifact')
            seen.add(name)
            h = hashlib.sha256()
            with archive.extractfile(member) as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b''):
                    h.update(block)
            if h.hexdigest() != expected[name]['sha256']:
                raise ValueError('Runtime native bytes differ from published npm archive')
    if seen != set(expected):
        raise ValueError('Native registry archive omits exported package files')


def expected_records(policy, crates):
    output = []
    for source in policy['sources']:
        suffix = '.tar.xz' if source['url'].endswith('.tar.xz') else '.tar.gz'
        output.append({**source, 'kind': 'native-source', 'path': f'original-sources/{source["name"]}-{source["version"]}{suffix}'})
    for crate in crates:
        output.append({**crate, 'kind': 'cargo-source', 'path': f'cargo-sources/{crate["name"]}-{crate["version"]}.crate'})
    return output


def recursive_metadata(record, captured, policy_root):
    if record['name'] == 'rsvg':
        if captured['Cargo.lock'] != (policy_root / 'metadata/librsvg-Cargo.lock').read_bytes():
            raise ValueError('Actual librsvg Cargo lock differs from pinned transitive closure')
    if record['name'] == 'glib':
        if captured['subprojects/gvdb.wrap'] != (policy_root / 'metadata/glib-gvdb.wrap').read_bytes():
            raise ValueError('Actual glib fallback dependency differs from pinned closure')


def captures(record):
    if record['kind'] != 'native-source':
        return ()
    return {'rsvg': ('Cargo.lock',), 'glib': ('subprojects/gvdb.wrap',)}.get(record['name'], ())


def resolve(runtime_root, lock_path, image_id, output, policy_root=POLICY_ROOT):
    if platform.system() != 'Linux':
        raise ValueError('Connected source resolution runs only on the disposable Linux builder')
    policy, material, crates = load_policy(policy_root)
    runtime = runtime_inventory(runtime_root, lock_path, image_id, policy)
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    for name in ('reviewed-recipe', 'original-sources', 'cargo-sources', 'notices', 'registry-provenance'):
        (output / name).mkdir()
    for record in material:
        target = output / 'reviewed-recipe' / record['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(policy_root / record['path'], target)
    npm_path = output / 'registry-provenance/native-package.tgz'
    npm = download(runtime['runtimePackage']['registryArchive'], npm_path,
                   policy['limits']['perSourceBytes'], expected_integrity=runtime['runtimePackage']['integrity'])
    verify_npm_archive(npm_path, runtime)
    downloaded = npm['bytes']
    records = []
    started = time.monotonic()
    for index, record in enumerate(expected_records(policy, crates)):
        if time.monotonic() - started > 3600:
            raise ValueError('Source resolution exceeded its one-hour wall-clock budget')
        path = output / record['path']
        available = min(policy['limits']['perSourceBytes'], policy['limits']['totalDownloadBytes'] - downloaded)
        if available <= 0:
            raise ValueError('Corresponding source exceeds its total download budget')
        result = download(record['url'], path, available, expected_sha=record.get('sha256'))
        downloaded += result['bytes']
        # Verify required embedded lockfiles before accepting derived source coverage.
        _, captured = inspect_archive(path, policy, captures(record))
        recursive_metadata(record, captured, policy_root)
        records.append({**record, **result})
        if index % 25 == 0:
            print(json.dumps({'sourceArchivesRetained': index + 1, 'bytes': downloaded}), flush=True)
    # Resolution records hashes. Only the independent offline verifier can emit
    # a source-materials-verified receipt, after all files are re-read.
    resolved = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-lock-v1',
                'status': 'resolved-pending-independent-verification',
                'policySha256': sha(policy_root / 'source-policy.json'),
                'runtime': runtime, 'material': material, 'sources': records,
                'registryArchive': {'path': 'registry-provenance/native-package.tgz', **npm},
                'sourceArchiveCount': len(records), 'totalDownloadedBytes': downloaded,
                'scope': policy['scope'], 'legalApproval': False, 'binaryRebuilt': False}
    (output / 'source-lock.json').write_text(json.dumps(resolved, indent=2) + '\n')
    return resolved


def verify(runtime_root, lock_path, image_id, source_root, policy_root=POLICY_ROOT):
    policy, material, crates = load_policy(policy_root)
    runtime = runtime_inventory(runtime_root, lock_path, image_id, policy)
    lock = bounded_json(checked_file(source_root, 'source-lock.json'))
    if (lock.get('schemaVersion') != 1 or lock.get('type') != 'aster-sharp-native-source-lock-v1' or
            lock.get('policySha256') != sha(policy_root / 'source-policy.json') or
            lock.get('runtime') != runtime or lock.get('material') != material):
        raise ValueError('Source lock is not bound to the reviewed policy and exact app native bytes')
    for item in material:
        p = checked_file(source_root, 'reviewed-recipe/' + item['path'])
        if p.stat().st_size != item['bytes'] or sha(p) != item['sha256']:
            raise ValueError('Retained corresponding-source recipe or modification changed')
    registry = lock['registryArchive']
    p = checked_file(source_root, 'registry-provenance/native-package.tgz')
    if registry.get('path') != 'registry-provenance/native-package.tgz' or sha(p) != registry.get('sha256') or p.stat().st_size != registry.get('bytes'):
        raise ValueError('Retained npm package provenance changed')
    verify_npm_archive(p, runtime)
    expected = expected_records(policy, crates)
    actual = lock.get('sources', [])
    if len(actual) != len(expected) or lock.get('sourceArchiveCount') != len(expected):
        raise ValueError('Corresponding source omits required native or Cargo dependencies')
    checked_directory(source_root, 'notices')
    text_bytes, text_records, total_source_bytes = 0, [], 0
    for wanted, saved in zip(expected, actual, strict=True):
        if any(saved.get(key) != value for key, value in wanted.items()) or not DIGEST.fullmatch(saved.get('sha256', '')):
            raise ValueError('Corresponding source identity or transitive checksum changed')
        path = checked_file(source_root, wanted['path'])
        total_source_bytes += path.stat().st_size
        if (path.stat().st_size > policy['limits']['perSourceBytes'] or
                total_source_bytes > policy['limits']['totalDownloadBytes'] or
                path.stat().st_size != saved.get('bytes') or sha(path) != saved['sha256']):
            raise ValueError('Corresponding source archive bytes changed')
        texts, captured = inspect_archive(path, policy, captures(wanted))
        recursive_metadata(wanted, captured, policy_root)
        for original, data in texts:
            text_bytes += len(data)
            if text_bytes > MAX_LICENSE_BYTES:
                raise ValueError('Original source notices exceed their output limit')
            content_hash = hashlib.sha256(data).hexdigest()
            target_name = 'notices/' + content_hash + '.txt'
            target = source_root / target_name
            if target.is_symlink():
                raise ValueError('Source notice must not be a symlink')
            if target.exists():
                if target.read_bytes() != data:
                    raise ValueError('Existing retained notice differs from original source')
            else:
                target.write_bytes(data)
            text_records.append({'source': wanted['path'], 'originalPath': original,
                                 'file': target_name, 'sha256': content_hash, 'bytes': len(data)})
    receipt = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-receipt-v1',
               'result': 'source-materials-verified', 'appImageId': image_id,
               'runtimePackage': runtime['runtimePackage'], 'nativeFiles': runtime['nativeFiles'],
               'sourceLockSha256': sha(source_root / 'source-lock.json'),
               'nativeSourceCount': len(policy['sources']), 'cargoSourceCount': len(crates),
               'sourceArchiveCount': len(expected), 'licenseFileCount': len(text_records),
               'notices': text_records, 'scope': policy['scope'],
               'legalApproval': False, 'binaryRebuilt': False,
               'limits': 'Source identity follows the signed upstream packaging recipe and published npm artifact; not a claim of bit-for-bit rebuild reproducibility or coverage of other OS packages.'}
    receipt_path = source_root / 'receipt.json'
    if receipt_path.is_symlink():
        raise ValueError('Source receipt must not be a symbolic link')
    if receipt_path.exists():
        if bounded_json(receipt_path) != receipt:
            raise ValueError('Existing native-source verification receipt differs; never overwrite')
    else:
        receipt_path.write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('resolve', 'verify', 'policy'))
    parser.add_argument('--runtime-root', type=Path)
    parser.add_argument('--node-lock', type=Path)
    parser.add_argument('--image-id')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--source-root', type=Path)
    args = parser.parse_args()
    if args.action == 'policy':
        policy, material, crates = load_policy()
        print(json.dumps({'nativeSources': len(policy['sources']), 'cargoSources': len(crates), 'reviewedFiles': len(material)}))
        return
    if not args.runtime_root or not args.node_lock or not args.image_id:
        parser.error('--runtime-root, --node-lock and --image-id are required')
    if args.action == 'resolve':
        if not args.output:
            parser.error('resolve requires --output for a new directory')
        result = resolve(args.runtime_root, args.node_lock, args.image_id, args.output)
        print(json.dumps({'status': result['status'], 'sources': result['sourceArchiveCount']}))
    else:
        if not args.source_root:
            parser.error('verify requires --source-root')
        result = verify(args.runtime_root, args.node_lock, args.image_id, args.source_root)
        print(json.dumps({key: result[key] for key in ('result', 'appImageId', 'nativeSourceCount', 'cargoSourceCount', 'sourceLockSha256')}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
        print('Native source gate refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
