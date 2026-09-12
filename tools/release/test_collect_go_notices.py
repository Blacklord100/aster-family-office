import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('go_notices', Path(__file__).with_name('collect-go-notices.py'))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class BinaryInventoryTests(unittest.TestCase):
    def fixture(self):
        dependency = {'Path': 'example.invalid/dependency', 'Version': 'v1.2.3', 'Sum': 'h1:synthetic'}
        build = {'Path': 'example.invalid/project/cli', 'Main': {'Path': 'example.invalid/project'},
                 'GoVersion': 'go1.27.1', 'Deps': [dependency]}
        modules = [{'Path': 'example.invalid/project', 'Main': True},
                   {**dependency, 'Dir': '/synthetic/offline-cache/module'}]
        return build, modules

    def test_only_dependencies_embedded_in_binary_are_selected(self):
        build, modules = self.fixture()
        modules.append({'Path': 'example.invalid/test-only', 'Version': 'v1.0.0', 'Sum': 'h1:test'})
        self.assertEqual(len(notices.select_modules(build, modules)), 1)

    def test_same_version_different_content_sum_is_rejected(self):
        build, modules = self.fixture()
        modules[1]['Sum'] = 'h1:different'
        with self.assertRaisesRegex(ValueError, 'differs from the locked'):
            notices.select_modules(build, modules)

    def test_replacement_module_cannot_borrow_original_license(self):
        build, modules = self.fixture()
        modules[1]['Replace'] = {'Path': '/unreviewed/local/source'}
        with self.assertRaisesRegex(ValueError, 'Replacement dependencies'):
            notices.select_modules(build, modules)

    def test_binary_with_unrelated_main_module_is_rejected(self):
        build, modules = self.fixture()
        build['Main']['Path'] = 'example.invalid/another-project'
        with self.assertRaisesRegex(ValueError, 'main module differs'):
            notices.select_modules(build, modules)

    def test_missing_module_content_identity_is_rejected(self):
        build, modules = self.fixture()
        del build['Deps'][0]['Sum']
        with self.assertRaisesRegex(ValueError, 'incomplete or duplicated'):
            notices.select_modules(build, modules)

    def test_spdx_binds_executable_hash_and_exact_dependencies(self):
        build, modules = self.fixture()
        digest = 'a' * 64
        sbom = notices.spdx(build, Path('aster'), digest, modules[1:], '2026-09-12T00:00:00Z')
        self.assertEqual(sbom['packages'][0]['checksums'][0]['checksumValue'], digest)
        self.assertEqual(len(sbom['packages']), 3)
        self.assertEqual(sbom['packages'][2]['versionInfo'], 'v1.2.3')
        self.assertEqual(sbom['packages'][2]['licenseDeclared'], 'NOASSERTION')
        self.assertIn('h1:synthetic', sbom['packages'][2]['sourceInfo'])


if __name__ == '__main__':
    unittest.main()
