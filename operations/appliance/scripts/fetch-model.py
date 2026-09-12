#!/usr/bin/env python3
"""Connected release-builder download of the approved, exactly pinned model pack."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lock', type=Path, default=Path(__file__).resolve().parents[1] / 'model/model-lock.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text())
    if args.output.exists():
        raise ValueError('Refusing existing model destination')
    if shutil.disk_usage(args.output.parent.resolve()).free < lock['totalBytes'] + 10 * 1024**3:
        raise ValueError('Preserve at least10GiB free after model download')
    args.output.mkdir(parents=True)
    for item in lock['files']:
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Unsafe model path')
        target = args.output / 'ollama' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        source = item['source']
        if source['kind'] == 'bundled':
            shutil.copyfile(args.lock.parent / source['path'], target)
        elif source['kind'] == 'https':
            if not source['url'].startswith('https://huggingface.co/google/'):
                raise ValueError('Only the approved Google repository is allowed')
            with urllib.request.urlopen(source['url'], timeout=300) as response, target.open('xb') as output:
                if response.url.split(':', 1)[0] != 'https':
                    raise ValueError('Refusing a non-HTTPS model redirect')
                count = 0
                while chunk := response.read(4 * 1024 * 1024):
                    count += len(chunk)
                    if count > item['size']:
                        raise ValueError('Model response exceeds reviewed length')
                    output.write(chunk)
        else:
            raise ValueError('Unknown model asset source')
        with target.open('rb') as stream:
            sha = hashlib.file_digest(stream, 'sha256').hexdigest()
        if target.stat().st_size != item['size'] or sha != item['sha256']:
            raise ValueError('Downloaded model differs from approved bytes')
        os.chmod(target, 0o644)
    spec = importlib.util.spec_from_file_location('model_export', Path(__file__).with_name('export-model.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    inventory = module.inspect_model(args.output / 'ollama', lock['name'])
    if inventory['digest'] != lock['digest'] or inventory['totalBytes'] != lock['totalBytes']:
        raise ValueError('Native model manifest differs from pinned identity')
    inventory['upstream'] = lock['upstream']
    (args.output / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
    (args.output / 'Modelfile').write_text(f'# Native cache import; never ollama pull\nFROM {lock["name"]}\n')
    print(json.dumps({'name': lock['name'], 'digest': inventory['digest'], 'bytes': inventory['totalBytes']}))


if __name__ == '__main__':
    main()
