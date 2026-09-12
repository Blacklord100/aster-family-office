#!/usr/bin/env python3
"""Bounded actual Linux text+vision smoke. Does not qualify production extraction."""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:11439')
    parser.add_argument('--model-lock', type=Path, default=Path(__file__).resolve().parents[1] / 'model/model-lock.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.base_url.startswith('http://127.0.0.1:'):
        raise ValueError('Smoke may access only its disposable loopback model service')
    lock = json.loads(args.model_lock.read_text())
    tags = request(args.base_url, '/api/tags')
    matching = [m for m in tags['models'] if m['name'] == lock['name'] and m['digest'].removeprefix('sha256:') == lock['digest'][7:]]
    if len(matching) != 1:
        raise ValueError('Loaded Linux model is not the approved complete artifact')
    checks = []
    for name, prompt, images in [('text', 'Reply with exactly the word SYNTHETIC.', None),
                                  ('vision', 'What is the main color of this square? Reply with one word.', [base64.b64encode(square_png()).decode()])]:
        body = {'model': lock['name'], 'prompt': prompt, 'stream': False, 'think': False, 'keep_alive': 0,
                'options': {'temperature': 0, 'num_ctx': 512, 'num_predict': 16}}
        if images:
            body['images'] = images
        started = time.monotonic()
        result = request(args.base_url, '/api/generate', body)
        answer = result.get('response', '').strip()
        if not result.get('done') or not answer:
            raise ValueError('Model did not finish its bounded smoke request')
        expected = 'synthetic' if name == 'text' else 'red'
        if expected not in answer.lower():
            raise ValueError(f'Known synthetic {name} smoke answer was incorrect: {answer[:120]}')
        checks.append({'check': name, 'passed': True, 'elapsedSeconds': round(time.monotonic() - started, 3),
                       'output': answer, 'evalCount': result.get('eval_count'), 'numCtx': 512})
    receipt = {'schemaVersion': 1, 'scope': 'bounded Linux CPU text+vision startup only; no extraction accuracy, throughput or full-context qualification',
               'model': lock['name'], 'digest': lock['digest'], 'totalBytes': lock['totalBytes'],
               'checks': checks, 'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    args.output.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
