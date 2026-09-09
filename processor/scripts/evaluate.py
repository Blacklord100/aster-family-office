"""Run held-out synthetic evaluation. --real-local measures the configured local model."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from service.classifier import RelevanceClassifier
from service.config import Settings
from service.documents import Document, Page
from service.grounding import deterministic_facts
from service.pipeline import process
from tests.fake_ollama import fake_ollama


def expected_fact(row):
    names = {'capital_call': 'Cedar Partners IV', 'valuation': 'Meridian Real Assets',
             'distribution': 'Harbor Income Fund', 'news': 'Pine Robotics'}
    dates = {'capital_call': '2026-08-31', 'valuation': '2026-06-30', 'distribution': '2026-08-15', 'news': '2026-09-01'}
    return {'kind': row['kind'], 'investmentName': names[row['kind']], 'effectiveDate': dates[row['kind']],
            'amount': row['amount'], 'currency': None if row['kind'] == 'news' else 'USD' if row['kind'] == 'distribution' else 'EUR',
            'dueDate': '2026-09-30' if row['kind'] == 'capital_call' else None,
            'summary': row['text'][:1000], 'evidence': {'page': 1, 'quote': row['text']}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--real-local', action='store_true')
    parser.add_argument('--limit', type=int, default=12)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    rows = json.loads((root / 'corpus' / 'holdout.json').read_text())[:args.limit]
    classifier = RelevanceClassifier()
    confusion = Counter()
    results = []
    for row in rows:
        predicted, probability = classifier.predict(row['text'])
        confusion[('t' if predicted == row['relevant'] else 'f') + ('p' if predicted else 'n')] += 1
        document = Document([Page(1, row['text'], 'synthetic holdout')], [])
        rules = deterministic_facts(document.pages)
        record = {'id': row['id'], 'expectedRelevant': row['relevant'], 'predictedRelevant': predicted,
                  'relevanceProbability': round(probability, 4), 'rulesCandidateCount': len(rules)}
        for mode in ('workflow', 'agentic'):
            start = time.monotonic()
            if args.real_local:
                settings = Settings('evaluation-only-synthetic-token',
                                    ollama_base_url=os.getenv('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
                                    ollama_model=os.getenv('OLLAMA_MODEL', 'gemma4:e4b-m3'))
                output = process(document, row['id'], mode, settings, classifier)
            else:
                # Scripted golden replies test orchestration/schema/validation only.
                facts = [expected_fact(row)] if row['relevant'] else []
                replies = [{'facts': facts}] if mode == 'workflow' else [
                    {'action': 'read_page', 'page': 1}, {'action': 'extract', 'page': 1},
                    {'facts': facts}, {'action': 'finish', 'page': None}]
                with fake_ollama(replies) as (url, _):
                    output = process(document, row['id'], mode, Settings('evaluation-only-synthetic-token', ollama_base_url=url), classifier)
            record[mode] = {'candidateCount': len(output.facts),
                            'expectedFactRecovered': any(f.kind == row['kind'] and f.amount == row['amount'] for f in output.facts),
                            'seconds': round(time.monotonic() - start, 3), 'model': output.model,
                            'warnings': [w for w in output.warnings if not w.startswith(('Candidate facts', 'Confidence is'))]}
        results.append(record)
        print(json.dumps(record), flush=True)
    positive_count = sum(row['relevant'] for row in rows)
    report = {'syntheticOnly': True, 'seed': 42, 'trainingDocuments': 48, 'heldoutDocuments': len(rows),
              'modelResponses': 'actual local Ollama' if args.real_local else 'scripted golden contract server, NOT model quality',
              'classificationConfusion': dict(confusion),
              'classificationAccuracy': sum(confusion[k] for k in ('tp', 'tn')) / len(rows),
              'rulesDocumentCoverage': sum(r['rulesCandidateCount'] > 0 for r in results if r['expectedRelevant']) / max(1, positive_count),
              'workflowDocumentCoverage': sum(r['workflow']['expectedFactRecovered'] for r in results) / max(1, positive_count),
              'agenticDocumentCoverage': sum(r['agentic']['expectedFactRecovered'] for r in results) / max(1, positive_count),
              'limitations': ['Tiny English synthetic set; no production generalization claim.',
                             'Confidence is uncalibrated relevance probability.',
                             'Coverage requires expected kind and amount only; this is not complete financial accuracy.',
                             'Contract-server scores validate plumbing and evidence checks, not model reasoning.',
                             'No scanned PDF/OCR accuracy benchmark or multilingual layouts.'],
              'results': results}
    path = root / 'eval' / ('real-local.json' if args.real_local else 'synthetic-contract.json')
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(f'Wrote {path}', flush=True)


if __name__ == '__main__':
    main()
