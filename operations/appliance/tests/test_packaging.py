"""Synthetic byte-level packaging tests; no image, model or system is started."""
import gzip
import datetime
import hashlib
import importlib.util
import io
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


EXPORT = module('export-model')
STAGE = module('stage-bundle')
native_spec = importlib.util.spec_from_file_location('native_test_policy', ROOT.parents[1] / 'tools/release/collect-native-sources.py')
NATIVE = importlib.util.module_from_spec(native_spec)
native_spec.loader.exec_module(NATIVE)
processor_test_spec = importlib.util.spec_from_file_location('processor_assessment_fixture', ROOT.parents[1] / 'processor/runtime/test_security_assessment.py')
PROCESSOR_TEST = importlib.util.module_from_spec(processor_test_spec)
processor_test_spec.loader.exec_module(PROCESSOR_TEST)
processor_verify_spec = importlib.util.spec_from_file_location('processor_verify', ROOT.parents[1] / 'processor/runtime/verify-scan.py')
PROCESSOR_VERIFY = importlib.util.module_from_spec(processor_verify_spec)
processor_verify_spec.loader.exec_module(PROCESSOR_VERIFY)
processor_source_spec = importlib.util.spec_from_file_location('processor_source_fixture', ROOT.parents[1] / 'processor/runtime/test_export_sources.py')
PROCESSOR_SOURCE_TEST = importlib.util.module_from_spec(processor_source_spec)
processor_source_spec.loader.exec_module(PROCESSOR_SOURCE_TEST)


def put(root, name, data=b'SYNTHETIC PACKAGING TEST ONLY'):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}


def make_model(root):
    layers = []
    for kind in ['projector', 'model', 'license', 'params']:
        data = f'SYNTHETIC-{kind}'.encode()
        sha = hashlib.sha256(data).hexdigest()
        put(root / 'ollama', f'blobs/sha256-{sha}', data)
        layers.append({'mediaType': f'application/vnd.ollama.image.{kind}', 'digest': f'sha256:{sha}', 'size': len(data)})
    config = put(root / 'ollama', 'temporary', b'{}')
    (root / 'ollama/temporary').rename(root / 'ollama/blobs' / f'sha256-{config["sha256"]}')
    manifest = {'schemaVersion': 2, 'config': {'mediaType': 'application/vnd.docker.container.image.v1+json',
                 'digest': 'sha256:' + config['sha256'], 'size': 2}, 'layers': layers}
    put(root / 'ollama', 'manifests/registry.ollama.ai/library/synthetic/test', json.dumps(manifest).encode())
    inventory = EXPORT.inspect_model(root / 'ollama', 'synthetic:test')
    (root / 'inventory.json').write_text(json.dumps(inventory))
    put(root, 'Modelfile', b'# SYNTHETIC\nFROM synthetic:test\n')
    return inventory


def synthetic_source(root):
    for name in ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'operations/appliance/config/compose.offline.yaml',
                 'operations/appliance/config/compose.connected.yaml', 'operations/appliance/config/headers.caddy',
                 'operations/postgres/10-roles.sh', 'operations/scripts/processor-entrypoint.py',
                 'operations/appliance/vm/README.md', 'operations/appliance/README.md',
                 'operations/appliance/cli/README.md', 'operations/appliance/recovery.md']:
        put(root, name)
    policy_root = root / 'licenses/native/sharp-libvips-1.3.3'
    def item(name, data):
        value = put(policy_root, name, data)
        return {'path': value['path'], 'sha256': value['sha256'], 'bytes': value['size']}
    recipe = item('recipe/versions.properties', b'VERSION_SYNTHETIC=1\n'); recipe['path'] = 'versions.properties'
    crate_hash = hashlib.sha256(b'SYNTHETIC PACKAGING TEST ONLY').hexdigest()
    cargo = ('version = 3\n[[package]]\nname = "synthetic"\nversion = "1.0.0"\n'
             'source = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "' + crate_hash + '"\n').encode()
    metadata = [item('metadata/glib-gvdb.wrap', b'[wrap-git]\nrevision=SYNTHETIC\n'), item('metadata/librsvg-Cargo.lock', cargo)]
    put(policy_root, 'recipe-provenance.json', json.dumps({'files': [recipe]}).encode())
    put(policy_root, 'metadata-provenance.json', json.dumps({'files': metadata}).encode())
    put(policy_root, 'README.md')
    policy = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-policy-v1', 'versions': {'synthetic': '1'},
              'sources': [{'name': 'synthetic', 'version': '1', 'url': 'https://example.invalid/SYNTHETIC.tar.gz'},
                          {'name': 'gvdb', 'version': 'SYNTHETIC', 'url': 'https://example.invalid/SYNTHETIC-gvdb.tar.gz'}]}
    put(policy_root, 'source-policy.json', json.dumps(policy).encode())
    return policy_root


