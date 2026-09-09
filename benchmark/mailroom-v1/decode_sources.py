"""Preserve source text, rendered pixels and gold-anchor diagnostics without inference."""
import argparse
import base64
from dataclasses import asdict
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import re
import sys
import time
from uuid import uuid4

from PIL import Image

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent.parent
sys.path.insert(0, str(APP / 'processor'))
from service.config import Settings
from service.documents import DocumentError, parse_document


def digest(data):
    return sha256(data).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def processor_hashes():
    return {str(path.relative_to(APP)): digest(path.read_bytes())
            for path in sorted((APP / 'processor/service').glob('*.py'))}


def decoder_hashes():
    files = ['processor/requirements.lock.txt', *['processor/service/' + name for name in
             ('config.py', 'documents.py', 'pdf_worker.py', 'page_images.py', 'ocr_worker.py', 'html_text.py')]]
    return {name: digest((APP / name).read_bytes()) for name in files}


def prepare(corpus, output, settings):
    corpus, output = corpus.resolve(), output.resolve()
    if output == APP or output.is_relative_to(APP):
        raise ValueError('Decode artifacts must be outside the application repository.')
    if output.exists():
        raise ValueError('Refusing to overwrite an existing decode directory.')
    manifest_bytes = (corpus / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    for relative, expected in manifest['files'].items():
        path = (corpus / relative).resolve()
        if not path.is_relative_to(corpus) or digest(path.read_bytes()) != expected:
            raise ValueError('Frozen corpus checksum mismatch: ' + relative)
    gold_bytes = (corpus / 'gold.json').read_bytes()
    cases = {case['id']: case for case in json.loads(gold_bytes)['cases']}
    before = processor_hashes()
    decoder_before = decoder_hashes()
    output.mkdir(parents=True, mode=0o700)
    (output / 'images').mkdir(mode=0o700)
    rows = []
    normalized = lambda text: re.sub(r'\s+', ' ', text).strip()
    for source in manifest['documents']:
        started = time.monotonic()
        original_path = (corpus / source['filename']).resolve()
        if not original_path.is_relative_to(corpus):
            raise ValueError('Original source path escapes frozen corpus.')
        original = original_path.read_bytes()
        if digest(original) != source['sha256']:
            raise ValueError('Original EML checksum mismatch: ' + source['id'])
        pages, warnings, error, issues = [], [], None, []
        try:
            document = parse_document(original, Path(source['filename']).name, 'message/rfc822', settings)
            warnings = document.warnings
            for page in document.pages:
                row = {'number': page.number, 'text': page.text, 'source': page.source,
                       'textSha256': digest(page.text.encode()), 'layout_text': page.layout_text,
                       'layoutSha256': digest(page.layout_text.encode()) if page.layout_text is not None else None,
                       'image': None}
                if page.image_png_base64:
                    raw = base64.b64decode(page.image_png_base64, validate=True)
                    image_hash = digest(raw)
                    target = output / 'images' / (image_hash + '.png')
                    if target.exists() and target.read_bytes() != raw:
                        raise ValueError('Image content-address collision.')
                    if not target.exists():
                        target.write_bytes(raw)
                    with Image.open(io.BytesIO(raw)) as picture:
                        row['image'] = {'path': str(target.relative_to(output)), 'sha256': image_hash,
                                        'bytes': len(raw), 'width': picture.width, 'height': picture.height,
                                        'format': picture.format}
                pages.append(row)
            for index, fact in enumerate(cases[source['id']]['facts']):
                page = next((p for p in pages if p['number'] == fact['evidencePage']), None)
                missing = [anchor for anchor in fact['evidenceAnchors']
                           if page is None or normalized(anchor) not in normalized(page['text'])]
                if missing:
                    issues.append({'factIndex': index, 'expectedPage': fact['evidencePage'], 'missingAnchors': missing})
        except DocumentError as exc:
            error = str(exc)
        payload = {'sourceId': source['id'], 'sourceSha256': source['sha256'],
                   'manifestSha256': digest(manifest_bytes), 'pages': pages,
                   'warnings': warnings, 'decodeError': error}
        write(output / (source['id'] + '.json'), payload)
        rows.append({'caseId': source['id'], 'sourceSha256': source['sha256'], 'pages': len(pages),
                     'category': source.get('category'), 'anchorIssues': issues, 'decodeError': error,
                     'ocrPages': sum('local OCR' in p['source'] for p in pages),
                     'pageImages': [{'number': p['number'], 'source': p['source'], **p['image']}
                                    for p in pages if p['image']],
                     'artifactSha256': digest((output / (source['id'] + '.json')).read_bytes()),
                     'wallSeconds': time.monotonic() - started})
    after = processor_hashes()
    decoder_after = decoder_hashes()
    settings_public = {key: value for key, value in asdict(settings).items() if key != 'token'}
    summary = {'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
               'inferencePerformed': False, 'manifestSha256': digest(manifest_bytes),
               'goldSha256': digest(gold_bytes), 'processorBefore': before, 'processorAfter': after,
               'processorUnchanged': before == after, 'settings': settings_public,
               'decoderBefore': decoder_before, 'decoderAfter': decoder_after,
               'decoderUnchanged': decoder_before == decoder_after,
               'documents': len(rows), 'decoded': sum(row['decodeError'] is None for row in rows),
               'blocked': sum(row['decodeError'] is not None for row in rows),
               'documentsWithAnchorIssues': sum(bool(row['anchorIssues']) for row in rows),
               'ocrPages': sum(row['ocrPages'] for row in rows),
               'renderedPageImages': sum(len(row['pageImages']) for row in rows), 'rows': rows}
    write(output / 'decode-index.json', summary)
    if not summary['decoderUnchanged']:
        raise ValueError('Decoder source changed during independent decoding; preserve and use a fresh output directory.')
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--corpus', type=Path, default=ROOT)
    parser.add_argument('--settings-json', type=Path, help='Public Settings fields only; token/provider secrets are prohibited.')
    args = parser.parse_args()
    public = json.loads(args.settings_json.read_text()) if args.settings_json else {}
    allowed = {'ocr_enabled', 'max_ocr_pages', 'visual_pages_enabled', 'max_visual_pages', 'max_visual_bytes',
               'max_nested_eml_depth', 'max_email_parts', 'max_email_attachments', 'document_decode_timeout_seconds',
               'max_file_bytes', 'max_pages', 'max_text_chars'}
    if not isinstance(public, dict) or set(public) - allowed:
        raise ValueError('Only document decoding settings are accepted.')
    settings = Settings(token='synthetic-decoding-' + uuid4().hex, **public)
    corpus, output = args.corpus.resolve(), args.output.resolve()
    # PDF decoding invokes the existing isolated worker module from its package.
    os.chdir(APP / 'processor')
    summary = prepare(corpus, output, settings)
    print(json.dumps({key: value for key, value in summary.items() if key not in
                      {'rows', 'processorBefore', 'processorAfter', 'decoderBefore', 'decoderAfter', 'settings'}}, indent=2))


if __name__ == '__main__':
    main()
