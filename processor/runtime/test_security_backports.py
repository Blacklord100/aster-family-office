import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('backports', Path(__file__).with_name('apply-security-backports.py'))
backports = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backports)


class ExactBackportTests(unittest.TestCase):
    def fixture(self, root):
        source = root / 'source'
        (source / 'src').mkdir(parents=True)
        (source / 'src/check.cpp').write_text('old\n')
        patch = root / 'fix.patch'
        patch.write_text('diff --git a/src/check.cpp b/src/check.cpp\n'
                         '--- a/src/check.cpp\n+++ b/src/check.cpp\n@@ -1 +1 @@\n-old\n+new\n')
        digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
        record = {'cve': 'CVE-fixture', 'commit': 'fixture', 'url': 'https://example.invalid/fix',
                  'authentication': 'synthetic', 'filename': patch.name, 'sha256': digest(patch.read_text()),
                  'files': [{'path': 'src/check.cpp', 'beforeSha256': digest('old\n'),
                             'afterSha256': digest('new\n')}]}
        return {'tesseract': {'version': 'fixture'}, 'securityBackports': [record]}, source

    def test_exact_patch_applies_and_receipt_keeps_original_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config, source = self.fixture(root)
            receipt = backports.apply_backports(config, root, source)
            self.assertEqual((source / 'src/check.cpp').read_text(), 'new\n')
            self.assertEqual(receipt['backports'][0]['cve'], 'CVE-fixture')

    def test_changed_patch_is_rejected_before_source_write(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config, source = self.fixture(root)
            (root / 'fix.patch').write_text('tampered')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                backports.apply_backports(config, root, source)
            self.assertEqual((source / 'src/check.cpp').read_text(), 'old\n')

    def test_other_source_revision_cannot_use_fuzzy_match(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config, source = self.fixture(root)
            (source / 'src/check.cpp').write_text('prefix\nold\n')
            with self.assertRaisesRegex(ValueError, 'exact reviewed source'):
                backports.apply_backports(config, root, source)

    def test_wrong_output_hash_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config, source = self.fixture(root)
            config['securityBackports'][0]['files'][0]['afterSha256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'differs'):
                backports.apply_backports(config, root, source)

    def test_escape_path_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config, source = self.fixture(root)
            config['securityBackports'][0]['files'][0]['path'] = '../escape'
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                backports.apply_backports(config, root, source)
            config['securityBackports'][0]['files'][0]['path'] = 'src/check.cpp'
            (source / 'src/check.cpp').unlink()
            (source / 'src/check.cpp').symlink_to(root / 'outside')
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                backports.apply_backports(config, root, source)


if __name__ == '__main__':
    unittest.main()
