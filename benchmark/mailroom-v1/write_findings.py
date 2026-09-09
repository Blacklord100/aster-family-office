"""Create measured Markdown findings from preserved scores; no inference or DB.

Default behavior refuses a partial experiment. --allow-partial creates an
explicitly stamped progress report, never a final result or model recommendation.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
import html
import json
from math import ceil
from pathlib import Path
from statistics import median
import os
import uuid

ROOT = Path(__file__).resolve().parent
FINAL = {'completed', 'failed'}


def md(value):
    return html.escape(str(value), quote=False).replace('|', '\\|').replace('\n', '; ').replace('\r', '').replace('`', "'").replace('[', '\\[').replace(']', '\\]')


def percentage(value):
    return '—' if value is None else f'{100 * value:.1f}%'


def seconds(value):
    return '—' if value is None else f'{value:.2f} s'


def nearest_rank_p95(values):
    observed = sorted(value for value in values if value is not None)
    return observed[ceil(0.95 * len(observed)) - 1] if observed else None


def label(cell, models):
    return f"{models[cell // 2]} · {['workflow', 'agentic'][cell % 2]}"


def require_complete(rows, allow_partial=False):
    identifiers = [row['jobId'] for row in rows]
    cells = Counter(row['cell'] for row in rows)
    if len(rows) != 388 or len(set(identifiers)) != 388 or cells != {0: 97, 1: 97, 2: 97, 3: 97}:
        raise ValueError('Expected the complete 388-job plan, with 97 distinct jobs in each of four cells.')
    completed = sum(row['final']['status'] in FINAL for row in rows)
    if completed != 388 and not allow_partial:
        raise ValueError(f'Refusing partial findings: {completed}/388 unique jobs have final outcomes. Use --allow-partial only for an explicitly labeled progress report.')
    return completed == 388


def metrics(rows, which='final'):
    observations = [row[which] for row in rows]
    scores = [row['score'] for row in observations]
    expected = sum(score['goldFactCount'] for score in scores)
    exact = sum(score['supportedExactMatches'] for score in scores)
    returned = sum(score['returnedFactCount'] for score in scores)
    durations = [row['wallSeconds'] for row in observations if row.get('wallSeconds') is not None]
    return {'planned': len(rows), 'final': sum(row['status'] in FINAL for row in observations), 'valid': sum(score['validOutputEnvelope'] for score in scores), 'failed': sum(row['status'] == 'failed' for row in observations), 'expected': expected, 'exact': exact, 'returned': returned, 'unsupported': returned - exact, 'recall': exact / expected if expected else None, 'precision': exact / returned if returned else None, 'median': median(durations) if durations else None, 'p95': nearest_rank_p95(durations), 'max': max(durations) if durations else None, 'perfect': sum(score['factPerfect'] for score in scores), 'correctionProxy': sum(score['reviewCorrectionProxy']['totalUnits'] for score in scores)}


def confusion(rows, which='final'):
    result = Counter({'TP': 0, 'TN': 0, 'FP': 0, 'FN': 0, 'unavailable': 0})
    for row in rows:
        score = row[which]['score']
        predicted, expected = score.get('predictedRelevant'), score.get('expectedRelevant')
        if type(predicted) is not bool or type(expected) is not bool:
            result['unavailable'] += 1
        elif predicted:
            result['TP' if expected else 'FP'] += 1
        else:
            result['FN' if expected else 'TN'] += 1
    return dict(result)


def comparable_mode_pairs(rows, model):
    grouped = {}
    for row in rows:
        if row['model'] == model:
            grouped.setdefault(row['caseId'], {})[row['mode']] = row['final']['status']
    return sum(pair.get('workflow') == 'completed' and pair.get('agentic') == 'completed' for pair in grouped.values())


def table(headers, rows):
    return ['| ' + ' | '.join(md(item) for item in headers) + ' |', '| ' + ' | '.join('---' for _ in headers) + ' |'] + ['| ' + ' | '.join(md(item) for item in row) + ' |' for row in rows]


def build_findings(scorecard, manifest, complete):
    rows = scorecard['uniqueSourceRows']
    receipts = scorecard['rows']
    by_cell = {cell: [row for row in rows if row['cell'] == cell] for cell in range(4)}
    models = [by_cell[0][0]['model'], by_cell[2][0]['model']]
    document_count = len(manifest['documents'])
    original_count = len({(item['office_id'], item['sha256']) for item in manifest['documents']})
    gold_receipts = sum(len(row['expectedFacts']) for row in receipts if row['cell'] == 0)
    gold_sources = sum(len(row['expectedFacts']) for row in by_cell[0])
    collection = scorecard.get('collection') or {}
    checks = collection.get('checks', [])
    finished = sum(row['final']['status'] in FINAL for row in rows)
    lines = ['# Aster: the 100-email experiment', '']
    if not complete:
        lines += [f'**PARTIAL PROGRESS REPORT — {finished}/388 unique jobs have final outcomes. Pending jobs remain in the planned fact denominator. These figures are not final accuracy or a model ranking.**', '']
    lines += [f"Generated {datetime.now(timezone.utc).isoformat()} from scorecard dated {md(scorecard['generatedAt'])}. Run: {md(scorecard['runId'])}.", '', '[Open the portable interactive report](./report.html) · [Download all email results as CSV](./email-results.csv)', '', '## Measured scope and denominators', '', f'- {document_count} frozen email receipts across {len({d["office_id"] for d in manifest["documents"]})} offices and {len({d["mailbox_id"] for d in manifest["documents"]})} mailboxes.', f'- {original_count} unique office/source originals: three within-office byte-identical copies share documents and jobs. The same bytes received by different offices stay separate.', f'- Four cells: {len(rows)} unique production jobs and {len(receipts)} receipt-level evaluations. Primary metrics count unique jobs; duplicate receipt views do not add inference work.', f'- {gold_receipts} scored fact observations per 100 receipts; {gold_sources} scored facts per 97 unique originals. Across four cells the primary fact denominator is {gold_sources * 4}.', f'- Collection status: {md(collection.get("status", "unavailable"))}; {sum(item.get("passed") is True for item in checks)}/{len(checks)} collection assertions passed. Provider network calls: {md(collection.get("networkCallsToMailProviders", "unavailable"))}.', '', 'The local fixture adapter replaced Gmail transport only. Production pagination/history parsing, durable cursors, receipt deduplication, encrypted original storage, tenant isolation, engine pins, queue leases, retries and processor result storage were exercised. This does not test real Gmail delivery, OAuth consent, Microsoft Graph or a live mailbox network.', '', 'An exact fact requires all six financial fields, its correct source page, a contiguous evidence quote and every required gold anchor. Missing and failed sources remain in the gold denominator. Precision counts supported exact facts divided by returned facts; recall counts supported exact facts divided by all planned gold facts.', '', '## Stored outcomes', '']
    matrix = []
    for cell, grouped in by_cell.items():
        value = metrics(grouped)
        matrix.append([label(cell, models), f'{value["exact"]}/{value["expected"]}', percentage(value['recall']), percentage(value['precision']), f'{value["valid"]}/{value["planned"]}', value['failed'], seconds(value['median']), seconds(value['p95']), seconds(value['max'])])
    lines += table(['Configuration', 'Exact/gold facts', 'Recall', 'Precision', 'Valid results/jobs', 'Failed jobs', 'Median', 'P95', 'Maximum'], matrix)
    lines += ['', 'Median, P95 and maximum use the last recorded processor HTTP request for each job, retaining failed HTTP durations and excluding missing durations. P95 uses the nearest-rank method: sort the n observed durations and take rank ceil(0.95 × n), counted from 1, without interpolation. These durations exclude queue waiting and retry delays; all-attempt totals below retain failed request time. They are not end-to-end email latency.', '', '## First attempt, stored outcome and retries', '']
    retry_rows = []
    for cell, grouped in by_cell.items():
        first, final = metrics(grouped, 'firstAttempt'), metrics(grouped)
        retry_rows.append([label(cell, models), f'{first["exact"]}/{first["expected"]}', f'{final["exact"]}/{final["expected"]}', sum(row['processingHttpAttempts'] > 1 for row in grouped), sum(row['processingHttpAttempts'] for row in grouped), sum(row['firstAttempt']['status'] == 'failed' and row['final']['status'] == 'completed' for row in grouped), sum(row['firstAttempt']['status'] == 'failed' and row['final']['status'] == 'failed' for row in grouped), seconds(sum(row.get('allAttemptWallSeconds', 0) for row in grouped))])
    lines += table(['Configuration', 'First exact/gold', 'Stored exact/gold', 'Jobs retried', 'HTTP attempts', 'Failure→valid', 'Failure→failed', 'All HTTP time'], retry_rows)
    lines += ['', 'Every recorded attempt is retained; the final result is not a best-of selection. Normal bounded worker retries remained enabled. A source rejected before inference can therefore incur repeated HTTP failures without a model call.', '', '## Relevance classification', '', 'Confusion counts use the stored result’s relevance decision. Unavailable outputs are listed separately, not folded into false positives or false negatives; they still affect financial extraction coverage.', '']
    lines += table(['Configuration', 'TP', 'TN', 'FP', 'FN', 'Unavailable', 'Total jobs'], [[label(cell, models), *[confusion(grouped)[key] for key in ['TP', 'TN', 'FP', 'FN', 'unavailable']], len(grouped)] for cell, grouped in by_cell.items()])
    lines += ['', '## Content categories', '', 'Each cell shows **exact/gold facts; unsupported facts; valid results/jobs**. Categories are assigned to the canonical unique original. Byte-duplicate receipts are visible in the interactive report but do not add a unique-source row.', '']
    category_rows = []
    for category in sorted({row.get('category') or 'uncategorized' for row in rows}):
        values = [category]
        for cell in range(4):
            grouped = [row for row in by_cell[cell] if (row.get('category') or 'uncategorized') == category]
            value = metrics(grouped)
            values.append(f'{value["exact"]}/{value["expected"]}; U={value["unsupported"]}; {value["valid"]}/{value["planned"]} valid')
        category_rows.append(values)
    lines += table(['Category', *[label(cell, models) for cell in range(4)]], category_rows)
    lines += ['', '## Input boundaries and capability failures', '', 'Password-protected PDFs deliberately have no accessible scored gold facts; their hidden values remain in `unavailableSourceFacts` and are not treated as extracted or fact-perfect results. Nested-message attachments contain known source facts in the scored denominator: rejecting that format is an input capability failure, distinct from the expected password boundary.', '']
    block_rows = []
    for cell, grouped in by_cell.items():
        encrypted = [row for row in grouped if row.get('expectedSafeInputBlock')]
        nested = [row for row in grouped if row.get('category') == 'nested_eml_attachment']
        block_rows.append([label(cell, models), len(encrypted), sum(row['final']['status'] == 'failed' for row in encrypted), sum(row['final']['score']['returnedFactCount'] for row in encrypted), len(nested), sum(row['final']['status'] == 'failed' for row in nested), sum(row['final']['score']['supportedExactMatches'] for row in nested), sum(row['final']['score']['goldFactCount'] for row in nested)])
    lines += table(['Configuration', 'Expected encrypted inputs', 'Encrypted failed jobs', 'Encrypted returned facts', 'Nested inputs', 'Nested failed jobs', 'Nested exact', 'Nested gold'], block_rows)
    lines += ['', 'These counts describe observed outcomes. They do not certify that every unsafe input is rejected correctly. Decode errors, HTTP status codes, warnings and original sources remain available in the scorecard/report.', '', '## Differences between modes', '']
    disagreements = scorecard.get('modeDisagreements', [])
    distinct = sorted({item['caseId'] for item in disagreements})
    comparable_receipts = {model: comparable_mode_pairs(receipts, model) for model in models}
    comparable_originals = {model: comparable_mode_pairs(rows, model) for model in models}
    lines += [f'Compared {sum(comparable_receipts.values())} usable receipt pairs across the two models ({sum(comparable_originals.values())} unique-original pairs). Each pair compares workflow and agentic output for the same model and source. {len(disagreements)} model/receipt comparisons differed in canonical financial facts or relevance, covering {len(distinct)} distinct receipt case IDs. Pairs with a failed or unavailable output are excluded and remain visible in the failure tables.', '']
    for model in models:
        ids = sorted({item['caseId'] for item in disagreements if item['model'] == model})
        lines.append(f'- {md(model)}: {comparable_receipts[model]} comparable receipt pairs ({comparable_originals[model]} unique-original pairs); {len(ids)} differing receipt pairs. ' + ('Differing case IDs: ' + ', '.join(md(case_id) for case_id in ids) + '.' if ids else 'No differing case IDs recorded.'))
    lines += ['', 'No model or processing mode is automatically selected from these measurements. A higher fact count alone does not establish better correctness, review effort or operational fit.', '', '## Warnings and review burden', '']
    warnings = Counter()
    review_rows = []
    for cell, grouped in by_cell.items():
        for row in grouped:
            warnings.update(str(value) for value in row['final'].get('warnings', []))
        review_rows.append([label(cell, models), sum(bool(row['final'].get('warnings')) for row in grouped), sum(any(step.get('status') == 'error' for step in (row['final'].get('output') or {}).get('trace', [])) for row in grouped), metrics(grouped)['correctionProxy'], sum((row['final'].get('modelChatCalls') or 0) > 0 for row in grouped), sum(row['final'].get('modelChatCalls') or 0 for row in grouped), sum(row['final'].get('modelChatCalls') is None for row in grouped)])
    lines += table(['Configuration', 'Jobs with warnings', 'Inference-error traces', 'Review-edit proxy units', 'Jobs with model calls', 'Structured calls', 'Call count unknown'], review_rows)
    lines += ['', 'The edit proxy counts deterministic missing/removal/field/evidence corrections; it is not observed human review time. Model-call counts come from the production trace; deterministic notices can legitimately use zero model calls. Unknown counts remain separate.', '', 'Most frequent exact warning texts:', '']
    lines += [f'- {count} occurrence(s): {md(warning[:1000])}' for warning, count in warnings.most_common(12)] or ['- None recorded.']
    lines += ['', '## Model provenance and timing limits', '']
    for model in scorecard.get('inventory', []):
        details = model.get('details') or {}
        values = {'Tag': model.get('name', model.get('model', 'unavailable')), 'digest': model.get('digest', 'unavailable'), 'bytes': model.get('size', 'unavailable'), 'format': details.get('format', 'unavailable'), 'declared parameters': details.get('parameter_size', 'unavailable'), 'quantization': details.get('quantization_level', 'unavailable')}
        lines.append('- ' + '; '.join(f'{key}: {md(value)}' for key, value in values.items()) + '.')
    lines += ['', 'The Qwen alias in this experiment is configured for CPU execution; Gemma uses the existing deployment GPU configuration. Model size, quantization, device routing and warm-cache order differ. These sequential observations on shared local hardware are not a controlled CPU/GPU or model speed ranking. Raw Ollama transport was not instrumented; selected engine pins, model inventory, production processor requests/results and trace counts were retained.', '', '## What these results do not measure', '', '- The corpus is fictional, authored with its gold labels, and not independently adjudicated. It does not establish production accuracy, multilingual coverage or general OCR robustness.', '- No extraction was automatically accepted or posted. Review decisions, ledger correctness, economic-event posting deduplication, consolidation accounting and stress-test accuracy are separate checks, not inferred from this benchmark.', '- Holdings look-through, manager relationships, knowledge-index proposal acceptance and total exposure are not scored by the six-field extraction comparison. Undisclosed weights must remain unknown.', '- The fake provider exercises production collection mechanics; it does not prove real mailbox connectivity, OAuth authorization, provider rate limits or delivery reliability.', '- Both models received decoded text, including prior local OCR for scans. Direct multimodal image-reading capabilities were not compared; Linux OCR requires separate validation.', '- No cloud model was called. This comparison does not establish cloud-versus-local accuracy or certify an air-gapped deployment.', '', f'Frozen corpus manifest SHA-256: {md(scorecard["manifestSha256"])}.', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--corpus', type=Path, default=ROOT)
    parser.add_argument('--allow-partial', action='store_true')
    args = parser.parse_args()
    manifest_bytes = (args.corpus / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    scorecard = json.loads((args.run / 'scorecard.json').read_text())
    if scorecard['manifestSha256'] != sha256(manifest_bytes).hexdigest():
        raise ValueError('Findings and corpus do not share the same frozen manifest.')
    if len(scorecard['rows']) != 400 or len({(row['caseId'], row['cell']) for row in scorecard['rows']}) != 400:
        raise ValueError('Expected all 400 planned receipt evaluations.')
    complete = require_complete(scorecard['uniqueSourceRows'], args.allow_partial)
    content = build_findings(scorecard, manifest, complete)
    target = args.run / 'findings.md'
    temporary = target.with_name(target.name + '.' + uuid.uuid4().hex + '.partial')
    try:
        with temporary.open('x') as stream:
            os.chmod(temporary, 0o600)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({'findings': str(target), 'complete': complete, 'automaticModelSelection': False, 'inferenceCalls': 0, 'databaseCalls': 0}))


if __name__ == '__main__':
    main()
