"""Verify detached custom processor sources against the exact local image.

No fetching, extraction or model execution. This deliberately covers only the
three custom source builds; distro packages and other wheel/image gaps remain.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]


def exporter():
    spec = importlib.util.spec_from_file_location('processor_source_export', ROOT / 'processor/runtime/export-sources.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def verify_material(evidence, processor_source):
    module = exporter()
    manifest_path = module.regular(evidence, 'source-manifest.json')
    manifest = module.read_json(manifest_path)
    if (manifest.get('schemaVersion') != 1 or manifest.get('type') != module.TYPE
            or manifest.get('scope') != ['tesseract', 'libtiff', 'pillow']
            or manifest.get('limits') != {'otherDistroPackages': False, 'otherWheels': False, 'reproducibleBuild': False}):
        raise ValueError('Unexpected custom processor source coverage')
    actual = [item for item in module.files(evidence) if item['path'] not in
              {'source-manifest.json', 'runtime-attestation.json', 'receipt.json'}]
    if actual != manifest.get('files'):
        raise ValueError('Retained custom source files differ from the complete manifest')
    reviewed_lock_path = module.regular(processor_source, 'runtime/upstream-sources.json')
    lock = module.read_json(reviewed_lock_path)
    expected_sources = module.source_records(lock)
    if manifest.get('sources') != expected_sources:
        raise ValueError('Custom source inventory differs from reviewed original sources')
    expected_names = {'build/' + name for name in module.BUILD_EVIDENCE}
    expected_names |= {'build/dpkg-status', 'build/runtime-manifest.json'}
    for source in expected_sources:
        name = 'archives/' + source['filename']
        if module.sha(module.regular(evidence, name)) != source['sha256']:
            raise ValueError('Original source archive differs from reviewed checksum')
        expected_names.add(name)
    for item in module.recipe_files(processor_source):
        name = 'recipe/' + item['path']
        if module.record(evidence, name) != {**item, 'path': name}:
            raise ValueError('Retained build recipe differs from reviewed repository inputs')
        expected_names.add(name)
    if {item['path'] for item in actual} != expected_names:
        raise ValueError('Incomplete custom source archives, build evidence or recipe')
    for item in lock['provenanceFiles'] + lock['securityBackports']:
        if module.sha(module.regular(evidence, 'recipe/runtime/source-provenance/' + item['filename'])) != item['sha256']:
            raise ValueError('Retained authentication or patch differs from reviewed checksum')
    runtime_path = module.regular(evidence, 'build/runtime-manifest.json')
    runtime = module.read_json(runtime_path)
    if (module.sha(runtime_path) != manifest.get('runtimeManifestSha256') or
            runtime.get('securityBuild') != module.read_json(module.regular(evidence, 'build/security-build.json')) or
            runtime['securityBuild']['sourceConfigurationSha256'] != module.sha(reviewed_lock_path) or
            runtime['securityBuild']['harnessSha256'] != module.sha(module.regular(processor_source, 'runtime/security-regression.cc'))):
        raise ValueError('Retained build evidence differs from runtime or reviewed source identities')
    return manifest


def verify_receipt(evidence, image_id, processor_source):
    module = exporter()
    manifest = verify_material(evidence, processor_source)
    receipt = module.read_json(module.regular(evidence, 'receipt.json'))
    attestation_path = module.regular(evidence, 'runtime-attestation.json')
    attestation = module.read_json(attestation_path)
    digest = module.sha(module.regular(evidence, 'source-manifest.json'))
    if (not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id)
            or receipt != {'schemaVersion': 1, 'type': module.TYPE + '-receipt',
                           'result': 'source-materials-verified', 'processorImageId': image_id,
                           'sourceManifestSha256': digest,
                           'runtimeAttestationSha256': module.sha(attestation_path),
                           'sourceArchiveCount': 3, 'buildDependencyCount': len(manifest['sources']) - 3,
                           'retainedFiles': len(manifest['files']),
                           'retainedBytes': sum(item['bytes'] for item in manifest['files'])}
            or attestation != {'schemaVersion': 1, 'type': module.TYPE + '-attestation',
                               'sourceManifestSha256': digest, 'runtimeManifestSha256': manifest['runtimeManifestSha256'],
                               'installedFiles': manifest['installedFiles'], 'result': 'verified'}):
        raise ValueError('Custom source receipt must match the exact image and its native attestation')
    return receipt


def collect(evidence, image_id, processor_source, output):
    module = exporter()
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise ValueError('An immutable exact processor image ID is required')
    manifest = verify_material(evidence, processor_source)
    if output.exists() or output.is_symlink():
        raise ValueError('Refusing an existing custom source collection')
    frozen = module.files(evidence)
    if any(item['path'] in ('receipt.json', 'runtime-attestation.json') for item in frozen):
        raise ValueError('Collect only a fresh builder export, never an adopted receipt')
    # Mount only a checked manifest file. BuildKit's host export root may be
    # private to the builder UID, while the service image runs as UID 10001.
    # No source directory permissions are changed or unrelated bytes exposed.
    with tempfile.TemporaryDirectory(prefix='aster-custom-source-attestation-') as directory:
        mounted = Path(directory) / 'source-manifest.json'
        mounted.write_bytes(module.regular(evidence, 'source-manifest.json').read_bytes())
        mounted.chmod(0o444)
        if module.record(mounted.parent, mounted.name) != next(item for item in frozen if item['path'] == mounted.name):
            raise ValueError('Custom source manifest changed before exact-image verification')
        # The mounted verifier is reviewed local code, not a script from the export.
        command = ['docker', 'run', '--rm', '--read-only', '--network', 'none', '--cap-drop', 'ALL',
                   '--security-opt', 'no-new-privileges', '--entrypoint', 'python',
                   '--mount', f'type=bind,src={mounted},dst=/opt/aster/source-manifest-to-verify.json,readonly',
                   '--mount', f'type=bind,src={(ROOT / "processor/runtime/export-sources.py").resolve()},dst=/opt/aster/verify-custom-sources.py,readonly',
                   image_id, '/opt/aster/verify-custom-sources.py', 'attest',
                   '--manifest', '/opt/aster/source-manifest-to-verify.json']
        try:
            result = subprocess.run(command, check=False, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError('Exact-image custom source attestation exceeded its 120 second limit') from error
        if result.returncode != 0:
            raise RuntimeError(f'Exact-image custom source attestation exited {result.returncode}\n'
                               f'stdout (last 4096 characters):\n{result.stdout[-4096:]}\n'
                               f'stderr (last 8192 characters):\n{result.stderr[-8192:]}')
    if len(result.stdout) > 4 * 1024**2:
        raise ValueError('Exact-image custom source attestation is too large')
    attestation = json.loads(result.stdout)
    output.mkdir(parents=True)
    for item in frozen:
        source = module.regular(evidence, item['path'])
        target = output / item['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o644)
        if module.record(output, item['path']) != item:
            raise ValueError('Custom source changed during collection')
    (output / 'runtime-attestation.json').write_text(json.dumps(attestation, sort_keys=True, indent=2) + '\n')
    receipt = {'schemaVersion': 1, 'type': module.TYPE + '-receipt', 'result': 'source-materials-verified',
               'processorImageId': image_id, 'sourceManifestSha256': module.sha(output / 'source-manifest.json'),
               'runtimeAttestationSha256': module.sha(output / 'runtime-attestation.json'),
               'sourceArchiveCount': 3, 'buildDependencyCount': len(manifest['sources']) - 3,
               'retainedFiles': len(manifest['files']), 'retainedBytes': sum(item['bytes'] for item in manifest['files'])}
    (output / 'receipt.json').write_text(json.dumps(receipt, sort_keys=True, indent=2) + '\n')
    verify_receipt(output, image_id, processor_source)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--export', dest='evidence', type=Path, required=True)
    parser.add_argument('--image-id', required=True)
    parser.add_argument('--source', type=Path, default=ROOT / 'processor')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if not args.verify and args.output is None:
        parser.error('--output is required for collection')
    print(json.dumps(verify_receipt(args.evidence, args.image_id, args.source) if args.verify else
                     collect(args.evidence, args.image_id, args.source, args.output)))


if __name__ == '__main__':
    main()
