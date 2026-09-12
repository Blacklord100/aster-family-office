"""No Docker/systemd mutations: strict controls for the hosted synthetic probe."""
import copy
import hashlib
import http.server
import importlib.util
import os
from pathlib import Path
import ssl
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('unix_ingress', Path(__file__).parents[1] / 'scripts/probe-unix-ingress.py')
PROBE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PROBE)
IMAGE = 'sha256:' + 'c' * 64
NAME = 'aster-synthetic-test'


def topology():
    containers = []
    for value in ('a', 'b'):
        containers.append({'Id': value * 64, 'Image': IMAGE, 'Config': {'User': '10001:10001'},
                           'State': {'Running': True}, 'HostConfig': {'ReadonlyRootfs': True,
                           'Privileged': False, 'CapDrop': ['ALL'], 'CapAdd': None,
                           'SecurityOpt': ['no-new-privileges:true'], 'Dns': ['127.0.0.1'], 'PortBindings': {}},
                           'NetworkSettings': {'Ports': {}, 'Networks': {NAME: {'NetworkID': 'd' * 64}}}})
    network = {'Name': NAME, 'Id': 'd' * 64, 'Internal': True, 'Driver': 'bridge', 'Scope': 'local',
               'Containers': {value['Id']: {} for value in containers}}
    return containers, network


