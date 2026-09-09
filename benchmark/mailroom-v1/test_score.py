"""Offline scoring controls. No database, provider or model is contacted."""
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
SPEC = importlib.util.spec_from_file_location('mailroom_score', ROOT / 'score.py')
score = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(score)


class Controls(unittest.TestCase):
    def test_nearest_rank_p95_is_observed_not_interpolated(self):
        self.assertIsNone(score.nearest_rank_p95([None]))
        self.assertEqual(score.nearest_rank_p95([None, 8]), 8)
        self.assertEqual(score.nearest_rank_p95(list(range(20, 0, -1))), 19)
        self.assertEqual(score.nearest_rank_p95([None, *range(1, 22)]), 20)

    def test_unknown_model_usage_is_not_zero(self):
        self.assertIsNone(score.calls({'facts': [], 'trace': [], 'model': None}))
        self.assertEqual(score.calls({'facts': [], 'model': None, 'trace': [{'stage': 'coverage'}]}), 0)
        self.assertEqual(score.calls({'facts': [], 'trace': [{'stage': 'model_usage', 'detail': '4 local structured model calls; 0 invalid individual candidates rejected.'}]}), 4)

    def test_ambiguous_currency_remains_critical_under_mailroom_ids(self):
        case = {'id': 'alder-house-16', 'relevant': True, 'facts': [], 'reviewExpectation': {'currency': None}}
        result = score.score_case(case, {'facts': [{'currency': 'USD'}], 'relevant': True}, [])
        self.assertEqual(result['criticalBoundaryFailures'][0]['reason'], 'invented_currency_for_ambiguous_symbol')

    def test_planned_missing_and_first_failure_are_preserved(self):
        case = json.loads((ROOT / 'gold.json').read_text())['cases'][0]
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            decoded = run / 'decode'
            decoded.mkdir()
            fact = case['facts'][0]
            quote = ' '.join(fact['evidenceAnchors'])
            (decoded / (case['id'] + '.json')).write_text(json.dumps({'pages': [{'number': fact['evidencePage'], 'text': quote, 'source': 'Synthetic scoring control'}], 'warnings': [], 'decodeError': None}))
            output = {'facts': [{**{field: fact.get(field) for field in score.strict.FIELDS}, 'evidence': {'page': fact['evidencePage'], 'quote': quote}}], 'relevant': True, 'trace': [], 'model': 'synthetic-model'}
            work = [{'id': str(index), 'sourceId': case['id'], 'sourceIds': [case['id']], 'documentId': 'synthetic-document', 'model': ['gemma-test', 'qwen-test'][index // 2], 'mode': ['workflow', 'agentic'][index % 2], 'cell': index} for index in range(4)]
            state = {'runId': 'offline-scoring-control', 'manifestSha256': sha256((ROOT / 'manifest.json').read_bytes()).hexdigest(), 'inventory': [], 'models': ['gemma-test', 'qwen-test'], 'sources': {case['id']: {}}, 'work': work}
            (run / 'state.json').write_text(json.dumps(state))
            (run / 'results.json').write_text(json.dumps([{**work[0], 'status': 'awaiting_review', 'output': output}]))
            initial = run / 'attempts/0/001'
            initial.mkdir(parents=True)
            (initial / 'attempt.json').write_text(json.dumps({'httpStatus': 422, 'startedAt': 'before', 'finishedAt': 'after', 'wallSeconds': 0.1}))
            (initial / 'response.json').write_text('{"error":"synthetic failure"}')
            final = run / 'attempts/0/002'
            final.mkdir(parents=True)
            (final / 'attempt.json').write_text(json.dumps({'httpStatus': 200, 'finishedAt': 'later', 'wallSeconds': 0.2}))
            (final / 'response.json').write_text(json.dumps(output))
            subprocess.run([sys.executable, str(ROOT / 'score.py'), '--run', str(run), '--decoded', str(decoded)], check=True, capture_output=True)
            result = json.loads((run / 'scorecard.json').read_text())
            self.assertEqual(len(result['rows']), 4)
            first = result['rows'][0]
            self.assertEqual(first['firstAttempt']['status'], 'failed')
            self.assertEqual(first['firstAttempt']['score']['supportedExactMatches'], 0)
            self.assertEqual(first['final']['score']['supportedExactMatches'], 1)
            self.assertEqual(first['processingHttpAttempts'], 2)
            self.assertAlmostEqual(first['allAttemptWallSeconds'], 0.3)
            self.assertEqual(sum(row['final']['status'] == 'unrun' for row in result['rows']), 3)
            self.assertEqual(result['matrix']['uniqueSourcesStoredFinal'][1]['pending'], 1)
            state['manifestSha256'] = 'wrong'
            (run / 'state.json').write_text(json.dumps(state))
            mismatch = subprocess.run([sys.executable, str(ROOT / 'score.py'), '--run', str(run), '--decoded', str(decoded)], capture_output=True)
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn(b'manifest identity', mismatch.stderr)


if __name__ == '__main__':
    unittest.main()
