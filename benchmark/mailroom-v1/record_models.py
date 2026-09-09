"""Synthetic-only fixed-loopback Ollama recorder; never a general network proxy.

Run after collection, alongside the scoped production worker. The immutable plan
and current.json select the only permitted job/model. Images must match rendered
pages from that original source in the independent decode registry. PNG bytes are
stored once; request templates can be reconstructed byte-for-byte for auditing.
"""
import argparse
import base64
from datetime import datetime, timezone
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import signal
import threading
import time
from uuid import uuid4

import httpx


MODELS = {'gemma4:e4b-m3', 'qwen3-aster-cpu:1.7b'}
MAX_REQUEST_BYTES = 14 * 1024 * 1024
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
APP = Path(__file__).resolve().parent.parent.parent
WORK_IDENTITY_FIELDS = ('id', 'organizationId', 'documentId', 'sourceId', 'sourceIds',
                        'model', 'mode', 'cell', 'origin')


def digest(data):
    return sha256(data).hexdigest()


def stamp():
    return datetime.now(timezone.utc).isoformat()

def plan_identity(state, version=3):
    # Production checkpoints update status/attempt progress. Only immutable
    # assignment fields bind the request; historical v2 preflights retain
    # their original complete-row hash algorithm for reproducible audits.
    identity = {key: state.get(key) for key in ['manifestSha256', 'work', 'processor']}
    if version >= 3:
        identity['work'] = [{key: row[key] for key in WORK_IDENTITY_FIELDS if key in row}
                            for row in state['work']]
    return digest(json.dumps(identity, sort_keys=True).encode())



def write(path, value):
    temporary = path.with_name(path.name + '.' + uuid4().hex + '.partial')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def bounded_json(path, maximum=12 * 1024 * 1024):
    if path.is_symlink() or path.stat().st_size > maximum:
        raise ValueError('Unsafe or oversized recording input.')
    return json.loads(path.read_bytes())


def preserve_request(body, images, image_directory):
    """Replace canonical base64 string values with unique reversible markers."""
    template, replacements = body, []
    for encoded in dict.fromkeys(images):
        raw = base64.b64decode(encoded, validate=True)
        if base64.b64encode(raw).decode('ascii') != encoded:
            raise ValueError('Image encoding is not canonical base64.')
        image_hash = digest(raw)
        path = image_directory / (image_hash + '.png')
        if path.exists():
            if path.is_symlink() or path.read_bytes() != raw:
                raise ValueError('Stored image mismatch.')
        else:
            path.write_bytes(raw)
            path.chmod(0o600)
        token = ('ASTER_RECORDED_IMAGE_' + uuid4().hex).encode('ascii')
        if token in template:
            raise ValueError('Unexpected image replacement collision.')
        old = b'"' + encoded.encode('ascii') + b'"'
        count = template.count(old)
        if count < 1:
            raise ValueError('Cannot preserve exact image encoding in JSON body.')
        template = template.replace(old, b'"' + token + b'"')
        replacements.append({'marker': token.decode(), 'sha256': image_hash,
                             'imageBytes': len(raw), 'occurrences': count})
    return template, replacements


def restore_request(template, replacements, image_directory):
    body = template
    for item in replacements:
        if not re.fullmatch(r'[a-f0-9]{64}', item['sha256']):
            raise ValueError('Invalid recorded image hash.')
        path = image_directory / (item['sha256'] + '.png')
        if path.is_symlink():
            raise ValueError('Symlink image is not permitted.')
        raw = path.read_bytes()
        if len(raw) != item['imageBytes'] or digest(raw) != item['sha256']:
            raise ValueError('Recorded image integrity failed.')
        old = b'"' + item['marker'].encode('ascii') + b'"'
        if body.count(old) != item['occurrences']:
            raise ValueError('Recorded image marker count changed.')
        body = body.replace(old, b'"' + base64.b64encode(raw) + b'"')
    return body


