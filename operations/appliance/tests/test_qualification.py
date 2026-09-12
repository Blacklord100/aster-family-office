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
import copy
import http.server
import threading
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


UPDATES = module('qualify-updates')
CONTROLLER = module('collect-controller')
SMOKE = module('model-smoke')
CACHE = module('prepare-bounded-cache')
ADMISSION = module('prepare-hosted-model')


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


class InternalModelClient(unittest.TestCase):
    def fixture(self):
        name, cid, nid = SMOKE.INTERNAL_CONTAINER, 'a' * 64, 'b' * 64
        container = {'Name': '/' + name, 'Id': cid, 'Image': 'sha256:' + 'c' * 64,
                     'State': {'Running': True, 'StartedAt': 'SYNTHETIC'}, 'HostConfig': {'PortBindings': {}},
                     'NetworkSettings': {'Networks': {name: {'NetworkID': nid, 'IPAddress': '172.20.0.2'}}}}
        network = {'Name': name, 'Id': nid, 'Driver': 'bridge', 'Scope': 'local', 'Internal': True,
                   'IPAM': {'Config': [{'Subnet': '172.20.0.0/16'}]},
                   'Containers': {cid: {'Name': name, 'IPv4Address': '172.20.0.2/16'}}}
        return container, network

    def test_direct_ip_is_bound_to_sole_internal_bridge_and_same_container(self):
        endpoint = SMOKE.internal_endpoint(*self.fixture())
        self.assertEqual(endpoint['baseURL'], 'http://172.20.0.2:11434')
        self.assertTrue(endpoint['internal'])
        self.assertFalse(endpoint['publishedPorts'])

    def test_remote_docker_environment_cannot_change_the_inspected_host(self):
        replies = [subprocess.CompletedProcess([], 0, json.dumps([value]), '') for value in self.fixture()]
        with patch.dict(os.environ, {'DOCKER_HOST': 'tcp://SYNTHETIC:2376', 'DOCKER_CONTEXT': 'SYNTHETIC-remote',
                                     'DOCKER_TLS_VERIFY': '1', 'DOCKER_CERT_PATH': '/SYNTHETIC'}), \
                patch.object(SMOKE.subprocess, 'run', side_effect=replies) as run:
            self.assertEqual(SMOKE.inspect_internal_endpoint()['baseURL'], 'http://172.20.0.2:11434')
        for call in run.call_args_list:
            self.assertEqual(call.args[0][:3], ['docker', '--host', 'unix:///var/run/docker.sock'])
            self.assertFalse(any(key.startswith('DOCKER_') for key in call.kwargs['env']))

    def test_external_extra_network_and_published_port_are_refused(self):
        container, network = self.fixture()
        bad_network = copy.deepcopy(network); bad_network['Internal'] = False
        with self.assertRaisesRegex(ValueError, 'internal local bridge'):
            SMOKE.internal_endpoint(container, bad_network)
        bad_container = copy.deepcopy(container)
        bad_container['NetworkSettings']['Networks']['external'] = {}
        with self.assertRaisesRegex(ValueError, 'only its internal network'):
            SMOKE.internal_endpoint(bad_container, network)
        bad_container = copy.deepcopy(container)
        bad_container['HostConfig']['PortBindings'] = {'11434/tcp': [{'HostPort': '11439'}]}
        with self.assertRaisesRegex(ValueError, 'not publish'):
            SMOKE.internal_endpoint(bad_container, network)

    def test_wrong_network_or_peer_and_public_loopback_outside_ips_are_refused(self):
        container, network = self.fixture()
        for address in ('127.0.0.1', '8.8.8.8', '172.21.0.2', '172.20.0.0'):
            changed = copy.deepcopy(container)
            changed['NetworkSettings']['Networks'][SMOKE.INTERNAL_CONTAINER]['IPAddress'] = address
            with self.subTest(address=address), self.assertRaises(ValueError):
                SMOKE.internal_endpoint(changed, network)
        for field in ('Id', 'Containers'):
            changed = copy.deepcopy(network); changed[field] = 'mismatch' if field == 'Id' else {}
            with self.subTest(field=field), self.assertRaises(ValueError):
                SMOKE.internal_endpoint(container, changed)

    def test_readiness_records_direct_route_and_checks_identity_again(self):
        endpoint = SMOKE.internal_endpoint(*self.fixture())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'connectivity.json'
            with patch.object(SMOKE, 'inspect_internal_endpoint', return_value=endpoint) as inspect, \
                    patch.object(SMOKE, 'request', return_value={'version': 'SYNTHETIC'}):
                self.assertEqual(SMOKE.await_internal_model(output), endpoint)
            self.assertEqual(inspect.call_count, 2)
            receipt = json.loads(output.read_text())
            self.assertEqual(receipt['result'], 'ready')
            self.assertEqual(receipt['version']['version'], 'SYNTHETIC')
            self.assertEqual(receipt['containerId'], endpoint['containerId'])

    def test_exit_and_changed_identity_leave_failure_receipt_without_waiting(self):
        endpoint = SMOKE.internal_endpoint(*self.fixture())
        for inspections in ([ValueError('SYNTHETIC exited')], [endpoint, dict(endpoint, containerId='replacement')]):
            with self.subTest(inspections=inspections), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'connectivity.json'
                with patch.object(SMOKE, 'inspect_internal_endpoint', side_effect=inspections), \
                        patch.object(SMOKE, 'request', return_value={'version': 'SYNTHETIC'}), \
                        patch.object(SMOKE.time, 'sleep') as sleep, self.assertRaises(ValueError):
                    SMOKE.await_internal_model(output)
                self.assertEqual(json.loads(output.read_text())['result'], 'failed')
                sleep.assert_not_called()

    def test_readiness_timeout_preserves_last_connection_error(self):
        endpoint = SMOKE.internal_endpoint(*self.fixture())
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'connectivity.json'
            with patch.object(SMOKE, 'inspect_internal_endpoint', return_value=endpoint), \
                    patch.object(SMOKE, 'request', side_effect=ConnectionError('SYNTHETIC refused')), \
                    patch.object(SMOKE.time, 'monotonic', side_effect=[0, 0, 0, 61, 61]), \
                    patch.object(SMOKE.time, 'sleep'), self.assertRaisesRegex(ValueError, 'readiness window'):
                SMOKE.await_internal_model(output)
            receipt = json.loads(output.read_text())
            self.assertEqual(receipt['result'], 'failed')
            self.assertEqual(receipt['attempts'], 1)
            self.assertIn('SYNTHETIC refused', receipt['lastRequestError'])

    def test_malformed_loopback_destinations_are_rejected_before_request(self):
        self.assertEqual(SMOKE.validate_loopback('http://127.0.0.1:11439'), 'http://127.0.0.1:11439')
        for url in ('http://127.0.0.1:11439@other-host', 'http://127.0.0.1:11439/path',
                    'http://127.0.0.1:11439?query=1', 'http://127.0.0.1:11439#fragment',
                    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://other-host:11439'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                SMOKE.validate_loopback(url)

    def test_inference_revalidates_identity_before_and_after_each_call(self):
        endpoint = SMOKE.internal_endpoint(*self.fixture())
        lock = {'name': 'SYNTHETIC:test', 'digest': 'sha256:' + 'a' * 64, 'totalBytes': 1}
        replies = [{'models': [{'name': lock['name'], 'digest': 'a' * 64}]},
                   {'done': True, 'response': 'SYNTHETIC'}, {'done': True, 'response': 'RED'}]
        # Reject both a change before the first generation and one after the
        # second generation returns, before its answer can count as passing.
        for checks_before_change, expected_calls in ((2, 1), (5, 3)):
            inspected = [endpoint] * checks_before_change + [dict(endpoint, networkId='replacement')]
            with self.subTest(checks=checks_before_change), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / 'receipt.json'
                with patch.object(SMOKE, 'inspect_internal_endpoint', side_effect=inspected), \
                        patch.object(SMOKE, 'request', side_effect=replies) as request, \
                        contextlib.redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, 'identity changed'):
                    SMOKE.qualify(endpoint['baseURL'], lock, output, expected_endpoint=endpoint)
                receipt = json.loads(output.read_text())
                self.assertEqual(request.call_count, expected_calls)
                self.assertEqual(receipt['result'], 'failed')
                self.assertEqual(receipt['checks'][-1]['result'], 'failed')
                self.assertEqual(receipt['connection']['networkId'], endpoint['networkId'])

    def server(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/must-not-follow')
                    self.end_headers()
                else:
                    self.server.requests.append(self.path)
                    self.send_response(200); self.end_headers(); self.wfile.write(b'{"synthetic":true}')

            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.requests = []
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, f'http://127.0.0.1:{server.server_port}'

    def test_host_proxy_environment_is_never_consulted_for_model_requests(self):
        server, base = self.server()
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:1', 'http_proxy': 'http://127.0.0.1:1',
                                     'NO_PROXY': '', 'no_proxy': ''}), \
                patch.object(SMOKE.urllib.request, 'getproxies', side_effect=AssertionError('Proxy lookup forbidden')):
            self.assertTrue(SMOKE.request(base, '/api/version', timeout=2)['synthetic'])
        self.assertEqual(server.requests, ['/api/version'])

    def test_http_redirect_cannot_send_prompts_to_another_destination(self):
        server, base = self.server()
        with self.assertRaisesRegex(ValueError, 'must not redirect'):
            SMOKE.request(base, '/redirect', timeout=2)
        self.assertEqual(server.requests, [])


