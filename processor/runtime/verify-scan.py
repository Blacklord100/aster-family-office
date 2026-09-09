"""Fail a release scan that loses runtime package identity or has HIGH/CRITICAL CVEs."""
import json
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


def verify(manifest, scan, lock):
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
    if vulnerabilities:
        problems.append(f'{len(vulnerabilities)} HIGH/CRITICAL findings block release')
    if problems:
        raise ValueError('\n'.join(problems))
    return {'copiedSystemPackages': len(manifest['systemPackages']),
            'scannedSystemPackages': len(os_packages), 'scannedPythonPackages': len(python_packages),
            'highOrCritical': 0}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Usage: verify-scan.py runtime-manifest.json processor-image-scan.json')
        result = verify(json.loads(Path(sys.argv[1]).read_text()), json.loads(Path(sys.argv[2]).read_text()),
                        (Path(__file__).resolve().parents[1] / 'requirements.lock.txt').read_text())
        print(json.dumps(result))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
