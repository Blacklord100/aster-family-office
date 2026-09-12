#!/usr/bin/env python3
"""Fail closed unless fresh raw scans cover every exact image in the release set."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--images', required=True, type=Path)
    parser.add_argument('--evidence', required=True, type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    inventory = json.loads((args.images / 'inventory.json').read_text())
    images = {i['service']: i['imageId'] for i in inventory['images']}
    if set(images) != {'app', 'processor', 'postgres', 'ollama', 'caddy'}:
        raise ValueError('All five exact image identities are required')
    records = []
    for service, image_id in images.items():
        path = args.evidence / f'{service}-scan.json'
        scan = json.loads(path.read_text())
        if scan.get('Metadata', {}).get('ImageID') != image_id:
            raise ValueError(f'Scan image identity mismatch: {service}')
        created = datetime.datetime.fromisoformat(scan['CreatedAt'].replace('Z', '+00:00'))
        age = (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds()
        if not -300 <= age <= 24 * 3600:
            raise ValueError(f'Security scan is stale or future dated: {service}')
        results = scan.get('Results', [])
        if not any(result.get('Packages') for result in results):
            raise ValueError(f'Scan omitted full package inventory: {service}')
        findings = [v for result in results for v in result.get('Vulnerabilities', [])
                    if v.get('Severity') in ('HIGH', 'CRITICAL')]
        if service == 'processor':
            subprocess.run(['python3', str(args.source / 'processor/runtime/verify-scan.py'),
                str(args.evidence / 'processor-runtime-manifest.json'), str(path),
                '--runtime-attestation', str(args.evidence / 'processor-runtime-security.json'),
                '--image-id', image_id, '--assessment-output', str(args.evidence / 'processor-assessment.json')], check=True)
        elif findings:
            raise ValueError(f'{service}: {len(findings)} unresolved HIGH/CRITICAL findings')
        records.append({'service': service, 'imageId': image_id, 'rawHighOrCritical': len(findings),
                        'scanSha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        sbom = json.loads((args.evidence / f'{service}.cdx.json').read_text())
        if sbom.get('bomFormat') != 'CycloneDX' or not sbom.get('components'):
            raise ValueError(f'Missing complete CycloneDX inventory: {service}')
    receipt = {'schemaVersion': 1, 'releaseId': inventory['releaseId'], 'result': 'passed',
               'imageIds': images, 'scans': records,
               'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    path = args.evidence / 'security-gate.json'
    if path.exists():
        raise ValueError('Never overwrite a previous security receipt')
    path.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'releaseId': inventory['releaseId'], 'result': 'passed', 'images': len(images)}))


if __name__ == '__main__':
    main()
