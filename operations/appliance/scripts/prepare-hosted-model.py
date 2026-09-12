#!/usr/bin/env python3
"""Admit one bounded model smoke on a fresh GitHub-hosted Ubuntu runner.

Reclaim only unused preinstalled Android/.NET SDKs on this ephemeral hosted job.
Never prune Docker, alter services/network, or reduce the model export reserve.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

UNUSED_SDKS = (Path('/usr/local/lib/android'), Path('/usr/share/dotnet'))


def memory_budget(meminfo, model_bytes):
    values = {line.split(':', 1)[0]: int(line.split()[1]) * 1024 for line in meminfo.splitlines()
              if line.startswith(('MemTotal:', 'MemAvailable:'))}
    total, available = values['MemTotal'], values['MemAvailable']
    reserve = 2 * 1024**3
    # Leave room above the complete weights/projector bytes for a bounded context,
    # CPU runtime and vision preprocessing. A smaller host gets a clear refusal.
    minimum = ((model_bytes + reserve + 1024**3 - 1) // 1024**3) * 1024**3
    limit = min(12 * 1024**3, min(total, available) - reserve)
    return {'totalBytes': total, 'availableBytes': available, 'hostReserveBytes': reserve,
            'minimumModelMemoryBytes': minimum, 'modelMemoryBytes': max(0, limit),
            'adequate': limit >= minimum}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--model-lock', type=Path, default=Path('operations/appliance/model/model-lock.json'))
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise ValueError('Never overwrite host admission evidence')
    receipt = {'schemaVersion': 1, 'result': 'running', 'scope': 'Bounded GitHub-hosted model smoke only',
               'removedUnusedSDKs': [], 'reserveBytes': 10 * 1024**3}
    try:
        if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted'
                or platform.system() != 'Linux' or platform.machine() != 'x86_64'):
            raise ValueError('Only an ephemeral GitHub-hosted Linux amd64 job may reclaim these SDKs')
        if 'ID=ubuntu' not in Path('/etc/os-release').read_text().splitlines():
            raise ValueError('Only the declared Ubuntu hosted runner is supported')
        lock = json.loads(args.model_lock.read_text())
        # Model download + retained10GiB reserve +4GiB temporary image/build room.
        model_bytes = sum(item['size'] for item in lock['files'])
        receipt['memory'] = memory_budget(Path('/proc/meminfo').read_text(), model_bytes)
        receipt['cpuCount'] = os.cpu_count()
        if not receipt['memory']['adequate']:
            raise ValueError('Insufficient available RAM for the bounded text+vision smoke plus the2GiB host reserve')
        receipt['requiredFreeBytes'] = model_bytes + receipt['reserveBytes'] + 4 * 1024**3
        receipt['freeBytesBefore'] = shutil.disk_usage(args.output.parent).free
        for sdk in UNUSED_SDKS:
            if shutil.disk_usage(args.output.parent).free >= receipt['requiredFreeBytes']:
                break
            if sdk.is_symlink() or any(parent.is_symlink() for parent in sdk.parents):
                raise ValueError('Refusing a symlinked preinstalled SDK path')
            if sdk.exists():
                if not sdk.is_dir():
                    raise ValueError('Expected a preinstalled SDK directory')
                subprocess.run(['sudo', 'rm', '-rf', '--', str(sdk)], check=True, timeout=300)
                receipt['removedUnusedSDKs'].append(str(sdk))
        receipt['freeBytesAfter'] = shutil.disk_usage(args.output.parent).free
        if receipt['freeBytesAfter'] < receipt['requiredFreeBytes']:
            raise ValueError('Insufficient hosted disk even after bounded SDK cleanup; do not reduce the10GiB reserve')
        receipt['result'] = 'admitted-bounded-smoke'
    except BaseException as error:
        receipt['result'], receipt['error'] = 'refused', str(error)
        raise
    finally:
        receipt['checkedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        args.output.write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt))


if __name__ == '__main__':
    main()