class BoundedRuntimeAdmission(unittest.TestCase):
    def test_public_host_memory_is_bounded_and_preserves_host_reserve(self):
        result = ADMISSION.memory_budget('MemTotal: 16777216 kB\nMemAvailable: 14680064 kB\n', 6146502701)
        self.assertTrue(result['adequate'])
        self.assertEqual(result['modelMemoryBytes'], 12 * 1024**3)
        self.assertGreaterEqual(result['availableBytes'] - result['modelMemoryBytes'], 2 * 1024**3)

    def test_small_or_busy_host_is_refused_before_predictable_model_oom(self):
        for total, available in [(7, 6), (16, 7)]:
            result = ADMISSION.memory_budget(f'MemTotal: {total * 1024**2} kB\nMemAvailable: {available * 1024**2} kB\n', 6146502701)
            self.assertFalse(result['adequate'])
            self.assertLessEqual(result['modelMemoryBytes'], (available - 2) * 1024**3)

    def test_restrictive_fixture_directories_become_traversable_without_changing_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'cache'; root.mkdir(mode=0o700)
            (root / 'blobs').mkdir(mode=0o700)
            asset = root / 'blobs/SYNTHETIC'; asset.write_bytes(b'SYNTHETIC'); asset.chmod(0o600)
            receipt = CACHE.prepare(root, {'files': [{'path': 'blobs/SYNTHETIC', 'size': 9}]})
            self.assertEqual(receipt['files'], 1)
            self.assertEqual(root.stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / 'blobs').stat().st_mode & 0o777, 0o755)
            self.assertEqual(asset.stat().st_mode & 0o777, 0o444)
            self.assertEqual(asset.read_bytes(), b'SYNTHETIC')

    def test_symlinked_fixture_cannot_change_permissions_elsewhere(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'cache'; root.mkdir()
            outside = Path(directory) / 'outside'; outside.write_bytes(b'SYNTHETIC'); outside.chmod(0o600)
            (root / 'link').symlink_to(outside)
            with self.assertRaisesRegex(ValueError, 'independent regular assets'):
                CACHE.prepare(root, {'files': [{'path': 'link', 'size': 9}]})
            self.assertEqual(outside.stat().st_mode & 0o777, 0o600)


if __name__ == '__main__':
    unittest.main()
