"""Four-cell original-EML image-pipeline preflight; explicit execution, no retries."""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import time
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent.parent
SPEC = importlib.util.spec_from_file_location('strict_mailroom_score', ROOT / 'score.py')
score = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(score)
MODELS = ('gemma4:e4b-m3', 'qwen3-aster-cpu:1.7b')


def digest(data):
    return sha256(data).hexdigest()


def stamp():
    return datetime.now(timezone.utc).isoformat()


def write(path, value):
    temporary = path.with_name(path.name + '.partial')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def fingerprint():
    paths = [*sorted((APP / 'processor/service').glob('*.py')), APP / 'processor/requirements.lock.txt',
             APP / 'processor/corpus/train.json']
    return {str(path.relative_to(APP)): digest(path.read_bytes()) for path in paths}


def frozen_source(source_id):
    manifest_raw = (ROOT / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    for relative, expected in manifest['files'].items():
        path = (ROOT / relative).resolve()
        if not path.is_relative_to(ROOT) or digest(path.read_bytes()) != expected:
            raise ValueError('Frozen source/gold checksum changed.')
    source = next(row for row in manifest['documents'] if row['id'] == source_id)
    raw = (ROOT / source['filename']).read_bytes()
    if digest(raw) != source['sha256']:
        raise ValueError('Original source hash changed.')
    return source, raw, digest(manifest_raw)


def decoded_snapshot(decoded, manifest_hash, processor):
    """Validate the whole independent export before recording its immutable pins."""
    manifest_raw = (ROOT / 'manifest.json').read_bytes()
    if digest(manifest_raw) != manifest_hash:
        raise ValueError('Frozen manifest changed during decoded-source validation.')
    sources = {row['id']: row for row in json.loads(manifest_raw)['documents']}
    index_raw = (decoded / 'decode-index.json').read_bytes()
    index = json.loads(index_raw)
    validated = score.source_registry(decoded, {'manifestSha256': manifest_hash, 'processor': processor}, sources)
    if validated is None or index['goldSha256'] != digest((ROOT / 'gold.json').read_bytes()):
        raise ValueError('Independent decoded gold identity is invalid.')
    # The registry validator hashes every JSON artifact and rendered PNG. Pin
    # the index as well, so replacing an artifact and its expected hash cannot
    # silently change the evidence used by an already prepared comparison.
    return {'indexSha256': digest(index_raw),
            'artifacts': {row['caseId'] + '.json': row['artifactSha256'] for row in index['rows']},
            'images': {page['path']: page['sha256'] for row in index['rows'] for page in row['pageImages']}}


def verify_prepared_inputs(plan):
    current = fingerprint()
    if not plan.get('processor') or current != plan['processor']:
        raise ValueError('Processor differs from the prepared preflight.')
    snapshot = decoded_snapshot(Path(plan['decodedDirectory']), plan['manifestSha256'], current)
    if not plan.get('decodedPins') or snapshot != plan['decodedPins']:
        raise ValueError('Independent decoded evidence differs from the prepared preflight.')
    return current


def prepare(run, decoded, source_id):
    if run.exists():
        raise ValueError('Refusing to overwrite an existing preflight.')
    source, raw, manifest_hash = frozen_source(source_id)
    pinned = fingerprint()
    decoded_pins = decoded_snapshot(decoded, manifest_hash, pinned)
    pages = json.loads((decoded / (source_id + '.json')).read_text())
    if pages.get('decodeError') or not any(page.get('image') for page in pages['pages']):
        raise ValueError('Image preflight requires an actually rendered source page.')
    if fingerprint() != pinned or decoded_snapshot(decoded, manifest_hash, pinned) != decoded_pins:
        raise ValueError('Processor or decoded evidence changed during preparation.')
    run.mkdir(parents=True, mode=0o700)
    (run / 'original.eml').write_bytes(raw)
    (run / 'original.eml').chmod(0o600)
    work = []
    for cell, (model, mode) in enumerate((model, mode) for model in MODELS for mode in ('workflow', 'agentic')):
        identity = str(uuid4())
        work.append({'id': identity, 'documentId': identity, 'sourceId': source_id, 'sourceIds': [source_id],
                     'model': model, 'mode': mode, 'cell': cell})
    write(run / 'preflight-plan.json', {'preparedAt': stamp(), 'manifestSha256': manifest_hash,
                                      'sourceSha256': source['sha256'], 'processor': pinned,
                                      'decodedPins': decoded_pins, 'decodedDirectory': str(decoded), 'work': work})
    print(json.dumps({'plan': str(run / 'preflight-plan.json'), 'decoded': str(decoded), 'planned': 4,
                      'source': source_id, 'imagePages': sum(bool(p.get('image')) for p in pages['pages'])}))


def execute(run):
    if (run / 'execution.json').exists():
        raise ValueError('A preflight records one attempt per cell; use a new preserved output for another execution.')
    plan_raw = (run / 'preflight-plan.json').read_bytes()
    plan = json.loads(plan_raw)
    source_id = plan['work'][0]['sourceId']
    source, raw, manifest_hash = frozen_source(source_id)
    if plan['manifestSha256'] != manifest_hash or (run / 'original.eml').read_bytes() != raw:
        raise ValueError('Planned or preserved original differs from the frozen source.')
    pinned = verify_prepared_inputs(plan)
    if not os.environ.get('PROCESSOR_TOKEN'):
        raise ValueError('PROCESSOR_TOKEN must be inherited privately.')
    decoded = Path(plan['decodedDirectory'])
    case = next(row for row in json.loads((ROOT / 'gold.json').read_text())['cases'] if row['id'] == source_id)
    pages = json.loads((decoded / (source_id + '.json')).read_text())['pages']
    execution = {'startedAt': stamp(), 'manifestSha256': manifest_hash, 'processor': pinned,
                 'planSha256': digest(plan_raw), 'decodedPins': plan['decodedPins'],
                 'completed': False, 'allResponsesRetained': True, 'automaticAcceptance': False,
                 'scope': 'Original EML direct processor HTTP preflight, one attempt per cell; collection and worker persistence are tested separately.'}
    write(run / 'execution.json', execution)
    results = []
    try:
        with httpx.Client(timeout=650, trust_env=False, follow_redirects=False) as client:
            for work in plan['work']:
                verify_prepared_inputs(plan)
                write(run / 'current.json', {**work, 'startedAt': stamp()})
                directory = run / 'attempts' / work['id']; directory.mkdir(parents=True, mode=0o700)
                engine = {'name': 'SYNTHETIC comparison ' + work['model'], 'provider': 'ollama', 'model': work['model']}
                request = client.build_request('POST', 'http://127.0.0.1:8000/v1/extract',
                          headers={'X-Processor-Key': os.environ['PROCESSOR_TOKEN']},
                          data={'document_id': work['documentId'], 'mode': work['mode'], 'engine': json.dumps(engine)},
                          files={'file': (Path(source['filename']).name, raw, 'message/rfc822')})
                request_bytes = request.read()
                (directory / 'request.multipart.bin').write_bytes(request_bytes)
                metadata = {**work, 'sourceSha256': source['sha256'], 'startedAt': stamp(),
                            'requestBytes': len(request_bytes), 'requestSha256': digest(request_bytes),
                            'contentType': request.headers['content-type']}
                started = time.monotonic()
                output = None
                try:
                    response = client.send(request)
                    if len(response.content) > 2 * 1024 * 1024:
                        raise ValueError('Processor response exceeds its declared bound.')
                    (directory / 'response.json').write_bytes(response.content)
                    metadata.update({'httpStatus': response.status_code, 'responseSha256': digest(response.content),
                                     'responseBytes': len(response.content)})
                    if response.status_code == 200:
                        output = response.json()
                        if (any(output.get(key) != work[key] for key in ['documentId', 'mode']) or
                                output.get('execution') != 'local' or output.get('model') not in (None, work['model'])):
                            raise ValueError('Processor response identity differs from the selected source/model.')
                        if output.get('model') is None:
                            records = [json.loads(path.read_text()) for path in
                                       (run / 'model-attempts' / work['id']).glob('*/attempt.json')]
                            if score.calls(output) != 0 or any(row.get('path') == '/api/chat' for row in records):
                                raise ValueError('Model-free output lacks zero-call accounting.')
                    metadata['status'] = 'completed' if output else 'failed'
                except (httpx.HTTPError, ValueError) as exc:
                    metadata.update({'status': 'failed', 'errorType': type(exc).__name__})
                    output = None
                metadata.update({'finishedAt': stamp(), 'wallSeconds': time.monotonic() - started})
                write(directory / 'attempt.json', metadata)
                result = {**metadata, 'output': output, 'score': score.score_case(case, output, pages),
                          'toolActivity': score.tool_activity(output)}
                results.append(result)
                write(run / 'results.json', results)
                print(json.dumps({**work, 'status': result['status'], 'exact': result['score']['supportedExactMatches'],
                                  'expected': result['score']['goldFactCount'], 'unsupported': len(result['score']['unsupportedFacts']),
                                  'seconds': result['wallSeconds']}), flush=True)
        verify_prepared_inputs(plan)
        frozen_source(source_id)
        execution['completed'] = True
    finally:
        try:
            verify_prepared_inputs(plan)
            decoded_unchanged = True
        except (ValueError, KeyError, OSError):
            decoded_unchanged = False
            execution['completed'] = False
        execution.update({'finishedAt': stamp(), 'processorUnchanged': fingerprint() == pinned,
                          'decodedEvidenceUnchanged': decoded_unchanged,
                          'finishedJobs': len(results)})
        write(run / 'execution.json', execution)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'run'])
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--decoded', type=Path)
    parser.add_argument('--source-id', default='alder-house-02')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    run = args.run.resolve()
    if run == APP or run.is_relative_to(APP):
        parser.error('Preflight outputs must be outside the application repository.')
    if args.command == 'prepare':
        if args.decoded is None:
            parser.error('Prepare requires --decoded')
        prepare(run, args.decoded.resolve(), args.source_id)
    elif not args.execute:
        parser.error('Actual inference requires --execute')
    else:
        execute(run)


if __name__ == '__main__':
    main()