class Controls(unittest.TestCase):
    def test_actual_shared_templates_use_private_paths_and_inherited_sockets(self):
        root = Path('/tmp/aster-synthetic-test')
        binary = root / 'releases/synthetic/payload/bin/asterctl'
        units, hashes = PROBE.render_units(root, binary)
        base = 'aster-ingress-' + hashlib.sha256(str(root).encode()).hexdigest()[:16]
        self.assertEqual(set(units), {base + '-' + protocol + '.' + kind for protocol in ('http', 'https') for kind in ('socket', 'service')})
        for kind in ('socket', 'service'):
            self.assertEqual(hashes[kind], hashlib.sha256((PROBE.TEMPLATES / (kind + '.unit')).read_bytes()).hexdigest())
        for protocol, port in [('http', 80), ('https', 443)]:
            self.assertIn(f'ListenStream=0.0.0.0:{port}\n', units[base + '-' + protocol + '.socket'])
            service = units[base + '-' + protocol + '.service']
            self.assertIn('ExecStart=/asterctl ingress --socket /sockets/' + protocol + '.sock', service)
            for instruction in ('User=10001', 'PrivateNetwork=true', 'RestrictAddressFamilies=AF_UNIX',
                                'NoNewPrivileges=true', 'CapabilityBoundingSet=\n', 'RootDirectory=' + str(root / 'run/ingress-jail')):
                self.assertIn(instruction, service)
            self.assertNotIn('@', service)

    def test_paths_tokens_and_nonrelease_binary_are_rejected(self):
        for value in ['/tmp/SYNTHETIC space', '/tmp/../SYNTHETIC', '/tmp/SYNTHETIC\nUser=0', '/', 'relative']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                PROBE.render_units(Path(value), Path(value) / 'releases/test/payload/bin/asterctl')
        with self.assertRaises(ValueError):
            PROBE.render_units(Path('/tmp/test'), Path('/usr/bin/asterctl'))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / 'socket.unit').write_text('@UNKNOWN@')
            with self.assertRaisesRegex(ValueError, 'Unresolved'):
                PROBE.render_units(Path('/tmp/test'), Path('/tmp/test/releases/test/payload/bin/asterctl'), path)

    def test_internal_topology_has_no_publication_and_no_foreign_peer(self):
        containers, network = topology()
        self.assertEqual(PROBE.inspect_topology(containers, network, NAME, IMAGE)['dockerPublications'], [])
        changes = [lambda c, n: n.update(Internal=False),
                   lambda c, n: n['Containers'].update({'e' * 64: {}}),
                   lambda c, n: c[0]['HostConfig'].update(PortBindings={'443/tcp': [{}]}),
                   lambda c, n: c[0]['NetworkSettings']['Networks'].update({'external': {}}),
                   lambda c, n: c[0]['HostConfig'].update(CapAdd=['NET_ADMIN']),
                   lambda c, n: c[0]['Config'].update(User='0'),
                   lambda c, n: c[0].update(Image='sha256:' + 'f' * 64)]
        for change in changes:
            c, n = copy.deepcopy((containers, network)); change(c, n)
            with self.subTest(change=change), self.assertRaises(ValueError):
                PROBE.inspect_topology(c, n, NAME, IMAGE)

    def test_wrong_sni_alert_requires_immediate_positive_control_and_never_waives_ca(self):
        alert = ssl.SSLError(1, 'synthetic unknown SNI'); alert.reason = 'TLSV1_ALERT_INTERNAL_ERROR'
        with patch.object(PROBE, 'https', side_effect=[alert, {'status': 200}]) as request:
            result = PROBE.reject_tls(Path('/SYNTHETIC/root.crt'), 'wrong.synthetic.test')
        self.assertEqual(result['validHostnameControl']['status'], 200)
        self.assertEqual(request.call_args.args, (Path('/SYNTHETIC/root.crt'),))
        for ca, hostname, errors in [(None, PROBE.HOSTNAME, [alert]),
                                     (Path('/ca'), 'wrong.synthetic.test', [alert, ConnectionRefusedError()]),
                                     (Path('/ca'), 'wrong.synthetic.test', [TimeoutError()])]:
            with patch.object(PROBE, 'https', side_effect=errors), self.assertRaises(OSError):
                PROBE.reject_tls(ca, hostname)

    def test_privileged_execution_discards_ambient_environment_and_remote_tools(self):
        with patch.dict(os.environ, {'LD_PRELOAD': '/SYNTHETIC/evil', 'SYSTEMD_UNIT_PATH': '/SYNTHETIC'}), \
                patch.object(PROBE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as run:
            PROBE.privileged(['/usr/bin/systemctl', 'show', 'aster-SYNTHETIC.service'])
        self.assertEqual(run.call_args.args[0][:6], ['/usr/bin/sudo', '-n', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8'])
        self.assertTrue(run.call_args.kwargs['capture_output'])
        with self.assertRaises(ValueError):
            PROBE.privileged(['systemctl', 'show'])

    def test_cleanup_timeout_is_a_failed_receipt_value_not_an_early_abort(self):
        def timed_out():
            raise subprocess.TimeoutExpired('SYNTHETIC cleanup', 1)
        result = PROBE.cleanup_command(timed_out)
        self.assertEqual(result.returncode, 1)
        self.assertIn('SYNTHETIC cleanup', result.stderr)

    def test_ca_continuity_compares_actual_public_bytes_after_restarts(self):
        public = b'SYNTHETIC PUBLIC CERTIFICATE'
        def read(cid, work, path):
            path.write_bytes(public)
        with tempfile.TemporaryDirectory() as directory, patch.object(PROBE.common, 'read_public_root', side_effect=read):
            self.assertTrue(PROBE.persistent_ca('a' * 64, Path(directory), hashlib.sha256(public).hexdigest())['unchanged'])
            with self.assertRaisesRegex(ValueError, 'CA changed'):
                PROBE.persistent_ca('a' * 64, Path(directory), '0' * 64)

    def test_unix_paths_must_be_exact_protected_sockets_not_links_or_regular_files(self):
        def run(args):
            value = 'socket|200|10001|10001' if args[-1].endswith('.sock') else 'directory|700|10001|10001'
            return subprocess.CompletedProcess(args, 0, value, '')
        with patch.object(PROBE, 'privileged', side_effect=run):
            self.assertEqual(len(PROBE.socket_permissions(Path('/SYNTHETIC/sockets'))), 3)
        for bad in ['socket|777|10001|10001', 'regular file|200|10001|10001',
                    'symbolic link|777|10001|10001', 'socket|200|0|10001']:
            def altered(args):
                return subprocess.CompletedProcess(args, 0, bad, '') if args[-1].endswith('.sock') else run(args)
            with patch.object(PROBE, 'privileged', side_effect=altered), self.assertRaises(ValueError):
                PROBE.socket_permissions(Path('/SYNTHETIC/sockets'))

    def test_actual_process_network_mount_and_binary_proof_are_required(self):
        properties = {'MainPID': '1234', 'User': '10001', 'Group': '10001', 'PrivateNetwork': 'yes',
                      'RestrictAddressFamilies': 'AF_UNIX', 'NoNewPrivileges': 'yes', 'CapabilityBoundingSet': '',
                      'AmbientCapabilities': '', 'ActiveState': 'active', 'RootDirectory': '/SYNTHETIC/run/ingress-jail'}
        responses = {'show': '\n'.join(key + '=' + value for key, value in properties.items()),
                     'status': 'Uid:\t10001\t10001\t10001\t10001\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n',
                     'route': 'Iface Destination Gateway Flags\n', 'dev': 'Inter-| Receive\n face |bytes\n lo: 1\n',
                     'mountinfo': '1 2 3:4 / /asterctl ro - ext4 /dev/x ro\n2 3 4:5 / /sockets ro - ext4 /dev/x ro\n'}
        def run(args, **kwargs):
            key = args[-1].rsplit('/', 1)[-1]
            if args[0].endswith('systemctl'): value = responses['show']
            elif args[0].endswith('readlink'): value = 'net:[2]'
            elif args[0].endswith('sha256sum'): value = 'a' * 64 + '  /proc/1234/exe'
            else: value = responses[key]
            return subprocess.CompletedProcess(args, 0, value, '')
        with tempfile.TemporaryDirectory() as directory, patch.object(PROBE, 'privileged', side_effect=run), \
                patch.object(PROBE.os, 'readlink', return_value='net:[1]'):
            result = PROBE.confinement('SYNTHETIC.service', 'a' * 64, Path(directory), Path('/SYNTHETIC'))
            self.assertTrue(result['noExternalRoutes'])
            for key, value in [('status', responses['status'].replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0')),
                               ('dev', responses['dev'] + ' eth0: 2\n'),
                               ('route', responses['route'] + 'eth0 00000000\n'),
                               ('mountinfo', responses['mountinfo'].replace('/sockets ro', '/sockets rw'))]:
                original = responses[key]; responses[key] = value
                with self.subTest(key=key), self.assertRaises(ValueError):
                    PROBE.confinement('SYNTHETIC.service', 'a' * 64, Path(directory), Path('/SYNTHETIC'))
                responses[key] = original
            with self.assertRaisesRegex(ValueError, 'exact retained controller'):
                PROBE.confinement('SYNTHETIC.service', 'b' * 64, Path(directory), Path('/SYNTHETIC'))
            with self.assertRaisesRegex(ValueError, 'systemd confinement'):
                PROBE.confinement('SYNTHETIC.service', 'a' * 64, Path(directory), Path('/OTHER'))

    def test_non_hosted_or_nonlinux_refuses_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(PROBE, 'privileged') as privileged, \
                patch.object(PROBE.common, 'docker') as docker, patch.dict(os.environ, {}, clear=True), \
                self.assertRaisesRegex(ValueError, 'GitHub-hosted'):
            PROBE.qualify(Path(directory) / 'evidence', Path(directory) / 'asterctl')
        privileged.assert_not_called(); docker.assert_not_called()


@unittest.skipUnless(shutil.which('openssl'), 'Actual synthetic TLS tests require OpenSSL')
class ActualTLS(unittest.TestCase):
    def test_real_tls_checks_known_answer_and_sends_the_deliberately_spoofed_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); ca = root / 'public.crt'; key = root / 'private.key'
            config = root / 'openssl.cnf'
            config.write_text('[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n'
                              '[dn]\nCN=' + PROBE.HOSTNAME + '\n[extensions]\n'
                              'basicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:' + PROBE.HOSTNAME + '\n')
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-keyout', str(key), '-out', str(ca), '-config', str(config)],
                           check=True, capture_output=True, timeout=15)
            requests, bodies = [], [PROBE.EXPECTED]
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    requests.append(dict(self.headers))
                    body = bodies[0]
                    self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers()
                    self.wfile.write(body)
                def log_message(self, *args):
                    pass
            server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(ca, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            original = socket.create_connection
            def connect(address, timeout, source_address):
                self.assertEqual(address, ('127.0.0.1', 443))
                self.assertEqual(source_address, ('127.0.0.2', 0))
                # macOS need not have a127.0.0.2 alias; only this local helper
                # test substitutes the actual ephemeral TLSserver endpoint.
                return original(server.server_address, timeout=timeout)
            try:
                with patch.object(PROBE.socket, 'create_connection', side_effect=connect):
                    result = PROBE.https(ca)
                    self.assertEqual(result['actualClientIp'], PROBE.CLIENT_IP)
                    self.assertEqual(requests[-1]['X-Real-IP'], '198.51.100.23')
                    self.assertEqual(requests[-1]['Forwarded'], 'for=198.51.100.24')
                    with self.assertRaises(ssl.SSLCertVerificationError):
                        PROBE.https(None)
                    with self.assertRaises(ssl.SSLCertVerificationError):
                        PROBE.https(ca, 'wrong.synthetic.test')
                    bodies[0] = b'SYNTHETIC|198.51.100.23||'
                    with self.assertRaisesRegex(ValueError, 'identity/response differs'):
                        PROBE.https(ca)
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=3)


if __name__ == '__main__':
    unittest.main()
