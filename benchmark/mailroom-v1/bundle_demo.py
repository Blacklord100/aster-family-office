"""Package the completed synthetic demonstration for offline inspection.

This is an evidence bundle, not an application installer. Only an explicit
allowlist of fictional sources, results and public documentation is included.
No environment file, database, credentials or raw processor requests are read.
"""
import argparse
import base64
from collections import Counter
import csv
from datetime import datetime
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent.parent


def archive_name(value):
    if not isinstance(value, str) or '\\' in value or ':' in value or any(ord(character) < 32 for character in value) or any(part in ['', '.', '..'] for part in value.split('/')):
        raise ValueError('Archive member names must be canonical relative paths.')
    return value


def read_regular(root, name):
    archive_name(name)
    root = root.resolve()
    path = root
    for part in name.split('/'):
        path = path / part
        if path.is_symlink():
            raise ValueError('A bundle input cannot be a symlink: ' + name)
    if not path.resolve().is_relative_to(root):
        raise ValueError('A bundle input escapes its allowed directory.')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024 * 1024:
            raise ValueError('Bundle inputs must be regular files no larger than 64 MiB.')
        value = stream.read(64 * 1024 * 1024 + 1)
        if len(value) > 64 * 1024 * 1024:
            raise ValueError('Bundle input grew beyond its size bound.')
        return value


def require_complete(score):
    unique, receipts = score['uniqueSourceRows'], score['rows']
    if len(unique) != 388 or len({row['jobId'] for row in unique}) != 388 or Counter(row['cell'] for row in unique) != {0: 97, 1: 97, 2: 97, 3: 97}:
        raise ValueError('The complete 388 distinct-job plan is required before packaging.')
    if any(row['final']['status'] not in ['completed', 'failed'] for row in unique):
        raise ValueError('The complete 388-job comparison is required before packaging; some outcomes are still partial.')
    if len(receipts) != 400 or len({(row['caseId'], row['cell']) for row in receipts}) != 400 or Counter(row['cell'] for row in receipts) != {0: 100, 1: 100, 2: 100, 3: 100}:
        raise ValueError('All 400 distinct receipt views are required before packaging.')
    jobs = {row['jobId']: row for row in unique}
    def comparable(outcome):
        return {**outcome, 'score': {key: value for key, value in outcome['score'].items() if key != 'caseId'}}
    if any(row['jobId'] not in jobs or row['cell'] != jobs[row['jobId']]['cell'] or row['model'] != jobs[row['jobId']]['model'] or row['mode'] != jobs[row['jobId']]['mode'] or comparable(row['final']) != comparable(jobs[row['jobId']]['final']) for row in receipts):
        raise ValueError('Receipt views do not match their canonical job outcomes.')
    cells = score['matrix']['uniqueSourcesStoredFinal']
    if len(cells) != 4 or {row['cell'] for row in cells} != {0, 1, 2, 3} or any(row['complete'] is not True or row['finished'] != 97 or row['planned'] != 97 for row in cells):
        raise ValueError('Complete aggregate cells do not match the detailed job plan.')