class Registry:
    def __init__(self, run, decoded, preflight=False, create=True, current_decoder=True):
        self.run, self.decoded = run.resolve(), decoded.resolve()
        self.plan_name = 'preflight-plan.json' if preflight else 'state.json'
        self.state = bounded_json(self.run / self.plan_name)
        index = bounded_json(self.decoded / 'decode-index.json')
        if index.get('decoderUnchanged') is not True:
            raise ValueError('Independent decode did not preserve decoder source.')
        if self.state.get('manifestSha256') != index['manifestSha256']:
            raise ValueError('Plan and rendered sources use different frozen originals.')
        if not preflight and any(self.state.get('processor', {}).get(path) != expected
                                 for path, expected in index['decoderBefore'].items()):
            raise ValueError('Independent decode and frozen processor source differ.')
        if current_decoder and any(digest((APP / path).read_bytes()) != expected
                                   for path, expected in index.get('decoderBefore', {}).items()):
            raise ValueError('Independent decode differs from current decoder source.')
        self.work = {row['id']: row for row in self.state['work']}
        if not self.work or any(row['model'] not in MODELS for row in self.work.values()):
            raise ValueError('Only the two approved synthetic comparison models are permitted.')
        self.sources = {row['caseId']: row for row in index['rows']}
        if any(source_id not in self.sources for row in self.work.values()
               for source_id in row.get('sourceIds', [row['sourceId']])):
            raise ValueError('Planned source is absent from independent registry.')
        for source_id, source in self.sources.items():
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', source_id):
                raise ValueError('Invalid registry source identifier.')
            if source.get('artifactSha256'):
                artifact = self.decoded / (source_id + '.json')
                if artifact.is_symlink() or digest(artifact.read_bytes()) != source['artifactSha256']:
                    raise ValueError('Independent decoded artifact changed.')
            for item in source['pageImages']:
                path = (self.decoded / item['path']).resolve()
                if not path.is_relative_to(self.decoded):
                    raise ValueError('Independent image path escapes registry.')
                raw = path.read_bytes()
                if len(raw) != item['bytes'] or digest(raw) != item['sha256']:
                    raise ValueError('Independent source image changed.')
        context_path = self.run / 'model-recording-context.json'
        previous = bounded_json(context_path) if context_path.exists() else None
        version = previous.get('version') if previous else 3
        if version not in (2, 3):
            raise ValueError('Unsupported recorder identity version.')
        context = {'version': version, 'planFile': self.plan_name, 'decodedDirectory': str(self.decoded),
                   'planIdentitySha256': plan_identity(self.state, version),
                   'decodeIndexSha256': digest((self.decoded / 'decode-index.json').read_bytes())}
        if previous is not None:
            if previous != context:
                raise ValueError('Recorder plan or source registry changed after recording began.')
        elif create:
            write(context_path, context)
        self.recordings = self.run / 'model-attempts'
        self.images = self.run / 'model-images'
        for path in [self.recordings, self.images]:
            if create and path.is_symlink():
                raise ValueError('Recording directory must not be a symlink.')
            if create:
                path.mkdir(mode=0o700, exist_ok=True)
        self.requests = 0

    def current(self):
        active = bounded_json(self.run / 'current.json', 128 * 1024)
        planned = self.work.get(active.get('id'))
        if not planned or any(active.get(key) != planned.get(key)
                              for key in ['documentId', 'organizationId', 'model', 'mode', 'sourceId']):
            raise ValueError('Current request is not an authorized synthetic planned job.')
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', planned['id']):
            raise ValueError('Invalid synthetic job ID.')
        return planned

    def validate(self, path, raw, planned=None):
        if path not in ('/api/show', '/api/chat'):
            raise ValueError('Only fixed show/chat routes are permitted.')
        current = self.current() if planned is None else planned
        body = json.loads(raw)
        if not isinstance(body, dict) or body.get('model') != current['model']:
            raise ValueError('Model does not match the active synthetic job.')
        allowed = {'model'} if path == '/api/show' else {'model', 'messages', 'format', 'stream', 'think', 'options', 'keep_alive'}
        if set(body) - allowed:
            raise ValueError('Unexpected request fields.')
        images = []
        if path == '/api/chat':
            if body.get('stream') is not False or not isinstance(body.get('messages'), list) or len(body['messages']) > 8:
                raise ValueError('Only bounded nonstreaming chat requests are permitted.')
            for message in body['messages']:
                if not isinstance(message, dict) or not isinstance(message.get('content'), str):
                    raise ValueError('Invalid chat message.')
                supplied = message.get('images', [])
                if not isinstance(supplied, list):
                    raise ValueError('Invalid image list.')
                images.extend(supplied)
        if len(images) > 4 or any(not isinstance(value, str) or len(value) > 5_592_408 for value in images):
            raise ValueError('Image input bound exceeded.')
        expected = {image['sha256']: {'caseId': source_id, 'sourceSha256': self.sources[source_id]['sourceSha256'], **image}
                    for source_id in current.get('sourceIds', [current['sourceId']])
                    for image in self.sources[source_id]['pageImages']}
        provenance, total = [], 0
        for encoded in images:
            raw_image = base64.b64decode(encoded, validate=True)
            total += len(raw_image)
            match = expected.get(digest(raw_image))
            if not match or match['bytes'] != len(raw_image):
                raise ValueError('Image does not match a rendered page of the active original.')
            provenance.append(match)
        if total > 8 * 1024 * 1024:
            raise ValueError('Aggregate image bound exceeded.')
        return current, images, provenance


