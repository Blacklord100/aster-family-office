"""Bounded local process and evidence tests; no Docker, model or office is run."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import unittest
from unittest.mock import patch
import contextlib
import io

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


UPDATES = module('qualify-updates')
CONTROLLER = module('collect-controller')
SMOKE = module('model-smoke')


@unittest.skipUnless(os.name == 'posix', 'Own process-group signals require POSIX')
class ObservedInterruption(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aster-synthetic-fault-observer-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.journal, self.log = self.root / 'journal.json', self.root / 'process.log'

    def launch(self, statement, timeout=2):
        code = 'import json,time;from pathlib import Path;p=Path(' + repr(str(self.journal)) + ');' + statement
        return UPDATES.interrupt_at_phase([sys.executable, '-c', code], self.journal,
                                         'synthetic-candidate', 'old-fleet-stopped', self.log, timeout=timeout)

    def test_observes_durable_phase_and_really_kills_only_its_child(self):
        event = self.launch("p.write_text(json.dumps({'candidate':{'releaseId':'synthetic-candidate'},'phase':'old-fleet-stopped'}));time.sleep(30)")
        self.assertEqual(event['processExit'], -signal.SIGKILL)
        self.assertEqual(event['journalPhaseObserved'], 'old-fleet-stopped')
        self.assertEqual(event['signal'], 'SIGKILL')

    def test_foreign_candidate_cannot_supply_passing_receipt(self):
        with self.assertRaisesRegex(RuntimeError, 'Timed out'):
            self.launch("p.write_text(json.dumps({'candidate':{'releaseId':'another-candidate'},'phase':'old-fleet-stopped'}));time.sleep(30)", timeout=0.2)

    def test_null_candidate_or_incomplete_journal_cannot_supply_receipt(self):
        with self.assertRaisesRegex(RuntimeError, 'Timed out'):
            self.launch("p.write_text(json.dumps({'candidate':None,'phase':'old-fleet-stopped'}));time.sleep(30)", timeout=0.2)

    def test_exited_controller_is_not_an_observed_interruption(self):
        with self.assertRaisesRegex(RuntimeError, 'exited before'):
            self.launch('raise SystemExit(7)')


class ControllerEvidence(unittest.TestCase):
    def stream(self, *extra):
        return '\n'.join(json.dumps(m) for m in [
            {'config': {'scanner_name': 'govulncheck', 'scanner_version': 'v1.8.0',
                        'scan_mode': 'binary', 'scan_level': 'symbol'}},
            {'SBOM': {'modules': [{'path': 'SYNTHETIC'}], 'roots': ['SYNTHETIC']}}, *extra])

    def test_complete_binary_evidence_is_recognized(self):
        self.assertEqual(CONTROLLER.scan_messages(self.stream())['reachableFindings'], 0)

    def test_json_success_does_not_waive_reachable_finding(self):
        with self.assertRaisesRegex(ValueError, 'reachable vulnerable symbols'):
            CONTROLLER.scan_messages(self.stream({'finding': {'osv': 'SYNTHETIC', 'trace': [{'function': 'Vulnerable'}]}}))

    def test_source_scan_or_missing_inventory_is_not_binary_proof(self):
        for invalid in (self.stream().replace('"binary"', '"source"'), self.stream().split('\n')[0]):
            with self.assertRaises(ValueError):
                CONTROLLER.scan_messages(invalid)


class ModelFailureEvidence(unittest.TestCase):
    def test_partial_model_failure_retains_completed_and_failed_checks(self):
        lock = {'name': 'SYNTHETIC:test', 'digest': 'sha256:' + 'a' * 64, 'totalBytes': 1}
        replies = [{'models': [{'name': lock['name'], 'digest': 'a' * 64}]},
                   {'done': True, 'response': 'SYNTHETIC', 'eval_count': 1}, OSError('SYNTHETIC connection lost')]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'receipt.json'
            with patch.object(SMOKE, 'request', side_effect=replies), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(OSError):
                SMOKE.qualify('http://127.0.0.1:1', lock, output)
            receipt = json.loads(output.read_text())
            self.assertEqual(receipt['result'], 'failed')
            self.assertEqual([r['result'] for r in receipt['checks']], ['passed', 'passed', 'failed'])
            self.assertGreaterEqual(receipt['checks'][-1]['elapsedSeconds'], 0)
            self.assertIn('connection lost', receipt['checks'][-1]['error'])
            self.assertFalse(output.with_name('receipt.json.partial').exists())

    def test_unavailable_model_retains_identity_failure(self):
        lock = {'name': 'SYNTHETIC:test', 'digest': 'sha256:' + 'a' * 64, 'totalBytes': 1}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'receipt.json'
            with patch.object(SMOKE, 'request', side_effect=ConnectionError('SYNTHETIC unavailable')), contextlib.redirect_stdout(io.StringIO()), self.assertRaises(ConnectionError):
                SMOKE.qualify('http://127.0.0.1:1', lock, output)
            self.assertEqual(json.loads(output.read_text())['checks'][0]['result'], 'failed')


if __name__ == '__main__':
    unittest.main()
