"""Offline observer tests; no long-running observer or inference is launched."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('mailroom_observer', ROOT / 'watch_report.py')
watch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watch)


def row(status, exact=0, returned=0):
    return {'cell': 0, 'model': 'synthetic-model', 'mode': 'workflow', 'final': {'status': status, 'score': {'goldFactCount': 1, 'supportedExactMatches': exact, 'returnedFactCount': returned}}}


class ObserverControls(unittest.TestCase):
    def test_tool_stderr_and_runtime_are_bounded(self):
        code, message = watch.run_tool([sys.executable, '-c', "import sys; sys.stderr.write('x' * 100000)"], 5)
        self.assertEqual(code, 0)
        self.assertEqual(len(message), 8000)
        with self.assertRaises(subprocess.TimeoutExpired):
            watch.run_tool([sys.executable, '-c', 'import time; time.sleep(5)'], 0.05)

    def test_completed_only_metrics_keep_full_plan_denominator(self):
        result = watch.completed_diagnostics({'uniqueSourceRows': [row('completed', 1, 1), row('failed'), row('pending')], 'rows': [1, 2, 3]}, 3)
        self.assertFalse(result['allExpectedJobsFinal'])
        cell = result['cells'][0]
        self.assertEqual(cell['finishedUniqueJobs'], 2)
        self.assertEqual(cell['failedJobs'], 1)
        self.assertEqual(cell['recallOnFinishedJobsOnly'], 0.5)
        self.assertAlmostEqual(cell['fullPlanRecallLowerBound'], 1 / 3)
        self.assertEqual(cell['pendingGoldFacts'], 1)
        self.assertTrue(watch.completed_diagnostics({'uniqueSourceRows': [row('completed'), row('failed')], 'rows': [1, 2]}, 2)['allExpectedJobsFinal'])

    def test_duplicate_observer_cannot_steal_or_delete_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'observer.pid.lock'
            with watch.ExclusiveLock(path):
                original = path.read_bytes()
                with self.assertRaisesRegex(RuntimeError, 'observer lock already exists'):
                    with watch.ExclusiveLock(path):
                        self.fail('Second observer entered')
                self.assertEqual(path.read_bytes(), original)
            self.assertFalse(path.exists())

    def test_failed_renderer_preserves_last_good_report(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            for name in ['state.json', 'collection.json']:
                (run / name).write_text('{}')
            (run / 'attempts').mkdir()
            (run / 'report.html').write_text('last good report')
            (run / 'scorecard.json').write_text('last good scorecard')
            def fake_command(command, timeout):
                stage = Path(command[command.index('--run') + 1])
                if command[1].endswith('score.py'):
                    (stage / 'scorecard.json').write_text('{}')
                    return 0, ''
                return 1, 'synthetic renderer failure'
            with patch.object(watch, 'run_tool', fake_command):
                with self.assertRaisesRegex(RuntimeError, 'synthetic renderer failure'):
                    watch.generation(run, run, ROOT, b'[]', 5)
            self.assertEqual((run / 'report.html').read_text(), 'last good report')
            self.assertEqual((run / 'scorecard.json').read_text(), 'last good scorecard')
            self.assertEqual(list(run.glob('.observer-stage-*')), [])


if __name__ == '__main__':
    unittest.main()
