#!/usr/bin/env python3
"""Stage a complete, unsigned appliance directory; asterctl signs release.json.

Inputs are explicit immutable artifacts. This script never fetches a dependency,
reaches a model server, runs a release binary, or silently creates missing assets.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys

FROZEN_INPUTS = {}

def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def relative(value):
    if not isinstance(value, str) or '\\' in value or ':' in value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError('Invalid asset path')
    p = PurePosixPath(value)
    if p.is_absolute() or not p.parts or any(x in ('', '.', '..') for x in value.split('/')):
        raise ValueError('Asset path must be canonical and relative')
    return p


def checked_file(root, name, expected_hash=None, expected_size=None):
    p = root
    for part in relative(name).parts:
        p = p / part
        if p.is_symlink():
            raise ValueError(f'Symlinks are not allowed in payload inputs: {name}')
    info = p.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError(f'Expected an independent regular file: {name}')
    if expected_size is not None and info.st_size != expected_size:
        raise ValueError(f'Asset length mismatch: {name}')
    actual_hash = sha256(p)
    if expected_hash is not None and actual_hash != expected_hash:
        raise ValueError(f'Asset hash mismatch: {name}')
    identity = (actual_hash, info.st_size)
    if FROZEN_INPUTS.setdefault(str(p.absolute()), identity) != identity:
        raise ValueError(f'Asset changed after validation: {name}')
    return p


def copy_file(source, destination, executable=False):
    checked_file(source.parent, source.name)
    expected = FROZEN_INPUTS[str(source.absolute())]
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise ValueError(f'Duplicate payload path: {destination.name}')
    shutil.copyfile(source, destination)
    if (sha256(destination), destination.stat().st_size) != expected:
        raise ValueError(f'Copied asset changed after validation: {source.name}')
    os.chmod(destination, 0o755 if executable else 0o644)


def copy_tree(source, destination):
    count = 0
    for source_file in sorted(source.rglob('*')):
        if source_file.is_symlink():
            raise ValueError('Payload trees must not include symbolic links')
        if source_file.is_dir():
            continue
        name = source_file.relative_to(source).as_posix()
        checked_file(source, name)
        copy_file(source_file, destination / name, executable=bool(source_file.stat().st_mode & 0o111))
        count += 1
    if not count:
        raise ValueError(f'Required payload directory is empty: {source.name}')


def controller_evidence(root, binary):
    gate = json.loads(checked_file(root, 'security-gate.json').read_text())
    if (gate.get('schemaVersion') != 1 or gate.get('type') != 'aster-controller-security-gate-v1'
            or gate.get('result') != 'passed' or gate.get('strictBinaryScanExitCode') != 0
            or gate.get('binarySha256') != sha256(binary) or gate.get('binaryBytes') != binary.stat().st_size):
        raise ValueError('Controller security receipt must cover the exact installer binary')
    expected = {'govulncheck.json', 'govulncheck.txt', 'notices/receipt.json',
                'notices/inventory.json', 'notices/controller.spdx.json', 'notices/build-info.json'}
    files = gate.get('files', {})
    if not isinstance(files, dict) or not expected.issubset(files):
        raise ValueError('Controller scan, notices and SPDX evidence are incomplete')
    for name, digest in files.items():
        if not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('Invalid controller evidence hash')
        checked_file(root, name, digest)
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()} - {'security-gate.json'}
    if actual != set(files):
        raise ValueError('Controller evidence inventory differs from the retained files')
    notices = json.loads((root / 'notices/receipt.json').read_text())
    if (notices.get('type') != 'aster-go-binary-notice-inventory-v1' or notices.get('binarySha256') != gate['binarySha256']
            or notices.get('spdxSha256') != files['notices/controller.spdx.json']
            or notices.get('licenseInventorySha256') != files['notices/inventory.json']):
        raise ValueError('Controller notice receipt does not match the exact installer and SPDX inventory')
    spec = importlib.util.spec_from_file_location('controller_scan', Path(__file__).with_name('collect-controller.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.scan_messages((root / 'govulncheck.json').read_text())


def image_evidence(root, image_inventory, processor_source=None):
    gate = json.loads(checked_file(root, 'security-gate.json').read_text())
    images = {i['service']: i['imageId'] for i in image_inventory['images']}
    records = gate.get('scans', [])
    if (gate.get('result') != 'passed' or gate.get('releaseId') != image_inventory['releaseId']
            or gate.get('imageIds') != images or len(records) != 5 or {r.get('service') for r in records} != set(images)):
        raise ValueError('Passing image evidence must include all five exact image scans')
    for record in records:
        service = record['service']
        scan_path = checked_file(root, f'{service}-scan.json', record.get('scanSha256'))
        sbom_path = checked_file(root, f'{service}.cdx.json', record.get('sbomSha256'))
        if not all(re.fullmatch(r'[0-9a-f]{64}', record.get(k, '')) for k in ('scanSha256', 'sbomSha256')):
            raise ValueError('Image evidence lacks raw scan/SBOM hashes')
        scan, sbom = json.loads(scan_path.read_text()), json.loads(sbom_path.read_text())
        if scan.get('Metadata', {}).get('ImageID') != images[service] or record.get('imageId') != images[service]:
            raise ValueError('Raw scan does not identify the exact image')
        created = datetime.datetime.fromisoformat(scan['CreatedAt'].replace('Z', '+00:00'))
        if not -300 <= (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds() <= 86400:
            raise ValueError('Image scan is stale or future dated')
        if not any(r.get('Packages') for r in scan.get('Results', [])) or sbom.get('bomFormat') != 'CycloneDX' or not sbom.get('components'):
            raise ValueError('Raw scan/SBOM package inventory is missing')
        findings = [v for r in scan.get('Results', []) for v in r.get('Vulnerabilities', []) if v.get('Severity') in ('HIGH', 'CRITICAL')]
        if record.get('rawHighOrCritical') != len(findings) or (service != 'processor' and findings):
            raise ValueError('Unresolved image findings differ from the passing receipt')
        if service == 'processor':
            names = {'processor-runtime-manifest.json', 'processor-runtime-security.json', 'processor-assessment.json'}
            if set(gate.get('processorEvidence', {})) != names:
                raise ValueError('Exact processor assessment inputs are missing')
            for name, digest in gate['processorEvidence'].items():
                if not re.fullmatch(r'[0-9a-f]{64}', digest):
                    raise ValueError('Invalid processor evidence hash')
                checked_file(root, name, digest)
            assessment = json.loads((root / 'processor-assessment.json').read_text())
            manifest = json.loads((root / 'processor-runtime-manifest.json').read_text())
            runtime = json.loads((root / 'processor-runtime-security.json').read_text())
            manifest_sha = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
            if (assessment.get('type') != 'aster-exact-image-security-assessment-v1' or assessment.get('imageID') != images[service]
                    or assessment.get('scanSha256') != hashlib.sha256(json.dumps(scan, sort_keys=True).encode()).hexdigest()
                    or assessment.get('manifestSha256') != manifest_sha or runtime.get('manifestSha256') != manifest_sha
                    or assessment.get('rawHighOrCritical') != len(findings) or assessment.get('unassessedHighOrCritical') != 0
                    or len(assessment.get('assessments', [])) != len(findings)):
                raise ValueError('Processor assessment is not bound to the exact raw scan/runtime inputs')
            runtime_root = Path(__file__).resolve().parents[3] / 'processor/runtime'
            reviewed_runtime = (processor_source / 'runtime') if processor_source else runtime_root
            modules = {}
            for name in ('security-assessment', 'verify-scan'):
                spec = importlib.util.spec_from_file_location(name, runtime_root / (name + '.py'))
                modules[name] = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(modules[name])
            rechecked = modules['security-assessment'].assess(manifest, scan, runtime, images[service],
                json.loads((reviewed_runtime / 'security-policy.json').read_text()),
                (reviewed_runtime / 'upstream-sources.json').read_bytes(), (reviewed_runtime / 'security-regression.cc').read_bytes())
            rechecked['inventory'] = modules['verify-scan'].verify(manifest, scan,
                (reviewed_runtime.parent / 'requirements.lock.txt').read_text(), rechecked)
            if assessment != rechecked:
                raise ValueError('Retained processor assessment differs from independent current-policy verification')


def native_source_evidence(root, image_id, policy_root):
    receipt = json.loads(checked_file(root, 'receipt.json').read_text())
    lock_file = checked_file(root, 'source-lock.json', receipt.get('sourceLockSha256'))
    lock = json.loads(lock_file.read_text())
    if (receipt.get('schemaVersion') != 1 or receipt.get('type') != 'aster-sharp-native-source-receipt-v1'
            or receipt.get('result') != 'source-materials-verified' or receipt.get('appImageId') != image_id
            or lock.get('schemaVersion') != 1 or lock.get('type') != 'aster-sharp-native-source-lock-v1' or lock.get('runtime', {}).get('appImageId') != image_id
            or not re.fullmatch(r'[0-9a-f]{64}', receipt.get('sourceLockSha256', ''))
            or receipt.get('runtimePackage') != lock['runtime'].get('runtimePackage')
            or not receipt.get('nativeFiles') or receipt['nativeFiles'] != lock['runtime'].get('nativeFiles')):
        raise ValueError('Native source receipt must cover the exact application image and native files')
    sources, material, notices = lock.get('sources', []), lock.get('material', []), receipt.get('notices', [])
    spec = importlib.util.spec_from_file_location('native_policy', Path(__file__).resolve().parents[3] / 'tools/release/collect-native-sources.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    policy, expected_material, crates = module.load_policy(policy_root)
    if lock.get('policySha256') != sha256(policy_root / 'source-policy.json') or material != expected_material:
        raise ValueError('Native source receipt differs from the reviewed repository policy or recipe')
    supplements = module.expected_supplements(policy, crates)
    if (lock.get('noticeSupplements', []) != supplements or receipt.get('noticeSupplements', []) != supplements
            or lock.get('unresolvedNotices', [])):
        raise ValueError('Native source original notice supplements are changed or unresolved')
    expected_sources = module.expected_records(policy, crates)
    if len(sources) != len(expected_sources) or any(any(actual.get(k) != v for k, v in expected.items()) for actual, expected in zip(sources, expected_sources)):
        raise ValueError('Native source receipt omits or changes reviewed transitive source coverage')
    if not sources or not material or not notices or len(sources) != receipt.get('sourceArchiveCount') or len(sources) != lock.get('sourceArchiveCount'):
        raise ValueError('Native source closure or retained notices are incomplete')
    if (sum(s.get('kind') == 'native-source' for s in sources) != receipt.get('nativeSourceCount')
            or sum(s.get('kind') == 'cargo-source' for s in sources) != receipt.get('cargoSourceCount')
            or any(s.get('kind') not in ('native-source', 'cargo-source') for s in sources)):
        raise ValueError('Native source transitive inventory differs from its verification receipt')
    retained = {'receipt.json', 'source-lock.json'}
    supplement_files = module.supplemental_materials(supplements)
    for item, prefix, field in [(i, 'reviewed-recipe/', 'path') for i in material] + [(i, '', 'path') for i in sources + [lock['registryArchive']] + supplement_files] + [(i, '', 'file') for i in notices]:
        name = prefix + item[field]
        if not re.fullmatch(r'[0-9a-f]{64}', item.get('sha256', '')) or not isinstance(item.get('bytes'), int) or item['bytes'] <= 0:
            raise ValueError('Native source material hash/length is missing')
        checked_file(root, name, item['sha256'], item['bytes'])
        retained.add(name)
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    if actual != retained:
        raise ValueError('Native source retained files differ from the complete receipt inventory')
    for supplement in supplements:
        record = next(x for x in expected_sources if x['kind'] == 'cargo-source'
                      and (x['name'], x['version']) == (supplement['name'], supplement['version']))
        texts = module.source_notices(checked_file(root, record['path']), record, policy, policy_root, root, supplements)
        for original, data in texts:
            digest = hashlib.sha256(data).hexdigest()
            expected = {'source': record['path'], 'originalPath': original, 'file': 'notices/' + digest + '.txt',
                        'sha256': digest, 'bytes': len(data)}
            if expected not in notices:
                raise ValueError('Original supplemental notice is missing from the independently checked receipt')


def processor_source_evidence(root, image_id, processor_source, raw_runtime_manifest):
    spec = importlib.util.spec_from_file_location('processor_source_collection', Path(__file__).with_name('collect-processor-sources.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.verify_receipt(root, image_id, processor_source)
    if module.exporter().read_json(root / 'build/runtime-manifest.json') != module.exporter().read_json(raw_runtime_manifest):
        raise ValueError('Custom source runtime manifest differs from exact-image security evidence')
    # Freeze every validated byte so a changed source cannot be adopted on copy.
    for item in module.exporter().files(root):
        checked_file(root, item['path'], item['sha256'], item['bytes'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', required=True, type=Path)
    parser.add_argument('--images', required=True, type=Path)
    parser.add_argument('--runtime', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--compliance', required=True, type=Path,
                        help='Reviewed licenses/ and sbom/ directories, including security-gate.json')
    parser.add_argument('--asterctl', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text())
    if spec.get('schemaVersion') != 1 or spec.get('platform') != {'os': 'linux', 'arch': 'amd64'}:
        raise ValueError('Require schemaVersion1 and linux/amd64')
    if spec.get('ingress') != 'systemd-unix-v1':
        raise ValueError('Current appliance profiles require systemd-unix-v1 ingress')
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,79}', spec.get('releaseId', '')):
        raise ValueError('Invalid release ID')
    if spec.get('channel') not in ('stable', 'preview') or not isinstance(spec.get('sequence'), int) or spec['sequence'] < 1:
        raise ValueError('Invalid release channel or sequence')
    schema = spec['schema']
    if not all(isinstance(schema.get(k), int) for k in ('min', 'max', 'target')) or not (1 <= schema['min'] <= schema['target'] <= schema['max']):
        raise ValueError('Invalid schema compatibility range')
    image_inventory = json.loads(checked_file(args.images, 'inventory.json').read_text())
    if image_inventory['releaseId'] != spec['releaseId'] or image_inventory['platform'] != 'linux/amd64':
        raise ValueError('Image set belongs to another release or platform')
    if {i['service'] for i in image_inventory['images']} != {'app', 'processor', 'postgres', 'ollama', 'caddy'} or len(image_inventory['images']) != 5:
        raise ValueError('The complete five-image set is required')
    runtime = json.loads(checked_file(args.runtime, 'inventory.json').read_text())
    if any(runtime.get(k) != v for k, v in {'kind': 'ubuntu-deb', 'os': 'ubuntu', 'version': '24.04', 'arch': 'amd64'}.items()):
        raise ValueError('Incorrect runtime target')
    if not {'docker.io', 'docker-compose-v2', 'containerd', 'runc', 'iptables', 'openssl'}.issubset({p['name'] for p in runtime['packages']}):
        raise ValueError('Incomplete runtime package inventory')
    model = json.loads(checked_file(args.model, 'inventory.json').read_text())
    if model.get('format') != 'ollama-cache-v2' or not re.fullmatch(r'sha256:[0-9a-f]{64}', model['digest']):
        raise ValueError('Expected a digest-pinned complete native Ollama cache')
    required_layers = {'manifest', 'application/vnd.ollama.image.model', 'application/vnd.ollama.image.projector', 'application/vnd.ollama.image.license'}
    if not required_layers.issubset({item['kind'] for item in model['files']}):
        raise ValueError('Missing model manifest, weights, projector or license')
    module_spec = importlib.util.spec_from_file_location('model_export', Path(__file__).with_name('export-model.py'))
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    inspected = module.inspect_model(args.model / 'ollama', model['name'])
    if inspected['digest'] != model['digest'] or inspected['files'] != model['files']:
        raise ValueError('Model inventory omits or changes an original manifest layer')
    gate = json.loads((args.compliance / 'sbom/security-gate.json').read_text())
    if gate.get('result') != 'passed' or gate.get('releaseId') != spec['releaseId']:
        raise ValueError('A passing security receipt for this exact release is required')
    expected_ids = {i['service']: i['imageId'] for i in image_inventory['images']}
    if gate.get('imageIds') != expected_ids:
        raise ValueError('Security receipt does not cover the exact five image IDs')
    image_evidence(args.compliance / 'sbom', image_inventory, args.source / 'processor')
    # Validate the entire input before creating any output.
    for item in image_inventory['images']:
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', item['imageId']):
            raise ValueError('Invalid image ID')
        checked_file(args.images, item['path'], item['sha256'], item['size'])
    for item in runtime['packages']:
        checked_file(args.runtime, item['path'], item['sha256'], item['size'])
    for item in model['files']:
        checked_file(args.model / 'ollama', item['path'], item['sha256'], item['size'])
    checked_file(args.model, 'Modelfile')
    checked_file(args.asterctl.parent, args.asterctl.name)
    # ELF class64, little-endian, EM_X86_64. A macOS helper is not a Linux installer.
    header = args.asterctl.read_bytes()[:20]
    if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\x3e\x00':
        raise ValueError('asterctl must be a Linux amd64 executable')
    controller_evidence(args.compliance / 'controller', args.asterctl)
    native_policy_root = args.source / 'licenses/native/sharp-libvips-1.3.3'
    native_source_evidence(args.compliance / 'licenses/native-sources', expected_ids['app'], native_policy_root)
    processor_source_evidence(args.compliance / 'licenses/processor-custom-sources', expected_ids['processor'], args.source / 'processor', args.compliance / 'sbom/processor-runtime-manifest.json')
    if args.output.exists():
        raise ValueError('Refusing an existing bundle directory')
    args.output.mkdir(parents=True)
    payload = args.output / 'payload'
    copy_tree(args.source / 'operations/appliance/config', payload / 'config')
    for source, target in [('operations/postgres/10-roles.sh', 'postgres/10-roles.sh'),
                           ('operations/scripts/processor-entrypoint.py', 'scripts/processor-entrypoint.py')]:
        copy_file(args.source / source, payload / 'config' / target)
    copy_file(args.asterctl, payload / 'bin/asterctl', executable=True)
    copy_tree(args.compliance / 'licenses', payload / 'licenses')
    for name in ('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'):
        copy_file(args.source / name, payload / 'licenses/project' / name)
    copy_tree(args.source / 'licenses', payload / 'licenses/project/third-party')
    copy_tree(args.compliance / 'sbom', payload / 'sbom')
    copy_tree(args.compliance / 'controller', payload / 'sbom/controller')
    for name, root in [('images', args.images), ('runtime', args.runtime), ('models', args.model)]:
        copy_file(root / 'inventory.json', payload / name / 'inventory.json')
    images = []
    for item in image_inventory['images']:
        target = 'payload/images/' + item['path']
        copy_file(args.images / item['path'], args.output / target)
        images.append({k: (target if k == 'path' else item[k]) for k in ('service', 'path', 'reference', 'imageId')})
    packages = []
    for item in runtime['packages']:
        target = 'payload/runtime/' + item['path']
        copy_file(args.runtime / item['path'], args.output / target)
        packages.append({k: (target if k == 'path' else item[k]) for k in ('name', 'version', 'architecture', 'path', 'sha256')})
    model_files = []
    for item in model['files']:
        target = 'payload/models/ollama/' + item['path']
        copy_file(args.model / 'ollama' / item['path'], args.output / target)
        model_files.append(target)
    copy_file(args.model / 'Modelfile', payload / 'models/Modelfile')
    copy_tree(args.source / 'operations/appliance/vm', payload / 'vm')
    copy_file(args.source / 'operations/appliance/README.md', payload / 'docs/README.md')
    copy_file(args.source / 'operations/appliance/cli/README.md', payload / 'docs/operator-cli.md')
    copy_file(args.source / 'operations/appliance/recovery.md', payload / 'docs/recovery.md')
    # Re-evaluate the copied artifacts; a passing input receipt does not authorize
    # a source file to change while staging is in progress.
    image_evidence(payload / 'sbom', image_inventory, args.source / 'processor')
    controller_evidence(payload / 'sbom/controller', payload / 'bin/asterctl')
    native_source_evidence(payload / 'licenses/native-sources', expected_ids['app'], payload / 'licenses/project/third-party/native/sharp-libvips-1.3.3')
    processor_source_evidence(payload / 'licenses/processor-custom-sources', expected_ids['processor'], args.source / 'processor', payload / 'sbom/processor-runtime-manifest.json')
    (payload / 'docs/distribution-status.json').write_text(json.dumps({
        'schemaVersion': 1, 'distributionReady': False, 'scope': 'Internal signed test candidate only',
        'remainingObligations': ['Corresponding-source closure for OS packages and runtime-service images',
                                 'Final license and distribution review', 'Required target qualification receipts']}, indent=2) + '\n')
    os.chmod(payload / 'docs/distribution-status.json', 0o644)
    files = []
    for item in sorted(payload.rglob('*')):
        if item.is_file():
            files.append({'path': item.relative_to(args.output).as_posix(), 'sha256': sha256(item),
                          'size': item.stat().st_size, 'mode': stat.S_IMODE(item.stat().st_mode)})
    manifest = {k: spec[k] for k in ('schemaVersion', 'releaseId', 'productVersion', 'sequence', 'channel', 'platform', 'schema')}
    # The installed controller explicitly owns ingress for these Unix-listener
    # profiles; older controllers reject this unknown signed field safely.
    manifest['ingress'] = spec['ingress']
    manifest.update({'createdAt': spec.get('createdAt', datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')),
                     'files': files, 'images': images,
                     'model': {'name': model['name'], 'digest': model['digest'], 'files': model_files, 'modelfile': 'payload/models/Modelfile'},
                     'compose': {'offline': 'payload/config/compose.offline.yaml', 'connected': 'payload/config/compose.connected.yaml'},
                     'runtime': {k: runtime[k] for k in ('kind', 'os', 'version', 'arch')}})
    manifest['runtime']['packages'] = packages
    (args.output / 'release.json').write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'releaseId': spec['releaseId'], 'files': len(files), 'bytes': sum(f['size'] for f in files),
                      'status': 'unsigned; sign with separately held publisher trust before distribution'}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(f'Bundle staging refused: {error}')
