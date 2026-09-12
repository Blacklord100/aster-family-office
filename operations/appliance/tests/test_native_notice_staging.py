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


def fixture(root, actual_commit=COMMIT, matched_source=False, embedded_source=False):
    policy_root, source = root / 'policy', root / 'source'
    def put(base, name, data):
        path = base / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
        return {'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    crate_name = 'cargo-sources/fixture-1.0.crate'
    original = b'Original synthetic license from exact fixture revision'
    contents = {
        'fixture-1.0/Cargo.toml.orig': b'[package]\nname="fixture"\nversion="1.0"\nrepository="https://github.com/example/fixture"\nlicense="MIT"\n',
        'fixture-1.0/.cargo_vcs_info.json': json.dumps({'git': {'sha1': actual_commit}}).encode(),
        'fixture-1.0/src/lib.rs': b'// synthetic source only',
    }
    if matched_source:
        contents.pop('fixture-1.0/.cargo_vcs_info.json')
        contents['fixture-1.0/Cargo.toml'] = b'# generated\n' + contents['fixture-1.0/Cargo.toml.orig']
        contents['fixture-1.0/lib/import.a'] = b'!<arch>\nsynthetic import library'
    header = b'/* Original synthetic source license notice */\n'
    if embedded_source:
        contents['fixture-1.0/src/lib.rs'] = header + b'pub fn original() {}'
        contents['fixture-1.0/build.rs'] = header + b'fn main() {}'
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in contents.items():
            item = tarfile.TarInfo(name); item.size = len(data); archive.addfile(item, io.BytesIO(data))
    crate = put(source, crate_name, buffer.getvalue())
    recipe = put(policy_root, 'recipe/versions.properties', b'VERSION_SYNTHETIC=1\n'); recipe['path'] = 'versions.properties'
    cargo = ('version=3\n[[package]]\nname="fixture"\nversion="1.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' + crate['sha256'] + '"\n').encode()
    metadata = [put(policy_root, 'metadata/glib-gvdb.wrap', b'[wrap-git]\nrevision=synthetic\n'),
                put(policy_root, 'metadata/librsvg-Cargo.lock', cargo)]
    put(policy_root, 'recipe-provenance.json', json.dumps({'files': [recipe]}).encode())
    put(policy_root, 'metadata-provenance.json', json.dumps({'files': metadata}).encode())
    put(policy_root, 'README.md', b'Synthetic qualification fixture, never release material')
    original_hash = hashlib.sha256(original).hexdigest()
    policy = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-policy-v1', 'versions': {'synthetic': '1'},
              'sources': [{'name': 'synthetic', 'version': '1', 'url': 'https://example.invalid/native.tar.gz'},
                          {'name': 'gvdb', 'version': 'synthetic', 'url': 'https://example.invalid/gvdb.tar.gz'}],
              'limits': {'archiveMembers': 100, 'expandedSourceBytes': 1024 * 1024, 'perSourceBytes': 1024 * 1024},
              'noticeSupplements': [{'name': 'fixture', 'version': '1.0', 'crateSha256': crate['sha256'],
                'repository': 'https://github.com/example/fixture', 'vcsCommit': COMMIT, 'license': 'MIT',
                'files': [{'filename': 'LICENSE', 'url': 'https://raw.githubusercontent.com/example/fixture/' + COMMIT + '/LICENSE',
                           'sha256': original_hash, 'bytes': len(original)}]}]}
    if embedded_source:
        policy['noticeSupplements'][0]['files'] = []
        policy['noticeSupplements'][0]['embeddedOriginalNotices'] = [
            {'filename': name, 'classification': 'embedded-upstream-notice', 'bytes': len(contents['fixture-1.0/' + name]),
             'sha256': hashlib.sha256(contents['fixture-1.0/' + name]).hexdigest(),
             'headerBytes': len(header), 'headerSha256': hashlib.sha256(header).hexdigest()} for name in ('src/lib.rs', 'build.rs')]
    if matched_source:
        upstream_buffer = io.BytesIO()
        mapping = []
        with tarfile.open(fileobj=upstream_buffer, mode='w:gz') as archive:
            for name, data in sorted(contents.items()):
                if name.endswith('/Cargo.toml'): continue
                path = name.split('/', 1)[1]
                target = 'sub/' + ('Cargo.toml' if path == 'Cargo.toml.orig' else path)
                mapping.append({'path': path, 'upstreamPath': target, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
                item = tarfile.TarInfo('upstream/' + target); item.size = len(data); archive.addfile(item, io.BytesIO(data))
            item = tarfile.TarInfo('upstream/LICENSE'); item.size = len(original); archive.addfile(item, io.BytesIO(original))
        supplement = policy['noticeSupplements'][0]
        proof = put(policy_root, 'notice-provenance/fixture-1.0.json', json.dumps({
            **{k: supplement[k] for k in ('name', 'version', 'crateSha256', 'repository', 'vcsCommit')}, 'files': mapping}).encode())
        put(source, 'notice-source-archives/fixture-1.0.tar.gz', upstream_buffer.getvalue())
        supplement['sourceArchive'] = {'url': 'https://codeload.github.com/example/fixture/tar.gz/' + COMMIT,
            'sha256': hashlib.sha256(upstream_buffer.getvalue()).hexdigest(), 'bytes': len(upstream_buffer.getvalue()),
            'packagePath': 'sub', 'fileProof': {**proof, 'fileCount': len(mapping)}}
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
    if not embedded_source: put(source, supplements[0]['files'][0]['path'], original)
    texts = [(name, data) for name, data in contents.items() if name.endswith('.rs')] if embedded_source else [('upstream/' + COMMIT + '/LICENSE', original)]
    notices = []
    for name, data in texts:
        digest = hashlib.sha256(data).hexdigest()
        text = put(source, 'notices/' + digest + '.txt', data)
        notices.append({'source': crate_name, 'originalPath': name, 'file': text['path'], 'sha256': digest, 'bytes': len(data)})
    runtime = {'appImageId': IMAGE, 'runtimePackage': {'name': 'SYNTHETIC'}, 'nativeFiles': [{'path': 'SYNTHETIC', 'sha256': 'c' * 64}]}
    lock = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-lock-v1', 'runtime': runtime,
            'material': material, 'policySha256': NATIVE.sha(policy_root / 'source-policy.json'), 'sources': sources,
            'sourceArchiveCount': len(sources), 'registryArchive': registry, 'noticeSupplements': supplements, 'unresolvedNotices': []}
    put(source, 'source-lock.json', json.dumps(lock).encode())
    receipt = {'schemaVersion': 1, 'type': 'aster-sharp-native-source-receipt-v1', 'result': 'source-materials-verified',
               'appImageId': IMAGE, 'sourceLockSha256': NATIVE.sha(source / 'source-lock.json'),
               'runtimePackage': runtime['runtimePackage'], 'nativeFiles': runtime['nativeFiles'],
               'sourceArchiveCount': len(sources), 'nativeSourceCount': 2, 'cargoSourceCount': 1,
               'noticeSupplements': supplements, 'notices': notices}
    put(source, 'receipt.json', json.dumps(receipt).encode())
    return source, policy_root, lock, receipt


class NoticeStaging(unittest.TestCase):
    def test_staging_preserves_every_declared_embedded_original_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, policy, _, receipt = fixture(Path(temporary), embedded_source=True)
            STAGE.native_source_evidence(source, IMAGE, policy)
            notice = receipt['notices'].pop(); (source / notice['file']).unlink()
            (source / 'receipt.json').write_text(json.dumps(receipt))
            # Clear the per-copy mutation cache to model a fresh invocation:
            # the semantic provenance check must still reject this omission.
            STAGE.FROZEN_INPUTS.clear()
            with self.assertRaisesRegex(ValueError, 'Original supplemental notice is missing'):
                STAGE.native_source_evidence(source, IMAGE, policy)

    def test_complete_source_match_is_rechecked_by_staging_and_cannot_omit_upstream_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, policy, _, receipt = fixture(Path(temporary), matched_source=True)
            STAGE.native_source_evidence(source, IMAGE, policy)
            (source / receipt['noticeSupplements'][0]['sourceArchive']['path']).unlink()
            with self.assertRaises((ValueError, OSError)):
                STAGE.native_source_evidence(source, IMAGE, policy)

    def test_staging_rejects_rehashed_incomplete_file_mapping(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, policy, lock, receipt = fixture(Path(temporary), matched_source=True)
            current = json.loads((policy / 'source-policy.json').read_text())
            proof = current['noticeSupplements'][0]['sourceArchive']['fileProof']
            path = policy / proof['path']; value = json.loads(path.read_text()); value['files'].pop()
            path.write_text(json.dumps(value)); proof.update({'sha256': NATIVE.sha(path), 'bytes': path.stat().st_size})
            (policy / 'source-policy.json').write_text(json.dumps(current))
            _, material, crates = NATIVE.load_policy(policy)
            lock['material'] = material; lock['policySha256'] = NATIVE.sha(policy / 'source-policy.json')
            for item in material: (source / 'reviewed-recipe' / item['path']).write_bytes((policy / item['path']).read_bytes())
            supplements = NATIVE.expected_supplements(current, crates)
            lock['noticeSupplements'] = supplements; receipt['noticeSupplements'] = supplements
            (source / 'source-lock.json').write_text(json.dumps(lock)); receipt['sourceLockSha256'] = NATIVE.sha(source / 'source-lock.json')
            (source / 'receipt.json').write_text(json.dumps(receipt))
            with self.assertRaisesRegex(ValueError, 'Complete packaged source file inventory'):
                STAGE.native_source_evidence(source, IMAGE, policy)

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
