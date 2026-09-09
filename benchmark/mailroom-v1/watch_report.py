"""Observe preserved benchmark files; never call a database, service or model.

Scoring and rendering run sequentially against a snapshot in a staging folder.
Only a fully successful generation replaces the last good HTML/CSV/scorecard.
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent
MAX_JSON_BYTES = 64 * 1024 * 1024
FINAL_STATES = {'completed', 'failed'}


def stamp():
    return datetime.now(timezone.utc).isoformat()


def atomic_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.partial')
    try:
        with temporary.open('xb') as stream:
            os.chmod(temporary, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json(path, value):
    atomic_bytes(path, (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode())


def bounded_bytes(path):
    with path.open('rb') as stream:
        content = stream.read(MAX_JSON_BYTES + 1)
    if len(content) > MAX_JSON_BYTES:
        raise ValueError('Observer file exceeds 64 MiB bound: ' + path.name)
    return content


class ExclusiveLock:
    """No automatic stale-lock deletion: PID reuse cannot steal an active lock."""
    def __init__(self, path):
        self.path = path
        self.token = uuid.uuid4().hex
        self.inode = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raise RuntimeError('An observer lock already exists at ' + str(self.path) + '. Inspect its PID before manually removing a stale lock.') from None
        self.inode = os.fstat(descriptor).st_ino
        with os.fdopen(descriptor, 'w') as stream:
            json.dump({'pid': os.getpid(), 'host': socket.gethostname(), 'startedAt': stamp(), 'token': self.token}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        return self

    def __exit__(self, *ignored):
        try:
            if self.path.stat().st_ino == self.inode and json.loads(self.path.read_text()).get('token') == self.token:
                self.path.unlink()
        except (FileNotFoundError, ValueError):
            pass


def completed_diagnostics(scorecard, expected_count=388):
    rows = scorecard['uniqueSourceRows']
    grouped = {}
    for row in rows:
        grouped.setdefault(row['cell'], []).append(row)
    cells = []
    for cell, planned in sorted(grouped.items()):
        finished = [row for row in planned if row['final']['status'] in FINAL_STATES]
        usable = [row for row in finished if row['final']['status'] == 'completed']
        scores = [row['final']['score'] for row in finished]
        expected = sum(score['goldFactCount'] for score in scores)
        full_expected = sum(row['final']['score']['goldFactCount'] for row in planned)
        exact = sum(score['supportedExactMatches'] for score in scores)
        returned = sum(score['returnedFactCount'] for score in scores)
        cells.append({'cell': cell, 'model': planned[0]['model'], 'mode': planned[0]['mode'], 'partial': len(finished) != len(planned), 'finishedUniqueJobs': len(finished), 'plannedUniqueJobs': len(planned), 'usableResults': len(usable), 'failedJobs': len(finished) - len(usable), 'finishedGoldFacts': expected, 'fullPlanGoldFacts': full_expected, 'pendingGoldFacts': full_expected - expected, 'exactFactsOnFinishedJobs': exact, 'unsupportedFactsOnFinishedJobs': returned - exact, 'recallOnFinishedJobsOnly': exact / expected if expected else None, 'precisionOnFinishedJobsOnly': exact / returned if returned else None, 'fullPlanRecallLowerBound': exact / full_expected if full_expected else None})
    finished_count = sum(cell['finishedUniqueJobs'] for cell in cells)
    return {'label': 'Partial diagnostic: finished jobs only, including failures; not a final model ranking.', 'plannedUniqueJobs': len(rows), 'finishedUniqueJobs': finished_count, 'plannedReceiptEvaluations': len(scorecard.get('rows', [])), 'allExpectedJobsFinal': len(rows) == expected_count and finished_count == expected_count, 'cells': cells}


def run_tool(command, timeout):
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    captured = bytearray()
    def drain():
        for chunk in iter(lambda: process.stderr.read(4096), b''):
            room = max(0, 8000 - len(captured))
            captured.extend(chunk[:room])
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
        raise
    finally:
        reader.join(timeout=2)
        process.stderr.close()
    return code, captured.decode('utf8', errors='replace')


def generation(run, decoded, corpus, results_bytes, timeout):
    with tempfile.TemporaryDirectory(prefix='.observer-stage-', dir=run) as temporary:
        stage = Path(temporary)
        for name in ['state.json', 'collection.json']:
            atomic_bytes(stage / name, bounded_bytes(run / name))
        atomic_bytes(stage / 'results.json', results_bytes)
        # The scorer only reads attempts. Large immutable originals are not copied.
        (stage / 'attempts').symlink_to(run / 'attempts', target_is_directory=True)
        commands = [
            [sys.executable, str(ROOT / 'score.py'), '--run', str(stage), '--decoded', str(decoded), '--corpus', str(corpus)],
            [sys.executable, str(ROOT / 'render_report.py'), '--run', str(stage), '--corpus', str(corpus)],
        ]
        tools = []
        for command in commands:
            started = time.monotonic()
            code, error = run_tool(command, timeout)
            tools.append({'tool': Path(command[1]).name, 'exitCode': code, 'seconds': round(time.monotonic() - started, 3)})
            if code:
                raise RuntimeError(Path(command[1]).name + ' failed: ' + error[:8000])
        scorecard = json.loads(bounded_bytes(stage / 'scorecard.json'))
        diagnostics = completed_diagnostics(scorecard)
        names = ['scorecard.json', 'summary.json', 'report.html', 'email-results.csv']
        artifacts = {name: bounded_bytes(stage / name) for name in names}
        # Both commands and every artifact have succeeded before publication.
        # Each replacement is atomic. observer-status.json acts as the commit
        # marker for this generation and records the coherent artifact hashes.
        for name, content in artifacts.items():
            atomic_bytes(run / name, content)
        return diagnostics, {name: sha256(content).hexdigest() for name, content in artifacts.items()}, tools


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--decoded', required=True, type=Path)
    parser.add_argument('--corpus', type=Path, default=ROOT)
    parser.add_argument('--interval', type=float, default=15, help='Seconds between polls, 1–60; default 15.')
    parser.add_argument('--command-timeout', type=float, default=60, help='Per scoring/rendering command, 5–120 seconds.')
    parser.add_argument('--stop-file', type=Path, help='Default: RUN/observer.stop. The observer only reads this file.')
    parser.add_argument('--once', action='store_true', help='Make at most one generation, useful for verification.')
    args = parser.parse_args()
    if not 1 <= args.interval <= 60 or not 5 <= args.command_timeout <= 120:
        parser.error('Use interval 1–60 seconds and command timeout 5–120 seconds.')
    run = args.run.resolve()
    if not run.is_dir():
        parser.error('Run directory must already exist.')
    stop_file = args.stop_file.resolve() if args.stop_file else run / 'observer.stop'
    stopped = {'signal': None}
    def stop(number, frame):
        stopped['signal'] = signal.Signals(number).name
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    status_path = run / 'observer-status.json'
    events_path = run / 'observer-events.json'
    events = []
    last_good = None
    successful_hash = None
    previous_error = None
    started_at = stamp()
    def event(kind, **details):
        events.append({'at': stamp(), 'kind': kind, **details})
        del events[:-200]
        atomic_json(events_path, {'boundedMostRecentEvents': 200, 'events': events})
    with ExclusiveLock(run / 'observer.pid.lock'):
        event('started', pid=os.getpid(), pollSeconds=args.interval, mutations='Report artifacts and observer metadata only; no database, service or inference calls.')
        while True:
            reason = stopped['signal'] or ('stop_file' if stop_file.exists() else None)
            if reason:
                event('stopped', reason=reason)
                atomic_json(status_path, {'pid': os.getpid(), 'state': 'stopped', 'reason': reason, 'at': stamp(), 'startedAt': started_at, 'lastGoodGeneration': last_good})
                return
            try:
                results = bounded_bytes(run / 'results.json')
                digest = sha256(results).hexdigest()
                if digest != successful_hash:
                    diagnostics, hashes, tools = generation(run, args.decoded.resolve(), args.corpus.resolve(), results, args.command_timeout)
                    last_good = {'at': stamp(), 'resultsSha256': digest, 'artifactSha256': hashes, 'diagnostics': diagnostics, 'tools': tools}
                    successful_hash = digest
                    previous_error = None
                    event('published', resultsSha256=digest, finishedUniqueJobs=diagnostics['finishedUniqueJobs'], plannedUniqueJobs=diagnostics['plannedUniqueJobs'])
                complete = bool(last_good and last_good['diagnostics']['allExpectedJobsFinal'])
                atomic_json(status_path, {'pid': os.getpid(), 'state': 'complete' if complete else 'watching', 'at': stamp(), 'startedAt': started_at, 'pollSeconds': args.interval, 'lastGoodGeneration': last_good})
                if complete or args.once:
                    event('finished', reason='all_388_jobs_final' if complete else 'once')
                    return
            except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
                detail = {'type': type(error).__name__, 'message': str(error)[:8000]}
                if detail != previous_error:
                    event('generation_failed', error=detail, previousReportPreserved=True)
                    previous_error = detail
                atomic_json(status_path, {'pid': os.getpid(), 'state': 'error', 'at': stamp(), 'startedAt': started_at, 'error': detail, 'previousReportPreserved': True, 'lastGoodGeneration': last_good})
                if args.once:
                    raise SystemExit(1)
            deadline = time.monotonic() + args.interval
            while time.monotonic() < deadline and not stopped['signal'] and not stop_file.exists():
                time.sleep(min(0.25, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    main()
