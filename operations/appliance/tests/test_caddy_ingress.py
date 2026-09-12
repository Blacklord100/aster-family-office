"""Synthetic routing/TLS/receipt controls; these tests never invoke Docker."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ingress', Path(__file__).parents[1] / 'scripts/probe-caddy-ingress.py')
INGRESS = importlib.util.module_from_spec(spec)
spec.loader.exec_module(INGRESS)
IMAGE = 'sha256:' + 'c' * 64
CID, NID = 'a' * 64, 'b' * 64


def fixture(name='aster-synthetic-ingress-test', published=True):
    container = {'Id': CID, 'Name': '/' + name, 'Image': IMAGE, 'Config': {'User': '10001:10001'},
                 'State': {'Running': True}, 'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False,
                 'CapDrop': ['ALL'], 'CapAdd': None, 'SecurityOpt': ['no-new-privileges:true'], 'Dns': ['127.0.0.1'],
                 'PortBindings': {port: [{'HostIp': '127.0.0.1', 'HostPort': ''}] for port in ['8080/tcp', '8443/tcp']}},
                 'NetworkSettings': {'Networks': {name: {'NetworkID': NID, 'IPAddress': '172.20.0.2'}},
                 'Ports': {port: [{'HostIp': '127.0.0.1', 'HostPort': str(40000 + index)}] if published else None
                           for index, port in enumerate(['8080/tcp', '8443/tcp'])}}}
    network = {'Id': NID, 'Name': name, 'Internal': True, 'Driver': 'bridge', 'Scope': 'local',
               'IPAM': {'Config': [{'Subnet': '172.20.0.0/16'}]},
               'Containers': {CID: {'Name': name, 'IPv4Address': '172.20.0.2/16'}}}
    return container, network


class Topology(unittest.TestCase):
    def test_missing_effective_publication_is_preserved_for_direct_ip_diagnosis(self):
        endpoint = INGRESS.topology(*fixture(published=False), 'aster-synthetic-ingress-test', IMAGE)
        self.assertEqual(endpoint['containerIPv4'], '172.20.0.2')
        self.assertEqual(endpoint['effectivePublications'], {'8080/tcp': None, '8443/tcp': None})
        self.assertEqual(INGRESS.topology(*fixture(), 'aster-synthetic-ingress-test', IMAGE)['effectivePublications']['8443/tcp'], 40001)

    def test_external_extra_network_or_foreign_peer_is_not_equivalent(self):
        cases = []
        c, n = fixture(); n['Internal'] = False; cases.append((c, n))
        c, n = fixture(); c['NetworkSettings']['Networks']['external'] = {}; cases.append((c, n))
        c, n = fixture(); n['Containers']['d' * 64] = {}; cases.append((c, n))
        c, n = fixture(); c['NetworkSettings']['Networks']['aster-synthetic-ingress-test']['IPAddress'] = '8.8.8.8'; cases.append((c, n))
        for item in cases:
            with self.subTest(item=item), self.assertRaises(ValueError):
                INGRESS.topology(*item, 'aster-synthetic-ingress-test', IMAGE)

    def test_mutable_root_wrong_image_and_external_publication_fail(self):
        cases = []
        c, n = fixture(); c['HostConfig']['ReadonlyRootfs'] = False; cases.append((c, n))
        c, n = fixture(); c['Image'] = 'sha256:' + 'd' * 64; cases.append((c, n))
        c, n = fixture(); c['Config']['User'] = '0'; cases.append((c, n))
        c, n = fixture(); c['HostConfig']['CapAdd'] = ['NET_ADMIN']; cases.append((c, n))
        c, n = fixture(); c['NetworkSettings']['Ports']['8443/tcp'][0]['HostIp'] = '0.0.0.0'; cases.append((c, n))
        for item in cases:
            with self.subTest(item=item), self.assertRaises(ValueError):
                INGRESS.topology(*item, 'aster-synthetic-ingress-test', IMAGE)

    def test_docker_environment_cannot_select_remote_host_or_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                'DOCKER_HOST': 'tcp://example.invalid:2376', 'DOCKER_CONTEXT': 'SYNTHETIC',
                'DOCKER_CONFIG': '/SYNTHETIC/credentials', 'HTTPS_PROXY': 'http://example.invalid'}), \
                patch.object(INGRESS.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as run:
            INGRESS.docker(['version'], Path(directory))
        call = run.call_args
        self.assertEqual(call.args[0][:3], ['docker', '--host', 'unix:///var/run/docker.sock'])
        self.assertEqual(call.kwargs['env']['DOCKER_CONFIG'], directory + '/docker-config')
        self.assertFalse({'DOCKER_HOST', 'DOCKER_CONTEXT', 'HTTPS_PROXY'} & call.kwargs['env'].keys())


@unittest.skipUnless(shutil.which('openssl'), 'Actual synthetic TLS tests require OpenSSL CLI')
class RealTLS(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='aster-synthetic-ingress-tls-')
        root = Path(cls.directory.name)
        cls.ca, key = root / 'certificate.pem', root / 'private-key.pem'
        config = root / 'openssl.cnf'
        config.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n'
                          '[dn]\nCN=' + INGRESS.HOSTNAME + '\n[extensions]\n'
                          'basicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:' + INGRESS.HOSTNAME + '\n')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-keyout', str(key), '-out', str(cls.ca), '-config', str(config)],
                       check=True, capture_output=True, timeout=15)
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = INGRESS.BODY if self.headers['Host'] == INGRESS.HOSTNAME else b'WRONG HOST'
                self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers()
                self.wfile.write(body)
            def log_message(self, *args):
                pass
        cls.server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.ca, key)
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(timeout=3); cls.directory.cleanup()

    def test_explicit_public_ca_and_matching_hostname_work_over_actual_tls(self):
        result = INGRESS.https('127.0.0.1', self.server.server_port, self.ca)
        self.assertEqual(result['status'], 200)
        self.assertEqual(result['hostnameVerified'], INGRESS.HOSTNAME)
        self.assertIn(result['tlsVersion'], ['TLSv1.2', 'TLSv1.3'])

    def test_wrong_sni_hostname_and_untrusted_root_are_rejected(self):
        for ca, name in [(self.ca, 'wrong.synthetic.test'), (None, INGRESS.HOSTNAME)]:
            with self.subTest(hostname=name, ca=ca), self.assertRaises(ssl.SSLCertVerificationError):
                INGRESS.https('127.0.0.1', self.server.server_port, ca, name)


class Receipts(unittest.TestCase):
    def fake_docker(self, published):
        calls = []
        name = None
        def run(args, work, **kwargs):
            nonlocal name
            calls.append(args)
            value = ''
            if args[0] == 'version': value = '{}'
            if args[:2] == ['image', 'inspect']: value = IMAGE
            if args[:2] == ['network', 'create']: value = NID
            if args[0] == 'create': name = args[args.index('--name') + 1]; value = CID
            if args[0] == 'cp': Path(args[-1]).write_text('SYNTHETIC PUBLIC CERTIFICATE')
            if args[0] == 'inspect': value = json.dumps([fixture(name, published)[0]])
            if args[:2] == ['network', 'inspect']: value = json.dumps([fixture(name, published)[1]])
            return subprocess.CompletedProcess(args, 0, value, '')
        return run, calls

    def test_missing_publications_fail_receipt_but_keep_successful_direct_control(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'evidence'
            run, calls = self.fake_docker(False)
            with patch.object(INGRESS.sys, 'platform', 'linux'), patch.object(INGRESS, 'docker', side_effect=run), \
                    patch.object(INGRESS, 'https', return_value={'status': 200}), \
                    patch.object(INGRESS, 'rejected_certificate', return_value={'certificateRejected': True}), \
                    self.assertRaisesRegex(RuntimeError, 'qualification failed'):
                INGRESS.qualify(output)
            receipt = json.loads((output / 'receipt.json').read_text())
            self.assertEqual(receipt['result'], 'failed')
            self.assertEqual(receipt['checks'][0]['result'], 'passed')
            self.assertEqual([item['name'] for item in receipt['checks'] if item['result'] == 'failed'],
                             ['host-published-https', 'host-published-http-redirect'])
            self.assertIn(['rm', '--force', '--volumes', CID], calls)
            self.assertIn(['network', 'rm', NID], calls)
            self.assertFalse(any('prune' in command for command in calls))
            self.assertFalse((output / 'private-key.pem').exists())

    def test_all_routes_and_tls_controls_required_for_passing_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'evidence'
            run, calls = self.fake_docker(True)
            with patch.object(INGRESS.sys, 'platform', 'linux'), patch.object(INGRESS, 'docker', side_effect=run), \
                    patch.object(INGRESS, 'https', return_value={'status': 200}), \
                    patch.object(INGRESS, 'http_redirect', return_value={'status': 308}), \
                    patch.object(INGRESS, 'rejected_certificate', return_value={'certificateRejected': True}):
                receipt = INGRESS.qualify(output)
            self.assertEqual(receipt['result'], 'passed')
            self.assertEqual(len(receipt['checks']), 5)
            self.assertTrue(all(item['result'] == 'passed' for item in receipt['checks']))
            self.assertEqual(receipt['imageId'], IMAGE)
            created = next(args for args in calls if args[0] == 'create')
            self.assertIn('--init', created)
            self.assertEqual(created[created.index('--memory') + 1], '256m')

    def test_successful_routes_do_not_waive_failed_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'evidence'
            normal, _ = self.fake_docker(True)
            def run(args, work, **kwargs):
                if args[:2] == ['network', 'rm']:
                    return subprocess.CompletedProcess(args, 1, '', 'SYNTHETIC cleanup denied')
                return normal(args, work, **kwargs)
            with patch.object(INGRESS.sys, 'platform', 'linux'), patch.object(INGRESS, 'docker', side_effect=run), \
                    patch.object(INGRESS, 'https', return_value={'status': 200}), \
                    patch.object(INGRESS, 'http_redirect', return_value={'status': 308}), \
                    patch.object(INGRESS, 'rejected_certificate', return_value={'certificateRejected': True}), \
                    self.assertRaises(RuntimeError):
                INGRESS.qualify(output)
            receipt = json.loads((output / 'receipt.json').read_text())
            self.assertEqual(receipt['result'], 'failed')
            self.assertTrue(all(item['result'] == 'passed' for item in receipt['checks']))
            self.assertTrue(any(item['result'] == 'failed' for item in receipt['cleanup']))

    def test_existing_output_is_not_overwritten_or_used(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(INGRESS.sys, 'platform', 'linux'), \
                patch.object(INGRESS, 'docker') as docker, self.assertRaises(FileExistsError):
            INGRESS.qualify(Path(directory))
        docker.assert_not_called()

    def test_non_linux_refuses_before_docker_or_output_creation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(INGRESS.sys, 'platform', 'darwin'), \
                patch.object(INGRESS, 'docker') as docker, self.assertRaisesRegex(ValueError, 'disposable Linux'):
            INGRESS.qualify(Path(directory) / 'evidence')
        docker.assert_not_called()


if __name__ == '__main__':
    unittest.main()
