#!/usr/bin/env python3
"""Retain bounded diagnostics for the single named synthetic model container."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    receipt = {'schemaVersion': 1, 'container': 'aster-bounded-model',
               'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    docker = ['docker', '--host', 'unix:///var/run/docker.sock']
    docker_env = {key: value for key, value in os.environ.items() if not key.startswith('DOCKER_')}
    try:
        result = subprocess.run([*docker, 'inspect', 'aster-bounded-model'], text=True,
                                capture_output=True, timeout=20, env=docker_env)
        if result.returncode:
            raise ValueError(result.stderr.strip()[:1000] or 'Container is absent')
        container = json.loads(result.stdout)[0]
        environment = dict(value.split('=', 1) for value in container['Config'].get('Env', []) if '=' in value)
        receipt.update({'result': 'captured', 'id': container['Id'], 'imageId': container['Image'], 'state': container['State'],
            'user': container['Config'].get('User'), 'home': environment.get('HOME'),
            'modelPath': environment.get('OLLAMA_MODELS'), 'modelMemoryBytes': container['HostConfig']['Memory'],
            'modelMemorySwapBytes': container['HostConfig']['MemorySwap'],
            'readonlyRootfs': container['HostConfig']['ReadonlyRootfs'], 'networkMode': container['HostConfig']['NetworkMode']})
    except Exception as error:
        receipt.update({'result': 'container-unavailable', 'error': str(error)[:1000]})
    try:
        logs = subprocess.run([*docker, 'logs', '--timestamps', '--tail', '300', 'aster-bounded-model'],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20, env=docker_env)
        (args.output / 'container.log').write_bytes(logs.stdout[-1024**2:])
        receipt['logsExitCode'] = logs.returncode
    except Exception as error:
        receipt['logsError'] = str(error)[:1000]
    (args.output / 'container-state.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
