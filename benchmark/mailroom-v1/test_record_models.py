"""Recorder controls use synthetic local files; no inference or services are started."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('model_recorder', ROOT / 'record_models.py')
recorder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recorder)


def image(color):
    buffer = io.BytesIO()
    Image.new('RGB', (20, 12), color).save(buffer, format='PNG')
    return buffer.getvalue()


class Controls(unittest.TestCase):
    def setup_registry(self, root):
        run, decoded = root / 'run', root / 'decoded'
        run.mkdir(); decoded.mkdir()
        source = image('white')
        (decoded / 'source.png').write_bytes(source)
        work = {'id': 'synthetic-job', 'organizationId': 'synthetic-office', 'documentId': 'synthetic-document', 'sourceId': 'synthetic-source',
                'sourceIds': ['synthetic-source'], 'model': 'gemma4:e4b-m3', 'mode': 'workflow'}
        recorder.write(run / 'preflight-plan.json', {'manifestSha256': 'same', 'work': [work]})
        recorder.write(run / 'current.json', work)
        recorder.write(decoded / 'decode-index.json', {'decoderUnchanged': True, 'manifestSha256': 'same',
                      'rows': [{'caseId': 'synthetic-source', 'sourceSha256': 'original-source-hash',
                                'pageImages': [{'path': 'source.png', 'sha256': recorder.digest(source), 'bytes': len(source),
                                                'number': 2, 'source': 'attachment 1; PDF page 1'}]}]})
        return recorder.Registry(run, decoded, preflight=True), source

    def test_exact_byte_reconstruction_preserves_whitespace_unicode_and_repeated_images(self):
        with tempfile.TemporaryDirectory() as directory:
            images = Path(directory)
            encoded = base64.b64encode(image('white')).decode()
            raw = json.dumps({'messages': [{'role': 'user', 'content': '€ — source data',
                                          'images': [encoded, encoded]}]}, ensure_ascii=False, indent=3).encode()
            template, substitutions = recorder.preserve_request(raw, [encoded, encoded], images)
            self.assertNotIn(encoded.encode(), template)
            self.assertEqual(len(substitutions), 1)
            self.assertEqual(substitutions[0]['occurrences'], 2)
            self.assertEqual(len(list(images.glob('*.png'))), 1)
            self.assertEqual(recorder.restore_request(template, substitutions, images), raw)
            next(images.glob('*.png')).write_bytes(image('black'))
            with self.assertRaisesRegex(ValueError, 'integrity'):
                recorder.restore_request(template, substitutions, images)

    def test_only_active_planned_model_and_exact_source_images_are_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            registry, source = self.setup_registry(Path(temporary))
            payload = {'model': 'gemma4:e4b-m3', 'stream': False,
                       'messages': [{'role': 'user', 'content': 'Synthetic',
                                     'images': [base64.b64encode(source).decode()]}]}
            work, images, provenance = registry.validate('/api/chat', json.dumps(payload).encode())
            self.assertEqual(work['id'], 'synthetic-job')
            self.assertEqual(provenance[0]['sourceSha256'], 'original-source-hash')
            self.assertEqual(provenance[0]['number'], 2)
            self.assertEqual(len(images), 1)
            for path in ['/api/pull', '/api/create', 'https://outside.invalid/api/chat']:
                with self.assertRaisesRegex(ValueError, 'fixed'):
                    registry.validate(path, json.dumps(payload).encode())
            payload['model'] = 'qwen3-aster-cpu:1.7b'
            with self.assertRaisesRegex(ValueError, 'active'):
                registry.validate('/api/chat', json.dumps(payload).encode())
            payload['model'] = 'gemma4:e4b-m3'
            payload['messages'][0]['images'] = [base64.b64encode(image('black')).decode()]
            with self.assertRaisesRegex(ValueError, 'active original'):
                registry.validate('/api/chat', json.dumps(payload).encode())

    def test_changed_current_context_and_corpus_identity_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            registry, _ = self.setup_registry(Path(temporary))
            current = recorder.bounded_json(registry.run / 'current.json')
            current['documentId'] = 'different-source'
            recorder.write(registry.run / 'current.json', current)
            with self.assertRaisesRegex(ValueError, 'authorized'):
                registry.current()
            plan = recorder.bounded_json(registry.run / 'preflight-plan.json')
            plan['manifestSha256'] = 'changed'
            recorder.write(registry.run / 'preflight-plan.json', plan)
            with self.assertRaisesRegex(ValueError, 'different frozen'):
                recorder.Registry(registry.run, registry.decoded, preflight=True)

    def recorded_attempt(self, root, with_images=True):
        registry, source = self.setup_registry(root)
        run = registry.run
        directory = run / 'model-attempts/synthetic-job/attempt'
        directory.mkdir(parents=True)
        encoded = base64.b64encode(source).decode()
        body = json.dumps({'model': 'gemma4:e4b-m3', 'stream': False,
                           'messages': [{'role': 'user', 'content': 'Synthetic',
                                         'images': [encoded] if with_images else []}]}).encode()
        current, images, provenance = registry.validate('/api/chat', body)
        template, substitutions = recorder.preserve_request(body, images, registry.images)
        (directory / 'request.template.bin').write_bytes(template)
        response = b'{"done":true}'
        (directory / 'response.bin').write_bytes(response)
        metadata = {'jobId': current['id'], **{key: current[key] for key in
                    ['documentId', 'organizationId', 'model', 'mode', 'sourceId']}, 'path': '/api/chat',
                    'imageCount': len(images), 'imageProvenance': provenance,
                    'requestBytes': len(body), 'requestSha256': recorder.digest(body),
                    'templateSha256': recorder.digest(template), 'imageReplacements': substitutions,
                    'responseBytes': len(response), 'responseSha256': recorder.digest(response)}
        recorder.write(directory / 'attempt.json', metadata)
        return registry, directory, metadata

    def test_audit_detects_response_and_image_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            registry, directory, _ = self.recorded_attempt(Path(temporary))
            self.assertTrue(recorder.audit(registry.run)['verified'])
            (directory / 'response.bin').write_bytes(b'changed')
            self.assertFalse(recorder.audit(registry.run)['verified'])

    def test_audit_rejects_request_metadata_model_source_and_image_count_lies(self):
        changes = [('model', 'qwen3-aster-cpu:1.7b'), ('sourceId', 'other-source'),
                   ('imageCount', 4), ('imageProvenance', [{'sha256': 'invented-image'}])]
        for key, value in changes:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as temporary:
                registry, directory, metadata = self.recorded_attempt(Path(temporary), with_images=False)
                self.assertTrue(recorder.audit(registry.run)['verified'])
                metadata[key] = value
                recorder.write(directory / 'attempt.json', metadata)
                self.assertFalse(recorder.audit(registry.run)['verified'])

    def test_audit_rejects_actual_request_image_and_model_mismatch_even_with_rehashed_bytes(self):
        for change in ['model', 'image']:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                registry, directory, metadata = self.recorded_attempt(Path(temporary), with_images=False)
                request = json.loads((directory / 'request.template.bin').read_bytes())
                if change == 'model':
                    request['model'] = 'qwen3-aster-cpu:1.7b'
                else:
                    request['messages'][0]['images'] = [base64.b64encode(image('black')).decode()]
                body = json.dumps(request).encode()
                (directory / 'request.template.bin').write_bytes(body)
                metadata.update(requestBytes=len(body), requestSha256=recorder.digest(body),
                                templateSha256=recorder.digest(body))
                recorder.write(directory / 'attempt.json', metadata)
                self.assertFalse(recorder.audit(registry.run)['verified'])

    def test_audit_rejects_changed_registry_and_plan(self):
        for filename in ['preflight-plan.json', 'decode-index.json']:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as temporary:
                registry, _, _ = self.recorded_attempt(Path(temporary))
                path = (registry.run if filename.startswith('preflight') else registry.decoded) / filename
                data = json.loads(path.read_bytes())
                if filename.startswith('preflight'):
                    data['work'][0]['documentId'] = 'changed'
                else:
                    data['rows'][0]['sourceSha256'] = 'changed'
                recorder.write(path, data)
                self.assertFalse(recorder.audit(registry.run)['verified'])

    def test_mutable_progress_does_not_change_identity_but_assignments_do(self):
        for field in recorder.WORK_IDENTITY_FIELDS:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                registry, _, _ = self.recorded_attempt(Path(temporary))
                plan_path = registry.run / 'preflight-plan.json'
                plan = recorder.bounded_json(plan_path)
                plan['work'][0].update(status='awaiting_review', attempts=2, finishedAt='2026-09-09T00:00:00Z')
                recorder.write(plan_path, plan)
                self.assertEqual(recorder.bounded_json(registry.run / 'model-recording-context.json')['version'], 3)
                self.assertTrue(recorder.audit(registry.run)['verified'])
                recorder.Registry(registry.run, registry.decoded, preflight=True)
                plan['work'][0][field] = {'sourceIds': ['changed'], 'model': 'qwen3-aster-cpu:1.7b',
                                        'mode': 'agentic', 'cell': 1,
                                        'origin': 'explicit_same_original_comparison'}.get(field, 'changed')
                recorder.write(plan_path, plan)
                self.assertFalse(recorder.audit(registry.run)['verified'])

    def test_historical_v2_recording_identity_remains_verifiable(self):
        with tempfile.TemporaryDirectory() as temporary:
            registry, _, _ = self.recorded_attempt(Path(temporary))
            path = registry.run / 'model-recording-context.json'
            context = recorder.bounded_json(path)
            context['version'] = 2
            context['planIdentitySha256'] = recorder.plan_identity(registry.state, version=2)
            recorder.write(path, context)
            self.assertTrue(recorder.audit(registry.run)['verified'])


if __name__ == '__main__':
    unittest.main()
