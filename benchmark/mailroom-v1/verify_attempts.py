"""Audit preserved multipart originals, engine pins and response bytes offline.

No database, processor, mailbox or model is contacted. Every attempt directory,
including failed retries, is counted. Payload content and authentication data are
never included in the report. Partial audits require explicit --allow-partial.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
from email.parser import BytesHeaderParser
from email.policy import default
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import uuid

ROOT = Path(__file__).resolve().parent
MAX_REQUEST = 11 * 1024 * 1024
MAX_RESPONSE = 2_000_000
FINAL = {'awaiting_review', 'failed', 'accepted', 'rejected', 'cancelled'}


def digest(data):
    return sha256(data).hexdigest()


def bounded(path, limit):
    with path.open('rb') as stream:
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise ValueError('file_size_limit')
    return content


def multipart(raw, content_type):
    """Parse exact wire payloads; never reserialize message/rfc822 file parts.

    email's full MIME parser treats message/rfc822 as a nested message and would
    not retain the original bytes. Only headers are parsed with that library;
    form-data bodies are separated at their exact CRLF boundary delimiters.
    """
    if not isinstance(content_type, str) or len(content_type) > 1024 or '\r' in content_type or '\n' in content_type:
        raise ValueError('invalid_content_type')
    header = BytesHeaderParser(policy=default).parsebytes(('Content-Type: ' + content_type + '\r\n\r\n').encode('ascii'))
    params = header.get_params(header='content-type') or []
    if header.defects or any(getattr(value, 'defects', ()) for value in header.values()) or header.get_content_type() != 'multipart/form-data' or len(params) != 2 or params[1][0] != 'boundary':
        raise ValueError('invalid_multipart_boundary')
    boundary = header.get_boundary()
    if not isinstance(boundary, str) or not re.fullmatch(r"[0-9A-Za-z'()+_,./:=?-]{1,70}", boundary):
        raise ValueError('invalid_multipart_boundary')
    marker = boundary.encode('ascii')
    prefix = b'--' + marker + b'\r\n'
    if not raw.startswith(prefix):
        raise ValueError('missing_initial_boundary')
    pieces = re.split(rb'\r\n--' + re.escape(marker) + rb'(?=\r\n|--)', raw[len(prefix):])
    if pieces[-1] not in [b'--', b'--\r\n']:
        raise ValueError('missing_final_boundary_or_epilogue')
    pieces = pieces[:-1]
    if len(pieces) != 4:
        raise ValueError('unexpected_form_part_count')
    fields = {}
    for index, piece in enumerate(pieces):
        if index:
            if not piece.startswith(b'\r\n'):
                raise ValueError('malformed_part_delimiter')
            piece = piece[2:]
        head, separator, body = piece.partition(b'\r\n\r\n')
        if not separator or len(head) > 8192:
            raise ValueError('invalid_part_headers')
        headers = BytesHeaderParser(policy=default).parsebytes(head + b'\r\n\r\n')
        names = [name.lower() for name in headers.keys()]
        if headers.defects or any(getattr(value, 'defects', ()) for value in headers.values()) or len(names) != len(set(names)) or set(names) - {'content-disposition', 'content-type'}:
            raise ValueError('unexpected_or_duplicate_part_header')
        disposition = headers.get_params(header='content-disposition') or []
        if headers.get_content_disposition() != 'form-data' or len([key for key, _ in disposition if key == 'name']) != 1 or any(key not in ['form-data', 'name', 'filename'] for key, _ in disposition):
            raise ValueError('invalid_part_disposition')
        name = headers.get_param('name', header='content-disposition')
        if name not in {'file', 'mode', 'document_id', 'engine'} or name in fields:
            raise ValueError('unexpected_or_duplicate_form_field')
        if name == 'file':
            if headers.get_content_type() != 'message/rfc822' or not headers.get_filename() or len([key for key, _ in disposition if key == 'filename']) != 1:
                raise ValueError('invalid_original_file_part')
            fields[name] = body
        else:
            if headers.get_filename() is not None or len(body) > 8192:
                raise ValueError('invalid_text_part')
            fields[name] = body.decode('utf8', errors='strict')
    if set(fields) != {'file', 'mode', 'document_id', 'engine'}:
        raise ValueError('missing_form_fields')
    return fields


def audit_attempt(directory, work, source, expected_file_bytes, allow_partial=False):
    report = {'jobId': work['id'], 'sourceId': work['sourceId'], 'cell': work['cell'], 'model': work['model'], 'mode': work['mode'], 'attemptDirectory': directory.name, 'issues': [], 'requestVerified': False, 'responseVerified': False, 'responseUnavailableExplicit': False, 'incomplete': False}
    issues = report['issues']
    def issue(code, field=None):
        issues.append({'code': code, **({'field': field} if field else {})})
    try:
        metadata = json.loads(bounded(directory / 'attempt.json', 64 * 1024))
        if not isinstance(metadata, dict):
            raise ValueError('invalid_attempt_metadata')
    except (OSError, ValueError, UnicodeError):
        issue('missing_or_invalid_attempt_metadata')
        return report
    for field, expected in [('jobId', work['id']), ('sourceId', work['sourceId']), ('sourceIds', work['sourceIds']), ('model', work['model']), ('mode', work['mode']), ('cell', work['cell'])]:
        if metadata.get(field) != expected:
            issue('attempt_metadata_pin_mismatch', field)
    report['httpStatus'] = metadata.get('httpStatus')
    report['hasRecordedError'] = bool(metadata.get('errorType') or metadata.get('error'))
    if not metadata.get('finishedAt'):
        report['incomplete'] = True
        if not allow_partial:
            issue('attempt_record_not_finished')
    try:
        request = bounded(directory / 'request.multipart.bin', MAX_REQUEST)
    except (OSError, ValueError):
        issue('missing_or_oversize_request_payload')
        request = None
    if request is not None:
        if metadata.get('requestBytes') != len(request):
            issue('request_size_metadata_mismatch')
        if metadata.get('requestSha256') != digest(request):
            issue('request_hash_metadata_mismatch')
        try:
            fields = multipart(request, metadata.get('contentType'))
            if digest(fields['file']) != source['sha256']:
                issue('original_file_hash_mismatch')
            if len(fields['file']) != expected_file_bytes:
                issue('original_file_size_mismatch')
            if fields['mode'] != work['mode']:
                issue('multipart_mode_pin_mismatch')
            if fields['document_id'] != work['documentId']:
                issue('multipart_document_pin_mismatch')
            engine = json.loads(fields['engine'])
            if not isinstance(engine, dict) or set(engine) != {'name', 'provider', 'model'} or engine.get('provider') != 'ollama' or engine.get('model') != work['model'] or engine.get('name') != 'SYNTHETIC comparison ' + work['model']:
                issue('multipart_local_engine_pin_mismatch')
            report['originalFileSha256'] = digest(fields['file'])
            report['originalFileBytes'] = len(fields['file'])
        except (ValueError, TypeError, UnicodeError):
            issue('invalid_or_unexpected_multipart_structure')
        report['requestVerified'] = not issues
    response_path = directory / 'response.json'
    if response_path.exists():
        try:
            response = bounded(response_path, MAX_RESPONSE)
            if metadata.get('responseBytes') != len(response):
                issue('response_size_metadata_mismatch')
            if metadata.get('responseSha256') != digest(response):
                issue('response_hash_metadata_mismatch')
            if metadata.get('httpStatus') == 200:
                payload = json.loads(response)
                if not isinstance(payload, dict) or payload.get('documentId') != work['documentId'] or payload.get('mode') != work['mode'] or payload.get('execution') != 'local' or payload.get('model') not in [None, work['model']]:
                    issue('response_identity_pin_mismatch')
                report['responsePayloadKind'] = 'successful_json_result'
            elif not isinstance(metadata.get('httpStatus'), int) or not 400 <= metadata['httpStatus'] <= 599:
                issue('unexpected_response_http_status')
            else:
                # A legitimate failed HTTP response may be plain text or empty.
                # Verify its exact bytes; do not require a successful-result JSON schema.
                report['responsePayloadKind'] = 'failed_http_response_bytes'
            report['responseVerified'] = not any(item['code'].startswith(('response_', 'unexpected_response')) for item in issues)
        except (OSError, ValueError, UnicodeError):
            issue('invalid_or_oversize_response_payload')
    else:
        has_hash = metadata.get('responseSha256') is not None or metadata.get('responseBytes') is not None
        if has_hash:
            issue('recorded_response_payload_missing')
        elif report['hasRecordedError'] and metadata.get('finishedAt'):
            report['responseUnavailableExplicit'] = True
            report['responseAbsenceReason'] = 'Recorded transport or proxy failure before a response payload was preserved; request can still be verified.'
        elif report['incomplete'] and allow_partial:
            report['responseAbsenceReason'] = 'Attempt is still in progress; response verification is pending.'
        else:
            issue('response_payload_missing_without_recorded_failure')
    report['passed'] = not issues and not report['incomplete']
    return report


def atomic_json(path, data):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.partial')
    try:
        with temporary.open('x') as stream:
            os.chmod(temporary, 0o600)
            json.dump(data, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--corpus', type=Path, default=ROOT)
    parser.add_argument('--allow-partial', action='store_true')
    args = parser.parse_args()
    run, corpus = args.run.resolve(), args.corpus.resolve()
    state = json.loads(bounded(run / 'state.json', 16 * 1024 * 1024))
    results = json.loads(bounded(run / 'results.json', 64 * 1024 * 1024))
    manifest_bytes = bounded(corpus / 'manifest.json', 2 * 1024 * 1024)
    manifest = json.loads(manifest_bytes)
    if state['manifestSha256'] != digest(manifest_bytes):
        raise ValueError('Run manifest binding mismatch.')
    work = {item['id']: item for item in state['work']}
    if len(work) != 388 or len(state['work']) != 388 or Counter(item['cell'] for item in work.values()) != {0: 97, 1: 97, 2: 97, 3: 97}:
        raise ValueError('Expected all 388 unique planned jobs in four 97-job cells.')
    if any(not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', item.get(field, '')) for item in work.values() for field in ['id', 'documentId']):
        raise ValueError('Job and document identifiers must be UUIDs; artifact paths cannot be supplied by plan fields.')
    result_map = {item['id']: item for item in results}
    if len(result_map) != len(results) or set(result_map) != set(work):
        raise ValueError('Stored results do not contain each planned job exactly once.')
    final_count = sum(row['status'] in FINAL for row in results)
    if final_count != 388 and not args.allow_partial:
        raise ValueError(f'Refusing partial request audit: {final_count}/388 jobs have final outcomes.')
    sources = {item['id']: item for item in manifest['documents']}
    source_sizes = {}
    for source_id, source in sources.items():
        path = (corpus / source['filename']).resolve()
        if not path.is_relative_to(corpus):
            raise ValueError('Source path leaves the frozen corpus.')
        raw = bounded(path, MAX_REQUEST)
        if digest(raw) != source['sha256'] or manifest['files'].get(source['filename']) != source['sha256']:
            raise ValueError('Frozen source checksum mismatch.')
        source_sizes[source_id] = len(raw)
    report = {'version': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'runId': state['runId'], 'manifestSha256': state['manifestSha256'], 'partial': final_count != 388, 'plannedUniqueJobs': 388, 'finalUniqueJobs': final_count, 'issues': [], 'attempts': [], 'jobsWithoutRecordedAttempts': [], 'scope': 'Exact preserved processor-request bytes and local engine pins, including every retry. A forwarded processor request does not by itself prove a model was called; some workflow notices are rule-only and some inputs fail before inference.', 'payloadContentsIncluded': False, 'authenticationContentsIncluded': False, 'networkCalls': 0, 'databaseCalls': 0, 'inferenceCalls': 0}
    known = set(work)
    attempt_root = run / 'attempts'
    if not attempt_root.exists():
        report['issues'].append({'code': 'attempt_root_missing'})
    for directory in (attempt_root.iterdir() if attempt_root.is_dir() else []):
        if directory.name not in known or not directory.is_dir() or directory.is_symlink():
            report['issues'].append({'code': 'unexpected_job_attempt_path'})
    for job_id, planned in work.items():
        for field in ['model', 'mode', 'documentId', 'cell']:
            if result_map[job_id].get(field) != planned.get(field):
                report['issues'].append({'code': 'stored_result_plan_mismatch', 'jobId': job_id, 'field': field})
        source = sources.get(planned['sourceId'])
        if not source or planned['model'] != state['models'][planned['cell'] // 2] or planned['mode'] != ['workflow', 'agentic'][planned['cell'] % 2]:
            report['issues'].append({'code': 'planned_source_or_engine_pin_mismatch', 'jobId': job_id})
            continue
        if any(source_id not in sources or sources[source_id]['sha256'] != source['sha256'] or sources[source_id]['office_id'] != source['office_id'] for source_id in planned['sourceIds']):
            report['issues'].append({'code': 'shared_receipt_source_mismatch', 'jobId': job_id})
        job_path = attempt_root / job_id
        directories = sorted(job_path.iterdir()) if job_path.is_dir() and not job_path.is_symlink() else []
        if not directories:
            report['jobsWithoutRecordedAttempts'].append({'jobId': job_id, 'status': result_map[job_id]['status'], 'final': result_map[job_id]['status'] in FINAL})
            if result_map[job_id]['status'] in FINAL:
                report['issues'].append({'code': 'final_job_has_no_recorded_processor_request', 'jobId': job_id})
        for directory in directories:
            if not directory.is_dir() or directory.is_symlink() or any(path.is_symlink() for path in directory.iterdir()):
                report['issues'].append({'code': 'invalid_attempt_artifact_path', 'jobId': job_id})
                continue
            report['attempts'].append(audit_attempt(directory, planned, source, source_sizes[planned['sourceId']], args.allow_partial))
    audits = report['attempts']
    report['counts'] = {'recordedAttempts': len(audits), 'verifiedRequests': sum(item['requestVerified'] for item in audits), 'verifiedResponses': sum(item['responseVerified'] for item in audits), 'explicitFailuresWithoutResponsePayload': sum(item['responseUnavailableExplicit'] for item in audits), 'incompleteAttemptRecords': sum(item['incomplete'] for item in audits), 'mismatchedAttempts': sum(bool(item['issues']) for item in audits), 'mismatchItems': len(report['issues']) + sum(len(item['issues']) for item in audits), 'jobsWithRetries': sum(count > 1 for count in Counter(item['jobId'] for item in audits).values())}
    report['status'] = 'failed' if report['counts']['mismatchItems'] else 'partial' if report['partial'] or report['counts']['incompleteAttemptRecords'] else 'passed'
    report['everyRecordedRequestMatchesFrozenOriginalAndPin'] = bool(audits) and all(item['requestVerified'] for item in audits)
    target = run / 'attempt-integrity.json'
    atomic_json(target, report)
    print(json.dumps({'audit': str(target), 'status': report['status'], 'counts': report['counts'], 'payloadContentsIncluded': False}))
    if report['status'] == 'failed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
