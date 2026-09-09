"""Image-preflight provenance controls; no services or inference are used."""
import base64
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import httpx

SPEC = importlib.util.spec_from_file_location('image_preflight_controls', Path(__file__).with_name('run_image_probe.py'))
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class Controls(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.corpus, self.decoded, self.run = root / 'corpus', root / 'decoded', root / 'run'
        self.corpus.mkdir(); self.decoded.mkdir(); (self.decoded / 'images').mkdir()
        self.processor = {'processor/service/documents.py': 'decoder-v1'}
        self.stack.enter_context(patch.object(probe, 'ROOT', self.corpus))
        self.stack.enter_context(patch.object(probe, 'fingerprint', side_effect=lambda: dict(self.processor)))
        self.stack.enter_context(redirect_stdout(io.StringIO()))
        documents, files = [], {}
        gold = {'cases': [{'id': name, 'facts': [], 'relevant': False} for name in ['source-a', 'source-b']]}
        probe.write(self.corpus / 'gold.json', gold)
        files['gold.json'] = probe.digest((self.corpus / 'gold.json').read_bytes())
        for name in ['source-a', 'source-b']:
            raw = ('Subject: Synthetic ' + name + '\r\n\r\nSource body.').encode()
            (self.corpus / (name + '.eml')).write_bytes(raw)
            files[name + '.eml'] = probe.digest(raw)
            documents.append({'id': name, 'filename': name + '.eml', 'sha256': probe.digest(raw)})
        probe.write(self.corpus / 'manifest.json', {'files': files, 'documents': documents})
        self.manifest_hash = probe.digest((self.corpus / 'manifest.json').read_bytes())
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4wAAAABJRU5ErkJggg==')
        self.image = self.decoded / 'images/page.png'; self.image.write_bytes(png)
        image = {'path': 'images/page.png', 'sha256': probe.digest(png), 'bytes': len(png),
                 'width': 1, 'height': 1, 'format': 'PNG'}
        rows = []
        for source in documents:
            payload = {'sourceId': source['id'], 'sourceSha256': source['sha256'],
                       'manifestSha256': self.manifest_hash, 'decodeError': None,
                       'pages': [{'number': 1, 'text': 'Source body.', 'source': 'PDF page 1', 'image': image}]}
            artifact = self.decoded / (source['id'] + '.json'); probe.write(artifact, payload)
            rows.append({'caseId': source['id'], 'sourceSha256': source['sha256'],
                         'artifactSha256': probe.digest(artifact.read_bytes()),
                         'pageImages': [{'number': 1, 'source': 'PDF page 1', **image}]})
        probe.write(self.decoded / 'decode-index.json', {
            'manifestSha256': self.manifest_hash, 'goldSha256': files['gold.json'],
            'decoderBefore': self.processor, 'decoderUnchanged': True,
            'documents': 2, 'decoded': 2, 'blocked': 0, 'documentsWithAnchorIssues': 0,
            'ocrPages': 0, 'renderedPageImages': 2, 'rows': rows})
        probe.prepare(self.run, self.decoded, 'source-a')
        self.plan = json.loads((self.run / 'preflight-plan.json').read_text())

    def assert_rejected_before_http(self):
        with patch.object(probe.httpx, 'Client') as client, patch.dict('os.environ', {'PROCESSOR_TOKEN': 'synthetic-control'}):
            with self.assertRaises((ValueError, OSError)):
                probe.execute(self.run)
            client.assert_not_called()
        self.assertFalse((self.run / 'execution.json').exists())

    def test_prepare_pins_complete_registry_and_preserves_existing_plan(self):
        self.assertEqual(probe.verify_prepared_inputs(self.plan), self.processor)
        self.assertEqual(set(self.plan['decodedPins']['artifacts']), {'source-a.json', 'source-b.json'})
        self.assertEqual(self.plan['decodedPins']['images']['images/page.png'], probe.digest(self.image.read_bytes()))
        original = (self.run / 'preflight-plan.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            probe.prepare(self.run, self.decoded, 'source-a')
        self.assertEqual(original, (self.run / 'preflight-plan.json').read_bytes())

    def test_decoder_change_fails_before_http(self):
        self.processor['processor/service/documents.py'] = 'decoder-v2'
        self.assert_rejected_before_http()

    def test_target_artifact_change_fails_before_http(self):
        (self.decoded / 'source-a.json').write_text('{}')
        self.assert_rejected_before_http()

    def test_other_source_artifact_change_fails_before_http(self):
        (self.decoded / 'source-b.json').write_text('{}')
        self.assert_rejected_before_http()

    def test_source_png_change_fails_before_http(self):
        self.image.write_bytes(b'changed pixels')
        self.assert_rejected_before_http()

    def test_replacing_artifact_and_registry_hash_cannot_repin_prepared_plan(self):
        artifact = self.decoded / 'source-a.json'
        value = json.loads(artifact.read_text()); value['pages'][0]['text'] = 'Different evidence'
        probe.write(artifact, value)
        index_path = self.decoded / 'decode-index.json'
        index = json.loads(index_path.read_text()); index['rows'][0]['artifactSha256'] = probe.digest(artifact.read_bytes())
        probe.write(index_path, index)
        self.assert_rejected_before_http()

    def test_legacy_unpinned_plan_is_refused(self):
        self.plan.pop('decodedPins')
        probe.write(self.run / 'preflight-plan.json', self.plan)
        self.assert_rejected_before_http()

    def test_mutation_after_last_response_preserves_attempts_but_blocks_completion(self):
        client = MagicMock()
        client.__enter__.return_value = client
        request = httpx.Request('POST', 'http://127.0.0.1:8000/v1/extract', content=b'synthetic multipart',
                                headers={'content-type': 'multipart/form-data; boundary=synthetic'})
        client.build_request.return_value = request
        count = 0
        def response(_):
            nonlocal count
            count += 1
            if count == 4:
                self.image.write_bytes(b'changed after final response')
            return httpx.Response(500, content=b'Explicit synthetic failure')
        client.send.side_effect = response
        scoring = {'supportedExactMatches': 0, 'goldFactCount': 0, 'unsupportedFacts': []}
        with patch.object(probe.httpx, 'Client', return_value=client), patch.object(probe.score, 'score_case', return_value=scoring), patch.dict('os.environ', {'PROCESSOR_TOKEN': 'synthetic-control'}):
            with self.assertRaisesRegex(ValueError, 'image changed'):
                probe.execute(self.run)
        self.assertEqual(client.send.call_count, 4)
        execution = json.loads((self.run / 'execution.json').read_text())
        self.assertFalse(execution['completed'])
        self.assertFalse(execution['decodedEvidenceUnchanged'])
        self.assertEqual(execution['finishedJobs'], 4)
        self.assertEqual(len(json.loads((self.run / 'results.json').read_text())), 4)


if __name__ == '__main__':
    unittest.main()
