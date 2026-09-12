#!/usr/bin/env python3
"""Actually sign, verify, package and unpack tiny bytes with the built native CLI.

No images, models, financial records or container services are executed. All test
keys are temporary, and the bootstrap root remains outside the transport bundle.
"""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import sys

from test_packaging import Packaging, ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asterctl', required=True, type=Path)
    args = parser.parse_args()
    cli = args.asterctl.resolve(strict=True)
    fixture = Packaging()
    fixture.setUp()
    try:
        subprocess.run(fixture.inputs(), check=True, capture_output=True, text=True)
        bundle, keys = fixture.root / 'bundle', fixture.root / 'test-only-keys'
        def run(*command):
            result = subprocess.run([str(x) for x in command], capture_output=True, text=True)
            if result.returncode:
                raise ValueError(result.stderr[-1500:])
            return result
        run(cli, 'init-trust', '--keys', keys)
        expiry = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
        run(cli, 'sign', '--bundle', bundle, '--keys', keys, '--sequence', '1', '--expires', expiry)
        if (bundle / 'metadata/root.json').exists():
            raise ValueError('Do not fabricate an in-bundle bootstrap trust root')
        run(cli, 'verify', '--bundle', bundle, '--trust-root', keys / 'root.json',
            '--trust-root-sha256', (keys / 'root.sha256').read_text().strip())
        run(sys.executable, ROOT / 'scripts/pack-bundle.py', '--bundle', bundle, '--output', fixture.root / 'media', '--part-mib', '1')
        transport = json.loads((fixture.root / 'media/parts.json').read_text())
        unpacked = fixture.root / 'unpacked'
        run(cli, 'unpack', '--input', fixture.root / 'media/parts.json', '--output', unpacked,
            '--trust-root', keys / 'root.json', '--trust-root-sha256', (keys / 'root.sha256').read_text().strip(),
            '--max-unpack-gib', '1')
        if (unpacked / 'release.json').read_bytes() != (bundle / 'release.json').read_bytes():
            raise ValueError('Unpacked release manifest differs from the signed input')
        verified = json.loads(run(cli, 'verify', '--bundle', unpacked, '--trust-root', keys / 'root.json',
            '--trust-root-sha256', (keys / 'root.sha256').read_text().strip()).stdout)
        manifest = json.loads((bundle / 'release.json').read_text())
        if (verified.get('ok') is not True or verified.get('releaseId') != manifest['releaseId']
                or verified.get('sequence') != manifest['sequence'] or verified.get('files') != len(manifest['files'])):
            raise ValueError('Unpacked release did not pass independent external-root verification')
        print(json.dumps({'result': 'passed-real-cli-sign-pack-unpack-verify-contract', 'scope': 'Tiny synthetic byte fixture; no image/model execution',
                          'parts': len(transport['parts']), 'bootstrapRootExternal': True,
                          'unpackedReleaseVerified': True, 'verifiedFiles': verified['files']}))
    finally:
        fixture.tearDown()


if __name__ == '__main__':
    main()