def synthetic_compliance(root, binary, app_image, source_root):
    """Byte-level gate fixtures, never evidence about a real binary or image."""
    controller = root / 'controller'
    inventory = put(controller, 'notices/inventory.json', b'{"SYNTHETIC":true}')
    spdx = put(controller, 'notices/controller.spdx.json', b'{"SYNTHETIC":true}')
    put(controller, 'notices/build-info.json', b'{"SYNTHETIC":true}')
    put(controller, 'notices/texts/SYNTHETIC.txt')
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    put(controller, 'notices/receipt.json', json.dumps({'type': 'aster-go-binary-notice-inventory-v1',
        'binarySha256': binary_hash, 'spdxSha256': spdx['sha256'], 'licenseInventorySha256': inventory['sha256']}).encode())
    messages = [{'config': {'scanner_name': 'govulncheck', 'scanner_version': 'v1.8.0', 'scan_mode': 'binary', 'scan_level': 'symbol'}},
                {'SBOM': {'modules': [{'path': 'SYNTHETIC'}], 'roots': ['SYNTHETIC']}}]
    put(controller, 'govulncheck.json', '\n'.join(json.dumps(m) for m in messages).encode())
    put(controller, 'govulncheck.txt')
    files = {p.relative_to(controller).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in controller.rglob('*') if p.is_file()}
    put(controller, 'security-gate.json', json.dumps({'schemaVersion': 1, 'type': 'aster-controller-security-gate-v1',
        'result': 'passed', 'strictBinaryScanExitCode': 0, 'binarySha256': binary_hash,
        'binaryBytes': binary.stat().st_size, 'files': files}).encode())

    native = root / 'licenses/native-sources'
    def item(name):
        value = put(native, name)
        return {'path': value['path'], 'sha256': value['sha256'], 'bytes': value['size']}
    policy_root = source_root / 'licenses/native/sharp-libvips-1.3.3'
    policy, material, crates = NATIVE.load_policy(policy_root)
    sources = [{**source, **item(source['path'])} for source in NATIVE.expected_records(policy, crates)]
    for record in material:
        put(native, 'reviewed-recipe/' + record['path'], (policy_root / record['path']).read_bytes())
    registry = item('registry-provenance/native-package.tgz')
    notice = item('notices/SYNTHETIC.txt'); notice['file'] = notice.pop('path')
    runtime = {'appImageId': app_image, 'runtimePackage': {'name': 'SYNTHETIC'}, 'nativeFiles': [{'path': 'SYNTHETIC', 'sha256': 'a' * 64}]}
    lock = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-lock-v1', 'runtime': runtime, 'material': material,
            'policySha256': STAGE.sha256(policy_root / 'source-policy.json'),
            'sources': sources, 'registryArchive': registry, 'sourceArchiveCount': len(sources)}
    lock_file = put(native, 'source-lock.json', json.dumps(lock).encode())
    put(native, 'receipt.json', json.dumps({'schemaVersion': 1, 'type': 'aster-sharp-native-source-receipt-v1',
        'result': 'source-materials-verified', 'appImageId': app_image, 'sourceLockSha256': lock_file['sha256'],
        'runtimePackage': runtime['runtimePackage'], 'nativeFiles': runtime['nativeFiles'],
        'sourceArchiveCount': len(sources), 'nativeSourceCount': len(policy['sources']), 'cargoSourceCount': len(crates), 'notices': [notice]}).encode())