def audit_registry(run, decoded=None):
    context_path = run / 'model-recording-context.json'
    context = bounded_json(context_path) if context_path.exists() else None
    preflight = context['planFile'] == 'preflight-plan.json' if context else (run / 'preflight-plan.json').exists()
    plan = bounded_json(run / ('preflight-plan.json' if preflight else 'state.json'))
    if decoded is None:
        decoded = Path(context['decodedDirectory']) if context else Path(plan.get('decodedDirectory', run / 'decoded'))
    return Registry(run, decoded, preflight=preflight, create=False, current_decoder=False)


def verified_attempt(run, metadata_path, registry):
    metadata = bounded_json(metadata_path)
    directory = metadata_path.parent
    planned = registry.work.get(metadata.get('jobId'))
    if (not planned or directory.parent.name != planned['id'] or
            any(metadata.get(recorded) != planned.get(expected) for recorded, expected in
                [('jobId', 'id'), ('documentId', 'documentId'), ('organizationId', 'organizationId'), ('model', 'model'),
                 ('mode', 'mode'), ('sourceId', 'sourceId')])):
        raise ValueError('Recorded request identity differs from the frozen plan.')
    template = (directory / 'request.template.bin').read_bytes()
    if digest(template) != metadata['templateSha256']:
        raise ValueError('Request template changed.')
    body = restore_request(template, metadata['imageReplacements'], run / 'model-images')
    if len(body) != metadata['requestBytes'] or digest(body) != metadata['requestSha256']:
        raise ValueError('Reconstructed request differs from the exact submitted bytes.')
    _, images, provenance = registry.validate(metadata['path'], body, planned=planned)
    if metadata.get('imageCount') != len(images) or metadata.get('imageProvenance') != provenance:
        raise ValueError('Recorded image metadata differs from actual request images and independent source provenance.')
    expected_images = {digest(base64.b64decode(value, validate=True)) for value in images}
    if {item['sha256'] for item in metadata['imageReplacements']} != expected_images:
        raise ValueError('Image reconstruction references differ from submitted image values.')
    response_path = directory / 'response.bin'
    if metadata.get('responseSha256'):
        response = response_path.read_bytes()
        if len(response) != metadata['responseBytes'] or digest(response) != metadata['responseSha256']:
            raise ValueError('Recorded response changed.')
    elif not metadata.get('errorCode'):
        raise ValueError('Missing response without an explicit transport error.')
    return {**metadata, 'imageCount': len(images), 'imageProvenance': provenance}


def audit(run, decoded=None):
    rows, errors = [], []
    try:
        registry = audit_registry(run, decoded)
    except (ValueError, KeyError, OSError) as exc:
        registry = None
        errors.append({'attempt': None, 'error': str(exc)})
    if registry:
        for metadata_path in sorted((run / 'model-attempts').glob('*/*/attempt.json')):
            try:
                metadata = verified_attempt(run, metadata_path, registry)
                rows.append({key: metadata.get(key) for key in ['jobId', 'path', 'model', 'sourceId', 'httpStatus', 'imageCount', 'wallSeconds', 'requestSha256', 'responseSha256', 'errorCode']})
            except (ValueError, KeyError, OSError) as exc:
                errors.append({'attempt': str(metadata_path.parent.relative_to(run)), 'error': str(exc)})
    report = {'version': 2, 'generatedAt': stamp(), 'verified': bool(rows) and not errors,
              'recordedRequests': len(rows), 'chatRequests': sum(row['path'] == '/api/chat' for row in rows),
              'chatRequestsWithImages': sum(row['path'] == '/api/chat' and row['imageCount'] > 0 for row in rows),
              'errors': errors, 'rows': rows,
              'scope': 'Recorded model transport only; check complete production attempts separately. Reconstructed requests, model identity, actual image counts and source provenance are checked against the plan and independent registry.'}
    write(run / 'model-attempt-integrity.json', report)
    return report


