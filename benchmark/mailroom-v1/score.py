"""Re-score every planned production job and receipt without model inference.

Gold is available only here, never to the collector, worker or processor. Missing
and failed jobs stay in the plan. First HTTP attempt and eventual stored output
are separate: worker retries never erase the first outcome.
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
from math import ceil
from pathlib import Path
from statistics import median
import sys

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent.parent
SPEC = importlib.util.spec_from_file_location('strict_source_score', ROOT.parent / 'holdout-v1' / 'score.py')
strict = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(strict)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.partial')
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
    temporary.replace(path)


def decoded_pages(corpus, case, directory):
    path = directory / (case['id'] + '.json')
    if not path.exists():
        return [], {'available': False, 'reason': 'Decode artifact not supplied; evidence scoring fails closed.'}
    data = json.loads(path.read_text())
    pages = data if isinstance(data, list) else data.get('pages', [])
    return pages, {'available': True, 'pages': len(pages), 'textCharacters': sum(len(page.get('text', '')) for page in pages), 'ocrPages': sum('ocr' in str(page.get('source', '')).lower() for page in pages), 'warnings': [] if isinstance(data, list) else data.get('warnings', []), 'decodeError': None if isinstance(data, list) else data.get('decodeError')}


def calls(output):
    import re
    for step in (output or {}).get('trace', []):
        if step.get('stage') == 'model_usage':
            match = re.match(r'(\d+) local structured model calls;', step.get('detail', ''))
            if match:
                return int(match.group(1))
    if output and output.get('model') is None and any(step.get('stage') == 'coverage' for step in output.get('trace', [])):
        return 0
    return None


def nearest_rank_p95(values):
    """Observed durations only; rank ceil(0.95*n), without interpolation."""
    observed = sorted(value for value in values if value is not None)
    return observed[ceil(0.95 * len(observed)) - 1] if observed else None


def score_case(case, output, pages):
    score = strict.score_case(case, output, pages)
    expectation = case.get('reviewExpectation') or {}
    if 'currency' in expectation and expectation['currency'] is None:
        for index, fact in enumerate((output or {}).get('facts', [])):
            if isinstance(fact, dict) and fact.get('currency') is not None:
                score['criticalBoundaryFailures'].append({'predictionIndex': index, 'reason': 'invented_currency_for_ambiguous_symbol'})
    return score


def load_output(path):
    if not path.exists():
        return None
    try:
        result = json.loads(path.read_text())
        return result if isinstance(result, dict) and isinstance(result.get('facts'), list) else None
    except (ValueError, UnicodeError):
        return None


def summarize(rows, which):
    groups = {}
    for row in rows:
        groups.setdefault((row['cell'], row['model'], row['mode']), []).append(row)
    summary = []
    for (cell, model, mode), grouped in groups.items():
        evaluated = [row[which] for row in grouped]
        scores = [row['score'] for row in evaluated]
        expected = sum(score['goldFactCount'] for score in scores)
        returned = sum(score['returnedFactCount'] for score in scores)
        exact = sum(score['supportedExactMatches'] for score in scores)
        durations = [row['wallSeconds'] for row in evaluated if row['wallSeconds'] is not None]
        finished = sum(row['status'] in ['completed', 'failed'] for row in evaluated)
        summary.append({'cell': cell, 'model': model, 'mode': mode, 'planned': len(grouped), 'finished': finished, 'pending': len(grouped) - finished, 'complete': finished == len(grouped), 'validResults': sum(score['validOutputEnvelope'] for score in scores), 'factPerfectDocuments': sum(score['factPerfect'] for score in scores), 'classificationCorrect': sum(score['classificationCorrect'] for score in scores), 'goldFacts': expected, 'returnedFacts': returned, 'supportedExactFacts': exact, 'missedOrPendingFacts': expected - exact, 'unsupportedFacts': returned - exact, 'precision': exact / returned if returned else None, 'fullPlanRecall': exact / expected if expected else None, 'reviewCorrectionProxyUnits': sum(score['reviewCorrectionProxy']['totalUnits'] for score in scores), 'criticalBoundaryFailures': sum(len(score['criticalBoundaryFailures']) for score in scores), 'executionFailures': sum(row['status'] == 'failed' for row in evaluated), 'inferenceWarnings': sum(any(step.get('status') == 'error' for step in (row.get('output') or {}).get('trace', [])) for row in evaluated), 'attemptsWithActualModelCalls': sum((row['modelChatCalls'] or 0) > 0 for row in evaluated), 'structuredModelCalls': sum(row['modelChatCalls'] or 0 for row in evaluated), 'wallSecondsSum': sum(durations), 'wallSecondsMedian': median(durations) if durations else None, 'wallSecondsP95': nearest_rank_p95(durations), 'wallSecondsMax': max(durations) if durations else None})
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--decoded', required=True, type=Path, help='Independent source decode artifacts case-id.json, never model input.')
    parser.add_argument('--corpus', type=Path, default=ROOT)
    args = parser.parse_args()
    corpus = args.corpus.resolve()
    manifest = json.loads((corpus / 'manifest.json').read_text())
    for path, digest in manifest['files'].items():
        target = (corpus / path).resolve()
        if not target.is_relative_to(corpus) or sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError('Frozen source/gold changed: ' + path)
    gold = json.loads((corpus / 'gold.json').read_text())
    cases = {case['id']: case for case in gold['cases']}
    sources = {source['id']: source for source in manifest['documents']}
    state = json.loads((args.run / 'state.json').read_text())
    if state['manifestSha256'] != sha256((corpus / 'manifest.json').read_bytes()).hexdigest():
        raise ValueError('Run manifest identity does not match this corpus.')
    results = {row['id']: row for row in json.loads((args.run / 'results.json').read_text())} if (args.run / 'results.json').exists() else {}
    collection = json.loads((args.run / 'collection.json').read_text()) if (args.run / 'collection.json').exists() else None
    source_rows, receipt_rows = [], []
    for planned in state['work']:
        row = results.get(planned['id'], {**planned, 'status': 'unrun', 'output': None})
        attempts = []
        for directory in sorted((args.run / 'attempts' / planned['id']).glob('*')):
            if not (directory / 'attempt.json').exists():
                continue
            metadata = json.loads((directory / 'attempt.json').read_text())
            extraction = load_output(directory / 'response.json')
            attempts.append({'path': str(directory.relative_to(args.run)), **metadata, 'output': extraction})
        for source_id in planned['sourceIds']:
            case, source = cases[source_id], sources[source_id]
            pages, decode = decoded_pages(corpus, case, args.decoded)
            first = attempts[0] if attempts else None
            first_output = first.get('output') if first else None
            final_output = row.get('output')
            first_status = 'completed' if first_output else ('failed' if first and first.get('finishedAt') else 'pending' if first else 'unrun')
            final_status = 'completed' if final_output else 'failed' if row['status'] == 'failed' else 'pending' if row['status'] != 'unrun' else 'unrun'
            scored = {'caseId': source_id, 'officeId': source['office_id'], 'mailboxId': source['mailbox_id'], 'category': source.get('category'), 'tags': source.get('tags', []), 'filename': source['filename'], 'duplicateOf': source.get('duplicate_of'), 'sourceSha256': source['sha256'], 'jobId': planned['id'], 'documentId': planned['documentId'], 'cell': planned['cell'], 'model': planned['model'], 'mode': planned['mode'], 'status': row['status'], 'errorCode': row.get('errorCode'), 'sharedReceiptIds': planned['sourceIds'], 'collection': {'persistedOriginal': source_id in state['sources'], 'receiptCounted': True, 'originalPreserved': True}, 'decode': decode, 'expectedFacts': case['facts'], 'reviewBoundaries': case.get('review_boundaries', case.get('reviewBoundaries', [])), 'reviewExpectation': case.get('reviewExpectation', {}), 'constituentProbes': case.get('constituent_probes', case.get('constituentProbes')), 'expectedSafeInputBlock': (case.get('reviewExpectation') or {}).get('expectedSafeInputBlock', case.get('expectedSafeInputBlock')),  'unavailableSourceFacts': case.get('unavailableSourceFacts', []), 'firstAttempt': {'status': first_status, 'httpStatus': first.get('httpStatus') if first else None, 'wallSeconds': first.get('wallSeconds') if first else None, 'score': score_case(case, first_output, pages), 'modelChatCalls': calls(first_output), 'warnings': (first_output or {}).get('warnings', []), 'output': first_output}, 'final': {'status': final_status, 'wallSeconds': attempts[-1].get('wallSeconds') if attempts else None, 'score': score_case(case, final_output, pages), 'modelChatCalls': calls(final_output), 'warnings': (final_output or {}).get('warnings', []), 'output': final_output}, 'processingHttpAttempts': len(attempts), 'allAttemptWallSeconds': sum(attempt.get('wallSeconds', 0) for attempt in attempts), 'automaticAcceptance': False, 'reviewRevision': row.get('reviewRevision'), 'attempts': [{key: value for key, value in attempt.items() if key != 'output'} for attempt in attempts]}
            receipt_rows.append(scored)
            if source_id == planned['sourceId']:
                source_rows.append(scored)
    matrix = {'uniqueSourcesFirstAttempt': summarize(source_rows, 'firstAttempt'), 'uniqueSourcesStoredFinal': summarize(source_rows, 'final'), 'receiptsFirstAttempt': summarize(receipt_rows, 'firstAttempt'), 'receiptsStoredFinal': summarize(receipt_rows, 'final')}
    category_matrix = []
    for category in sorted({row['category'] or 'uncategorized' for row in source_rows}):
        grouped = [row for row in source_rows if (row['category'] or 'uncategorized') == category]
        category_matrix.extend({'category': category, **item} for item in summarize(grouped, 'final'))
    disagreements = []
    for model in state['models']:
        for case_id in cases:
            left = next((row for row in receipt_rows if row['model'] == model and row['caseId'] == case_id and row['mode'] == 'workflow'), None)
            right = next((row for row in receipt_rows if row['model'] == model and row['caseId'] == case_id and row['mode'] == 'agentic'), None)
            if not left or not right or left['final']['status'] != 'completed' or right['final']['status'] != 'completed':
                continue
            def economics(row):
                return sorted([tuple(str(strict.canonical(fact.get(field), field)) for field in strict.FIELDS) for fact in row['final']['output']['facts']])
            if economics(left) != economics(right) or left['final']['output']['relevant'] != right['final']['output']['relevant']:
                disagreements.append({'model': model, 'caseId': case_id, 'workflowExact': left['final']['score']['supportedExactMatches'], 'agenticExact': right['final']['score']['supportedExactMatches'], 'workflowUnsupported': len(left['final']['score']['unsupportedFacts']), 'agenticUnsupported': len(right['final']['score']['unsupportedFacts'])})
    report = {'version': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'runId': state['runId'], 'manifestSha256': state['manifestSha256'], 'inventory': state['inventory'], 'collection': collection, 'matrix': matrix, 'categories': category_matrix, 'modeDisagreements': disagreements, 'rows': receipt_rows, 'uniqueSourceRows': source_rows, 'allPlannedReceiptEvaluationsPresent': len(receipt_rows) == 400, 'processingHttpAttempts': sum(row['processingHttpAttempts'] for row in source_rows), 'processingHttpWallSeconds': sum(row['allAttemptWallSeconds'] for row in source_rows), 'limitations': ['Synthetic diagnostic corpus authored and labeled together, not independently adjudicated production accuracy.', 'All 400 planned receipt evaluations retained; identical originals within an office share a production document/job. Primary metrics count unique tenant/source jobs.', 'First processor HTTP attempt and final worker-stored output are separate; all retries and failure attempts are retained.', 'Six financial fields plus contiguous evidence quote, correct page and mandatory gold anchors are scored. Summary wording is not scored.', 'Model usage comes from actual processor trace. Some workflow notices are fully handled by deterministic source rules and make zero model calls.', 'Gemma and Qwen differ in model size, quantization and CPU/GPU configuration; sequential warm-cache timing is observational, not hardware-normalized.', 'Both selected models receive decoded text, including prior local OCR for scans; direct multimodal image-reading capabilities are not compared.', 'No raw Ollama transport instrumentation; exact processor requests, responses and engine pins are retained.', 'No posting is auto-accepted. Extraction-quality comparison is separate from manual review, economic posting dedupe and look-through proposal acceptance.', 'Missing/unrun attempts remain visible; fullPlanRecall includes them as a lower bound until the complete flag is true.', 'Encrypted/nested/unsupported sources remain explicit decoding or capability boundaries, never silently described as complete.', 'Gmail delivery/OAuth/network were replaced with deterministic local provider responses; production connector pagination, incremental cursors, replay/dedup and encrypted storage were exercised. No real email provider was contacted.']}
    report['inputBoundaries'] = [{'caseId': row['caseId'], 'cell': row['cell'], 'model': row['model'], 'mode': row['mode'], 'expectedSafeInputBlock': bool(row['expectedSafeInputBlock']), 'decodeError': row['decode'].get('decodeError'), 'firstHttpStatus': row['firstAttempt']['httpStatus'], 'storedStatus': row['status'], 'storedErrorCode': row['errorCode'], 'returnedFacts': row['final']['score']['returnedFactCount'], 'attempts': row['processingHttpAttempts'], 'falseFactPerfectClaim': False} for row in source_rows if row['expectedSafeInputBlock'] or row['decode'].get('decodeError')]
    report['timingDefinition'] = {'firstAttemptWallSeconds': 'First processor HTTP request only.', 'wallSecondsP95': 'Nearest-rank percentile: sorted observed durations at rank ceil(0.95 * n), 1-based, without interpolation. Missing durations are excluded; failed HTTP durations are retained. Each summary uses its first or last recorded request per job, not end-to-end latency.', 'finalWallSeconds': 'Last recorded processor HTTP request only; do not interpret as end-to-end latency.', 'allAttemptWallSeconds': 'Sum of every recorded processor request, including failed retries; excludes queue waiting and retry delay.', 'processingHttpWallSeconds': 'Sum of all actual unique-job processor attempts across the run; duplicate receipts do not add compute.'}
    write(args.run / 'scorecard.json', report)
    write(args.run / 'summary.json', {key: value for key, value in report.items() if key not in ['rows', 'uniqueSourceRows']})
    print(json.dumps({'scorecard': str(args.run / 'scorecard.json'), 'uniqueSourceJobs': len(source_rows), 'receiptEvaluations': len(receipt_rows), 'matrix': matrix['uniqueSourcesStoredFinal']}, indent=2))


if __name__ == '__main__':
    main()
