#!/usr/bin/env python3
"""Make only the freshly downloaded public model fixture readable by UID10001."""
import argparse
import json
import os
from pathlib import Path
import stat


def prepare(root, inventory):
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Expected a regular bounded model fixture directory')
    paths = [root, *root.rglob('*')]
    expected = {item['path']: item for item in inventory['files']}
    actual = set()
    for path in paths:
        info = path.lstat()
        if path.is_symlink() or (not stat.S_ISDIR(info.st_mode) and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)):
            raise ValueError('Bounded cache must contain only independent regular assets')
        if path.is_file():
            name = path.relative_to(root).as_posix()
            if name not in expected or info.st_size != expected[name]['size']:
                raise ValueError('Bounded cache differs from the complete downloaded inventory')
            actual.add(name)
    if actual != set(expected):
        raise ValueError('Bounded cache omits downloaded model assets')
    for path in paths:
        # The only mount is /models (read-only); source bytes and owner stay fixed.
        os.chmod(path, 0o755 if path.is_dir() else 0o444)
    return {'result': 'prepared-public-model-fixture', 'directories': sum(p.is_dir() for p in paths),
            'files': len(actual), 'directoryMode': '0755', 'fileMode': '0444', 'containerUID': 10001}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, type=Path)
    args = parser.parse_args()
    expected = Path(os.environ['RUNNER_TEMP']) / 'aster-model-smoke/model'
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or args.model.absolute() != expected.absolute():
        raise ValueError('Only this hosted job’s newly downloaded model fixture may be prepared')
    if args.model.is_symlink():
        raise ValueError('The downloaded fixture directory must not be a symlink')
    receipt = prepare(args.model / 'ollama', json.loads((args.model / 'inventory.json').read_text()))
    (args.model.parent / 'cache-permissions.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
