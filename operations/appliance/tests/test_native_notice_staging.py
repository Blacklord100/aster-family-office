"""Exact-crate original notice staging controls; entirely synthetic source bytes."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


STAGE = load('native_notice_stage', ROOT / 'operations/appliance/scripts/stage-bundle.py')
NATIVE = load('native_notice_policy', ROOT / 'tools/release/collect-native-sources.py')
IMAGE = 'sha256:' + 'a' * 64
COMMIT = 'b' * 40


def fixture(root, actual_commit=COMMIT):
    policy_root, source = root / 'policy', root / 'source'
    def put(base, name, data):
        path = base / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        return {'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    crate_name = 'cargo-sources/fixture-1.0.crate'
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in {
            'fixture-1.0/Cargo.toml.orig': b'[package]\nname="fixture"\nversion="1.0"\nrepository="https://github.com/example/fixture"\nlicense="MIT"\n',
            'fixture-1.0/.cargo_vcs_info.json': json.dumps({'git': {'sha1': actual_commit}}).encode(),
            'fixture-1.0/src/lib.rs': b'// synthetic source only',
        }.items():
            item = tarfile.TarInfo(name); item.size = len(data); archive.addfile(item, io.BytesIO(data))
    crate = put(source, crate_name, buffer.getvalue())
    recipe = put(policy_root, 'recipe/versions.properties', b'VERSION_SYNTHETIC=1\n'); recipe['path'] = 'versions.properties'
    cargo = ('version=3\n[[package]]\nname="fixture"\nversion="1.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' + crate['sha256'] + '"\n').encode()
    metadata = [put(policy_root, 'metadata/glib-gvdb.wrap', b'[wrap-git]\nrevision=synthetic\n'),
                put(policy_root, 'metadata/librsvg-Cargo.lock', cargo)]
    put(policy_root, 'recipe-provenance.json', json.dumps({'files': [recipe]}).encode())
    put(policy_root, 'metadata-provenance.json', json.dumps({'files': metadata}).encode())
    put(policy_root, 'README.md', b'Synthetic qualification fixture, never release material')
    original = b'Original synthetic license from exact fixture revision'
    original_hash = hashlib.sha256(original).hexdigest()
    policy = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-policy-v1', 'versions': {'synthetic': '1'},
              'sources': [{'name': 'synthetic', 'version': '1', 'url': 'https://example.invalid/native.tar.gz'},
                          {'name': 'gvdb', 'version': 'synthetic', 'url': 'https://example.invalid/gvdb.tar.gz'}],
              'limits': {'archiveMembers': 100, 'expandedSourceBytes': 1024 * 1024},
              'noticeSupplements': [{'name': 'fixture', 'version': '1.0', 'crateSha256': crate['sha256'],
                'repository': 'https://github.com/example/fixture', 'vcsCommit': COMMIT, 'license': 'MIT',
                'files': [{'filename': 'LICENSE', 'url': 'https://raw.githubusercontent.com/example/fixture/' + COMMIT + '/LICENSE',
                           'sha256': original_hash, 'bytes': len(original)}]}]}
    put(policy_root, 'source-policy.json', json.dumps(policy).encode())
    policy, material, crates = NATIVE.load_policy(policy_root)
    supplements = NATIVE.expected_supplements(policy, crates)
    for record in material:
        put(source, 'reviewed-recipe/' + record['path'], (policy_root / record['path']).read_bytes())
    sources = []
    for expected in NATIVE.expected_records(policy, crates):
        data = buffer.getvalue() if expected['kind'] == 'cargo-source' else b'SYNTHETIC source archive placeholder'
        sources.append({**expected, **put(source, expected['path'], data)})
    registry = put(source, 'registry-provenance/native-package.tgz', b'SYNTHETIC npm provenance fixture')
    put(source, supplements[0]['files'][0]['path'], original)
    text = put(source, 'notices/' + original_hash + '.txt', original)
    notice = {'source': crate_name, 'originalPath': 'upstream/' + COMMIT + '/LICENSE',
              'file': text['path'], 'sha256': original_hash, 'bytes': len(original)}
    runtime = {'appImageId': IMAGE, 'runtimePackage': {'name': 'SYNTHETIC'}, 'nativeFiles': [{'path': 'SYNTHETIC', 'sha256': 'c' * 64}]}
    lock = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-lock-v1', 'runtime': runtime,
            'material': material, 'policySha256': NATIVE.sha(policy_root / 'source-policy.json'), 'sources': sources,
            'sourceArchiveCount': len(sources), 'registryArchive': registry, 'noticeSupplements': supplements, 'unresolvedNotices': []}
    put(source, 'source-lock.json', json.dumps(lock).encode())
    receipt = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-receipt-v1', 'result': 'source-materials-verified',
               'appImageId': IMAGE, 'sourceLockSha256': NATIVE.sha(source / 'source-lock.json'),
               'runtimePackage': runtime['runtimePackage'], 'nativeFiles': runtime['nativeFiles'],
               'sourceArchiveCount': len(sources), 'nativeSourceCount': 2, 'cargoSourceCount': 1,
               'noticeSupplements': supplements, 'notices': [notice]}
    put(source, 'receipt.json', json.dumps(receipt).encode())
    return source, policy_root, lock, receipt


class NoticeStaging(unittest.TestCase):
    def test_original_supplement_survives_complete_inventory_and_provenance_check(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, policy, _, _ = fixture(Path(temporary))
            STAGE.native_source_evidence(source, IMAGE, policy)

    def test_removing_or_changing_original_supplement_fails(self):
        for remove in (True, False):
            with self.subTest(remove=remove), tempfile.TemporaryDirectory() as temporary:
                source, policy, _, receipt = fixture(Path(temporary))
                original = source / receipt['noticeSupplements'][0]['files'][0]['path']
                if remove: original.unlink()
                else: original.write_bytes(b'Replacement text')
                with self.assertRaises((ValueError, OSError)):
                    STAGE.native_source_evidence(source, IMAGE, policy)

    def test_rehashed_receipt_cannot_hide_supplement_or_unresolved_notices(self):
        for unresolved in (True, False):
            with self.subTest(unresolved=unresolved), tempfile.TemporaryDirectory() as temporary:
                source, policy, lock, receipt = fixture(Path(temporary))
                if unresolved: lock['unresolvedNotices'] = [{'source': 'cargo-sources/fixture-1.0.crate', 'reason': 'missing-original-notice'}]
                else: lock['noticeSupplements'] = []; receipt['noticeSupplements'] = []
                (source / 'source-lock.json').write_text(json.dumps(lock))
                receipt['sourceLockSha256'] = NATIVE.sha(source / 'source-lock.json')
                (source / 'receipt.json').write_text(json.dumps(receipt))
                with self.assertRaisesRegex(ValueError, 'changed or unresolved'):
                    STAGE.native_source_evidence(source, IMAGE, policy)

    def test_matching_policy_hashes_cannot_waive_wrong_embedded_crate_commit(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, policy, _, _ = fixture(Path(temporary), actual_commit='d' * 40)
            with self.assertRaisesRegex(ValueError, 'embedded crate identity'):
                STAGE.native_source_evidence(source, IMAGE, policy)


if __name__ == '__main__':
    unittest.main()
