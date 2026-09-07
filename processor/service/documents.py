"""Bounded local decoding. PDFs run in a disposable, time-limited child process."""
from dataclasses import dataclass
from email import policy
from email.parser import BytesParser
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from .config import Settings


class DocumentError(ValueError):
    pass


@dataclass
class Page:
    number: int
    text: str
    source: str


@dataclass
class Document:
    pages: list[Page]
    warnings: list[str]


def decode_text(data: bytes) -> str:
    if data.startswith((b'%PDF-', b'PK\x03\x04', b'MZ', b'\x7fELF', b'\x89PNG')):
        raise DocumentError('File signature does not match plain text')
    try:
        text = data.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise DocumentError('Text must use UTF-8 encoding') from exc
    if '\x00' in text or sum(ord(c) < 32 and c not in '\n\r\t\f' for c in text) > 2:
        raise DocumentError('Binary content is not accepted as text')
    return text.replace('\r\n', '\n')


def parse_document(data: bytes, filename: str, mime: str, settings: Settings) -> Document:
    if not data or len(data) > settings.max_file_bytes:
        raise DocumentError('File is empty or exceeds 10 MiB')
    suffix = Path(filename).suffix.lower()
    allowed = {'.pdf': {'application/pdf', 'application/octet-stream'},
               '.txt': {'text/plain', 'application/octet-stream'},
               '.eml': {'message/rfc822', 'text/plain', 'application/octet-stream'}}
    if suffix not in allowed or mime.split(';')[0].lower() not in allowed[suffix]:
        raise DocumentError('Only matching PDF, UTF-8 TXT, or EML uploads are supported')
    pages: list[Page] = []
    warnings: list[str] = []
    ocr_remaining = settings.max_ocr_pages if settings.ocr_enabled else 0

    def add(text: str, source: str):
        if len(pages) >= settings.max_pages:
            raise DocumentError('Combined page limit exceeded')
        if sum(len(p.text) for p in pages) + len(text) > settings.max_text_chars:
            raise DocumentError('Extracted text limit exceeded')
        pages.append(Page(len(pages) + 1, text, source))

    def pdf(blob: bytes, source: str):
        nonlocal ocr_remaining
        if not blob.startswith(b'%PDF-'):
            raise DocumentError('Invalid PDF signature')
        with tempfile.TemporaryDirectory(prefix='aster-pdf-') as temp:
            path = Path(temp) / 'input.pdf'
            path.write_bytes(blob)
            args = [sys.executable, '-m', 'service.pdf_worker', str(path),
                    str(settings.max_pages - len(pages)), str(settings.max_text_chars),
                    str(ocr_remaining)]
            try:
                result = subprocess.run(args, capture_output=True, timeout=75, check=False)
            except subprocess.TimeoutExpired as exc:
                raise DocumentError('PDF processing time limit exceeded') from exc
            if result.returncode != 0:
                raise DocumentError('PDF could not be processed within safety limits')
            try:
                content = json.loads(result.stdout)
            except (ValueError, UnicodeDecodeError) as exc:
                raise DocumentError('Invalid PDF parser result') from exc
            if content.get('error'):
                raise DocumentError(content['error'])
            warnings.extend(content['warnings'])
            ocr_remaining -= content.get('ocr_pages', 0)
            for page in content['pages']:
                add(page, source)

    if suffix == '.pdf':
        pdf(data, 'document')
    elif suffix == '.txt':
        for text in decode_text(data).split('\f'):
            add(text, 'document')
    else:
        if b'\n' not in data or not any(data.lower().startswith(h) or b'\n' + h in data[:8192].lower()
                                         for h in (b'from:', b'subject:', b'mime-version:')):
            raise DocumentError('Invalid EML header signature')
        message = BytesParser(policy=policy.default).parsebytes(data)
        parts = []
        for part in message.walk():
            parts.append(part)
            if len(parts) > 32:
                raise DocumentError('EML MIME part limit exceeded')
        attachments = 0
        decoded_total = 0
        body = []
        queued = []
        for part in parts:
            if part.get_content_type() == 'message/rfc822':
                raise DocumentError('Nested message attachments are not supported')
            if part.is_multipart():
                continue
            blob = part.get_payload(decode=True) or b''
            decoded_total += len(blob)
            if decoded_total > settings.max_file_bytes:
                raise DocumentError('Decoded attachment size limit exceeded')
            name = part.get_filename()
            if name or part.get_content_disposition() == 'attachment':
                attachments += 1
                if attachments > 8 or len(blob) > 5 * 1024 * 1024:
                    raise DocumentError('Attachment count or size limit exceeded')
                extension = Path(name or '').suffix.lower()
                if extension == '.pdf' and part.get_content_type() in allowed['.pdf']:
                    queued.append(('pdf', blob, f'attachment {attachments}'))
                elif extension == '.txt' and part.get_content_type() in allowed['.txt']:
                    queued.append(('txt', blob, f'attachment {attachments}'))
                else:
                    warnings.append(f'Attachment {attachments} skipped: unsupported type; nothing executed.')
            elif part.get_content_type() == 'text/plain':
                charset = (part.get_content_charset() or 'utf-8').lower()
                if charset not in ('utf-8', 'us-ascii', 'ascii'):
                    warnings.append('Non-UTF-8 email body skipped.')
                else:
                    body.append(decode_text(blob))
            elif part.get_content_type() == 'text/html':
                warnings.append('HTML email body skipped; plain text or a supported attachment is required.')
        add('\n'.join(body), 'email body')
        for kind, blob, source in queued:
            if kind == 'pdf':
                pdf(blob, source)
            else:
                for text in decode_text(blob).split('\f'):
                    add(text, source)
    if not any(p.text.strip() for p in pages):
        warnings.append('No readable text; no facts can be extracted.')
    return Document(pages, warnings)
