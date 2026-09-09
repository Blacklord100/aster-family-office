import contextlib
import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('verify_scan', Path(__file__).with_name('verify-scan.py'))
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class InventoryTests(unittest.TestCase):
    def fixture(self):
        return ({'schemaVersion': 1, 'systemPackages': [{'name': 'tesseract-ocr', 'version': '5.5.0-1+aster1'}]},
                {'Metadata': {'OS': {'Family': 'debian', 'Name': '13.6'}}, 'Results': [
                    {'Class': 'os-pkgs', 'Packages': [{'Name': 'tesseract-ocr', 'Version': '5.5.0', 'Release': '1+aster1'}]},
                    {'Type': 'python-pkg', 'Packages': [{'Name': 'Pillow', 'Version': '12.3.0'}]}]})

    def test_exact_rebuild_and_python_inventory_pass(self):
        self.assertEqual(scanner.verify(*self.fixture(), 'Pillow==12.3.0')['highOrCritical'], 0)

    def test_missing_package_metadata_fails_even_without_vulnerabilities(self):
        manifest, scan = self.fixture()
        scan['Results'][0]['Packages'] = []
        with self.assertRaisesRegex(ValueError, 'lost copied Debian package'):
            scanner.verify(manifest, scan, 'Pillow==12.3.0')

    def test_wrong_rebuild_version_fails(self):
        manifest, scan = self.fixture()
        scan['Results'][0]['Packages'][0]['Release'] = '1'
        with self.assertRaisesRegex(ValueError, 'lost copied Debian package'):
            scanner.verify(manifest, scan, 'Pillow==12.3.0')

    def test_missing_native_wheel_metadata_fails(self):
        with self.assertRaisesRegex(ValueError, 'lost locked Python package'):
            scanner.verify(*self.fixture(), 'Pillow==12.3.0\nnumpy==2.5.3')

    def test_darwin_only_lock_entry_does_not_require_linux_package(self):
        scanner.verify(*self.fixture(), 'Pillow==12.3.0\npyobjc-core==12.2.2; sys_platform == "darwin"')

    def test_unfixed_critical_is_never_ignored(self):
        manifest, scan = self.fixture()
        scan['Results'][0]['Vulnerabilities'] = [{'Severity': 'CRITICAL', 'PkgName': 'tesseract-ocr',
                                                'InstalledVersion': '5.5.0-1+aster1', 'VulnerabilityID': 'CVE-test'}]
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, 'block release'):
            scanner.verify(manifest, scan, 'Pillow==12.3.0')

    def test_epoch_is_part_of_package_identity(self):
        self.assertEqual(scanner.version({'Version': '1.2', 'Release': '3', 'Epoch': 2}), '2:1.2-3')


if __name__ == '__main__':
    unittest.main()
