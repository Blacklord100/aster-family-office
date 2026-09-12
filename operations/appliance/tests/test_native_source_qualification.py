"""Failure controls for the Linux native-source qualification wrapper; no Docker."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/qualify-native-sources.py'
SPEC = importlib.util.spec_from_file_location('native_source_qualification', SCRIPT)
QUALIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QUALIFY)
IMAGE = 'sha256:' + 'a' * 64
CONTAINER = 'b' * 64


class NativeSourceQualificationTests(unittest.TestCase):
    def test_exact_export_retains_only_selected_package_and_detects_later_native_tamper(self):
        native = QUALIFY.collector()
        policy, _, _ = native.load_policy()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            trusted, original = root / 'checkout', root / 'image-runtime'
            trusted.mkdir()
            package_path = 'node_modules/' + policy['package']['name']
            package = original / package_path
            package.mkdir(parents=True)
            (package / 'package.json').write_text(json.dumps({'name': policy['package']['name'],
                'version': policy['package']['version'], 'license': policy['package']['declaredLicense']}))
            (package / 'versions.json').write_text(json.dumps(policy['versions']))
            library = package / policy['package']['library']
            library.parent.mkdir()
            header = bytearray(64)
            header[:6], header[18:20] = b'\x7fELF\x02\x01', b'\x3e\x00'
            library.write_bytes(header)
            (original / 'node_modules/unrelated.txt').write_bytes(b'outside-this-source-gate')
            (trusted / 'package-lock.json').write_text(json.dumps({'packages': {package_path: {
                'version': policy['package']['version'], 'integrity': 'sha512-synthetic',
                'resolved': 'https://registry.npmjs.org/synthetic.tgz'}}}))
            for name in ('tools/release/collect-native-sources.py', 'tools/release/collect-notices.py',
                         'operations/appliance/scripts/qualify-native-sources.py', 'operations/Dockerfile.app'):
                target = trusted / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(QUALIFY.ROOT / name, target)
            calls = []

            def transport(args, **kwargs):
                calls.append(args)
                if args[0] == '/usr/bin/git':
                    return 'c' * 40
                if args[3:5] == ['image', 'inspect']:
                    return json.dumps([{'Id': IMAGE, 'Os': 'linux', 'Architecture': 'amd64'}])
                if args[3] == 'create':
                    return CONTAINER
                if args[3] == 'inspect':
                    return json.dumps([{'Id': CONTAINER, 'Image': IMAGE,
                        'State': {'Status': 'created', 'Running': False}, 'HostConfig': {'NetworkMode': 'none'}}])
                if args[3] == 'cp':
                    shutil.copytree(original / 'node_modules', args[-1])
                    return ''
                if args[3] == 'rm':
                    return ''
                self.fail('Unexpected command')

            with patch.object(QUALIFY.sys, 'platform', 'linux'), patch.object(QUALIFY, 'ROOT', trusted), \
                    patch.object(QUALIFY, 'disk_guard'), patch.object(QUALIFY, 'collector', return_value=native), \
                    patch.object(QUALIFY, 'command', side_effect=transport), \
                    patch.object(native.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0,
                        ' (NEEDED) Shared library: [libc.so.6]', '')):
                output = root / 'evidence'
                QUALIFY.prepare(IMAGE, output)
                QUALIFY.bound_export(output)
                self.assertFalse((output / 'runtime-export/node_modules/unrelated.txt').exists())
                self.assertEqual((output / 'runtime-export' / package_path / policy['package']['library']).read_bytes(), bytes(header))
                self.assertEqual(len([x for x in calls if len(x) > 3 and x[3] == 'inspect']), 2)
                self.assertTrue(any(x[3:] == ['rm', CONTAINER] for x in calls if len(x) > 3))
                self.assertFalse(any(x[3] in ('run', 'start') for x in calls if len(x) > 3))
                with (output / 'runtime-export' / package_path / policy['package']['library']).open('ab') as stream:
                    stream.write(b'changed')
                with self.assertRaisesRegex(ValueError, 'differ from the exact-image export'):
                    QUALIFY.bound_export(output)

    def test_remote_docker_and_proxy_environment_are_not_inherited(self):
        with patch.dict(QUALIFY.os.environ, {'DOCKER_HOST': 'tcp://remote.invalid:2376',
                                           'HTTPS_PROXY': 'https://proxy.invalid', 'PRIVATE_TOKEN': 'synthetic'}):
            with patch.object(QUALIFY.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{}', '')) as run:
                QUALIFY.command(QUALIFY.DOCKER + ['image', 'inspect', IMAGE])
            args = run.call_args
            self.assertEqual(args.args[0][:3], ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock'])
            self.assertNotIn('DOCKER_HOST', args.kwargs['env'])
            self.assertNotIn('HTTPS_PROXY', args.kwargs['env'])
            self.assertNotIn('PRIVATE_TOKEN', args.kwargs['env'])

    def test_export_rejects_running_retagged_or_networked_container(self):
        base = {'Id': CONTAINER, 'Image': IMAGE, 'State': {'Status': 'created', 'Running': False},
                'HostConfig': {'NetworkMode': 'none'}}
        for change in ({'Image': 'sha256:' + 'c' * 64}, {'State': {'Status': 'running', 'Running': True}},
                       {'HostConfig': {'NetworkMode': 'default'}}, {'Id': 'd' * 64}):
            with self.subTest(change=change), patch.object(QUALIFY, 'command', return_value=json.dumps([{**base, **change}])):
                with self.assertRaisesRegex(ValueError, 'identity or inert state'):
                    QUALIFY.inspect_container(CONTAINER, IMAGE)
        with patch.object(QUALIFY, 'command', return_value=json.dumps([base])):
            self.assertEqual(QUALIFY.inspect_container(CONTAINER, IMAGE)['state'], 'created')

    def test_readonly_proof_requires_every_bound_material_mount(self):
        paths = [Path('/trusted repo'), Path('/evidence/original-sources')]
        valid = ('61 25 0:47 / /trusted\\040repo ro,relatime - ext4 /dev/root rw\n'
                 '62 25 0:47 / /evidence/original-sources ro,relatime - ext4 /dev/root rw\n')
        self.assertEqual(QUALIFY.readonly_proof(paths, valid), [str(x) for x in paths])
        for invalid in (valid.replace('ro,relatime', 'rw,relatime', 1), valid.splitlines()[0]):
            with self.assertRaisesRegex(ValueError, 'mounted read-only'):
                QUALIFY.readonly_proof(paths, invalid)

    def test_offline_refuses_host_namespace_even_when_network_metadata_looks_empty(self):
        with patch.object(QUALIFY.os, 'readlink', side_effect=['net:[1]', 'mnt:[3]']):
            with self.assertRaisesRegex(ValueError, 'new kernel network and mount namespaces'):
                QUALIFY.network_proof('net:[1]', 'mnt:[2]')
        with patch.object(QUALIFY.os, 'readlink', side_effect=['net:[3]', 'mnt:[2]']):
            with self.assertRaisesRegex(ValueError, 'new kernel network and mount namespaces'):
                QUALIFY.network_proof('net:[1]', 'mnt:[2]')

    def test_offline_refuses_any_external_interface_or_route(self):
        for interfaces, routes in (('lo: 0\neth0: 0', 'header\n'), ('lo: 0', 'header\neth0 00000000')):
            with self.subTest(interfaces=interfaces, routes=routes):
                with patch.object(QUALIFY.os, 'readlink', side_effect=['net:[3]', 'mnt:[4]']), \
                        patch.object(Path, 'read_text', side_effect=[interfaces, routes]):
                    with self.assertRaisesRegex(ValueError, 'non-loopback network'):
                        QUALIFY.network_proof('net:[1]', 'mnt:[2]')

    def test_isolation_receipt_records_actual_namespaces_and_clean_environment(self):
        with patch.object(QUALIFY.os, 'readlink', side_effect=['net:[3]', 'mnt:[4]']), \
                patch.object(Path, 'read_text', side_effect=['lo: 0\n', 'header\n']), \
                patch.dict(QUALIFY.os.environ, QUALIFY.clean_env(), clear=True):
            result = QUALIFY.network_proof('net:[1]', 'mnt:[2]')
        self.assertEqual(result['networkNamespace'], 'net:[3]')
        self.assertEqual(result['mountNamespace'], 'mnt:[4]')
        self.assertEqual(result['interfaces'], ['lo'])
        self.assertFalse(result['proxyEnvironmentPresent'])

    def test_offline_never_invokes_collector_without_isolation(self):
        with patch.object(QUALIFY.os, 'geteuid', return_value=1001), \
                patch.object(QUALIFY.os, 'readlink', side_effect=['net:[1]', 'mnt:[4]']), \
                patch.object(QUALIFY, 'collector') as collect:
            with self.assertRaisesRegex(ValueError, 'new kernel network'):
                QUALIFY.verify_offline(Path('/synthetic'), 'net:[1]', 'mnt:[2]')
            collect.assert_not_called()

    def test_readonly_setup_drops_privileges_and_clears_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / 'source.tar.gz'
            original.write_bytes(b'synthetic-public-original')
            with patch.object(QUALIFY.os, 'geteuid', return_value=0), \
                    patch.object(QUALIFY, 'network_proof'), \
                    patch.object(QUALIFY, 'readonly_paths', return_value=[original]), \
                    patch.object(QUALIFY, 'command') as command, \
                    patch.object(QUALIFY.os, 'execv') as execute:
                QUALIFY.enter_offline(root, 'net:[1]', 'mnt:[2]', 1001, 1001)
            self.assertEqual(command.call_args_list[1].args[0], ['/usr/bin/mount', '-o', 'remount,bind,ro', str(original)])
            argv = execute.call_args.args[1]
            self.assertEqual(argv[:8], ['/usr/bin/setpriv', '--reuid', '1001', '--regid', '1001', '--clear-groups', '--no-new-privs', '/usr/bin/env'])
            self.assertIn('-i', argv)
            self.assertIn('/usr/bin/python3', argv)
            self.assertIn('verify-offline', argv)

    def test_inventory_refuses_symlink_and_byte_overflow_without_following(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'source.tar.gz').write_bytes(b'12345')
            with self.assertRaisesRegex(ValueError, 'bounded inventory'):
                QUALIFY.files_inventory(root, limit=4)
            (root / 'redirect').symlink_to('/unrelated/host/material')
            with self.assertRaisesRegex(ValueError, 'Nonregular artifact entry'):
                QUALIFY.files_inventory(root)

    def test_low_disk_refuses_before_collection(self):
        with patch.object(QUALIFY.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 1})()), \
                patch.object(QUALIFY, 'collector') as collector:
            with self.assertRaisesRegex(ValueError, 'Insufficient disposable disk'):
                QUALIFY.resolve(Path('/synthetic'))
            collector.assert_not_called()

    def test_diagnostics_are_bounded_and_failed_command_never_succeeds(self):
        with patch.object(QUALIFY.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'o' * 50000, 'e' * 50000)):
            with self.assertRaisesRegex(ValueError, 'failed') as error:
                QUALIFY.command(['/usr/bin/docker', 'inspect'])
        self.assertLess(len(str(error.exception)), 13000)


if __name__ == '__main__':
    unittest.main()