def synthetic_image_scans(root, images, gate, processor_fixture):
    scans = []
    for image in images:
        name = image['service']
        scan = {'Metadata': {'ImageID': image['imageId']}, 'CreatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'Results': [{'Packages': [{'Name': 'SYNTHETIC'}], 'Vulnerabilities': []}]}
        if name == 'processor':
            manifest = json.loads((processor_fixture['output'] / 'build/runtime-manifest.json').read_text())
            runtime = {'nativeFiles': manifest['securityBuild']['nativeFiles'], 'tiffcropAbsent': True, 'provenanceVerified': True,
                       'manifestSha256': hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()}
            reviewed = processor_fixture['recipe'] / 'runtime'
            policy = json.loads((reviewed / 'security-policy.json').read_text())
            source_bytes, harness = (reviewed / 'upstream-sources.json').read_bytes(), (reviewed / 'security-regression.cc').read_bytes()
            scan['Metadata']['OS'] = {'Family': 'debian', 'Name': '13.6'}
            scan['Results'][0].update({'Class': 'os-pkgs', 'Packages': [{'Name': 'SYNTHETIC', 'Version': '1'}]})
            requirements = (processor_fixture['recipe'] / 'requirements.lock.txt').read_text()
            packages = []
            for line in requirements.splitlines():
                if line.strip() and not line.startswith('#') and ';' not in line:
                    package, version = line.split('==')
                    packages.append({'Name': package, 'Version': version})
            scan['Results'].append({'Type': 'python-pkg', 'Packages': packages})
            assessment = PROCESSOR_TEST.assessment.assess(manifest, scan, runtime, image['imageId'], policy, source_bytes, harness)
            assessment['inventory'] = PROCESSOR_VERIFY.verify(manifest, scan, requirements, assessment)
        scan_file = put(root, name + '-scan.json', json.dumps(scan).encode())
        sbom_file = put(root, name + '.cdx.json', b'{"bomFormat":"CycloneDX","components":[{"name":"SYNTHETIC"}]}')
        scans.append({'service': name, 'imageId': image['imageId'], 'rawHighOrCritical': 0,
                      'scanSha256': scan_file['sha256'], 'sbomSha256': sbom_file['sha256']})
        if name == 'processor':
            evidence = [('processor-runtime-manifest.json', manifest), ('processor-runtime-security.json', runtime),
                        ('processor-assessment.json', assessment)]
            gate['processorEvidence'] = {filename: put(root, filename, json.dumps(data).encode())['sha256'] for filename, data in evidence}
    gate['scans'] = scans


def synthetic_metadata_layout(bundle):
    """Untrusted protocol-layout fixture; real signing has a separate CLI test."""
    def metadata(name, kind, **values):
        return put(bundle / 'metadata', name, json.dumps({'signed': {'_type': kind, 'version': 1, **values},
            'signatures': [{'keyid': 'SYNTHETIC-NOT-A-VALID-SIGNATURE', 'sig': 'SYNTHETIC'}]}).encode())
    def reference(item):
        return {'version': 1, 'length': item['size'], 'hashes': {'sha256': item['sha256']}}
    release = bundle / 'release.json'
    target = {'length': release.stat().st_size, 'hashes': {'sha256': STAGE.sha256(release)}}
    targets = metadata('1.targets.json', 'targets', targets={'release.json': target})
    snapshot = metadata('1.snapshot.json', 'snapshot', meta={'targets.json': reference(targets)})
    metadata('timestamp.json', 'timestamp', meta={'snapshot.json': reference(snapshot)})


class Packaging(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aster-packaging-test-')
        self.root = Path(self.temp.name)
        self.model = self.root / 'model'
        self.inventory = make_model(self.model)

    def tearDown(self):
        self.temp.cleanup()

    def test_complete_model_includes_config_and_multimodal_assets(self):
        self.assertEqual(len(self.inventory['files']), 6)
        self.assertEqual(self.inventory['totalBytes'], sum(x['size'] for x in self.inventory['files']))
        self.assertEqual(self.inventory['digest'], 'sha256:' + self.inventory['files'][0]['sha256'])

    def test_missing_or_modified_projector_is_rejected(self):
        file = next(x for x in self.inventory['files'] if 'projector' in x['kind'])
        path = self.model / 'ollama' / file['path']
        path.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'mismatch'):
            EXPORT.inspect_model(self.model / 'ollama', 'synthetic:test')
        path.unlink()
        with self.assertRaisesRegex(ValueError, 'Missing'):
            EXPORT.inspect_model(self.model / 'ollama', 'synthetic:test')

    def test_path_and_link_escape_rejected(self):
        for value in ['/tmp/asset', '../asset', 'a/../b', 'a//b', 'a\\b', './file']:
            with self.assertRaises(ValueError):
                STAGE.relative(value)
        put(self.root, 'real')
        (self.root / 'link').symlink_to(self.root / 'real')
        with self.assertRaisesRegex(ValueError, 'Symlinks'):
            STAGE.checked_file(self.root, 'link')
        os.link(self.root / 'real', self.root / 'hardlink')
        with self.assertRaisesRegex(ValueError, 'independent'):
            STAGE.checked_file(self.root, 'hardlink')

    def inputs(self):
        release_id = 'synthetic-preview-1'
        images = []
        for service in ['app', 'processor', 'postgres', 'ollama', 'caddy']:
            item = put(self.root / 'images', f'{service}.tar', service.encode())
            images.append({**item, 'service': service, 'reference': f'aster-{service}:{release_id}',
                           'imageId': 'sha256:' + item['sha256']})
        (self.root / 'images/inventory.json').write_text(json.dumps({'releaseId': release_id, 'platform': 'linux/amd64', 'images': images}))
        packages = []
        for name in ['docker.io', 'docker-compose-v2', 'containerd', 'runc', 'iptables', 'openssl']:
            item = put(self.root / 'runtime', f'{name}_1_amd64.deb')
            packages.append({**item, 'name': name, 'version': '1', 'architecture': 'amd64'})
        (self.root / 'runtime/inventory.json').write_text(json.dumps({'kind': 'ubuntu-deb', 'os': 'ubuntu', 'version': '24.04', 'arch': 'amd64', 'packages': packages}))
        put(self.root / 'compliance', 'licenses/SYNTHETIC.txt')
        synthetic_source(self.root / 'synthetic-source')
        processor_fixture = PROCESSOR_SOURCE_TEST.create_export(self.root / 'custom-source-fixture')
        shutil.copytree(processor_fixture['recipe'], self.root / 'synthetic-source/processor')
        PROCESSOR_SOURCE_TEST.collect_fixture(processor_fixture, self.root / 'compliance/licenses/processor-custom-sources',
                                             next(item['imageId'] for item in images if item['service'] == 'processor'))
        gate = {'result': 'passed', 'releaseId': release_id, 'imageIds': {i['service']: i['imageId'] for i in images}}
        synthetic_image_scans(self.root / 'compliance/sbom', images, gate, processor_fixture)
        put(self.root / 'compliance', 'sbom/security-gate.json', json.dumps(gate).encode())
        spec = {'schemaVersion': 1, 'releaseId': release_id, 'productVersion': '0.0.0-test',
                'channel': 'preview', 'sequence': 1, 'platform': {'os': 'linux', 'arch': 'amd64'},
                'schema': {'min': 16, 'max': 16, 'target': 16}, 'createdAt': '2026-09-12T00:00:00Z'}
        put(self.root, 'spec.json', json.dumps(spec).encode())
        put(self.root, 'asterctl', b'\x7fELF\x02\x01' + b'\0' * 12 + b'\x3e\x00SYNTHETIC-NEVER-EXECUTED')
        synthetic_compliance(self.root / 'compliance', self.root / 'asterctl', images[0]['imageId'], self.root / 'synthetic-source')
        return [sys.executable, str(ROOT / 'scripts/stage-bundle.py'), '--spec', str(self.root / 'spec.json'),
                '--images', str(self.root / 'images'), '--runtime', str(self.root / 'runtime'),
                '--model', str(self.model), '--compliance', str(self.root / 'compliance'),
                '--asterctl', str(self.root / 'asterctl'), '--output', str(self.root / 'bundle'), '--source', str(self.root / 'synthetic-source')]

    def test_complete_inventory_and_deterministic_split_transport(self):
        result = subprocess.run(self.inputs(), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        bundle = self.root / 'bundle'
        manifest = json.loads((bundle / 'release.json').read_text())
        self.assertEqual(len(manifest['images']), 5)
        self.assertEqual(len(manifest['model']['files']), 6)
        for item in manifest['files']:
            path = bundle / item['path']
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), item['sha256'])
            self.assertEqual(path.stat().st_mode & 0o777, item['mode'])
        # Packing checks real protocol layout, not signature authenticity. Actual
        # Go CLI signing and external-root verification have a separate contract.
        synthetic_metadata_layout(bundle)
        for suffix in ['first', 'second']:
            subprocess.run([sys.executable, str(ROOT / 'scripts/pack-bundle.py'), '--bundle', str(bundle),
                            '--output', str(self.root / suffix), '--part-mib', '1'], check=True, capture_output=True)
        first = json.loads((self.root / 'first/parts.json').read_text())
        second = json.loads((self.root / 'second/parts.json').read_text())
        self.assertEqual(first, second)
        stream = b''.join((self.root / 'first' / p['path']).read_bytes() for p in first['parts'])
        self.assertEqual(hashlib.sha256(stream).hexdigest(), first['sha256'])
        with tarfile.open(fileobj=io.BytesIO(gzip.decompress(stream))) as archive:
            self.assertIn('release.json', archive.getnames())
            self.assertIn('payload/bin/asterctl', archive.getnames())
            self.assertIn('payload/sbom/controller/notices/controller.spdx.json', archive.getnames())
            self.assertIn('payload/licenses/native-sources/original-sources/synthetic-1.tar.gz', archive.getnames())

    def test_foreign_security_receipt_rejected_before_output(self):
        command = self.inputs()
        path = self.root / 'compliance/sbom/security-gate.json'
        gate = json.loads(path.read_text()); gate['imageIds']['app'] = 'sha256:' + 'a' * 64
        path.write_text(json.dumps(gate))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exact five image IDs', result.stderr)
        self.assertFalse((self.root / 'bundle').exists())

    def test_omitted_model_layer_rejected(self):
        command = self.inputs()
        path = self.model / 'inventory.json'
        inventory = json.loads(path.read_text())
        inventory['files'] = [f for f in inventory['files'] if not f['kind'].endswith('.params')]
        path.write_text(json.dumps(inventory))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('omits or changes', result.stderr)

    def test_wrong_platform_controller_rejected(self):
        command = self.inputs()
        (self.root / 'asterctl').write_bytes(b'not-a-linux-binary')
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Linux amd64 executable', result.stderr)

    def test_controller_evidence_cannot_be_reused_for_changed_binary(self):
        command = self.inputs()
        with (self.root / 'asterctl').open('ab') as stream:
            stream.write(b'SYNTHETIC CHANGE')
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exact installer binary', result.stderr)
        self.assertFalse((self.root / 'bundle').exists())

    def test_changed_controller_scan_cannot_supply_passing_receipt(self):
        command = self.inputs()
        (self.root / 'compliance/controller/govulncheck.json').write_text('{}')
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Asset hash mismatch', result.stderr)

    def test_native_source_receipt_requires_exact_image(self):
        command = self.inputs()
        path = self.root / 'compliance/licenses/native-sources/receipt.json'
        receipt = json.loads(path.read_text()); receipt['appImageId'] = 'sha256:' + 'f' * 64
        path.write_text(json.dumps(receipt))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exact application image', result.stderr)

    def test_custom_processor_source_receipt_requires_exact_image(self):
        command = self.inputs()
        path = self.root / 'compliance/licenses/processor-custom-sources/receipt.json'
        receipt = json.loads(path.read_text()); receipt['processorImageId'] = 'sha256:' + 'f' * 64
        path.write_text(json.dumps(receipt))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exact image', result.stderr)
        self.assertFalse((self.root / 'bundle').exists())

    def test_custom_processor_source_runtime_cannot_be_mixed_with_other_security_evidence(self):
        command = self.inputs()
        root = self.root / 'compliance/licenses/processor-custom-sources'
        runtime_path = root / 'build/runtime-manifest.json'
        runtime = json.loads(runtime_path.read_text()); runtime['SYNTHETIC_MIXED_BUILD'] = True
        runtime_path.write_text(json.dumps(runtime))
        manifest_path = root / 'source-manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['runtimeManifestSha256'] = STAGE.sha256(runtime_path)
        manifest['files'] = [item for item in PROCESSOR_SOURCE_TEST.EXPORT.files(root)
                             if item['path'] not in {'source-manifest.json', 'receipt.json', 'runtime-attestation.json'}]
        manifest_path.write_text(json.dumps(manifest))
        attestation_path = root / 'runtime-attestation.json'
        attestation = json.loads(attestation_path.read_text())
        attestation.update({'sourceManifestSha256': STAGE.sha256(manifest_path), 'runtimeManifestSha256': STAGE.sha256(runtime_path)})
        attestation_path.write_text(json.dumps(attestation))
        receipt_path = root / 'receipt.json'
        receipt = json.loads(receipt_path.read_text())
        receipt.update({'sourceManifestSha256': STAGE.sha256(manifest_path),
                        'runtimeAttestationSha256': STAGE.sha256(attestation_path),
                        'retainedBytes': sum(item['bytes'] for item in manifest['files'])})
        receipt_path.write_text(json.dumps(receipt))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('differs from exact-image security evidence', result.stderr)
        self.assertFalse((self.root / 'bundle').exists())

    def test_changed_native_source_archive_is_rejected(self):
        command = self.inputs()
        (self.root / 'compliance/licenses/native-sources/original-sources/synthetic-1.tar.gz').write_bytes(b'changed')
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Asset length mismatch', result.stderr)
        self.assertFalse((self.root / 'bundle').exists())

    def test_raw_image_report_cannot_be_removed_or_rehashed_to_hide_findings(self):
        command = self.inputs()
        path = self.root / 'compliance/sbom/app-scan.json'
        scan = json.loads(path.read_text())
        scan['Results'][0]['Vulnerabilities'] = [{'Severity': 'HIGH', 'VulnerabilityID': 'SYNTHETIC-CVE'}]
        path.write_text(json.dumps(scan))
        gate_path = self.root / 'compliance/sbom/security-gate.json'
        gate = json.loads(gate_path.read_text())
        record = next(r for r in gate['scans'] if r['service'] == 'app')
        record.update({'scanSha256': STAGE.sha256(path), 'rawHighOrCritical': 1})
        gate_path.write_text(json.dumps(gate))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unresolved image findings', result.stderr)
        path.unlink()
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'bundle').exists())

    def test_self_consistent_incomplete_native_closure_is_rejected(self):
        command = self.inputs()
        root = self.root / 'compliance/licenses/native-sources'
        lock_path, receipt_path = root / 'source-lock.json', root / 'receipt.json'
        lock, receipt = json.loads(lock_path.read_text()), json.loads(receipt_path.read_text())
        lock['sources'] = lock['sources'][:-1]; lock['sourceArchiveCount'] -= 1
        lock_path.write_text(json.dumps(lock))
        receipt.update({'sourceLockSha256': STAGE.sha256(lock_path), 'sourceArchiveCount': lock['sourceArchiveCount'], 'cargoSourceCount': 0})
        receipt_path.write_text(json.dumps(receipt))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('reviewed transitive source coverage', result.stderr)

    def test_changed_source_after_validation_is_rejected_before_copy(self):
        put(self.root, 'source')
        STAGE.checked_file(self.root, 'source')
        (self.root / 'source').write_bytes(b'changed after check')
        with self.assertRaisesRegex(ValueError, 'changed after validation'):
            STAGE.copy_file(self.root / 'source', self.root / 'destination')
        self.assertFalse((self.root / 'destination').exists())

    def test_rehashed_processor_receipt_cannot_approve_an_unknown_finding(self):
        command = self.inputs()
        root = self.root / 'compliance/sbom'
        scan_path, gate_path, assessment_path = root / 'processor-scan.json', root / 'security-gate.json', root / 'processor-assessment.json'
        scan, gate, assessment = [json.loads(p.read_text()) for p in (scan_path, gate_path, assessment_path)]
        scan['Results'][0]['Vulnerabilities'] = [{'Severity': 'HIGH', 'VulnerabilityID': 'SYNTHETIC-UNKNOWN-CVE', 'PkgName': 'SYNTHETIC', 'InstalledVersion': '1'}]
        scan_path.write_text(json.dumps(scan))
        assessment.update({'rawHighOrCritical': 1, 'assessments': [{'SYNTHETIC': True}],
                           'scanSha256': hashlib.sha256(json.dumps(scan, sort_keys=True).encode()).hexdigest()})
        assessment_path.write_text(json.dumps(assessment))
        gate['processorEvidence']['processor-assessment.json'] = STAGE.sha256(assessment_path)
        next(r for r in gate['scans'] if r['service'] == 'processor').update({'scanSha256': STAGE.sha256(scan_path), 'rawHighOrCritical': 1})
        gate_path.write_text(json.dumps(gate))
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Unassessed HIGH/CRITICAL', result.stderr)
        self.assertFalse((self.root / 'bundle').exists())

    def test_changed_bytes_during_copy_cannot_enter_release_manifest(self):
        put(self.root, 'source')
        original_copy = STAGE.shutil.copyfile
        def racing_copy(source, destination):
            original_copy(source, destination)
            destination.write_bytes(b'changed during copy')
        with patch.object(STAGE.shutil, 'copyfile', side_effect=racing_copy), self.assertRaisesRegex(ValueError, 'Copied asset changed'):
            STAGE.copy_file(self.root / 'source', self.root / 'destination')


if __name__ == '__main__':
    unittest.main()
