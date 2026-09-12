"""No Docker/systemd mutations: strict controls for the hosted synthetic probe."""
import copy
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import ssl
import shutil
import socket
import subprocess
import tempfile
import threading
import unittest
from types import SimpleNamespace
from contextlib import nullcontext
from unittest.mock import patch, MagicMock

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
    def test_caddy_permanent_redirect_requires301_and_exact_origin(self):
        origin = 'https://' + PROBE.HOSTNAME + '/qualification'
        cases = [(301, origin, b'', True), (308, origin, b'', False),
                 (302, origin, b'', False), (301, 'https://other.invalid/qualification', b'', False),
                 (301, origin, b'x' * 4097, False)]
        for status, location, body, allowed in cases:
            connection = MagicMock()
            response = connection.getresponse.return_value
            response.status = status; response.getheader.return_value = location; response.read.return_value = body
            with patch.object(PROBE.http.client, 'HTTPConnection', return_value=connection), self.subTest(status=status, location=location):
                if allowed:
                    self.assertEqual(PROBE.host_redirect(), {'status': 301, 'location': origin})
                else:
                    with self.assertRaisesRegex(ValueError, '"status": ' + str(status)):
                        PROBE.host_redirect()
            connection.close.assert_called_once()
            connection.request.assert_called_once_with('GET', '/qualification', headers={'Host': PROBE.HOSTNAME})
            response.read.assert_called_once_with(4097)

    def test_failed_provisioning_retains_original_error_and_only_selected_public_fields(self):
        user = SimpleNamespace(pw_name='aster-ingress', pw_uid=10001, pw_gid=10001,
                               pw_gecos='Aster ingress relay', pw_dir='/nonexistent', pw_shell='/usr/sbin/nologin',
                               pw_passwd='SYNTHETIC_CREDENTIAL_MUST_NOT_APPEAR')
        group = SimpleNamespace(gr_name='aster-ingress', gr_gid=10001, gr_mem=[], gr_passwd='SYNTHETIC_GROUP_SECRET')
        receipt = {'controllerSha256': 'a' * 64, 'templateSha256': {'service': 'b' * 64}}
        with patch.object(PROBE, 'prepare_account', side_effect=ValueError('SYNTHETIC safe postflight reason')), \
                patch.object(PROBE.pwd, 'getpwnam', return_value=user), patch.object(PROBE.pwd, 'getpwuid', return_value=user), \
                patch.object(PROBE.grp, 'getgrnam', return_value=group), patch.object(PROBE.grp, 'getgrgid', return_value=group), \
                patch.object(PROBE.pwd, 'getpwall') as all_users, patch.object(PROBE.grp, 'getgrall') as all_groups, \
                patch.object(PROBE, 'privileged', return_value=subprocess.CompletedProcess([], 0, 'systemd255 (SYNTHETIC)\nfeature-list', '')) as command, \
                self.assertRaisesRegex(ValueError, 'safe postflight reason'):
            PROBE.provision_with_diagnostics(Path('/SYNTHETIC/asterctl'), receipt)
        diagnostic = receipt['accountFailureDiagnostics']
        self.assertEqual(diagnostic['selectedPublicRecords']['userName']['uid'], 10001)
        self.assertEqual(diagnostic['systemdVersion'], 'systemd255 (SYNTHETIC)')
        self.assertNotIn('CREDENTIAL', json.dumps(receipt)); self.assertNotIn('GROUP_SECRET', json.dumps(receipt))
        self.assertEqual(receipt['controllerSha256'], 'a' * 64)
        all_users.assert_not_called(); all_groups.assert_not_called()
        self.assertEqual(command.call_args.args[0], ['/usr/bin/systemctl', '--version'])

    def test_only_exact_public_account_receipt_is_accepted(self):
        good = {'name': 'aster-ingress', 'uid': 10001, 'gid': 10001, 'createdUser': True, 'createdGroup': True}
        with patch.object(PROBE, 'privileged', return_value=subprocess.CompletedProcess([], 0, json.dumps(good), '')) as run:
            self.assertEqual(PROBE.prepare_account(Path('/SYNTHETIC/asterctl')), good)
        self.assertEqual(run.call_args.args[0], ['/usr/bin/env', '/SYNTHETIC/asterctl', 'prepare-ingress-account'])
        for field, value in [('uid', True), ('name', 'other'), ('gid', 10002), ('createdUser', 'true')]:
            invalid = {**good, field: value}
            with patch.object(PROBE, 'privileged', return_value=subprocess.CompletedProcess([], 0, json.dumps(invalid), '')), \
                    self.assertRaises(ValueError):
                PROBE.prepare_account(Path('/SYNTHETIC/asterctl'))

    def test_existing_or_unproven_accounts_are_never_deleted(self):
        absent = dict.fromkeys(['userName', 'userId', 'groupName', 'groupId'], False)
        with patch.object(PROBE, 'privileged') as run:
            result = PROBE.cleanup_account({**absent, 'groupId': True}, None, None)
        self.assertEqual(result['result'], 'passed'); run.assert_not_called()
        with patch.object(PROBE, 'privileged') as run, patch.object(PROBE, 'account_presence', return_value={**absent, 'groupId': True}), \
                self.assertRaisesRegex(ValueError, 'without a validated creation receipt'):
            PROBE.cleanup_account(absent, None, None)
        run.assert_not_called()

    def test_new_account_cleanup_revalidates_and_handles_userdel_private_group_removal(self):
        absent = dict.fromkeys(['userName', 'userId', 'groupName', 'groupId'], False)
        present = dict.fromkeys(absent, True)
        created = {'name': 'aster-ingress', 'uid': 10001, 'gid': 10001, 'createdUser': True, 'createdGroup': True}
        validated = {**created, 'createdUser': False, 'createdGroup': False}
        user = SimpleNamespace(pw_name='aster-ingress', pw_uid=10001, pw_gid=10001)
        for removes_group in [True, False]:
            after_user = absent if removes_group else {**absent, 'groupName': True, 'groupId': True}
            group = SimpleNamespace(gr_name='aster-ingress', gr_gid=10001, gr_mem=[])
            with patch.object(PROBE, 'account_presence', side_effect=[present, after_user, absent]), \
                    patch.object(PROBE, 'prepare_account', return_value=validated) as verify, \
                    patch.object(PROBE.pwd, 'getpwall', side_effect=[[user], []]), \
                    patch.object(PROBE.grp, 'getgrnam', return_value=group), patch.object(PROBE.grp, 'getgrgid', return_value=group), \
                    patch.object(PROBE, 'privileged', return_value=subprocess.CompletedProcess([], 0, '', '')) as run:
                result = PROBE.cleanup_account(absent, created, Path('/SYNTHETIC/asterctl'))
            self.assertEqual(result['result'], 'passed'); verify.assert_called_once()
            calls = [call.args[0] for call in run.call_args_list]
            self.assertEqual(calls[0], ['/usr/bin/env', '/usr/sbin/userdel', 'aster-ingress'])
            self.assertEqual(len(calls), 1 if removes_group else 2)
            if not removes_group:
                self.assertEqual(calls[1], ['/usr/bin/env', '/usr/sbin/groupdel', 'aster-ingress'])

    def test_changed_or_shared_identity_is_not_deleted(self):
        absent = dict.fromkeys(['userName', 'userId', 'groupName', 'groupId'], False)
        present = dict.fromkeys(absent, True)
        created = {'name': 'aster-ingress', 'uid': 10001, 'gid': 10001, 'createdUser': True, 'createdGroup': True}
        with patch.object(PROBE, 'account_presence', return_value=present), \
                patch.object(PROBE, 'prepare_account', return_value={**created, 'createdUser': False, 'createdGroup': False}), \
                patch.object(PROBE.pwd, 'getpwall', return_value=[SimpleNamespace(pw_name='other', pw_uid=10002, pw_gid=10001)]), \
                patch.object(PROBE, 'privileged') as run, self.assertRaisesRegex(ValueError, 'another account'):
            PROBE.cleanup_account(absent, created, Path('/SYNTHETIC/asterctl'))
        run.assert_not_called()

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

    def test_actual_user217_failure_stops_before_a_tls_retry_loop(self):
        state = 'MainPID=0\nActiveState=activating\nExecMainCode=1\nExecMainStatus=217\nResult=exit-code\n'
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(PROBE.socket, 'create_connection', return_value=nullcontext()), \
                patch.object(PROBE, 'privileged', return_value=subprocess.CompletedProcess([], 0, state, '')), \
                patch.object(PROBE, 'confinement') as confinement, \
                self.assertRaisesRegex(ValueError, '217'):
            PROBE.activated_relay('SYNTHETIC.service', 443, 'a' * 64, Path(directory), Path('/SYNTHETIC'))
        confinement.assert_not_called()

    def test_socket_activation_success_requires_actual_process_confinement(self):
        state = 'MainPID=1234\nActiveState=active\nExecMainCode=0\nExecMainStatus=0\nResult=success\n'
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(PROBE.socket, 'create_connection', return_value=nullcontext()) as connection, \
                patch.object(PROBE, 'privileged', return_value=subprocess.CompletedProcess([], 0, state, '')), \
                patch.object(PROBE, 'confinement', return_value={'uid': 10001}) as confinement:
            result = PROBE.activated_relay('SYNTHETIC.service', 443, 'a' * 64, Path(directory), Path('/SYNTHETIC'))
        self.assertEqual(result, {'uid': 10001})
        self.assertEqual(connection.call_args.args, (('127.0.0.1', 443),))
        confinement.assert_called_once()

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
