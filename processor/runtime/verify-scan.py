"""Fail a release scan that loses runtime package identity or has HIGH/CRITICAL CVEs."""
import json
import argparse
import importlib.util
from pathlib import Path
import re
import sys


def version(package):
    value = package.get('Version', '')
    if package.get('Release'):
        value += '-' + package['Release']
    if package.get('Epoch'):
        value = str(package['Epoch']) + ':' + value
    return value


def normalized(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def verify(manifest, scan, lock, assessment=None):
    problems = []
    os_info = scan.get('Metadata', {}).get('OS', {})
    if os_info.get('Family') != 'debian' or os_info.get('Name', '').split('.')[0] != '13':
        problems.append('Trivy did not identify the actual Debian 13 runtime')
    results = scan.get('Results', [])
    os_packages = {(p['Name'], version(p)) for result in results if result.get('Class') == 'os-pkgs'
                   for p in result.get('Packages', [])}
    python_packages = {(normalized(p['Name']), version(p)) for result in results
                       if result.get('Type') == 'python-pkg' for p in result.get('Packages', [])}
    if manifest.get('schemaVersion') != 1 or not manifest.get('systemPackages'):
        problems.append('The built runtime manifest is missing or unsupported')
    for package in manifest.get('systemPackages', []):
        identity = (package['name'], package['version'])
        if identity not in os_packages:
            problems.append('Trivy lost copied Debian package: ' + '@'.join(identity))
    for line in lock.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        requirement, separator, marker = line.partition(';')
        if separator:
            if marker.strip() == 'sys_platform == "darwin"':
                continue
            problems.append('Unreviewed platform marker in runtime lock: ' + line)
            continue
        match = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s;]+)', requirement.strip())
        if not match:
            problems.append('Unpinned runtime requirement: ' + line)
        elif (normalized(match[1]), match[2]) not in python_packages:
            problems.append('Trivy lost locked Python package: ' + requirement.strip())
    vulnerabilities = [item for result in results for item in result.get('Vulnerabilities', [])
                       if item.get('Severity') in {'HIGH', 'CRITICAL'}]
    for item in vulnerabilities:
        print(' | '.join(str(item.get(key) or 'no published fix') for key in
                         ['Severity', 'PkgName', 'InstalledVersion', 'VulnerabilityID', 'FixedVersion']))
    if vulnerabilities and assessment is None:
        problems.append(f'{len(vulnerabilities)} HIGH/CRITICAL findings block release')
    if assessment is not None and (assessment.get('rawHighOrCritical') != len(vulnerabilities) or
                                   assessment.get('unassessedHighOrCritical') != 0):
        problems.append('Exact-image assessment does not cover the raw scan findings')
    if problems:
        raise ValueError('\n'.join(problems))
    return {'copiedSystemPackages': len(manifest['systemPackages']),
            'scannedSystemPackages': len(os_packages), 'scannedPythonPackages': len(python_packages),
            'highOrCritical': len(vulnerabilities),
            'unassessedHighOrCritical': 0,
            'artifactAssessmentApplied': assessment is not None}


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('manifest', type=Path)
        parser.add_argument('scan', type=Path)
        parser.add_argument('--runtime-attestation', type=Path)
        parser.add_argument('--image-id')
        parser.add_argument('--assessment-output', type=Path)
        args = parser.parse_args()
        runtime_root = Path(__file__).resolve().parent
        manifest, scan = json.loads(args.manifest.read_text()), json.loads(args.scan.read_text())
        assessment = None
        if any([args.runtime_attestation, args.image_id, args.assessment_output]):
            if not all([args.runtime_attestation, args.image_id, args.assessment_output]):
                raise ValueError('Exact-image assessment requires runtime attestation, image ID and output')
            spec = importlib.util.spec_from_file_location('assessment', runtime_root / 'security-assessment.py')
            assessor = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(assessor)
            assessment = assessor.assess(manifest, scan, json.loads(args.runtime_attestation.read_text()), args.image_id,
                                         json.loads((runtime_root / 'security-policy.json').read_text()),
                                         (runtime_root / 'upstream-sources.json').read_bytes(),
                                         (runtime_root / 'security-regression.cc').read_bytes())
        result = verify(manifest, scan, (runtime_root.parent / 'requirements.lock.txt').read_text(), assessment)
        if assessment:
            # No success receipt is written until both CVE and full inventory checks pass.
            args.assessment_output.write_text(json.dumps({**assessment, 'inventory': result}, indent=2) + '\n')
        print(json.dumps(result))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
