"""Synthetic byte-level packaging tests; no image, model or system is started."""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


EXPORT = module('export-model')
STAGE = module('stage-bundle')


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
        gate = {'result': 'passed', 'releaseId': release_id, 'imageIds': {i['service']: i['imageId'] for i in images}}
        put(self.root / 'compliance', 'sbom/security-gate.json', json.dumps(gate).encode())
        spec = {'schemaVersion': 1, 'releaseId': release_id, 'productVersion': '0.0.0-test',
                'channel': 'preview', 'sequence': 1, 'platform': {'os': 'linux', 'arch': 'amd64'},
                'schema': {'min': 16, 'max': 16, 'target': 16}, 'createdAt': '2026-09-12T00:00:00Z'}
        put(self.root, 'spec.json', json.dumps(spec).encode())
        put(self.root, 'asterctl', b'\x7fELF\x02\x01' + b'\0' * 12 + b'\x3e\x00SYNTHETIC-NEVER-EXECUTED')
        return [sys.executable, str(ROOT / 'scripts/stage-bundle.py'), '--spec', str(self.root / 'spec.json'),
                '--images', str(self.root / 'images'), '--runtime', str(self.root / 'runtime'),
                '--model', str(self.model), '--compliance', str(self.root / 'compliance'),
                '--asterctl', str(self.root / 'asterctl'), '--output', str(self.root / 'bundle')]

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
        # Packing requires metadata existence, but does not authenticate it. TUF
        # authentication is separately tested by the real Go controller.
        for name in ['root', 'targets', 'snapshot', 'timestamp']:
            put(bundle / 'metadata', name + '.json', b'{"synthetic":true}')
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


if __name__ == '__main__':
    unittest.main()
