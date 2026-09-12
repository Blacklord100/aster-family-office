#!/usr/bin/env python3
"""Bounded actual Linux text+vision smoke. Does not qualify production extraction."""
import argparse
import base64
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import struct
import subprocess
import time
import urllib.request
import urllib.parse
import zlib


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise ValueError('The disposable model endpoint must not redirect requests')


def request(base, path, body=None, timeout=600):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, headers={'Content-Type': 'application/json'})
    # Never send synthetic prompts or image bytes through inherited host proxies.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), RefuseRedirects())
    with opener.open(request, timeout=timeout) as response:
        return json.load(response)


INTERNAL_CONTAINER = 'aster-bounded-model'


def internal_endpoint(container, network):
    """Admit only the fixed synthetic service on its sole internal local bridge.

    Docker documents direct host access for an internal bridge's container IP:
    https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal
    This is a Linux-host smoke client, not a Docker Desktop networking contract.
    """
    if container.get('Name') != '/' + INTERNAL_CONTAINER or not container.get('State', {}).get('Running'):
        raise ValueError('Bounded model exited or is not the expected disposable container')
    networks = container.get('NetworkSettings', {}).get('Networks', {})
    if set(networks) != {INTERNAL_CONTAINER}:
        raise ValueError('Bounded model must have only its internal network')
    if (network.get('Name') != INTERNAL_CONTAINER or network.get('Internal') is not True
            or network.get('Driver') != 'bridge' or network.get('Scope') != 'local'):
        raise ValueError('Bounded model network must be an internal local bridge')
    endpoint = networks[INTERNAL_CONTAINER]
    if endpoint.get('NetworkID') != network.get('Id') or not network.get('Id'):
        raise ValueError('Container network identity differs from inspected bridge')
    if container.get('HostConfig', {}).get('PortBindings'):
        raise ValueError('Internal model smoke must not publish host ports')
    address = ipaddress.IPv4Address(endpoint.get('IPAddress', ''))
    private_ranges = [ipaddress.IPv4Network(x) for x in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    subnets = [ipaddress.ip_network(x['Subnet']) for x in network.get('IPAM', {}).get('Config', []) if 'Subnet' in x]
    if not any(address in subnet for subnet in private_ranges) or not any(
            subnet.version == 4 and address in subnet and address not in (subnet.network_address, subnet.broadcast_address)
            for subnet in subnets):
        raise ValueError('Bounded model IP is outside its private bridge subnet')
    peer = network.get('Containers', {}).get(container.get('Id'), {})
    if peer.get('Name') != INTERNAL_CONTAINER or ipaddress.ip_interface(peer.get('IPv4Address', '')).ip != address:
        raise ValueError('Bridge does not identify the same disposable container IP')
    return {'baseURL': f'http://{address}:11434', 'containerId': container['Id'],
            'imageId': container['Image'], 'startedAt': container['State'].get('StartedAt'),
            'networkId': network['Id'], 'networkName': INTERNAL_CONTAINER, 'internal': True,
            'clientRoute': 'Linux host to directly inspected internal bridge IP', 'publishedPorts': False}


def inspect_internal_endpoint():
    def inspect(arguments):
        result = subprocess.run(['docker', '--host', 'unix:///var/run/docker.sock', *arguments, INTERNAL_CONTAINER],
                                check=True, capture_output=True, text=True, timeout=10,
                                env={key: value for key, value in os.environ.items() if not key.startswith('DOCKER_')})
        values = json.loads(result.stdout)
        if len(values) != 1:
            raise ValueError('Expected exactly one disposable Docker object')
        return values[0]
    return internal_endpoint(inspect(['inspect']), inspect(['network', 'inspect']))


def await_internal_model(output):
    """Retain connectivity failures separately from actual inference evidence."""
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError('Never overwrite another connectivity receipt')
    receipt = {'schemaVersion': 1, 'result': 'running', 'attempts': 0,
               'scope': 'internal bridge startup connectivity only'}
    started, endpoint = time.monotonic(), None
    try:
        while time.monotonic() - started < 60:
            current = inspect_internal_endpoint()
            if endpoint is not None and current != endpoint:
                raise ValueError('Disposable model identity changed during readiness')
            endpoint = current
            receipt.update(current)
            receipt['attempts'] += 1
            atomic_receipt(output, receipt)
            try:
                version = request(endpoint['baseURL'], '/api/version', timeout=2)
            except (OSError, ValueError) as error:
                receipt['lastRequestError'] = str(error)[:600]
                time.sleep(min(2, max(0, 60 - (time.monotonic() - started))))
                continue
            if inspect_internal_endpoint() != endpoint:
                raise ValueError('Disposable model identity changed after readiness')
            receipt.update({'result': 'ready', 'version': version})
            return endpoint
        raise ValueError('Bounded model did not become ready during the startup readiness window')
    except BaseException as error:
        receipt.update({'result': 'failed', 'error': str(error)[:600]})
        raise
    finally:
        receipt.update({'elapsedSeconds': round(time.monotonic() - started, 3),
                        'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()})
        atomic_receipt(output, receipt)


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


def validate_loopback(base_url):
    parts = urllib.parse.urlsplit(base_url)
    if (parts.scheme != 'http' or parts.hostname != '127.0.0.1' or parts.username is not None
            or parts.password is not None or parts.port is None or not 1 <= parts.port <= 65535
            or parts.path or parts.query or parts.fragment):
        raise ValueError('Smoke may access only its disposable loopback model service')
    return base_url


def qualify(base_url, lock, output, expected_endpoint=None):
    if output.exists():
        raise ValueError('Never overwrite another model qualification receipt')
    output.parent.mkdir(parents=True, exist_ok=True)
    receipt = {'schemaVersion': 1, 'result': 'running',
               'scope': 'bounded Linux CPU text+vision startup only; no extraction accuracy, throughput or full-context qualification',
               'host': {'system': platform.system(), 'machine': platform.machine()},
               'model': lock['name'], 'digest': lock['digest'], 'totalBytes': lock['totalBytes'],
               'checks': [], 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if expected_endpoint:
        receipt['connection'] = expected_endpoint

    def check_identity():
        if expected_endpoint and (base_url != expected_endpoint['baseURL']
                                  or inspect_internal_endpoint() != expected_endpoint):
            raise ValueError('Disposable model or internal network identity changed during inference')

    def checked_request(path, body=None):
        check_identity()
        result = request(base_url, path, body)
        check_identity()
        return result

    started, active = time.monotonic(), None
    try:
        active = {'check': 'model-identity', 'result': 'running'}
        receipt['checks'].append(active)
        atomic_receipt(output, receipt)
        tags = checked_request('/api/tags')
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
            # Ollama may enforce a larger minimum internally; this is the request,
            # while retained runner logs provide the observed runtime context.
            active = {'check': name, 'result': 'running', 'requestedNumCtx': 512}
            receipt['checks'].append(active)
            atomic_receipt(output, receipt)
            result = checked_request('/api/generate', body)
            answer = result.get('response', '').strip()
            active.update({'output': answer[:240], 'evalCount': result.get('eval_count')})
            if not result.get('done') or not answer:
                raise ValueError('Model did not finish its bounded smoke request')
            expected = 'synthetic' if name == 'text' else 'red'
            if expected not in answer.lower():
                raise ValueError(f'Known synthetic {name} smoke answer was incorrect')
            active.update({'result': 'passed', 'passed': True, 'elapsedSeconds': round(time.monotonic() - started, 3)})
            atomic_receipt(output, receipt)
        check_identity()
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
    endpoint = parser.add_mutually_exclusive_group()
    endpoint.add_argument('--base-url', default='http://127.0.0.1:11439')
    endpoint.add_argument('--internal-container', action='store_true',
                          help='Inspect the fixed disposable model on its internal Linux bridge; no published port')
    parser.add_argument('--model-lock', type=Path, default=Path(__file__).resolve().parents[1] / 'model/model-lock.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    approved_endpoint = None
    if args.internal_container:
        if platform.system() != 'Linux':
            raise ValueError('Direct internal bridge smoke requires its Linux Docker host')
        approved_endpoint = await_internal_model(args.output.with_name('connectivity.json'))
        args.base_url = approved_endpoint['baseURL']
    else:
        validate_loopback(args.base_url)
    lock = json.loads(args.model_lock.read_text())
    qualify(args.base_url, lock, args.output, expected_endpoint=approved_endpoint)


if __name__ == '__main__':
    main()
