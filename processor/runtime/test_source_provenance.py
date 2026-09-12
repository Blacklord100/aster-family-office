import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('source_fetch', ROOT / 'fetch-sources.py')
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)


class SourceProvenanceTests(unittest.TestCase):
    def test_retained_authentication_files_match_reviewed_pins(self):
        sources = json.loads((ROOT / 'upstream-sources.json').read_text())
        for source in sources['provenanceFiles']:
            fetch.check_hash(ROOT / 'source-provenance' / source['filename'], source['sha256'])

    def test_actual_local_package_identities_match_the_assessment_policy(self):
        spec = importlib.util.spec_from_file_location('source_assembly', ROOT / 'assemble.py')
        assembly = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(assembly)
        policy = json.loads((ROOT / 'security-policy.json').read_text())
        packages = {item['name']: assembly.custom_package_version(item)
                    for item in assembly.CUSTOM_PACKAGES.values()}
        for finding in policy['findings']:
            self.assertEqual(finding['installedVersion'], packages[finding['package']])

    def test_signed_git_tag_binds_the_exact_release_commit(self):
        sources = json.loads((ROOT / 'upstream-sources.json').read_text())
        auth = sources['tesseract']['authentication']
        tag = json.loads((ROOT / 'source-provenance' / auth['tagFile']).read_text())
        payload, signature = fetch.signed_tag(tag, auth)
        self.assertIn(b'tag 5.5.3\n', payload)
        self.assertTrue(signature.startswith(b'-----BEGIN PGP SIGNATURE-----'))
        modified = copy.deepcopy(tag)
        modified['verification']['payload'] = modified['verification']['payload'].replace(auth['commit'], '0' * 40)
        with self.assertRaisesRegex(RuntimeError, 'reviewed Git object'):
            fetch.signed_tag(modified, auth)

    def test_modified_download_fails_even_when_the_filename_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.tar.gz'
            original = b'original release bytes'
            expected = hashlib.sha256(original).hexdigest()
            path.write_bytes(original)
            fetch.check_hash(path, expected)
            path.write_bytes(original + b'changed')
            with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                fetch.check_hash(path, expected)


if __name__ == '__main__':
    unittest.main()
