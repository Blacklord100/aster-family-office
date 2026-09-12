#!/usr/bin/env python3
"""Retain licenses, SPDX and strict vulnerability evidence for the exact installer.

The supplied govulncheck executable must be built from the pinned v1.8.0 module.
Its JSON output is retained, then an ordinary binary-mode invocation gates the
candidate: JSON mode by itself can return zero even when findings are present.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def scan_messages(raw):
    decoder, messages = json.JSONDecoder(), []
    while raw.strip():
        raw = raw.lstrip()
        message, end = decoder.raw_decode(raw)
        if not isinstance(message, dict):
            raise ValueError('Unexpected govulncheck message')
        messages.append(message)
        raw = raw[end:]
    configs = [m['config'] for m in messages if 'config' in m]
    if len(configs) != 1 or configs[0].get('scanner_name') != 'govulncheck' or configs[0].get('scanner_version') != 'v1.8.0':
        raise ValueError('Require complete output from pinned govulncheck v1.8.0')
    if configs[0].get('scan_mode') != 'binary' or configs[0].get('scan_level') != 'symbol':
        raise ValueError('Controller scan must inspect the built binary symbols')
    inventories = [m['SBOM'] for m in messages if 'SBOM' in m]
    if len(inventories) != 1 or not inventories[0].get('modules') or not inventories[0].get('roots'):
        raise ValueError('Controller binary scan inventory is absent')
    reachable = [m['finding'] for m in messages if any(frame.get('function') for frame in m.get('finding', {}).get('trace', []))]
    if reachable:
        raise ValueError('Controller binary contains reachable vulnerable symbols')
    return {'messageCount': len(messages), 'reachableFindings': 0, 'configuration': configs[0]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', required=True, type=Path)
    parser.add_argument('--go', required=True, type=Path)
    parser.add_argument('--govulncheck', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    for path in (args.binary, args.go, args.govulncheck):
        if not path.is_file() or path.is_symlink():
            raise ValueError('Exact regular binary/tool paths are required')
    binary, go, scanner, source = [p.resolve() for p in (args.binary, args.go, args.govulncheck, args.source)]
    before = digest(binary)
    args.output.mkdir(parents=True, exist_ok=False)
    output = args.output.resolve()
    subprocess.run([sys.executable, source / 'tools/release/collect-go-notices.py', '--binary', binary,
                    '--go', go, '--module-root', source / 'operations/appliance/cli', '--project-root', source,
                    '--output', output / 'notices'], check=True, timeout=300)
    with (output / 'govulncheck.json').open('x') as stream, (output / 'govulncheck-json.stderr').open('x') as errors:
        subprocess.run([scanner, '-mode=binary', '-json', binary], stdout=stream, stderr=errors, check=True, timeout=900)
    # Keep both outputs even when the strict invocation refuses a candidate.
    with (output / 'govulncheck.txt').open('x') as stream:
        subprocess.run([scanner, '-mode=binary', binary], stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=900)
    scan = scan_messages((output / 'govulncheck.json').read_text())
    notices = json.loads((output / 'notices/receipt.json').read_text())
    if digest(binary) != before or notices.get('binarySha256') != before:
        raise ValueError('Controller changed during evidence collection')
    receipt = {'schemaVersion': 1, 'type': 'aster-controller-security-gate-v1', 'result': 'passed',
               'binarySha256': before, 'binaryBytes': binary.stat().st_size,
               'scanner': 'govulncheck', 'scannerVersion': 'v1.8.0', 'scannerBinarySha256': digest(scanner),
               'strictBinaryScanExitCode': 0, 'scan': scan,
               'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
               'files': {p.relative_to(output).as_posix(): digest(p) for p in sorted(output.rglob('*')) if p.is_file()}}
    (output / 'security-gate.json').write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'result': receipt['result'], 'binarySha256': before, 'reachableFindings': 0}))


if __name__ == '__main__':
    main()
