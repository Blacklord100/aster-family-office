"""Narrow exact-image dispositions; raw findings remain visible and unknowns fail closed."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re


def digest(data):
    return hashlib.sha256(data).hexdigest()


def assess(manifest, scan, runtime, image_id, policy, source_bytes, harness_bytes, now=None):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id or '') or scan.get('Metadata', {}).get('ImageID') != image_id:
        raise ValueError('Scan does not identify the exact candidate image')
    created = datetime.fromisoformat(scan['CreatedAt'].replace('Z', '+00:00'))
    now = now or datetime.now(timezone.utc)
    if not now - timedelta(hours=48) <= created <= now + timedelta(minutes=5):
        raise ValueError('Candidate scan evidence is stale or from the future')
    if runtime.get('manifestSha256') != digest(json.dumps(manifest, sort_keys=True).encode()):
        raise ValueError('Runtime attestation does not match the candidate manifest')
    build = manifest['securityBuild']
    source = json.loads(source_bytes)
    if (build.get('sourceConfigurationSha256') != digest(source_bytes) or
            build.get('harnessSha256') != digest(harness_bytes) or
            build.get('sourceFiles') != policy['sourceFiles']):
        raise ValueError('Security evidence differs from the reviewed source or regression harness')
    expected_backports = {'schemaVersion': 1, 'component': 'tesseract', 'baseVersion': source['tesseract']['version'],
                         'backports': [{key: item[key] for key in
                                       ['cve', 'commit', 'url', 'sha256', 'authentication', 'files']}
                                      for item in source['securityBackports']]}
    if build.get('backports') != expected_backports:
        raise ValueError('Missing or altered upstream security backports')
    if build.get('checks') != {'schemaVersion': 1, 'networkCases': 12, 'normprotoCases': 3,
                               'tiffCodecCases': 3, 'passed': True}:
        raise ValueError('Native security regressions did not pass with full coverage')
    expected_paths = {'/opt/tesseract/bin/tesseract', '/opt/tesseract/lib/libtesseract.so.5.5',
                      '/opt/libtiff/lib/libtiff.so.6'}
    files = build.get('nativeFiles', {})
    if (set(files) != expected_paths or any(not re.fullmatch(r'[0-9a-f]{64}', value) for value in files.values()) or
            runtime.get('nativeFiles') != files or runtime.get('tiffcropAbsent') is not True or
            runtime.get('provenanceVerified') is not True):
        raise ValueError('Runtime native payload or absent-tool evidence is incomplete')
    for name in ['tesseract', 'libtiff']:
        if manifest[name]['sourceArchives'] != [{key: source[name][key] for key in ['filename', 'sha256', 'url']}]:
            raise ValueError('Native source archive identity changed')
    approved = {(item['cve'], item['package'], item['installedVersion']): item for item in policy['findings']}
    assessments = []
    for result in scan.get('Results', []):
        for item in result.get('Vulnerabilities', []):
            if item.get('Severity') not in {'HIGH', 'CRITICAL'}:
                continue
            key = (item.get('VulnerabilityID'), item.get('PkgName'), item.get('InstalledVersion'))
            # A changed advisory severity or a different package/version requires review.
            if key not in approved or item.get('Severity') != 'HIGH' or result.get('Class') != 'os-pkgs':
                raise ValueError('Unassessed HIGH/CRITICAL finding blocks release: ' + str(key))
            assessments.append({**approved[key], 'rawSeverity': item['Severity'], 'imageID': image_id})
    return {'schemaVersion': 1, 'type': 'aster-exact-image-security-assessment-v1',
            'imageID': image_id, 'scanCreatedAt': scan['CreatedAt'],
            'scanSha256': digest(json.dumps(scan, sort_keys=True).encode()),
            'manifestSha256': runtime['manifestSha256'], 'rawHighOrCritical': len(assessments),
            'unassessedHighOrCritical': 0, 'assessments': assessments}
