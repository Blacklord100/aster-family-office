"""Tamper controls for offline original-byte and engine-pin provenance audit."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('mailroom_request_audit', ROOT / 'verify_attempts.py')
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)

FILE = b'From: synthetic@example.invalid\r\nSubject: fixture\r\n\r\nExact original\x00\xff\r\n'
BOUNDARY = '----synthetic-audit-boundary'
WORK = {'id': 'job-control', 'sourceId': 'source-control', 'sourceIds': ['source-control'], 'documentId': 'document-control', 'cell': 0, 'mode': 'workflow', 'model': 'gemma4-fixture'}
SOURCE = {'sha256': audit.digest(FILE)}


def make_wire(file=FILE, mode='workflow', provider='ollama', duplicate=False, duplicate_parameter=False):
    engine = json.dumps({'name': 'SYNTHETIC comparison ' + WORK['model'], 'provider': provider, 'model': WORK['model']}).encode()
    fields = [('file', file), ('mode', mode.encode()), ('document_id', WORK['documentId'].encode()), ('engine', engine)]
    if duplicate:
        fields[3] = ('mode', engine)
    raw = bytearray()
    for name, body in fields:
        raw.extend(('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="' + name + '"').encode())
        if duplicate_parameter:
            raw.extend(b'; name="mode"')
        if name == 'file':
            raw.extend(b'; filename="gmail-fixture.eml"\r\nContent-Type: message/rfc822')
        raw.extend(b'\r\n\r\n' + body + b'\r\n')
    raw.extend(('--' + BOUNDARY + '--\r\n').encode())
    return bytes(raw)


def provision(directory, wire=None):
    request = wire or make_wire()
    response = json.dumps({'documentId': WORK['documentId'], 'mode': WORK['mode'], 'execution': 'local', 'model': None, 'facts': []}).encode()
    metadata = {key: WORK[key] for key in ['sourceId', 'sourceIds', 'cell', 'model', 'mode']}
    metadata.update({'jobId': WORK['id'], 'startedAt': 'synthetic-start', 'finishedAt': 'synthetic-finish', 'httpStatus': 200, 'requestBytes': len(request), 'requestSha256': audit.digest(request), 'responseBytes': len(response), 'responseSha256': audit.digest(response), 'contentType': 'multipart/form-data; boundary=' + BOUNDARY})
    (directory / 'request.multipart.bin').write_bytes(request)
    (directory / 'response.json').write_bytes(response)
    (directory / 'attempt.json').write_text(json.dumps(metadata))
    return metadata


class IntegrityControls(unittest.TestCase):
    def test_preserves_exact_rfc822_binary_bytes(self):
        self.assertEqual(audit.multipart(make_wire(), 'multipart/form-data; boundary=' + BOUNDARY)['file'], FILE)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            provision(directory)
            result = audit.audit_attempt(directory, WORK, SOURCE, len(FILE))
            self.assertTrue(result['passed'])
            self.assertTrue(result['requestVerified'])
            self.assertTrue(result['responseVerified'])

    def test_changed_file_or_engine_pin_cannot_pass_with_fresh_outer_hash(self):
        for wire, code in [(make_wire(file=FILE + b'altered'), 'original_file_hash_mismatch'), (make_wire(mode='agentic'), 'multipart_mode_pin_mismatch'), (make_wire(provider='openai'), 'multipart_local_engine_pin_mismatch')]:
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                provision(directory, wire)
                result = audit.audit_attempt(directory, WORK, SOURCE, len(FILE))
                self.assertIn(code, [item['code'] for item in result['issues']])
                self.assertFalse(result['passed'])

    def test_request_and_response_metadata_hashes_are_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            metadata = provision(directory)
            metadata['requestSha256'] = 'wrong'
            metadata['responseSha256'] = 'wrong'
            (directory / 'attempt.json').write_text(json.dumps(metadata))
            result = audit.audit_attempt(directory, WORK, SOURCE, len(FILE))
            codes = [item['code'] for item in result['issues']]
            self.assertIn('request_hash_metadata_mismatch', codes)
            self.assertIn('response_hash_metadata_mismatch', codes)

    def test_rejects_duplicate_fields_and_duplicate_header_parameters(self):
        for wire in [make_wire(duplicate=True), make_wire(duplicate_parameter=True)]:
            with self.assertRaises(ValueError):
                audit.multipart(wire, 'multipart/form-data; boundary=' + BOUNDARY)

    def test_explicit_failed_response_absence_is_counted_not_dropped(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            metadata = provision(directory)
            for field in ['httpStatus', 'responseSha256', 'responseBytes']:
                del metadata[field]
            metadata['errorType'] = 'TimeoutError'
            (directory / 'response.json').unlink()
            (directory / 'attempt.json').write_text(json.dumps(metadata))
            result = audit.audit_attempt(directory, WORK, SOURCE, len(FILE))
            self.assertTrue(result['passed'])
            self.assertTrue(result['responseUnavailableExplicit'])
            self.assertFalse(result['responseVerified'])
            del metadata['errorType']
            (directory / 'attempt.json').write_text(json.dumps(metadata))
            result = audit.audit_attempt(directory, WORK, SOURCE, len(FILE))
            self.assertIn('response_payload_missing_without_recorded_failure', [item['code'] for item in result['issues']])

    def test_plain_text_failed_http_response_is_valid_byte_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            metadata = provision(directory)
            response = b'Internal Server Error'
            (directory / 'response.json').write_bytes(response)
            metadata.update({'httpStatus': 500, 'responseBytes': len(response), 'responseSha256': audit.digest(response)})
            (directory / 'attempt.json').write_text(json.dumps(metadata))
            result = audit.audit_attempt(directory, WORK, SOURCE, len(FILE))
            self.assertTrue(result['passed'])
            self.assertTrue(result['responseVerified'])
            self.assertEqual(result['responsePayloadKind'], 'failed_http_response_bytes')


if __name__ == '__main__':
    unittest.main()
