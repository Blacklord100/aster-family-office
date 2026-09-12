import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('qualification', Path(__file__).with_name('qualify-security-build.py'))
qualification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualification)


class SecurityQualificationTests(unittest.TestCase):
    def test_failed_assertion_retains_bounded_diagnostics_and_never_a_success_receipt(self):
        result = subprocess.CompletedProcess(['synthetic'], 1, 'x' * 20000, 'TIFF guard accepted malformed input')
        with patch.object(qualification.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, 'exited 1') as failure:
                qualification.run_security_regression(Path('/synthetic/harness'))
        self.assertIn('TIFF guard accepted malformed input', str(failure.exception))
        self.assertLess(len(str(failure.exception)), 17000)

    def test_zero_exit_does_not_waive_missing_security_cases(self):
        partial = {'schemaVersion': 1, 'networkCases': 11, 'normprotoCases': 3,
                   'tiffCodecCases': 3, 'passed': True}
        result = subprocess.CompletedProcess(['synthetic'], 0, json.dumps(partial), '')
        with patch.object(qualification.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, 'coverage'):
                qualification.run_security_regression(Path('/synthetic/harness'))

    def test_timeout_cannot_qualify_an_image(self):
        with patch.object(qualification.subprocess, 'run', side_effect=subprocess.TimeoutExpired('synthetic', 30)):
            with self.assertRaisesRegex(RuntimeError, '30 second limit'):
                qualification.run_security_regression(Path('/synthetic/harness'))

    def test_complete_native_case_receipt_is_required(self):
        complete = {'schemaVersion': 1, 'networkCases': 12, 'normprotoCases': 3,
                    'tiffCodecCases': 3, 'passed': True}
        result = subprocess.CompletedProcess(['synthetic'], 0, 'synthetic diagnostic\n' + json.dumps(complete), '')
        with patch.object(qualification.subprocess, 'run', return_value=result):
            self.assertEqual(qualification.run_security_regression(Path('/synthetic/harness')), complete)


if __name__ == '__main__':
    unittest.main()
