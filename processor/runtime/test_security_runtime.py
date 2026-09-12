import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location('runtime_security', Path(__file__).with_name('verify-security-runtime.py'))
runtime_security = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime_security)


class RuntimeSecurityInventoryTests(unittest.TestCase):
    def test_accepts_actual_manifest_file_and_symlink_record_shapes(self):
        runtime_security.verify_tool_inventory([{'files': [
            {'path': '/opt/libtiff/lib/libtiff.so.6', 'symlink': 'libtiff.so.6.2.0'},
            {'path': '/opt/libtiff/lib/libtiff.so.6.2.0', 'sha256': 'a' * 64},
        ]}])

    def test_affected_tool_cannot_be_hidden_in_a_file_record(self):
        with self.assertRaisesRegex(ValueError, 'affected TIFF'):
            runtime_security.verify_tool_inventory([{'files': [
                {'path': '/opt/libtiff/bin/tiffcrop', 'sha256': 'a' * 64},
            ]}])

    def test_malformed_entries_do_not_become_absence_proof(self):
        for entry in ['/opt/bin/tiffcrop', {}, {'path': 0}, {'path': 'relative'}]:
            with self.subTest(entry=entry), self.assertRaisesRegex(ValueError, 'Malformed'):
                runtime_security.verify_tool_inventory([{'files': [entry]}])


if __name__ == '__main__':
    unittest.main()