def serve(registry):
    client = httpx.Client(base_url='http://127.0.0.1:11434', timeout=httpx.Timeout(185, connect=5),
                          trust_env=False, follow_redirects=False)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(200 if self.path == '/healthz' else 404)
            self.end_headers()
            self.wfile.write(b'{"syntheticRecorder":true}')

        def do_POST(self):
            directory = None
            started = time.monotonic()
            metadata = {'startedAt': stamp()}
            try:
                length = int(self.headers.get('Content-Length', '-1'))
                if self.headers.get('Transfer-Encoding') or not 0 < length <= MAX_REQUEST_BYTES:
                    raise ValueError('Request length is missing or exceeds the bound.')
                self.connection.settimeout(190)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError('Incomplete request body.')
                current, images, provenance = registry.validate(self.path, raw)
                directory = registry.recordings / current['id'] / (str(time.time_ns()) + '-' + uuid4().hex[:8])
                directory.mkdir(parents=True, mode=0o700)
                template, replacements = preserve_request(raw, images, registry.images)
                (directory / 'request.template.bin').write_bytes(template)
                (directory / 'request.template.bin').chmod(0o600)
                metadata.update({'jobId': current['id'], 'documentId': current['documentId'],
                                 'model': current['model'], 'mode': current['mode'], 'sourceId': current['sourceId'],
                                 'organizationId': current.get('organizationId'),
                                 'path': self.path, 'requestSha256': digest(raw), 'requestBytes': len(raw),
                                 'templateSha256': digest(template), 'imageReplacements': replacements,
                                 'imageCount': len(images), 'imageProvenance': provenance})
                write(directory / 'attempt.json', metadata)
                received = bytearray()
                with client.stream('POST', self.path, content=raw, headers={'Content-Type': 'application/json'}) as upstream:
                    status = upstream.status_code
                    for chunk in upstream.iter_bytes():
                        received.extend(chunk)
                        if len(received) > MAX_RESPONSE_BYTES:
                            raise ValueError('Response exceeded the production bound.')
                metadata.update({'httpStatus': status, 'responseBytes': len(received), 'responseSha256': digest(received)})
                (directory / 'response.bin').write_bytes(received)
                (directory / 'response.bin').chmod(0o600)
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(received)))
                self.end_headers()
                self.wfile.write(received)
            except (ValueError, KeyError, OSError, httpx.HTTPError) as exc:
                metadata['errorCode'] = 'RECORDER_' + type(exc).__name__.upper()
                try:
                    self.send_response(502 if directory else 403)
                    self.end_headers()
                    self.wfile.write(b'{"error":"SYNTHETIC_MODEL_RECORDING_REJECTED"}')
                except OSError:
                    pass
            finally:
                metadata.update({'finishedAt': stamp(), 'wallSeconds': time.monotonic() - started})
                if directory:
                    write(directory / 'attempt.json', metadata)
                    registry.requests += 1
                    write(registry.run / 'model-recorder-status.json', {'at': stamp(), 'recordedSinceStart': registry.requests,
                                                                      'lastJobId': metadata['jobId'], 'lastPath': self.path,
                                                                      'lastErrorCode': metadata.get('errorCode')})

    server = HTTPServer(('127.0.0.1', 11436), Handler)
    server.timeout = 1
    stopped = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stopped.set())
    print(json.dumps({'listening': '127.0.0.1:11436', 'upstream': '127.0.0.1:11434', 'syntheticJobs': len(registry.work)}), flush=True)
    try:
        while not stopped.is_set():
            server.handle_request()
    finally:
        server.server_close()
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--decoded', type=Path)
    parser.add_argument('--preflight', action='store_true', help='Use explicit RUN/preflight-plan.json instead of collected state.')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if args.verify:
        result = audit(args.run.resolve(), args.decoded)
        print(json.dumps({key: value for key, value in result.items() if key != 'rows'}, indent=2))
        if not result['verified']:
            raise SystemExit(1)
    else:
        if args.decoded is None:
            parser.error('--decoded is required when recording')
        serve(Registry(args.run, args.decoded, args.preflight))


if __name__ == '__main__':
    main()
