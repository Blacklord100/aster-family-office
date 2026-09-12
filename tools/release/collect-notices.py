"""Collect installed dependency license texts offline, without claiming license approval."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys

MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024


def license_path(path):
    return (any(part.lower() in {'licenses', 'licences'} for part in path.parts) or
            bool(re.match(r'^(?:third[ _.-]?party[ _.-]?)?(licen[sc]es?|copying|copyright|notices?)([._-]|$)', path.name, re.I)))


def runtime_node_identities(root):
    """Read the installed standalone package tree; never follow external symlinks."""
    root = root.resolve()
    identities = set()
    pending = [root / 'node_modules']
    visited = set()
    while pending:
        directory = pending.pop()
        if not directory.exists():
            continue
        if not directory.resolve().is_relative_to(root) or directory.is_symlink():
            raise ValueError('Runtime dependency directory escapes its export')
        if directory in visited:
            continue
        visited.add(directory)
        if len(visited) > 10000:
            raise ValueError('Runtime dependency inventory exceeds its limit')
        for child in directory.iterdir():
            if child.name.startswith('.'):
                continue
            if child.is_symlink():
                raise ValueError('Export runtime packages as regular directories')
            candidates = sorted(child.iterdir()) if child.is_dir() and child.name.startswith('@') else [child]
            for package in candidates:
                if package.is_symlink() or not package.resolve().is_relative_to(root):
                    raise ValueError('Runtime package escapes its export')
                metadata = package / 'package.json'
                if metadata.is_file():
                    value = json.loads(metadata.read_text())
                    if not value.get('name') or not value.get('version'):
                        raise ValueError('Runtime package lacks name/version identity')
                    identities.add((value['name'], value['version']))
                    pending.append(package / 'node_modules')
    if not identities:
        raise ValueError('Runtime export has no installed package inventory')
    return identities


def node_packages(root):
    root = root.resolve()
    lock = json.loads((root / 'package-lock.json').read_text())
    for relative, entry in sorted(lock['packages'].items()):
        if not relative:
            continue
        path = root / relative
        if not path.resolve().is_relative_to(root) or '..' in Path(relative).parts:
            raise ValueError('Package path escapes the supplied installation')
        name = entry.get('name') or relative.rsplit('node_modules/', 1)[-1]
        record = {'ecosystem': 'npm', 'name': name, 'version': entry.get('version'),
                  'installationPath': relative, 'declaredLicense': entry.get('license'),
                  'optional': entry.get('optional', False), 'development': entry.get('dev', False)}
        if not (path / 'package.json').is_file():
            yield record, [], 'not-installed-on-this-platform'
            continue
        actual = json.loads((path / 'package.json').read_text())
        if actual.get('version') != entry.get('version'):
            raise ValueError('Installed package differs from the lock: ' + name)
        record['declaredLicense'] = actual.get('license') or entry.get('license')
        # Bundled modules (for example Next's dist/compiled) have their own
        # notices. Walk this installed package, excluding nested dependencies
        # which are inventoried separately; never follow symlinks or fetch URLs.
        candidates = []
        for directory, children, filenames in os.walk(path, followlinks=False):
            children[:] = [name for name in children if name not in {'node_modules', '.git'}
                           and not (Path(directory) / name).is_symlink()]
            for filename in filenames:
                child = Path(directory) / filename
                if not child.is_symlink() and license_path(child.relative_to(path)):
                    candidates.append(child)
                elif (not child.is_symlink() and re.match(r'^readme([._-]|$)', filename, re.I)
                      and child.stat().st_size <= MAX_FILE_BYTES):
                    text = child.read_text(errors='replace')
                    if ('Permission is hereby granted' in text and 'THE SOFTWARE IS PROVIDED' in text):
                        candidates.append(child)
        yield record, [(file, str(file.relative_to(path))) for file in sorted(candidates)], None


def with_supplements(packages, manifest):
    if manifest is None:
        yield from packages
        return
    base = manifest.parent.resolve()
    data = json.loads(manifest.read_text())
    if data.get('schemaVersion') != 1:
        raise ValueError('Unsupported supplemental notice inventory')
    mappings = {}
    for record in data['packages']:
        key = (record['name'], record['version'])
        if key in mappings:
            raise ValueError('Duplicate supplemental package identity')
        mappings[key] = record
    for record, files, status in packages:
        supplement = mappings.get((record['name'], record['version'])) if record['ecosystem'] == 'npm' else None
        if supplement and status is None:
            if supplement['declaredLicense'] != record.get('declaredLicense'):
                raise ValueError('Supplemental notice license differs from installed package metadata')
            files = list(files)
            record = dict(record)
            record['supplementalSources'] = supplement['sources']
            for source in supplement['sources']:
                path = base / source['file']
                if not path.resolve().is_relative_to(base) or path.is_symlink():
                    raise ValueError('Supplemental notice path escapes inventory')
                if hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
                    raise ValueError('Supplemental notice text checksum mismatch')
                files.append((path, 'reviewed-upstream/' + source['file']))
        yield record, files, status


def python_packages():
    for distribution in sorted(importlib.metadata.distributions(), key=lambda d: d.metadata.get('Name', '')):
        record = {'ecosystem': 'pypi', 'name': distribution.metadata['Name'], 'version': distribution.version,
                  'declaredLicense': distribution.metadata.get('License-Expression') or
                  distribution.metadata.get('License') or None}
        files = []
        for relative in distribution.files or []:
            if license_path(Path(str(relative))):
                path = Path(distribution.locate_file(relative))
                if path.is_file() and not path.is_symlink():
                    files.append((path, str(relative)))
        yield record, files, None


def collect(packages, destination):
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    inventory = []
    total = 0
    for record, files, status in packages:
        record = dict(record)
        # License metadata can be the entire license text. The complete text is
        # retained as a file when supplied, rather than silently truncating it.
        declared = record.get('declaredLicense')
        if declared is not None and not isinstance(declared, str):
            declared = json.dumps(declared, sort_keys=True)
        if declared and len(declared) > 512:
            record['declaredLicense'] = 'See license metadata in package; expression requires review'
        key = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()[:20]
        output = destination / 'texts' / key
        records = []
        for index, (source, original) in enumerate(files):
            size = source.stat().st_size
            if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES:
                raise ValueError('License collection exceeds its bounded output budget')
            data = source.read_bytes()
            if len(data) != size:
                raise ValueError('License source changed during collection')
            total += size
            output.mkdir(parents=True, exist_ok=True)
            name = f'{index:03d}.txt'
            (output / name).write_bytes(data)
            records.append({'originalPath': original, 'file': f'texts/{key}/{name}',
                            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': size})
        record['licenseFiles'] = records
        record['status'] = status or ('texts-collected-review-required' if records else 'missing-license-text')
        inventory.append(record)
    receipt = {'schemaVersion': 1, 'collector': 'aster-installed-license-inventory-v1',
               'networkUsed': False, 'legalApproval': False, 'packages': inventory,
               'totalLicenseBytes': total,
               'missingInstalledTexts': sum(item['status'] == 'missing-license-text' for item in inventory)}
    (destination / 'inventory.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-root', type=Path, help='Installed npm project with package-lock.json')
    parser.add_argument('--node-runtime-root', type=Path,
                        help='Select only packages present in this exported standalone node_modules tree')
    parser.add_argument('--python', action='store_true', help='Installed distributions of this interpreter')
    parser.add_argument('--output', type=Path, required=True, help='New output directory; never overwritten')
    parser.add_argument('--supplements', type=Path, help='Reviewed exact-version upstream notice inventory')
    parser.add_argument('--require-complete', action='store_true', help='Fail if installed license texts are missing')
    args = parser.parse_args()
    if not args.node_root and not args.python:
        parser.error('Select --node-root and/or --python')
    if args.node_runtime_root and not args.node_root:
        parser.error('--node-runtime-root requires the matching full --node-root installation')
    packages = []
    if args.node_root:
        node = list(node_packages(args.node_root))
        if args.node_runtime_root:
            selected = runtime_node_identities(args.node_runtime_root)
            node = [item for item in node if (item[0]['name'], item[0]['version']) in selected and item[2] is None]
            missing = selected - {(item[0]['name'], item[0]['version']) for item in node}
            if missing:
                raise ValueError('Runtime packages have no exact installed/locked notice source: ' +
                                 ', '.join(name + '@' + version for name, version in sorted(missing)))
        packages.extend(node)
    if args.python:
        packages.extend(python_packages())
    receipt = collect(with_supplements(packages, args.supplements), args.output)
    print(json.dumps({'packages': len(receipt['packages']), 'missingInstalledTexts': receipt['missingInstalledTexts'],
                      'legalApproval': False}))
    return 1 if args.require_complete and receipt['missingInstalledTexts'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
