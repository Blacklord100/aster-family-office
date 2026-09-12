"""Run inside the exact read-only image before artifact-specific CVE assessment."""
import hashlib
import json
from pathlib import Path


def main():
    manifest = json.loads(Path('/opt/aster/runtime-manifest.json').read_text())
    evidence = manifest['securityBuild']
    actual = {}
    for name, expected in evidence['nativeFiles'].items():
        if name not in {'/opt/tesseract/bin/tesseract', '/opt/tesseract/lib/libtesseract.so.5',
                        '/opt/libtiff/lib/libtiff.so.6'}:
            raise ValueError('Unexpected native attestation path')
        actual[name] = hashlib.sha256(Path(name).read_bytes()).hexdigest()
        if actual[name] != expected:
            raise ValueError('Runtime native bytes differ from qualified build')
    for source in manifest['sourceProvenance']:
        path = Path(source['path']).resolve()
        if not path.is_relative_to('/opt/aster/source-provenance'):
            raise ValueError('Invalid provenance path')
        if hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']:
            raise ValueError('Runtime source provenance changed')
    # Check every retained package payload and actual executable directories;
    # the tiffcrop CLI is deliberately excluded from this runtime.
    if any('tiffcrop' in Path(file).name.lower() for package in manifest['systemPackages'] for file in package['files']):
        raise ValueError('The affected TIFF command-line tool is in the inventory')
    for root in [Path('/opt'), Path('/usr/bin'), Path('/usr/local/bin')]:
        if any('tiffcrop' in path.name.lower() for path in root.rglob('*')):
            raise ValueError('The affected TIFF command-line tool is present')
    print(json.dumps({'schemaVersion': 1,
                      'manifestSha256': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest(),
                      'nativeFiles': actual, 'tiffcropAbsent': True, 'provenanceVerified': True}))


if __name__ == '__main__':
    main()
