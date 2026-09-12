"""Synthetic source/export identity tests; no Docker, downloads or native code."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


ROOT = Path(__file__).resolve().parents[2]
EXPORT = load(Path(__file__).with_name('export-sources.py'), 'synthetic_source_exporter')
COLLECT = load(ROOT / 'operations/appliance/scripts/collect-processor-sources.py', 'synthetic_source_collector')
IMAGE = 'sha256:' + 'a' * 64


def put(root, name, data):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def fixture(root):
    """Explicit independent synthetic source policy, never a real source receipt."""
    build, runtime, recipe, output = [root / name for name in ('build', 'runtime', 'processor', 'export')]
    for name in EXPORT.RECIPE_TOP:
        put(recipe, name, b'SYNTHETIC BUILD RECIPE\n')
    put(recipe, 'requirements.lock.txt', b'SYNTHETIC==1\n')
    for name in EXPORT.RECIPE_RUNTIME:
        put(recipe, 'runtime/' + name, b'SYNTHETIC BUILD INPUT\n')
    lock = {'buildDependencies': [], 'provenanceFiles': [], 'securityBackports': []}
    for component in ('tesseract', 'libtiff', 'pillow'):
        filename = component + '-SYNTHETIC.tar.gz'
        path = put(build, 'sources/' + filename, ('SYNTHETIC ORIGINAL ' + component).encode())
        lock[component] = {'filename': filename, 'sha256': EXPORT.sha(path), 'version': 'SYNTHETIC',
                           'url': 'https://example.invalid/' + filename,
                           'authentication': {'method': 'SYNTHETIC FIXTURE ONLY'}}
    wheel = put(build, 'sources/SYNTHETIC.whl', b'SYNTHETIC BUILD WHEEL')
    lock['buildDependencies'].append({'filename': wheel.name, 'sha256': EXPORT.sha(wheel), 'url': 'https://example.invalid/SYNTHETIC.whl'})
    for kind, filename in [('provenanceFiles', 'SYNTHETIC.asc'), ('securityBackports', 'SYNTHETIC.patch')]:
        path = put(recipe, 'runtime/source-provenance/' + filename, ('SYNTHETIC ' + kind).encode())
        put(build, 'source-provenance/' + filename, path.read_bytes())
        item = {'filename': filename, 'sha256': EXPORT.sha(path)}
        if kind == 'securityBackports':
            item.update({'component': 'tesseract', 'cve': 'CVE-SYNTHETIC', 'commit': 'b' * 40,
                         'url': 'https://example.invalid/SYNTHETIC.patch', 'authentication': 'SYNTHETIC', 'files': []})
        lock[kind].append(item)
    raw = json.dumps(lock).encode()
    put(recipe, 'runtime/upstream-sources.json', raw)
    put(build, 'upstream-sources.json', raw)
    native = {}
    for name in ('opt/tesseract/bin/tesseract', 'opt/tesseract/lib/libtesseract.so.5.5', 'opt/libtiff/lib/libtiff.so.6'):
        path = put(runtime, name, ('SYNTHETIC NATIVE ' + name).encode())
        native['/' + name] = EXPORT.sha(path)
    put(runtime, 'usr/local/lib/python3.12/site-packages/PIL/_imaging.SYNTHETIC.so', b'SYNTHETIC PILLOW NATIVE')
    put(runtime, 'usr/local/lib/python3.12/site-packages/PIL/__init__.py', b'SYNTHETIC PILLOW CODE')
    put(runtime, 'usr/local/lib/python3.12/site-packages/PIL/py.typed', b'')
    policy = {'sourceFiles': {'tesseract': {}, 'libtiff': {}}, 'findings': []}
    put(recipe, 'runtime/security-policy.json', json.dumps(policy).encode())
    security = {'nativeFiles': native, 'sourceConfigurationSha256': hashlib.sha256(raw).hexdigest(),
                'harnessSha256': EXPORT.sha(recipe / 'runtime/security-regression.cc'),
                'sourceFiles': policy['sourceFiles'],
                'checks': {'schemaVersion': 1, 'networkCases': 12, 'normprotoCases': 3, 'tiffCodecCases': 3,
                           'genericVectorCases': 5, 'unicharsetCases': 4, 'intprotoCases': 6, 'passed': True},
                'backports': {'schemaVersion': 1, 'component': 'tesseract', 'baseVersion': 'SYNTHETIC',
                             'backports': [{key: item[key] for key in ('cve', 'commit', 'url', 'sha256', 'authentication', 'files')}
                                          for item in lock['securityBackports']]}}
    for name in EXPORT.BUILD_EVIDENCE:
        put(build, name, json.dumps(security if name == 'security-build.json' else {'SYNTHETIC': True}).encode())
    manifest = {'schemaVersion': 1, 'systemPackages': [{'name': 'SYNTHETIC', 'version': '1'}], 'securityBuild': security,
                **{name: {'sourceArchives': [{key: lock[name][key] for key in ('filename', 'sha256', 'url')}]}
                   for name in ('tesseract', 'libtiff')}}
    put(runtime, EXPORT.RUNTIME_MANIFEST, json.dumps(manifest).encode())
    status = put(root, 'dpkg-status', b'Package: SYNTHETIC\nStatus: install ok installed\n')
    return {'build': build, 'runtime': runtime, 'recipe': recipe, 'output': output, 'package_status': status}


def create_export(root):
    paths = fixture(root)
    EXPORT.export(paths['build'], paths['runtime'], paths['recipe'], paths['output'], paths['package_status'])
    return paths


def collect_fixture(paths, output, image=IMAGE):
    evidence = EXPORT.attest(paths['runtime'], paths['output'] / 'source-manifest.json')
    with patch.object(COLLECT.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(evidence), '')):
        return COLLECT.collect(paths['output'], image, paths['recipe'], output)


class CustomProcessorSources(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aster-custom-source-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_exact_sources_recipe_empty_marker_and_installed_files_are_bound(self):
        paths = create_export(self.root)
        output = self.root / 'collected'
        receipt = collect_fixture(paths, output)
        self.assertEqual(COLLECT.verify_receipt(output, IMAGE, paths['recipe']), receipt)
        self.assertEqual(receipt['sourceArchiveCount'], 3)
        self.assertFalse((paths['runtime'] / 'archives').exists())
        self.assertLess((paths['runtime'] / EXPORT.MARKER).stat().st_size, 100)
        self.assertTrue(any(item['path'].endswith('/py.typed') and item['bytes'] == 0
                            for item in EXPORT.attest(paths['runtime'], paths['output'] / 'source-manifest.json')['installedFiles']))

    def test_changed_original_or_patch_cannot_export(self):
        for name in ('sources/tesseract-SYNTHETIC.tar.gz', 'source-provenance/SYNTHETIC.patch'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                paths = fixture(Path(directory))
                (paths['build'] / name).write_bytes(b'CHANGED INPUT')
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    EXPORT.export(paths['build'], paths['runtime'], paths['recipe'], paths['output'], paths['package_status'])
                self.assertFalse(paths['output'].exists())

    def test_native_pillow_or_python_source_change_fails_exact_image_attestation(self):
        for name in ('opt/tesseract/bin/tesseract', 'usr/local/lib/python3.12/site-packages/PIL/_imaging.SYNTHETIC.so',
                     'usr/local/lib/python3.12/site-packages/PIL/__init__.py'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                paths = create_export(Path(directory))
                (paths['runtime'] / name).write_bytes(b'CHANGED RUNTIME')
                with self.assertRaises(ValueError):
                    EXPORT.attest(paths['runtime'], paths['output'] / 'source-manifest.json')

    def test_missing_manifest_marker_or_changed_export_fails_attestation(self):
        paths = create_export(self.root)
        marker = paths['runtime'] / EXPORT.MARKER
        marker.write_text('0' * 64)
        with self.assertRaisesRegex(ValueError, 'not bound'):
            EXPORT.attest(paths['runtime'], paths['output'] / 'source-manifest.json')

    def test_source_and_recipe_cannot_self_attest_changed_reviewed_bytes(self):
        for name in ('archives/tesseract-SYNTHETIC.tar.gz', 'recipe/runtime/security-regression.cc', 'recipe/Dockerfile'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                paths = create_export(Path(directory))
                (paths['output'] / name).write_bytes(b'ALTERED BUT REHASHED')
                manifest_file = paths['output'] / 'source-manifest.json'
                manifest = json.loads(manifest_file.read_text())
                manifest['files'] = [item for item in EXPORT.files(paths['output']) if item['path'] != 'source-manifest.json']
                manifest_file.write_text(json.dumps(manifest))
                with self.assertRaises(ValueError):
                    COLLECT.verify_material(paths['output'], paths['recipe'])

    def test_other_image_receipt_and_extra_files_fail(self):
        paths = create_export(self.root)
        output = self.root / 'collected'
        collect_fixture(paths, output)
        with self.assertRaisesRegex(ValueError, 'exact image'):
            COLLECT.verify_receipt(output, 'sha256:' + 'b' * 64, paths['recipe'])
        put(output, 'UNLISTED', b'EXTRA')
        with self.assertRaisesRegex(ValueError, 'complete manifest'):
            COLLECT.verify_receipt(output, IMAGE, paths['recipe'])

    def test_selected_symlink_input_is_rejected_but_python_cache_is_not_recipe(self):
        paths = fixture(self.root)
        put(paths['recipe'], 'runtime/__pycache__/SYNTHETIC.pyc', b'GENERATED CACHE')
        self.assertFalse(any('__pycache__' in item['path'] for item in EXPORT.recipe_files(paths['recipe'])))
        selected = paths['recipe'] / 'runtime/security-regression.cc'
        selected.unlink()
        selected.symlink_to(self.root / 'outside')
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            EXPORT.recipe_files(paths['recipe'])

    def test_changed_copy_is_rejected_before_receipt(self):
        paths = create_export(self.root)
        output = self.root / 'collected'
        original = shutil.copyfile
        def changed(source, destination, *args, **kwargs):
            value = original(source, destination, *args, **kwargs)
            if str(destination).endswith('SYNTHETIC.patch'):
                Path(destination).write_bytes(b'CHANGED DURING COPY')
            return value
        with patch.object(COLLECT.shutil, 'copyfile', side_effect=changed), self.assertRaisesRegex(ValueError, 'changed during collection'):
            collect_fixture(paths, output)
        self.assertFalse((output / 'receipt.json').exists())

    def test_collector_never_executes_a_tag_or_export_script(self):
        paths = create_export(self.root)
        attestation = EXPORT.attest(paths['runtime'], paths['output'] / 'source-manifest.json')
        with patch.object(COLLECT.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(attestation), '')) as run:
            COLLECT.collect(paths['output'], IMAGE, paths['recipe'], self.root / 'collected')
        command = run.call_args.args[0]
        self.assertIn(IMAGE, command)
        self.assertEqual(command[command.index('--network') + 1], 'none')
        self.assertIn('--read-only', command)
        self.assertIn('no-new-privileges', command)
        self.assertIn('/opt/aster/verify-custom-sources.py', command)


if __name__ == '__main__':
    unittest.main()
