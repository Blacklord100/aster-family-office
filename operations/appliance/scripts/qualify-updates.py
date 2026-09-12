#!/usr/bin/env python3
"""Real SIGKILL/recovery drills on the explicitly owned disposable Linux appliance.

No fault receipt exists until its action is observed. A prepared script is not a
qualification result. Test releases reuse the exact image/model payload with new
signed release IDs/sequences; these are not publisher release candidates.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import stat
import subprocess
import time


def read_json(path):
    return json.loads(path.read_text())


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(command, *, timeout=3600, check=True):
    result = subprocess.run([str(x) for x in command], text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'{Path(str(command[0])).name} {command[1]} failed ({result.returncode}): {result.stderr[-1200:]}')
    return result


def interrupt_at_phase(command, journal, candidate_id, phase, log, timeout=2700):
    """Stop/recheck/kill only our newly spawned process group at an observed phase."""
    started = time.monotonic()
    observed = None
    with log.open('x') as stream:
        process = subprocess.Popen([str(x) for x in command], stdout=stream, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            while time.monotonic() - started < timeout:
                if process.poll() is not None:
                    raise RuntimeError(f'Update exited before observing {phase}; inspect {log.name}')
                try:
                    state = read_json(journal)
                except (OSError, json.JSONDecodeError):
                    state = {}
                if (state.get('candidate') or {}).get('releaseId') == candidate_id and state.get('phase') == phase:
                    # Freeze before re-reading: do not label a later boundary as
                    # the requested fault if the parent advanced during polling.
                    os.killpg(process.pid, signal.SIGSTOP)
                    confirmed = read_json(journal)
                    if confirmed.get('phase') != phase or (confirmed.get('candidate') or {}).get('releaseId') != candidate_id:
                        raise RuntimeError('Journal advanced before the requested interruption was frozen')
                    observed = confirmed
                    os.killpg(process.pid, signal.SIGKILL)
                    code = process.wait(timeout=20)
                    if code != -signal.SIGKILL:
                        raise RuntimeError('Expected actual SIGKILL termination')
                    return {'phase': phase, 'candidateReleaseId': candidate_id, 'signal': 'SIGKILL',
                            'journalPhaseObserved': observed['phase'], 'processExit': code,
                            'elapsedSeconds': round(time.monotonic() - started, 3)}
                time.sleep(0.01)
            raise RuntimeError(f'Timed out waiting for durable phase {phase}')
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=20)


def compose(root, *arguments):
    state = read_json(root / 'installation.json')
    return run(['docker', 'compose', '--project-name', state['project'], '--env-file',
                root / 'config' / (state['releaseId'] + '.env'), '--file',
                root / 'releases' / state['releaseId'] / 'payload/config/compose.offline.yaml', *arguments])


def expect_refusal(command, label, required_error=None):
    result = run(command, timeout=900, check=False)
    if result.returncode == 0:
        raise RuntimeError(f'{label} unexpectedly succeeded')
    if required_error and required_error.lower() not in result.stderr.lower():
        raise RuntimeError(f'{label} failed for another reason: {result.stderr[-800:]}')
    return {'check': label, 'refused': True, 'exitCode': result.returncode,
            'error': result.stderr.strip()[-600:]}


def negative_checks(base, cli, bundle, trust, trust_sha):
    results = []
    wrong = base / 'private/wrong-test-root'
    run([cli, 'init-trust', '--keys', wrong])
    results.append(expect_refusal([cli, 'verify', '--bundle', bundle,
        '--trust-root', wrong / 'root.json', '--trust-root-sha256', (wrong / 'root.sha256').read_text().strip()], 'wrong publisher root'))
    manifest_file = bundle / 'release.json'
    original = manifest_file.read_bytes()
    try:
        tampered = json.loads(original)
        tampered['productVersion'] += '-unsigned-tampering'
        manifest_file.write_text(json.dumps(tampered))
        results.append(expect_refusal([cli, 'verify', '--bundle', bundle,
            '--trust-root', trust, '--trust-root-sha256', trust_sha], 'signed manifest tampering'))
    finally:
        manifest_file.write_bytes(original)
    payload_file = bundle / 'payload/config/headers.caddy'
    original = payload_file.read_bytes()
    try:
        payload_file.write_bytes(original + b'\n# UNSIGNED SYNTHETIC TAMPERING\n')
        results.append(expect_refusal([cli, 'verify', '--bundle', bundle,
            '--trust-root', trust, '--trust-root-sha256', trust_sha], 'payload tampering'))
    finally:
        payload_file.write_bytes(original)
    # A new 16MiB tmpfs gives a real bounded insufficient-space filesystem. Do not
    # fill the host disk or interfere with any existing filesystem/service.
    mount = base / 'private/tiny-capacity'
    mount.mkdir()
    run(['mount', '-t', 'tmpfs', '-o', 'size=16m,nosuid,nodev,noexec', 'aster-qualification-tiny', mount], timeout=30)
    try:
        recipient = next(line.removeprefix('# public recipient: ') for line in (base / 'private/recovery.agekey').read_text().splitlines()
                         if line.startswith('# public recipient: '))
        results.append(expect_refusal([cli, 'install', '--root', mount / 'appliance', '--bundle', bundle,
            '--trust-root', trust, '--trust-root-sha256', trust_sha,
            '--hostname', 'aster-space-test.example.invalid', '--profile', 'offline', '--tls-mode', 'internal',
            '--recovery-recipient', recipient], 'insufficient disk before runtime mutation', 'insufficient disk'))
        if (mount / 'appliance/installation.json').exists():
            raise RuntimeError('Insufficient-space admission must not create an installation')
    finally:
        run(['umount', mount], timeout=30)
        mount.rmdir()
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, type=Path)
    args = parser.parse_args()
    base = args.base.resolve()
    runner = Path(os.environ.get('RUNNER_TEMP', '/nonexistent-runner-root')).resolve()
    if os.environ.get('ASTER_DISPOSABLE_RUNNER') != '1' or platform.system() != 'Linux' or platform.machine() != 'x86_64' or os.geteuid() != 0:
        raise ValueError('Only the explicitly owned disposable Linux amd64 runner may run this drill')
    if not base.is_relative_to(runner) or base == runner or base.is_symlink():
        raise ValueError('Qualification base must be a new child of the owned runner temp directory')
    cli, bundle, root = base / 'asterctl', base / 'bundle', base / 'restored'
    node = Path(os.environ.get('ASTER_QUALIFICATION_NODE', ''))
    if not node.is_absolute() or node.is_symlink() or not stat.S_ISREG(node.stat().st_mode) or not os.access(node, os.X_OK):
        raise ValueError('Qualification requires the exact setup-node regular executable')
    private_state = base / 'private/api-state.json'
    auth = read_json(private_state)
    if auth.get('email') != 'owner-appliance@example.invalid' or not auth.get('financial', {}).get('holdingId') or not auth.get('sessionCookies'):
        raise ValueError('The completed nonzero SYNTHETIC qualification state is required')
    current = read_json(root / 'installation.json')
    if current['hostname'] != 'aster-qualification.example.invalid' or current['profile'] != 'offline':
        raise ValueError('Refusing another deployment')
    trust = base / 'test-signing-keys/root.json'
    trust_sha = (base / 'test-signing-keys/root.sha256').read_text().strip()
    if file_hash(trust) != trust_sha or current['rootSha256'] != trust_sha:
        raise ValueError('Only this run\'s independently held ephemeral test trust is allowed')
    manifest = read_json(bundle / 'release.json')
    if manifest['channel'] != 'preview':
        raise ValueError('Never rewrite stable release metadata for a synthetic drill')
    receipt_file = base / 'proof/update-interruption.json'
    if receipt_file.exists():
        raise ValueError('Refusing to overwrite an earlier qualification receipt')
    receipt = {'schemaVersion': 1, 'result': 'running', 'executed': True,
               'scope': 'Actual same-host SIGKILL of the update controller/process group; daemon/host power failure not simulated',
               'checks': [], 'interruptions': []}
    candidate = base / 'private/update-candidate'
    candidate.mkdir()
    original_payload = bundle / 'payload'
    moved = False
    try:
        run([node, Path(__file__).with_name('qualify-api.mjs'), 'updated', root, private_state, base / 'proof/update-baseline.json'])
        receipt['checks'] += negative_checks(base, cli, bundle, trust, trust_sha)
        # Move this builder's immutable payload temporarily; installed/retained
        # copies are independent. No hard links, sparse placeholders or model copies.
        original_payload.rename(candidate / 'payload')
        moved = True
        for index, phase in enumerate(['old-fleet-stopped', 'candidate-starting'], start=1):
            before = read_json(root / 'installation.json')
            new = dict(manifest)
            new['releaseId'] = f'{manifest["releaseId"]}-fault{index}'
            new['sequence'] = before['sequence'] + 1
            new['createdAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
            (candidate / 'release.json').write_text(json.dumps(new, sort_keys=True, indent=2) + '\n')
            expiry = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
            run([cli, 'sign', '--bundle', candidate, '--keys', base / 'test-signing-keys', '--sequence', str(new['sequence']), '--expires', expiry])
            backup = base / 'private' / f'update-{index}.age'
            event = interrupt_at_phase([cli, 'update', '--root', root, '--bundle', candidate, '--output', backup, '--timeout', '60m'],
                root / 'journal.json', new['releaseId'], phase, base / 'proof' / f'update-{index}.log')
            # Start only PostgreSQL in this installation's own project to inspect
            # the sealed state after old-fleet-stopped. This is not writer admission.
            compose(root, 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres')
            status = json.loads(run([cli, 'status', '--root', root]).stdout)
            if not status.get('databaseAvailable') or status['database']['mode'] != 'maintenance':
                raise RuntimeError('Interrupted candidate did not retain the database maintenance barrier')
            expected_release = before['releaseId'] if phase == 'old-fleet-stopped' else new['releaseId']
            if status['database']['activeRelease'] != expected_release:
                raise RuntimeError('Database activation did not match the observed interruption boundary')
            if status['database']['activeOperations'] or status['database']['activeLeases']['total']:
                raise RuntimeError('A sealed interrupted release still admits active operations or worker leases')
            event['sealedDatabase'] = status['database']
            run([node, Path(__file__).with_name('qualify-api.mjs'), 'maintenance', root, private_state,
                 base / 'proof' / f'update-{index}-maintenance.json'])
            run([cli, 'continue-update', '--root', root, '--timeout', '60m'])
            after = json.loads(run([cli, 'status', '--root', root]).stdout)
            if after['operation']['phase'] != 'complete' or after['database']['mode'] != 'open' or after['database']['activeRelease'] != new['releaseId']:
                raise RuntimeError('continue-update did not reconcile the exact candidate and reopen one writer generation')
            if after['installation']['sequence'] != new['sequence'] or after['database']['generation'] <= before['generation']:
                raise RuntimeError('Release sequence/writer generation did not advance monotonically')
            run([node, Path(__file__).with_name('qualify-api.mjs'), 'updated', root, private_state,
                 base / 'proof' / f'update-{index}-accepted-state.json'])
            event.update({'continued': True, 'activeRelease': after['database']['activeRelease'],
                          'generation': after['database']['generation'], 'acceptedStateAndArchiveUnchanged': True,
                          'existingMfaSessionRetainedScope': True})
            receipt['interruptions'].append(event)
            receipt_file.write_text(json.dumps(receipt, indent=2) + '\n')
        receipt['result'] = 'passed-bounded-update-interruption-drill'
        receipt['notYetQualified'] = ['Physical host/daemon power loss', 'Interruption within an incompatible schema migration',
                                      'Every possible update phase and independent-host recovery', 'RPO/RTO and sustained workload']
    except BaseException as error:
        receipt['result'] = 'failed'
        receipt['error'] = str(error)
        raise
    finally:
        if moved:
            (candidate / 'payload').rename(original_payload)
        receipt['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        receipt_file.write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'result': receipt['result'], 'observedInterruptions': len(receipt['interruptions']),
                      'negativeChecks': len(receipt['checks'])}))


if __name__ == '__main__':
    main()
