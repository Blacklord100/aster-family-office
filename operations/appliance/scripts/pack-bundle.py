#!/usr/bin/env python3
"""Create deterministic gzip/tar media split below the GitHub per-asset size limit.

parts.json is a transport inventory, not a trust root. Reassembly must be followed
by asterctl verification against the independently trusted TUF root.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import stat
import tarfile


def signed_metadata_layout(bundle):
    """Check the real offline TUF file chain; this does not authenticate signatures."""
    def read(name, kind, reference=None):
        path = bundle / 'metadata' / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 5 * 1024**2:
            raise ValueError('Sign the bundle with the offline TUF protocol before packing')
        raw = path.read_bytes()
        if reference and (reference.get('length') != len(raw) or reference.get('hashes', {}).get('sha256') != hashlib.sha256(raw).hexdigest()):
            raise ValueError('TUF metadata hash/length differs from its parent')
        value = json.loads(raw)
        if value.get('signed', {}).get('_type') != kind or not value.get('signatures'):
            raise ValueError('Required signed TUF metadata is missing')
        return value['signed']
    def version(meta):
        value = meta.get('version')
        if type(value) is not int or value < 1:
            raise ValueError('TUF references require a positive metadata version')
        return value
    timestamp = read('timestamp.json', 'timestamp')
    snapshot_ref = timestamp['meta']['snapshot.json']
    snapshot = read(str(version(snapshot_ref)) + '.snapshot.json', 'snapshot', snapshot_ref)
    if snapshot.get('version') != snapshot_ref['version']:
        raise ValueError('TUF snapshot version differs from its parent')
    targets_ref = snapshot['meta']['targets.json']
    targets = read(str(version(targets_ref)) + '.targets.json', 'targets', targets_ref)
    if targets.get('version') != targets_ref['version']:
        raise ValueError('TUF targets version differs from its parent')
    release = (bundle / 'release.json').read_bytes()
    target = targets['targets']['release.json']
    if target.get('length') != len(release) or target.get('hashes', {}).get('sha256') != hashlib.sha256(release).hexdigest():
        raise ValueError('Signed release target differs from release.json')
    for path in (bundle / 'metadata').iterdir():
        if not re.fullmatch(r'(?:timestamp|[1-9][0-9]*\.(?:targets|snapshot|root))\.json', path.name) or not path.is_file() or path.is_symlink():
            raise ValueError('Unexpected file in the offline TUF metadata directory')


class PartsWriter:
    def __init__(self, destination, prefix, limit):
        self.destination, self.prefix, self.limit = destination, prefix, limit
        self.parts, self.file, self.count, self.hash = [], None, 0, None
        self.total_hash = hashlib.sha256()
        self.total_bytes = 0

    def write(self, data):
        self.total_hash.update(data)
        self.total_bytes += len(data)
        offset = 0
        while offset < len(data):
            if self.file is None:
                self.path = self.destination / f'{self.prefix}.tar.gz.part{len(self.parts):04d}'
                self.file, self.count, self.hash = self.path.open('xb'), 0, hashlib.sha256()
            block = data[offset:offset + self.limit - self.count]
            self.file.write(block)
            self.hash.update(block)
            self.count += len(block)
            offset += len(block)
            if self.count == self.limit:
                self.finish_part()
        return len(data)

    def finish_part(self):
        if self.file is not None:
            self.file.close()
            self.parts.append({'path': self.path.name, 'size': self.count, 'sha256': self.hash.hexdigest()})
            self.file = None

    def flush(self):
        if self.file:
            self.file.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--part-mib', type=int, default=1900)
    args = parser.parse_args()
    manifest = json.loads((args.bundle / 'release.json').read_text())
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,79}', manifest['releaseId']):
        raise ValueError('Invalid release ID')
    if not 1 <= args.part_mib <= 1900:
        raise ValueError('Each part must fit below the 2GB hosting limit')
    if args.output.exists():
        raise ValueError('Refusing an existing output directory')
    signed_metadata_layout(args.bundle)
    expected = {item['path']: item for item in manifest['files']}
    files = []
    for path in sorted(args.bundle.rglob('*')):
        info = path.lstat()
        if path.is_symlink() or (not path.is_dir() and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)):
            raise ValueError('Media must contain only independent regular files and directories')
        if path.is_dir():
            continue
        name = path.relative_to(args.bundle).as_posix()
        if name.startswith('payload/'):
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            item = expected.pop(name, None)
            if not item or digest != item['sha256'] or info.st_size != item['size'] or stat.S_IMODE(info.st_mode) != item['mode']:
                raise ValueError('Payload differs from release.json')
        elif name != 'release.json' and not name.startswith('metadata/'):
            raise ValueError('Unexpected file outside signed payload')
        files.append(path)
    if expected:
        raise ValueError('Payload files are missing')
    args.output.mkdir(parents=True)
    writer = PartsWriter(args.output, manifest['releaseId'], args.part_mib * 1024**2)
    with gzip.GzipFile(fileobj=writer, mode='wb', filename='', mtime=0, compresslevel=6) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
            for path in files:
                name = path.relative_to(args.bundle).as_posix()
                info = archive.gettarinfo(str(path), arcname=name)
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                info.pax_headers = {}
                with path.open('rb') as stream:
                    archive.addfile(info, stream)
    writer.finish_part()
    (args.output / 'parts.json').write_text(json.dumps({'schemaVersion': 1, 'releaseId': manifest['releaseId'],
        'format': 'tar+gzip', 'bytes': writer.total_bytes, 'sha256': writer.total_hash.hexdigest(),
        'parts': writer.parts, 'trust': 'Transport checks only; TUF verification remains mandatory'}, indent=2) + '\n')
    print(json.dumps({'parts': len(writer.parts), 'bytes': writer.total_bytes, 'sha256': writer.total_hash.hexdigest()}))


if __name__ == '__main__':
    main()