def verify_bindings(score, files, manifest):
    audit = json.loads(files['attempt-integrity.json'])
    if audit['status'] != 'passed' or audit['partial'] is not False or audit['finalUniqueJobs'] != 388 or audit['everyRecordedRequestMatchesFrozenOriginalAndPin'] is not True:
        raise ValueError('The complete request and response integrity audit must pass before packaging.')
    if audit['manifestSha256'] != score['manifestSha256'] or audit['runId'] != score['runId']:
        raise ValueError('Request audit belongs to a different run or corpus.')
    jobs = {row['jobId']: row for row in score['uniqueSourceRows']}
    attempts = audit['attempts']
    counts = Counter(row['jobId'] for row in attempts)
    if set(counts) != set(jobs) or audit['issues'] or audit['jobsWithoutRecordedAttempts'] or audit['counts']['mismatchItems'] != 0 or audit['counts']['recordedAttempts'] != len(attempts):
        raise ValueError('Request audit has gaps or does not cover these exact 388 jobs.')
    if len(attempts) != score['processingHttpAttempts'] or any(counts[job] != row['processingHttpAttempts'] for job, row in jobs.items()):
        raise ValueError('Audited retry counts differ from the scored attempts.')
    for attempt in attempts:
        row = jobs[attempt['jobId']]
        if attempt.get('passed') is not True or attempt['issues'] or attempt['incomplete'] or attempt['requestVerified'] is not True or not (attempt['responseVerified'] or attempt['responseUnavailableExplicit']):
            raise ValueError('A recorded attempt lacks complete passing byte/pin verification.')
        if any(attempt[key] != row[field] for key, field in [('sourceId', 'caseId'), ('model', 'model'), ('mode', 'mode'), ('cell', 'cell')]):
            raise ValueError('An audited attempt belongs to a different source or engine cell.')
    observation = json.loads(files['run-observation.json'])
    if observation['processorUnchanged'] is not True or observation['inventoryUnchanged'] is not True or observation['interrupted'] is not False:
        raise ValueError('A completed run with unchanged processing source and model inventory is required.')
    finished_times = [datetime.fromisoformat(attempt['finishedAt'].replace('Z', '+00:00')) for row in jobs.values() for attempt in row['attempts']]
    if not finished_times or datetime.fromisoformat(observation['stoppedAt'].replace('Z', '+00:00')) < max(finished_times):
        raise ValueError('Run observation predates the final scored processor attempt.')
    summary = json.loads(files['summary.json'])
    if any(summary[key] != score[key] for key in ['runId', 'manifestSha256', 'generatedAt', 'matrix']):
        raise ValueError('Summary is stale or belongs to a different score generation.')
    if json.loads(files['collection.json']) != score['collection']:
        raise ValueError('Collection evidence differs from the scorecard.')
    blocks = re.findall(r'<script id="data" type="application/json">(.*?)</script>', files['report.html'].decode('utf8'), flags=re.S)
    if len(blocks) != 1:
        raise ValueError('Portable report does not contain exactly one recognized data block.')
    view = json.loads(blocks[0])
    if any(view[key] != score[key] for key in ['runId', 'manifestSha256', 'generatedAt', 'matrix', 'collection']):
        raise ValueError('Portable report is stale or belongs to a different score generation.')
    sources = {source['id']: source for source in manifest['documents']}
    if set(view.get('originals', {})) != set(sources):
        raise ValueError('Portable report original downloads do not match the frozen corpus.')
    for source_id, encoded in view['originals'].items():
        source = sources[source_id]
        original = base64.b64decode(encoded['base64'], validate=True)
        if sha256(original).hexdigest() != source['sha256'] or len(original) != source['bytes'] or encoded['sha256'] != source['sha256'] or encoded['filename'] != Path(source['filename']).name:
            raise ValueError('Portable report embeds a different or unverified original file.')
    expected_keys = {(row['caseId'], row['cell'], row['jobId']) for row in score['rows']}
    if len(view['rows']) != 400 or {(row['id'], row['cell'], row['jobId']) for row in view['rows']} != expected_keys:
        raise ValueError('Portable report does not contain these exact 400 receipt outcomes.')
    expected_views = {(row['caseId'], row['cell'], row['jobId']): row for row in score['rows']}
    for row in view['rows']:
        expected = expected_views[(row['id'], row['cell'], row['jobId'])]
        if any(row[field] != expected[field] for field in ['model', 'mode', 'filename']):
            raise ValueError('Portable report source or engine routing differs from the scorecard.')
        for which in ['firstAttempt', 'final']:
            actual, result = row[which], expected[which]
            if actual['status'] != result['status'] or actual['exact'] != result['score']['supportedExactMatches'] or actual['expected'] != result['score']['goldFactCount'] or actual['facts'] != (result.get('output') or {}).get('facts', []) or actual['warnings'] != result.get('warnings', []) or actual['seconds'] != result.get('wallSeconds') or actual['calls'] != result.get('modelChatCalls'):
                raise ValueError('Portable report contains stale or different result details.')
    findings = files['findings.md'].decode('utf8')
    if 'PARTIAL PROGRESS REPORT' in findings or any(score[key] not in findings for key in ['runId', 'manifestSha256', 'generatedAt']):
        raise ValueError('Findings are partial, stale or not bound to this score generation.')
    records = list(csv.DictReader(io.StringIO(files['email-results.csv'].decode('utf8'))))
    expected_csv = {(row['caseId'], row['model'], row['mode'], which, row['jobId']): row[which] for row in score['rows'] for which in ['firstAttempt', 'final']}
    if len(records) != 800:
        raise ValueError('CSV must contain all 800 first/final receipt outcomes.')
    seen = set()
    for record in records:
        key = tuple(record[field] for field in ['case_id', 'model', 'mode', 'view', 'job_id'])
        if key in seen or key not in expected_csv:
            raise ValueError('CSV contains unexpected or duplicate outcomes.')
        seen.add(key)
        expected = expected_csv[key]
        if record['status'] != expected['status'] or record['exact_facts'] != str(expected['score']['supportedExactMatches']) or record['expected_facts'] != str(expected['score']['goldFactCount']) or record['unsupported_facts'] != str(len(expected['score']['unsupportedFacts'])):
            raise ValueError('CSV outcomes differ from the scorecard.')


