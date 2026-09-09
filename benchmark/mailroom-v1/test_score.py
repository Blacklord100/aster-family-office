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
    def test_tool_events_distinguish_availability_from_actual_return(self):
        activity = score.tool_activity({'trace': [
            {'stage': 'model_capabilities', 'status': 'ok', 'detail': 'image input available'},
            {'stage': 'vision', 'status': 'skipped'},
            {'stage': 'vision', 'status': 'ok'},
            {'stage': 'vision_result', 'status': 'ok'},
            {'stage': 'agent_search', 'status': 'ok'},
            {'stage': 'agent_layout', 'status': 'ok'},
            {'stage': 'workflow_retry', 'status': 'ok'},
            {'stage': 'trace_limit', 'status': 'warning'},
        ]})
        self.assertEqual(activity['visionRequestTraceCount'], 1)
        self.assertEqual(activity['visionResponseTraceCount'], 1)
        self.assertEqual(activity['visionUnavailableTraceCount'], 1)
        self.assertEqual(activity['agentSearches'], 1)
        self.assertEqual(activity['agentLayoutInspections'], 1)
        self.assertEqual(activity['workflowRevisits'], 1)
        self.assertTrue(activity['traceTruncated'])

    def test_model_recording_is_unknown_when_absent_and_bound_to_planned_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            planned = {'id': 'job', 'documentId': 'document', 'sourceId': 'case', 'model': 'gemma4:e4b-m3', 'mode': 'workflow'}
            self.assertIsNone(score.recorded_model_usage(run, planned)['chatRequests'])
            directory = run / 'model-attempts/job/attempt'; directory.mkdir(parents=True)
            self.assertFalse(score.recorded_model_usage(run, planned)['available'])
            self.assertIsNone(score.recorded_model_usage(run, planned)['chatRequests'])
            decoded = run / 'decoded'; decoded.mkdir()
            recorder = score.recorder
            recorder.write(run / 'preflight-plan.json', {'manifestSha256': 'same', 'work': [planned]})
            recorder.write(decoded / 'decode-index.json', {'decoderUnchanged': True, 'manifestSha256': 'same',
                           'rows': [{'caseId': 'case', 'sourceSha256': 'original', 'pageImages': []}]})
            recorder.Registry(run, decoded, preflight=True)
            request = json.dumps({'model': planned['model'], 'stream': False,
                                  'messages': [{'role': 'user', 'content': 'Synthetic'}]}).encode()
            (directory / 'request.template.bin').write_bytes(request)
            response = b'{"done":true}'
            (directory / 'response.bin').write_bytes(response)
            metadata = {'jobId': 'job', **{key: planned[key] for key in ['documentId', 'sourceId', 'model', 'mode']},
                        'path': '/api/chat', 'finishedAt': '2026-09-09T00:00:00Z', 'imageCount': 0, 'imageProvenance': [], 'imageReplacements': [],
                        'requestBytes': len(request), 'requestSha256': recorder.digest(request),
                        'templateSha256': recorder.digest(request), 'responseBytes': len(response),
                        'responseSha256': recorder.digest(response)}
            (directory / 'attempt.json').write_text(json.dumps(metadata))
            usage = score.recorded_model_usage(run, planned)
            self.assertEqual(usage['chatRequests'], 1)
            self.assertEqual(usage['chatRequestsWithImages'], 0)
            completed_at = metadata.pop('finishedAt')
            (directory / 'attempt.json').write_text(json.dumps(metadata))
            pending = score.recorded_model_usage(run, planned)
            self.assertFalse(pending['available'])
            self.assertEqual(pending['pendingRecords'], 1)
            self.assertIsNone(pending['chatRequests'])
            metadata['finishedAt'] = completed_at
            metadata['imageCount'] = 4
            (directory / 'attempt.json').write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, 'image metadata'):
                score.recorded_model_usage(run, planned)
            metadata['model'] = 'different-model'
            (directory / 'attempt.json').write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, 'identity'):
                score.recorded_model_usage(run, planned)

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
