import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('notices', Path(__file__).with_name('collect-notices.py'))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class LicenseInventoryTests(unittest.TestCase):
    def package(self, root, name='fixture', version='1.0.0'):
        package = root / 'node_modules' / name
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': name, 'version': version, 'license': 'MIT'}))
        (root / 'package-lock.json').write_text(json.dumps({'packages': {
            'node_modules/' + name: {'version': version, 'license': 'MIT'}}}))
        return package

    def test_preserves_bundled_dependency_notices_and_hashes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = self.package(root)
            (package / 'LICENSE').write_text('main license')
            nested = package / 'dist/compiled/vendor'
            nested.mkdir(parents=True)
            (nested / 'THIRD-PARTY-NOTICES.txt').write_text('bundled notice')
            receipt = notices.collect(notices.node_packages(root), root / 'output')
            self.assertEqual(len(receipt['packages'][0]['licenseFiles']), 2)
            self.assertFalse(receipt['legalApproval'])
            self.assertEqual(receipt['missingInstalledTexts'], 0)

    def test_absent_text_is_a_review_item_even_with_mit_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root)
            receipt = notices.collect(notices.node_packages(root), root / 'output')
            self.assertEqual(receipt['missingInstalledTexts'], 1)

    def test_mismatched_installed_version_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = self.package(root)
            (package / 'package.json').write_text('{"name":"fixture","version":"2.0.0"}')
            with self.assertRaisesRegex(ValueError, 'differs from the lock'):
                list(notices.node_packages(root))

    def test_runtime_selection_records_exact_versions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root, '@fixture/runtime', '3.4.5')
            self.assertEqual(notices.runtime_node_identities(root), {('@fixture/runtime', '3.4.5')})

    def test_symlink_cannot_pull_external_runtime_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'node_modules').mkdir()
            (root / 'node_modules/escape').symlink_to(root.parent, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'regular directories'):
                notices.runtime_node_identities(root)

    def test_existing_release_notices_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaises(FileExistsError):
                notices.collect([], root)

    def supplement(self, root, name='fixture', version='1.0.0', license_name='MIT'):
        base = root / 'supplements'
        base.mkdir()
        text = base / 'LICENSE.txt'
        text.write_text('Exact synthetic license text')
        manifest = base / 'sources.json'
        manifest.write_text(json.dumps({'schemaVersion': 1, 'packages': [{
            'name': name, 'version': version, 'declaredLicense': license_name,
            'sources': [{'file': text.name, 'sha256': hashlib.sha256(text.read_bytes()).hexdigest(),
                         'url': 'https://example.invalid/pinned-fixture-license'}]}]}))
        return manifest, text

    def test_reviewed_exact_version_license_text_is_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root)
            manifest, source = self.supplement(root)
            receipt = notices.collect(notices.with_supplements(notices.node_packages(root), manifest), root / 'output')
            self.assertEqual(receipt['missingInstalledTexts'], 0)
            saved = root / 'output' / receipt['packages'][0]['licenseFiles'][0]['file']
            self.assertEqual(saved.read_bytes(), source.read_bytes())
            self.assertIn('supplementalSources', receipt['packages'][0])
            self.assertFalse(receipt['legalApproval'])

    def test_changed_supplement_text_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root)
            manifest, source = self.supplement(root)
            source.write_text('Tampered license text')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                list(notices.with_supplements(notices.node_packages(root), manifest))

    def test_wrapper_license_cannot_replace_different_runtime_terms(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root)
            manifest, _ = self.supplement(root, license_name='Apache-2.0')
            with self.assertRaisesRegex(ValueError, 'differs from installed package'):
                list(notices.with_supplements(notices.node_packages(root), manifest))

    def test_supplement_for_other_version_does_not_clear_missing_text(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root)
            manifest, _ = self.supplement(root, version='2.0.0')
            receipt = notices.collect(notices.with_supplements(notices.node_packages(root), manifest), root / 'output')
            self.assertEqual(receipt['missingInstalledTexts'], 1)

    def test_supplement_path_cannot_escape_inventory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.package(root)
            manifest, source = self.supplement(root)
            data = json.loads(manifest.read_text())
            data['packages'][0]['sources'][0]['file'] = '../external.txt'
            (root / 'external.txt').write_bytes(source.read_bytes())
            manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, 'path escapes'):
                list(notices.with_supplements(notices.node_packages(root), manifest))


if __name__ == '__main__':
    unittest.main()