def publish_no_replace(temporary, target):
    # Both paths are in one directory/filesystem. link() atomically refuses an
    # existing destination, including a symlink created during archive writing.
    os.link(temporary, target)
    temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    target = args.output or args.run / 'aster-100-email-demo.zip'
    if target.exists():
        raise FileExistsError('Preserve the existing bundle; choose a new output filename.')
    score_bytes = read_regular(args.run, 'scorecard.json')
    score = json.loads(score_bytes)
    require_complete(score)
    run_files = {name: read_regular(args.run, name) for name in ['report.html', 'email-results.csv', 'findings.md', 'summary.json', 'collection.json', 'run-observation.json', 'attempt-integrity.json']}
    run_files['scorecard.json'] = score_bytes
    manifest_bytes = read_regular(ROOT, 'manifest.json')
    if sha256(manifest_bytes).hexdigest() != score['manifestSha256']:
        raise ValueError('Run and frozen corpus differ.')
    manifest = json.loads(manifest_bytes)
    verify_bindings(score, run_files, manifest)
    files = {'corpus/manifest.json': manifest_bytes}
    for relative, digest in manifest['files'].items():
        archive_name(relative)
        if relative not in ['gold.json', 'catalog.json'] and not re.fullmatch(r'fixtures/(?:emails/[^/]+\.eml|attachments/[^/]+\.pdf)', relative):
            raise ValueError('Manifest input is outside the explicit fictional corpus allowlist.')
        raw = read_regular(ROOT, relative)
        if sha256(raw).hexdigest() != digest:
            raise ValueError('Frozen source changed: ' + relative)
        files['corpus/' + relative] = raw
    files.update(run_files)
    if (args.run / 'assessment.md').exists():
        files['assessment.md'] = read_regular(args.run, 'assessment.md')
    for name in ['README.md', 'HARNESS.md', 'evaluation-plan.md']:
        files['corpus/' + name] = read_regular(ROOT, name)
    for name in ['offline-lp-packaging.md', 'offline-document-layout.md', 'backup-restore.md', 'access-recovery-maintenance.md']:
        files['operations/' + name] = read_regular(APP / 'operations', name)
    files['START-HERE.txt'] = (
        'ASTER — FICTIONAL 100-EMAIL DEMONSTRATION\n\n'
        'Open report.html in a browser. It needs no server or internet.\n'
        'Select an email to compare all four configurations and download its exact original EML.\n'
        'Read findings.md for measured results and assessment.md, when present, for interpretation.\n'
        'The corpus folder contains all 100 EML inputs, 57 inspection PDFs and frozen expected facts.\n'
        'Attached PDFs are already embedded in the EML files; do not ingest the inspection copies again.\n\n'
        'This ZIP is an inspection package, NOT the Aster application or an offline appliance installer.\n'
        'The proposed disconnected installation is described in operations/offline-lp-packaging.md.\n'
        'All people, email addresses and investment amounts in this corpus are fictional. No email was sent.\n'
        'Expected failures and model omissions remain in the results. No financial posting was auto-accepted.\n'
        'The fake provider exercised collection code; it did not test real Gmail/OAuth availability.\n\n'
        'attempt-integrity.json verifies every preserved processor request and response, including retries.\n'
        'It contains checksums and routing metadata, with no request bodies or authentication material.\n\n'
        'SHA256SUMS records each enclosed file for integrity checking; it is not a vendor signature.\n'
    ).encode('utf-8')
    files['SHA256SUMS'] = ''.join(sha256(raw).hexdigest() + '  ' + name + '\n' for name, raw in sorted(files.items())).encode('utf-8')
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + '.partial')
    owns_temporary = False
    try:
        with zipfile.ZipFile(temporary, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            owns_temporary = True
            for name, raw in sorted(files.items()):
                archive_name(name)
                archive.writestr(name, raw)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None or len(archive.namelist()) != len(files):
                raise ValueError('Archive integrity check failed.')
            for name, raw in files.items():
                if archive.read(name) != raw:
                    raise ValueError('Archived content differs: ' + name)
        publish_no_replace(temporary, target)
    except BaseException:
        if owns_temporary:
            temporary.unlink(missing_ok=True)
        raise
    print(json.dumps({'archive': str(target), 'files': len(files), 'bytes': target.stat().st_size, 'sha256': sha256(target.read_bytes()).hexdigest(), 'applicationInstaller': False}))


if __name__ == '__main__':
    main()
