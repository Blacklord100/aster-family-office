#!/usr/bin/env python3
"""Build/export all five appliance images from reviewed digest-pinned base inputs."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


def run(*args, capture=False):
    result = subprocess.run(args, check=True, text=True, capture_output=capture)
    return result.stdout if capture else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text())
    if lock['platform'] != 'linux/amd64':
        raise ValueError('Only the candidate linux/amd64 profile is built by this recipe')
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,80}', lock['releaseId']):
        raise ValueError('Invalid release ID')
    expected = {'node', 'nodeRuntime', 'processorBuild', 'processorRuntime', 'postgres', 'ollama', 'caddy'}
    if set(lock['bases']) != expected:
        raise ValueError('Missing or extra image base inputs')
    for reference in lock['bases'].values():
        if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', reference):
            raise ValueError('Every base image must be pinned by sha256 digest')
    if args.output.exists():
        raise ValueError('Refusing an existing output directory')
    args.output.mkdir(parents=True)
    bases = lock['bases']
    builds = {
        'app': ('operations/Dockerfile.app', args.source, {'NODE_IMAGE': bases['node'], 'NODE_RUNTIME_IMAGE': bases['nodeRuntime']}),
        'processor': ('Dockerfile', args.source / 'processor', {'PYTHON_IMAGE': bases['processorBuild'], 'PROCESSOR_RUNTIME_IMAGE': bases['processorRuntime']}),
        'ollama': ('Dockerfile.ollama', args.source / 'operations', {'OLLAMA_IMAGE': bases['ollama']}),
        'caddy': ('Dockerfile.caddy', args.source / 'operations', {'CADDY_IMAGE': bases['caddy']}),
    }
    images = []
    for service in ['app', 'processor', 'postgres', 'ollama', 'caddy']:
        reference = f'aster-{service}:{lock["releaseId"]}'
        if service == 'postgres':
            run('docker', 'pull', '--platform', lock['platform'], bases['postgres'])
            run('docker', 'tag', bases['postgres'], reference)
        else:
            dockerfile, context, build_args = builds[service]
            command = ['docker', 'build', '--platform', lock['platform'], '--pull',
                       '--file', str(context / dockerfile), '--tag', reference]
            for key, value in build_args.items():
                command += ['--build-arg', f'{key}={value}']
            run(*command, str(context))
            if service == 'processor':
                export_command = ['docker', 'build', '--platform', lock['platform'],
                                  '--file', str(context / dockerfile), '--target', 'source-evidence',
                                  '--output', 'type=local,dest=' + str((args.output / 'processor-sources').resolve())]
                for key, value in build_args.items():
                    export_command += ['--build-arg', f'{key}={value}']
                run(*export_command, str(context))
        info = json.loads(run('docker', 'image', 'inspect', reference, capture=True))[0]
        if info['Os'] != 'linux' or info['Architecture'] != 'amd64':
            raise ValueError('Built image architecture differs from release platform')
        tar = args.output / f'{service}.tar'
        run('docker', 'image', 'save', '--output', str(tar), reference)
        with tar.open('rb') as stream:
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        images.append({'service': service, 'path': tar.name, 'reference': reference,
                       'imageId': info['Id'], 'sha256': sha, 'size': tar.stat().st_size})
    (args.output / 'inventory.json').write_text(json.dumps({'version': 1, 'platform': lock['platform'],
        'releaseId': lock['releaseId'], 'bases': bases, 'images': images}, indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(f'Image build refused: {error}')
