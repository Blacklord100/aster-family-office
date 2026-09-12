#!/usr/bin/env python3
"""Bounded actual Linux text+vision smoke. Does not qualify production extraction."""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import struct
import time
import urllib.request
import zlib


def request(base, path, body=None, timeout=600):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def square_png():
    def chunk(kind, body):
        return struct.pack('!I', len(body)) + kind + body + struct.pack('!I', zlib.crc32(kind + body) & 0xffffffff)
    rows = b''.join(b'\0' + b'\xff\0\0' * 64 for _ in range(64))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 64, 64, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def atomic_receipt(path, receipt):
    temporary = path.with_name(path.name + '.partial')
    with temporary.open('x') as stream:
        json.dump(receipt, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def qualify(base_url, lock, output):
    if output.exists():
        raise ValueError('Never overwrite another model qualification receipt')
    output.parent.mkdir(parents=True, exist_ok=True)
    receipt = {'schemaVersion': 1, 'result': 'running',
               'scope': 'bounded Linux CPU text+vision startup only; no extraction accuracy, throughput or full-context qualification',
               'host': {'system': platform.system(), 'machine': platform.machine()},
               'model': lock['name'], 'digest': lock['digest'], 'totalBytes': lock['totalBytes'],
               'checks': [], 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    started, active = time.monotonic(), None
    try:
        active = {'check': 'model-identity', 'result': 'running'}
        receipt['checks'].append(active)
        atomic_receipt(output, receipt)
        tags = request(base_url, '/api/tags')
        matching = [m for m in tags['models'] if m['name'] == lock['name'] and m['digest'].removeprefix('sha256:') == lock['digest'][7:]]
        if len(matching) != 1:
            raise ValueError('Loaded Linux model is not the approved complete artifact')
        active.update({'result': 'passed', 'elapsedSeconds': round(time.monotonic() - started, 3)})
        atomic_receipt(output, receipt)
        for name, prompt, images in [('text', 'Reply with exactly the word SYNTHETIC.', None),
                                      ('vision', 'What is the main color of this square? Reply with one word.', [base64.b64encode(square_png()).decode()])]:
            body = {'model': lock['name'], 'prompt': prompt, 'stream': False, 'think': False, 'keep_alive': 0,
                    'options': {'temperature': 0, 'num_ctx': 512, 'num_predict': 16}}
            if images:
                body['images'] = images
            started = time.monotonic()
            active = {'check': name, 'result': 'running', 'numCtx': 512}
            receipt['checks'].append(active)
            atomic_receipt(output, receipt)
            result = request(base_url, '/api/generate', body)
            answer = result.get('response', '').strip()
            active.update({'output': answer[:240], 'evalCount': result.get('eval_count')})
            if not result.get('done') or not answer:
                raise ValueError('Model did not finish its bounded smoke request')
            expected = 'synthetic' if name == 'text' else 'red'
            if expected not in answer.lower():
                raise ValueError(f'Known synthetic {name} smoke answer was incorrect')
            active.update({'result': 'passed', 'passed': True, 'elapsedSeconds': round(time.monotonic() - started, 3)})
            atomic_receipt(output, receipt)
        receipt['result'] = 'passed-bounded-model-smoke'
    except BaseException as error:
        receipt['result'], receipt['error'] = 'failed', str(error)[:600]
        if active and active['result'] == 'running':
            active.update({'result': 'failed', 'passed': False, 'error': str(error)[:600],
                           'elapsedSeconds': round(time.monotonic() - started, 3)})
        raise
    finally:
        receipt['checkedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        atomic_receipt(output, receipt)
        print(json.dumps(receipt))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:11439')
    parser.add_argument('--model-lock', type=Path, default=Path(__file__).resolve().parents[1] / 'model/model-lock.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.base_url.startswith('http://127.0.0.1:'):
        raise ValueError('Smoke may access only its disposable loopback model service')
    lock = json.loads(args.model_lock.read_text())
    qualify(args.base_url, lock, args.output)


if __name__ == '__main__':
    main()
