"""Offline report controls, including refusal to overwrite with partial results."""
from copy import deepcopy
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('mailroom_findings', ROOT / 'write_findings.py')
findings = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(findings)


def synthetic_scorecard():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    gold = {case['id']: case for case in json.loads((ROOT / 'gold.json').read_text())['cases']}
    canonical = {}
    for source in manifest['documents']:
        canonical.setdefault((source['office_id'], source['sha256']), source)
    unique, receipts = [], []
    for cell in range(4):
        current = {}
        for index, (key, source) in enumerate(canonical.items()):
            case = gold[source['id']]
            score = {'goldFactCount': len(case['facts']), 'supportedExactMatches': 0, 'returnedFactCount': 0, 'validOutputEnvelope': False, 'factPerfect': False, 'reviewCorrectionProxy': {'totalUnits': len(case['facts'])}, 'predictedRelevant': None, 'expectedRelevant': case['relevant']}
            observation = {'status': 'failed', 'httpStatus': 422, 'wallSeconds': 0.1, 'score': score, 'warnings': [], 'output': None, 'modelChatCalls': None}
            row = {'jobId': f'control-{cell}-{index}', 'caseId': source['id'], 'cell': cell, 'model': ['gemma-fixture', 'qwen-fixture'][cell // 2], 'mode': ['workflow', 'agentic'][cell % 2], 'category': source['category'], 'expectedFacts': case['facts'], 'processingHttpAttempts': 3, 'allAttemptWallSeconds': 0.3, 'expectedSafeInputBlock': case.get('reviewExpectation', {}).get('expectedSafeInputBlock', False), 'firstAttempt': deepcopy(observation), 'final': deepcopy(observation)}
            unique.append(row)
            current[key] = row
        for source in manifest['documents']:
            row = deepcopy(current[(source['office_id'], source['sha256'])])
            row['caseId'] = source['id']
            receipts.append(row)
    return {'generatedAt': 'offline test only', 'runId': 'synthetic-report-control-no-inference', 'manifestSha256': sha256((ROOT / 'manifest.json').read_bytes()).hexdigest(), 'rows': receipts, 'uniqueSourceRows': unique, 'inventory': [], 'collection': {'status': 'synthetic control', 'checks': [], 'networkCallsToMailProviders': 0}, 'modeDisagreements': []}


class FindingsControls(unittest.TestCase):
    def test_comparable_pair_denominator_is_separate_from_differences(self):
        scorecard = synthetic_scorecard()
        # Give the same unchanged, usable result to one receipt in each mode.
        for row in [*scorecard['rows'], *scorecard['uniqueSourceRows']]:
            if row['model'] == 'gemma-fixture' and row['caseId'] == 'alder-house-01':
                row['final']['status'] = 'completed'
        self.assertEqual(findings.comparable_mode_pairs(scorecard['rows'], 'gemma-fixture'), 1)
        self.assertEqual(findings.comparable_mode_pairs(scorecard['rows'], 'qwen-fixture'), 0)
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        report = findings.build_findings(scorecard, manifest, True)
        self.assertIn('Compared 1 usable receipt pairs across the two models (1 unique-original pairs)', report)
        self.assertIn('0 model/receipt comparisons differed', report)
        self.assertIn('1 comparable receipt pairs (1 unique-original pairs); 0 differing receipt pairs', report)

    def test_p95_retains_failed_http_duration_and_excludes_missing(self):
        scorecard = synthetic_scorecard()
        rows = scorecard['uniqueSourceRows'][:21]
        for index, row in enumerate(rows):
            row['final']['wallSeconds'] = None if index == 20 else index + 1
        metric = findings.metrics(rows)
        self.assertEqual(metric['failed'], 21)
        self.assertEqual(metric['p95'], 19)
        self.assertEqual(metric['max'], 20)
        self.assertIsNone(findings.nearest_rank_p95([None]))

    def test_confusion_separates_unavailable(self):
        rows = [{'final': {'score': {'expectedRelevant': expected, 'predictedRelevant': predicted}}} for expected, predicted in [(True, True), (False, False), (False, True), (True, False), (True, None)]]
        self.assertEqual(findings.confusion(rows), {'TP': 1, 'TN': 1, 'FP': 1, 'FN': 1, 'unavailable': 1})

    def test_complete_plan_and_partial_refusal(self):
        scorecard = synthetic_scorecard()
        self.assertTrue(findings.require_complete(scorecard['uniqueSourceRows']))
        with self.assertRaisesRegex(ValueError, 'complete 388-job plan'):
            findings.require_complete(scorecard['uniqueSourceRows'][:-1])
        scorecard['uniqueSourceRows'][0]['final']['status'] = 'pending'
        with self.assertRaisesRegex(ValueError, 'Refusing partial findings: 387/388'):
            findings.require_complete(scorecard['uniqueSourceRows'])
        self.assertFalse(findings.require_complete(scorecard['uniqueSourceRows'], True))

    def test_cli_atomic_report_and_refusal_preserve_previous(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            scorecard = synthetic_scorecard()
            (run / 'scorecard.json').write_text(json.dumps(scorecard))
            command = [sys.executable, str(ROOT / 'write_findings.py'), '--run', str(run)]
            result = subprocess.run(command, check=True, capture_output=True)
            self.assertTrue(json.loads(result.stdout)['complete'])
            report = (run / 'findings.md').read_text()
            self.assertIn('388 unique production jobs and 400 receipt-level evaluations', report)
            self.assertIn('93 scored fact observations', report)
            self.assertIn('90 scored facts per 97 unique originals', report)
            self.assertIn('No model or processing mode is automatically selected', report)
            self.assertIn('[Open the portable interactive report](./report.html)', report)
            scorecard['uniqueSourceRows'][0]['final']['status'] = 'pending'
            (run / 'scorecard.json').write_text(json.dumps(scorecard))
            failed = subprocess.run(command, capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn(b'Refusing partial findings', failed.stderr)
            self.assertEqual((run / 'findings.md').read_text(), report)
            subprocess.run([*command, '--allow-partial'], check=True, capture_output=True)
            self.assertIn('PARTIAL PROGRESS REPORT', (run / 'findings.md').read_text())
            self.assertEqual(list(run.glob('*.partial')), [])


if __name__ == '__main__':
    unittest.main()
