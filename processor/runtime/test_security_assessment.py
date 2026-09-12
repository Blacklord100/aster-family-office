from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).parent
spec = importlib.util.spec_from_file_location('assessment', ROOT / 'security-assessment.py')
assessment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assessment)


class ExactImageAssessmentTests(unittest.TestCase):
    def fixture(self):
        source_bytes = (ROOT / 'upstream-sources.json').read_bytes()
        harness = (ROOT / 'security-regression.cc').read_bytes()
        source = json.loads(source_bytes)
        policy = json.loads((ROOT / 'security-policy.json').read_text())
        files = {name: 'a' * 64 for name in ['/opt/tesseract/bin/tesseract',
                 '/opt/tesseract/lib/libtesseract.so.5.5', '/opt/libtiff/lib/libtiff.so.6']}
        build = {'sourceConfigurationSha256': assessment.digest(source_bytes),
                 'harnessSha256': assessment.digest(harness), 'sourceFiles': policy['sourceFiles'],
                 'nativeFiles': files, 'checks': {'schemaVersion': 1, 'networkCases': 12,
                 'normprotoCases': 3, 'tiffCodecCases': 3, 'genericVectorCases': 5,
                 'unicharsetCases': 4, 'intprotoCases': 6, 'passed': True},
                 'backports': {'schemaVersion': 1, 'component': 'tesseract', 'baseVersion': '5.5.3',
                   'backports': [{key: item[key] for key in ['cve', 'commit', 'url', 'sha256',
                                  'authentication', 'files']} for item in source['securityBackports']]}}
        manifest = {'securityBuild': build, **{name: {'sourceArchives': [
                     {key: source[name][key] for key in ['filename', 'sha256', 'url']}]}
                    for name in ['tesseract', 'libtiff']}}
        image_id = 'sha256:' + 'b' * 64
        scan = {'CreatedAt': '2026-09-12T12:00:00Z', 'Metadata': {'ImageID': image_id}, 'Results': [
            {'Class': 'os-pkgs', 'Vulnerabilities': [{'VulnerabilityID': item['cve'],
                'PkgName': item['package'], 'InstalledVersion': item['installedVersion'], 'Severity': 'HIGH'}
                for item in policy['findings']]}]}
        runtime = {'manifestSha256': assessment.digest(json.dumps(manifest, sort_keys=True).encode()),
                   'nativeFiles': files, 'tiffcropAbsent': True, 'provenanceVerified': True}
        return [manifest, scan, runtime, image_id, policy, source_bytes, harness]

    def check(self, data):
        return assessment.assess(*data, now=datetime(2026, 9, 12, 13, tzinfo=timezone.utc))

    def rebind(self, data):
        # Simulates an internally consistent but unapproved/old image, ensuring
        # checked-in source policy, rather than a self-declared receipt, rejects it.
        data[2]['manifestSha256'] = assessment.digest(json.dumps(data[0], sort_keys=True).encode())

    def test_keeps_all_nine_raw_findings_and_binds_each_disposition_to_image(self):
        data = self.fixture()
        result = self.check(data)
        self.assertEqual(result['rawHighOrCritical'], 9)
        self.assertEqual(result['unassessedHighOrCritical'], 0)
        self.assertTrue(all(item['imageID'] == data[3] for item in result['assessments']))
        self.assertEqual(len(data[1]['Results'][0]['Vulnerabilities']), 9)

    def test_known_vulnerable_or_other_package_version_cannot_use_disposition(self):
        data = self.fixture()
        data[1]['Results'][0]['Vulnerabilities'][0]['InstalledVersion'] = '4.7.0-3+deb13u3'
        with self.assertRaisesRegex(ValueError, 'Unassessed'):
            self.check(data)

    def test_new_cve_is_never_implicitly_approved(self):
        data = self.fixture()
        data[1]['Results'][0]['Vulnerabilities'][0]['VulnerabilityID'] = 'CVE-unreviewed'
        with self.assertRaisesRegex(ValueError, 'Unassessed'):
            self.check(data)

    def test_pre_backport_package_revision_cannot_use_candidate_assessment(self):
        for revision in ['5.5.3-1+aster1', '5.5.3-1+aster2']:
            data = self.fixture()
            data[1]['Results'][0]['Vulnerabilities'][2]['InstalledVersion'] = revision
            with self.subTest(revision=revision), self.assertRaisesRegex(ValueError, 'Unassessed'):
                self.check(data)

    def test_changed_severity_requires_review(self):
        data = self.fixture()
        data[1]['Results'][0]['Vulnerabilities'][0]['Severity'] = 'CRITICAL'
        with self.assertRaisesRegex(ValueError, 'Unassessed'):
            self.check(data)

    def test_different_image_cannot_reuse_scan(self):
        data = self.fixture()
        data[3] = 'sha256:' + 'c' * 64
        with self.assertRaisesRegex(ValueError, 'exact candidate'):
            self.check(data)

    def test_stale_scan_cannot_qualify_new_release(self):
        data = self.fixture()
        data[1]['CreatedAt'] = '2026-09-09T00:00:00Z'
        with self.assertRaisesRegex(ValueError, 'stale'):
            self.check(data)

    def test_modified_manifest_cannot_reuse_runtime_attestation(self):
        data = self.fixture()
        data[0]['securityBuild']['checks']['passed'] = False
        with self.assertRaisesRegex(ValueError, 'attestation'):
            self.check(data)

    def test_self_consistent_unpatched_source_is_rejected(self):
        data = self.fixture()
        data[0]['securityBuild']['sourceFiles'] = deepcopy(data[4]['sourceFiles'])
        data[0]['securityBuild']['sourceFiles']['tesseract']['src/lstm/lstm.cpp'] = 'd' * 64
        self.rebind(data)
        with self.assertRaisesRegex(ValueError, 'reviewed source'):
            self.check(data)

    def test_missing_backport_fails_even_when_receipt_says_tests_passed(self):
        data = self.fixture()
        data[0]['securityBuild']['backports']['backports'].pop()
        self.rebind(data)
        with self.assertRaisesRegex(ValueError, 'backports'):
            self.check(data)

    def test_incomplete_regression_coverage_is_rejected(self):
        data = self.fixture()
        data[0]['securityBuild']['checks']['networkCases'] = 11
        self.rebind(data)
        with self.assertRaisesRegex(ValueError, 'full coverage'):
            self.check(data)

    def test_different_runtime_library_bytes_are_rejected(self):
        data = self.fixture()
        data[2]['nativeFiles'] = {**data[2]['nativeFiles'], '/opt/libtiff/lib/libtiff.so.6': 'd' * 64}
        with self.assertRaisesRegex(ValueError, 'native payload'):
            self.check(data)

    def test_different_library_soname_cannot_self_authorize_its_receipt(self):
        data = self.fixture()
        files = data[0]['securityBuild']['nativeFiles']
        files['/opt/tesseract/lib/libtesseract.so.5'] = files.pop('/opt/tesseract/lib/libtesseract.so.5.5')
        self.rebind(data)
        with self.assertRaisesRegex(ValueError, 'native payload'):
            self.check(data)

    def test_absent_tool_disposition_requires_runtime_absence(self):
        data = self.fixture()
        data[2]['tiffcropAbsent'] = False
        with self.assertRaisesRegex(ValueError, 'absent-tool'):
            self.check(data)


if __name__ == '__main__':
    unittest.main()
