"""Run a full-history credential scan; only exact reviewed historical candidates pass."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def audit(repo, scanner, output):
    repo = repo.resolve()
    git = lambda *args: subprocess.check_output(['git', '-C', str(repo), *args]).decode().strip()
    if git('rev-parse', '--is-shallow-repository') != 'false':
        raise ValueError('Full-history review refuses a shallow checkout')
    if subprocess.check_output([str(scanner), 'version']).decode().strip() != '8.30.1':
        raise ValueError('Use the reviewed Gitleaks 8.30.1 binary and verify its publisher checksum')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    raw_report = output / 'gitleaks.redacted.json'
    result = subprocess.run([str(scanner), 'git', str(repo), '--log-opts=--all --full-history',
                             '--redact=100', '--report-format=json', '--report-path=' + str(raw_report),
                             '--no-banner'], capture_output=True, text=True)
    if result.returncode not in {0, 1} or not raw_report.is_file():
        raise ValueError('History scanner failed; no clean result may be inferred')
    raw_report.chmod(0o600)
    findings = json.loads(raw_report.read_text())
    review = json.loads((Path(__file__).parent / 'history-secret-review.json').read_text())
    known = {item['fingerprint']: item for item in review['findings']}
    unknown = []
    for item in findings:
        key = item.get('Fingerprint')
        expected = known.get(key)
        if not expected or any(item.get(field) != expected[name] for field, name in
                               [('Commit', 'commit'), ('File', 'file'), ('StartLine', 'line'), ('RuleID', 'rule')]):
            unknown.append({'fingerprint': key, 'file': item.get('File'), 'commit': item.get('Commit'),
                            'line': item.get('StartLine'), 'rule': item.get('RuleID')})
    receipt = {'schemaVersion': 1, 'head': git('rev-parse', 'HEAD'),
               'reachableCommits': int(git('rev-list', '--all', '--count')),
               'scannerVersion': '8.30.1', 'fullHistory': True,
               'rawCandidates': len(findings), 'reviewedFalsePositives': len(findings) - len(unknown),
               'unreviewedCandidates': unknown,
               'redactedReportSha256': hashlib.sha256(raw_report.read_bytes()).hexdigest(),
               'status': 'needs-review' if unknown else 'passed',
               'scope': 'Reachable Git history credential patterns; separate data/asset provenance review required'}
    (output / 'history-audit.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: receipt[key] for key in ['head', 'reachableCommits', 'rawCandidates',
                                                  'reviewedFalsePositives', 'status']}))
    return 1 if unknown else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--gitleaks', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        sys.exit(audit(args.repo, args.gitleaks.resolve(), args.output))
    except (OSError, ValueError, subprocess.SubprocessError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
