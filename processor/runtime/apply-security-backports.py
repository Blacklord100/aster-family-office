"""Apply reviewed upstream fixes with exact pre/post-image checks, never fuzzy patches.

Only the pinned build configuration is accepted. Build-system hunks in the
retained upstream patch are excluded; source changes and upstream tests are kept.
The upstream commit patches are HTTPS/hash authenticated, not signed releases.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def apply_backports(config, evidence, source):
    receipts = []
    for record in config['securityBackports']:
        patch = evidence / record['filename']
        if digest(patch) != record['sha256']:
            raise ValueError('Backport patch checksum mismatch')
        permitted = {item['path']: item for item in record['files']}
        if len(permitted) != len(record['files']):
            raise ValueError('Duplicate backport path')
        for name, item in permitted.items():
            parts = PurePosixPath(name).parts
            if (not parts or '..' in parts or PurePosixPath(name).is_absolute() or
                    parts[0] not in {'src', 'unittest'} or (source / name).is_symlink()):
                raise ValueError('Unsafe backport path')
            if digest(source / name) != item['beforeSha256']:
                raise ValueError('Backport does not match the exact reviewed source: ' + name)
        selected = []
        found = set()
        for section in re.split(r'(?=^diff --git )', patch.read_text(), flags=re.MULTILINE)[1:]:
            match = re.match(r'diff --git a/(\S+) b/(\S+)\n', section)
            if not match or match[1] != match[2]:
                raise ValueError('Unsupported upstream patch layout')
            name = match[1]
            if name in permitted:
                if name in found:
                    raise ValueError('Duplicate patch section')
                found.add(name)
                selected.append(section)
        if found != set(permitted):
            raise ValueError('Backport is missing reviewed source changes')
        with tempfile.NamedTemporaryFile(mode='w', suffix='.patch') as temporary:
            temporary.write(''.join(selected))
            temporary.flush()
            subprocess.run(['patch', '--batch', '--fuzz=0', '--forward', '-p1', '-i', temporary.name],
                           cwd=source, capture_output=True, text=True, check=True, timeout=30)
        for name, item in permitted.items():
            if digest(source / name) != item['afterSha256']:
                raise ValueError('Patched source differs from reviewed result: ' + name)
        receipts.append({key: record[key] for key in
                         ['cve', 'commit', 'url', 'sha256', 'authentication', 'files']})
    return {'schemaVersion': 1, 'component': 'tesseract', 'baseVersion': config['tesseract']['version'],
            'backports': receipts}


if __name__ == '__main__':
    config = json.loads(Path('/build/upstream-sources.json').read_text())
    receipt = apply_backports(config, Path('/build/source-provenance'),
                             Path('/build/sources') / config['tesseract']['directory'])
    Path('/build/security-backports.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(f'Applied {len(receipt["backports"])} reviewed upstream patches with exact source hashes')
