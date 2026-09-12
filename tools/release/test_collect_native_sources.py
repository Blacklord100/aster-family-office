import base64
from contextlib import ExitStack
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('native_sources', Path(__file__).with_name('collect-native-sources.py'))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def archive(path, files):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, 'w:gz') as output:
        for name, data in files.items():
            header = tarfile.TarInfo(name)
            header.size = len(data)
            output.addfile(header, io.BytesIO(data))


class NativeSourceTests(unittest.TestCase):
    def supplemental_fixture(self, root):
        source = root / 'source'; source.mkdir()
        record = {'name': 'fixture', 'version': '1.0', 'kind': 'cargo-source', 'path': 'cargo-sources/fixture-1.0.crate'}
        path = source / record['path']
        commit = 'a' * 40
        metadata = b'[package]\nname="fixture"\nversion="1.0"\nrepository="https://github.com/example/fixture"\nlicense="MIT"\n'
        contents = {'fixture-1.0/Cargo.toml.orig': metadata,
                    'fixture-1.0/.cargo_vcs_info.json': json.dumps({'git': {'sha1': commit}}).encode(),
                    'fixture-1.0/src/lib.rs': b'// synthetic source'}
        archive(path, contents)
        original = b'Original fixture license from the exact synthetic upstream revision'
        supplement = {'name': 'fixture', 'version': '1.0', 'crateSha256': native.sha(path),
                      'repository': 'https://github.com/example/fixture', 'vcsCommit': commit, 'license': 'MIT',
                      'files': [{'filename': 'LICENSE', 'url': 'https://raw.githubusercontent.com/example/fixture/' + commit + '/LICENSE',
                                 'sha256': hashlib.sha256(original).hexdigest(), 'bytes': len(original)}]}
        policy = {**self.policy(), 'noticeSupplements': [supplement]}
        records = native.expected_supplements(policy, [{'name': 'fixture', 'version': '1.0', 'sha256': native.sha(path)}])
        target = source / records[0]['files'][0]['path']; target.parent.mkdir(parents=True); target.write_bytes(original)
        return source, path, record, policy, records, contents

    def test_original_supplement_is_bound_to_crate_commit_repository_license_and_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, path, record, policy, records, contents = self.supplemental_fixture(Path(temporary))
            texts = native.source_notices(path, record, policy, Path(temporary), source, records)
            self.assertEqual(texts[0][0], 'upstream/' + 'a' * 40 + '/LICENSE')
            self.assertTrue(texts[0][1].startswith(b'Original fixture license'))
            for field, replacement in (('repository', 'https://github.com/other/fixture'), ('license', 'Apache-2.0'), ('version', '2.0')):
                with self.subTest(field=field):
                    changed = dict(contents)
                    changed['fixture-1.0/Cargo.toml.orig'] = contents['fixture-1.0/Cargo.toml.orig'].replace(
                        (field + '="' + {'repository': 'https://github.com/example/fixture', 'license': 'MIT', 'version': '1.0'}[field] + '"').encode(),
                        (field + '="' + replacement + '"').encode())
                    archive(path, changed)
                    # Even a rehashed source cannot borrow another package's notice.
                    altered = [{**records[0], 'crateSha256': native.sha(path)}]
                    with self.assertRaisesRegex(ValueError, 'embedded crate identity'):
                        native.source_notices(path, record, policy, Path(temporary), source, altered)
            changed = {**contents, 'fixture-1.0/.cargo_vcs_info.json': json.dumps({'git': {'sha1': 'b' * 40}}).encode()}
            archive(path, changed)
            with self.assertRaisesRegex(ValueError, 'embedded crate identity'):
                native.source_notices(path, record, policy, Path(temporary), source, [{**records[0], 'crateSha256': native.sha(path)}])
            archive(path, contents)
            (source / records[0]['files'][0]['path']).write_bytes(b'generic replacement')
            with self.assertRaisesRegex(ValueError, 'supplemental notice bytes changed'):
                native.source_notices(path, record, policy, Path(temporary), source, [{**records[0], 'crateSha256': native.sha(path)}])

    def test_supplement_policy_refuses_mutable_urls_and_wrong_crate_digest(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, path, record, policy, records, _ = self.supplemental_fixture(Path(temporary))
            crates = [{'name': 'fixture', 'version': '1.0', 'sha256': native.sha(path)}]
            policy['noticeSupplements'][0]['files'][0]['url'] = 'https://raw.githubusercontent.com/example/fixture/main/LICENSE'
            with self.assertRaisesRegex(ValueError, 'reviewed provenance'):
                native.expected_supplements(policy, crates)
            policy['noticeSupplements'][0]['files'][0]['url'] = records[0]['files'][0]['url']
            policy['noticeSupplements'][0]['crateSha256'] = 'c' * 64
            with self.assertRaisesRegex(ValueError, 'reviewed crate'):
                native.expected_supplements(policy, crates)

    def test_empty_notice_is_a_missing_original_and_invalid_metadata_is_not(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'source.tar.gz'
            archive(path, {'source/LICENSE': b' \n', 'source/Cargo.lock': b'valid metadata'})
            with self.assertRaises(native.MissingOriginalNotice):
                native.inspect_archive(path, self.policy(), ('Cargo.lock',))
            with self.assertRaisesRegex(ValueError, 'required recursive dependency metadata') as error:
                native.inspect_archive(path, self.policy(), ('missing.lock',))
            self.assertNotIsInstance(error.exception, native.MissingOriginalNotice)
            expected = Path(temporary) / 'policy/metadata'; expected.mkdir(parents=True)
            (expected / 'glib-gvdb.wrap').write_bytes(b'expected recursive revision')
            archive(path, {'source/subprojects/gvdb.wrap': b'wrong recursive revision'})
            with self.assertRaisesRegex(ValueError, 'fallback dependency differs') as error:
                native.source_notices(path, {'kind': 'native-source', 'name': 'glib'}, self.policy(), expected.parent, Path(temporary), [])
            self.assertNotIsInstance(error.exception, native.MissingOriginalNotice)

    def test_reviewed_supplement_cannot_contain_only_whitespace(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, path, record, policy, records, _ = self.supplemental_fixture(Path(temporary))
            original = source / records[0]['files'][0]['path']
            original.write_bytes(b' \n')
            records[0]['files'][0].update({'bytes': 2, 'sha256': native.sha(original)})
            with self.assertRaisesRegex(ValueError, 'contains no text'):
                native.source_notices(path, record, policy, Path(temporary), source, records)

    def test_offline_budget_counts_original_supplement_and_npm_provenance(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.fixture(Path(temporary))
            policy, crates, source, reviewed, runtime, lock = fixture
            extra = source / 'supplemental-notices/fixture/LICENSE'; extra.parent.mkdir(parents=True); extra.write_bytes(b'x' * 1024)
            supplements = [{'files': [{'path': 'supplemental-notices/fixture/LICENSE'}]}]
            lock['noticeSupplements'] = supplements
            (source / 'source-lock.json').write_text(json.dumps(lock))
            policy['limits']['totalDownloadBytes'] = 1024
            with patch.object(native, 'expected_supplements', return_value=supplements), \
                    self.assertRaisesRegex(ValueError, 'total download budget'):
                self.verify(fixture)

    def test_missing_notices_accumulate_after_all_downloads_but_never_verify(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            policy, crates, source, reviewed, runtime, lock = self.fixture(root)
            archive(source / lock['sources'][0]['path'], {'fixture/subprojects/gvdb.wrap': b'pinned gvdb revision'})
            runtime['runtimePackage']['registryArchive'] = 'https://registry.npmjs.org/synthetic.tgz'
            by_url = {x['url']: source / x['path'] for x in lock['sources']}
            by_url[runtime['runtimePackage']['registryArchive']] = source / 'registry-provenance/native-package.tgz'
            requested = []
            def download(url, path, limit, **kwargs):
                requested.append(url); shutil.copyfile(by_url[url], path)
                return {'sha256': native.sha(path), 'bytes': path.stat().st_size}
            output = root / 'resolved'
            with patch.object(native.platform, 'system', return_value='Linux'), \
                    patch.object(native, 'load_policy', return_value=(policy, [], crates)), \
                    patch.object(native, 'runtime_inventory', return_value=runtime), \
                    patch.object(native, 'download', side_effect=download), \
                    self.assertRaisesRegex(native.MissingOriginalNotice, 'full diagnostic inventory'):
                native.resolve(root, root / 'lock.json', runtime['appImageId'], output, reviewed)
            saved = json.loads((output / 'source-lock.json').read_text())
            self.assertEqual(len(requested), 4)
            self.assertEqual(len(saved['sources']), 3)
            self.assertEqual(saved['status'], 'incomplete-original-notices')
            self.assertEqual(saved['unresolvedNotices'], [{'source': lock['sources'][0]['path'], 'reason': 'missing-original-notice'}])
            self.assertFalse((output / 'receipt.json').exists())
            with patch.object(native, 'load_policy', return_value=(policy, [], crates)), \
                    patch.object(native, 'runtime_inventory', return_value=runtime), \
                    self.assertRaisesRegex(native.MissingOriginalNotice, 'unresolved original notices'):
                native.verify(root, root / 'lock.json', runtime['appImageId'], output, reviewed)

    def test_identity_or_archive_errors_are_not_accumulated_as_missing_notices(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            policy, crates, source, reviewed, runtime, lock = self.fixture(root)
            runtime['runtimePackage']['registryArchive'] = 'https://registry.npmjs.org/synthetic.tgz'
            requested = []
            def download(url, path, limit, **kwargs):
                requested.append(url)
                target = source / 'registry-provenance/native-package.tgz' if len(requested) == 1 else source / lock['sources'][0]['path']
                shutil.copyfile(target, path)
                return {'sha256': native.sha(path), 'bytes': path.stat().st_size}
            output = root / 'resolved'
            with patch.object(native.platform, 'system', return_value='Linux'), \
                    patch.object(native, 'load_policy', return_value=(policy, [], crates)), \
                    patch.object(native, 'runtime_inventory', return_value=runtime), \
                    patch.object(native, 'download', side_effect=download), \
                    patch.object(native, 'source_notices', side_effect=ValueError('Synthetic identity mismatch')), \
                    self.assertRaisesRegex(ValueError, 'identity mismatch'):
                native.resolve(root, root / 'lock.json', runtime['appImageId'], output, reviewed)
            self.assertEqual(len(requested), 2)
            self.assertFalse((output / 'source-lock.json').exists())
            self.assertFalse((output / 'receipt.json').exists())

    def policy(self):
        return {'sources': [{'name': 'glib', 'version': '1.0', 'url': 'https://github.com/fixture/glib.tar.gz'},
                            {'name': 'rsvg', 'version': '1.0', 'url': 'https://github.com/fixture/rsvg.tar.gz'}],
                'scope': 'Synthetic exact-package source coverage',
                'limits': {'perSourceBytes': 1024 * 1024, 'totalDownloadBytes': 8 * 1024 * 1024,
                           'expandedSourceBytes': 16 * 1024 * 1024, 'archiveMembers': 100}}

    def fixture(self, root):
        policy = self.policy()
        source = root / 'source'
        source.mkdir()
        (source / 'notices').mkdir()
        reviewed = root / 'policy'
        (reviewed / 'metadata').mkdir(parents=True)
        (reviewed / 'source-policy.json').write_text('{}')
        (reviewed / 'metadata/glib-gvdb.wrap').write_bytes(b'pinned gvdb revision')
        (reviewed / 'metadata/librsvg-Cargo.lock').write_bytes(b'pinned Cargo crate checksum')
        crate_path = source / 'cargo-sources/fixture-1.0.crate'
        archive(crate_path, {'fixture-1.0/LICENSE': b'Original crate copyright and license'})
        crates = [{'name': 'fixture', 'version': '1.0', 'sha256': native.sha(crate_path),
                   'url': 'https://static.crates.io/crates/fixture/fixture-1.0.crate'}]
        records = []
        for record in native.expected_records(policy, crates):
            path = source / record['path']
            if record['kind'] == 'native-source':
                files = {'fixture/LICENSE': b'Original native copyright and license'}
                if record['name'] == 'glib':
                    files['fixture/subprojects/gvdb.wrap'] = b'pinned gvdb revision'
                else:
                    files['fixture/Cargo.lock'] = b'pinned Cargo crate checksum'
                archive(path, files)
            records.append({**record, 'sha256': native.sha(path), 'bytes': path.stat().st_size})
        data = b'synthetic native executable bytes'
        npm = source / 'registry-provenance/native-package.tgz'
        archive(npm, {'package/lib/libvips.so': data})
        files = [{'path': 'lib/libvips.so', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}]
        runtime = {'appImageId': 'sha256:' + 'a' * 64,
                   'runtimePackage': {'name': 'fixture', 'version': '1.0',
                                      'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(npm.read_bytes()).digest()).decode()},
                   'packageFiles': files, 'nativeFiles': files}
        lock = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-lock-v1',
                'policySha256': native.sha(reviewed / 'source-policy.json'), 'runtime': runtime,
                'material': [], 'sources': records, 'sourceArchiveCount': len(records),
                'registryArchive': {'path': 'registry-provenance/native-package.tgz', 'sha256': native.sha(npm), 'bytes': npm.stat().st_size}}
        (source / 'source-lock.json').write_text(json.dumps(lock))
        return policy, crates, source, reviewed, runtime, lock

    def verify(self, fixture):
        policy, crates, source, reviewed, runtime, _ = fixture
        with ExitStack() as stack:
            stack.enter_context(patch.object(native, 'load_policy', return_value=(policy, [], crates)))
            stack.enter_context(patch.object(native, 'runtime_inventory', return_value=runtime))
            return native.verify(Path('/synthetic/runtime'), Path('/synthetic/lock'), runtime['appImageId'], source, reviewed)

    def test_checked_in_recipe_covers_recursive_sources(self):
        policy, material, crates = native.load_policy()
        self.assertEqual(set(policy['versions']) | {'gvdb'}, {item['name'] for item in policy['sources']})
        self.assertGreater(len(crates), 300)
        self.assertTrue(all(native.DIGEST.fullmatch(item['sha256']) for item in crates))
        self.assertTrue(any(item['path'] == 'recipe/build/posix.sh' for item in material))

    def test_verified_sources_retain_original_notices_and_can_be_rechecked(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = self.fixture(Path(temp))
            receipt = self.verify(fixture)
            self.assertEqual(receipt['result'], 'source-materials-verified')
            self.assertEqual(receipt['sourceArchiveCount'], 3)
            self.assertEqual(receipt['cargoSourceCount'], 1)
            self.assertFalse(receipt['legalApproval'])
            self.assertFalse(receipt['binaryRebuilt'])
            self.assertEqual(receipt, self.verify(fixture))
            self.assertTrue(all((fixture[2] / item['file']).read_bytes().startswith(b'Original ') for item in receipt['notices']))

    def test_missing_transitive_crate_never_produces_passing_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = self.fixture(Path(temp))
            (fixture[2] / fixture[5]['sources'][-1]['path']).unlink()
            with self.assertRaisesRegex(ValueError, 'Missing regular source'):
                self.verify(fixture)
            self.assertFalse((fixture[2] / 'receipt.json').exists())

    def test_tampered_source_archive_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = self.fixture(Path(temp))
            (fixture[2] / fixture[5]['sources'][0]['path']).write_bytes(b'changed source')
            with self.assertRaisesRegex(ValueError, 'archive bytes changed'):
                self.verify(fixture)

    def test_self_consistent_lock_cannot_remove_required_dependency(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = self.fixture(Path(temp))
            lock = fixture[5]
            lock['sources'].pop()
            lock['sourceArchiveCount'] -= 1
            (fixture[2] / 'source-lock.json').write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, 'omits required'):
                self.verify(fixture)

    def test_same_versions_other_runtime_bytes_or_image_cannot_borrow_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = self.fixture(Path(temp))
            fixture[4]['appImageId'] = 'sha256:' + 'b' * 64
            with self.assertRaisesRegex(ValueError, 'exact app native bytes'):
                self.verify(fixture)

    def test_changed_embedded_cargo_lock_rejects_even_rehashed_source(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = self.fixture(Path(temp))
            lock = fixture[5]
            record = lock['sources'][1]
            path = fixture[2] / record['path']
            archive(path, {'fixture/LICENSE': b'Original license', 'fixture/Cargo.lock': b'changed crate closure'})
            record.update({'sha256': native.sha(path), 'bytes': path.stat().st_size})
            (fixture[2] / 'source-lock.json').write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, 'Cargo lock differs'):
                self.verify(fixture)

    def test_notice_directory_symlink_cannot_write_outside_source_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fixture = self.fixture(root)
            notices = fixture[2] / 'notices'
            notices.rmdir()
            outside = root / 'outside'
            outside.mkdir()
            notices.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'existing regular directory'):
                self.verify(fixture)
            self.assertEqual(list(outside.iterdir()), [])

    def test_source_archive_traversal_and_unbounded_members_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'archive.tar.gz'
            archive(path, {'root/../../LICENSE': b'data'})
            with self.assertRaisesRegex(ValueError, 'Noncanonical'):
                native.inspect_archive(path, self.policy())
            archive(path, {'root/LICENSE': b'data'})
            policy = self.policy()
            policy['limits']['expandedSourceBytes'] = 1
            with self.assertRaisesRegex(ValueError, 'expanded inventory limits'):
                native.inspect_archive(path, policy)

    def test_remote_or_downgraded_download_hosts_are_refused(self):
        for url in ('http://github.com/source.tar.gz', 'https://127.0.0.1/source',
                    'https://registry.npmjs.org.evil.invalid/source', 'https://user:pass@github.com/source'):
            with self.assertRaisesRegex(ValueError, 'origin or protocol'):
                native.validate_url(url)

    def runtime_fixture(self, root):
        policy, _, _ = native.load_policy()
        package_path = 'node_modules/next/node_modules/' + policy['package']['name']
        package = root / package_path
        package.mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({'name': policy['package']['name'],
            'version': policy['package']['version'], 'license': policy['package']['declaredLicense']}))
        (package / 'versions.json').write_text(json.dumps(policy['versions']))
        library = package / policy['package']['library']
        library.parent.mkdir()
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        header[18:20] = b'\x3e\x00'
        library.write_bytes(header)
        lock = root / 'package-lock.json'
        lock.write_text(json.dumps({'packages': {package_path: {'version': '1.3.3',
            'integrity': 'sha512-synthetic', 'resolved': 'https://registry.npmjs.org/fixture.tgz'}}}))
        return policy, lock, package

    def test_actual_exported_elf_versions_and_needed_libraries_are_inventoried(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            policy, lock, _ = self.runtime_fixture(root)
            with patch.object(native.subprocess, 'run', return_value=SimpleNamespace(stdout=' (NEEDED) Shared library: [libc.so.6]')) as command:
                result = native.runtime_inventory(root, lock, 'sha256:' + 'a' * 64, policy)
            self.assertEqual(result['nativeFiles'][0]['neededSystemLibraries'], ['libc.so.6'])
            self.assertEqual(command.call_args.args[0][0], '/usr/bin/readelf')
            self.assertEqual(result['versions'], policy['versions'])

    def test_unknown_native_link_and_changed_component_version_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            policy, lock, package = self.runtime_fixture(root)
            with patch.object(native.subprocess, 'run', return_value=SimpleNamespace(stdout=' (NEEDED) Shared library: [unreviewed.so]')):
                with self.assertRaisesRegex(ValueError, 'unreviewed shared dependency'):
                    native.runtime_inventory(root, lock, 'sha256:' + 'a' * 64, policy)
            versions = dict(policy['versions'])
            versions['glib'] = 'unreviewed-version'
            (package / 'versions.json').write_text(json.dumps(versions))
            with self.assertRaisesRegex(ValueError, 'version inventory differs'):
                native.runtime_inventory(root, lock, 'sha256:' + 'a' * 64, policy)

    def test_reviewed_glibc_resolver_is_system_scope_but_other_new_libraries_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            policy, lock, _ = self.runtime_fixture(root)
            expected = ['libc.so.6', 'libresolv.so.2']
            metadata = '\n'.join(' (NEEDED) Shared library: [' + name + ']' for name in expected)
            with patch.object(native.subprocess, 'run', return_value=SimpleNamespace(stdout=metadata)):
                inventory = native.runtime_inventory(root, lock, 'sha256:' + 'a' * 64, policy)
            self.assertEqual(inventory['nativeFiles'][0]['neededSystemLibraries'], expected)
            self.assertNotIn('glibc', {source['name'] for source in policy['sources']})
            with patch.object(native.subprocess, 'run', return_value=SimpleNamespace(stdout=metadata + '\n (NEEDED) Shared library: [new-unreviewed.so]')):
                with self.assertRaisesRegex(ValueError, 'unreviewed shared dependency: new-unreviewed.so'):
                    native.runtime_inventory(root, lock, 'sha256:' + 'a' * 64, policy)


if __name__ == '__main__':
    unittest.main()
