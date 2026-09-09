"""Bounded local decoding. PDFs run in a disposable, time-limited child process."""
from dataclasses import dataclass, field
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
import base64
import binascii
import json
from pathlib import Path
import quopri
import subprocess
import sys
import tempfile
import time

from .config import Settings
from .html_text import html_to_text, HTMLTextError


class DocumentError(ValueError):
    pass


@dataclass
class Page:
    number: int
    text: str
    source: str
    # Alternate views of this exact source page. Text remains the stable evidence
    # view; layout and pixels are reading aids, never model-generated evidence.
    layout_text: str | None = None
    image_png_base64: str | None = field(default=None, repr=False)


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
    visual_remaining = getattr(settings, 'max_visual_pages', 6) if getattr(settings, 'visual_pages_enabled', True) else 0
    visual_bytes_remaining = getattr(settings, 'max_visual_bytes', 8 * 1024 * 1024)
    layout_remaining = settings.max_text_chars
    decode_deadline = time.monotonic() + getattr(settings, 'document_decode_timeout_seconds', 75)

    def remaining_time():
        remaining = decode_deadline - time.monotonic()
        if remaining <= 0:
            raise DocumentError('Document decoding time limit exceeded')
        return remaining

    def add(text: str, source: str, layout_text=None, image_png_base64=None):
        remaining_time()
        if len(pages) >= settings.max_pages:
            raise DocumentError('Combined page limit exceeded')
        if sum(len(p.text) for p in pages) + len(text) > settings.max_text_chars:
            raise DocumentError('Extracted text limit exceeded')
        pages.append(Page(len(pages) + 1, text, source, layout_text, image_png_base64))

    def pdf(blob: bytes, source: str):
        nonlocal ocr_remaining, visual_remaining, visual_bytes_remaining, layout_remaining
        if not blob.startswith(b'%PDF-'):
            raise DocumentError('Invalid PDF signature')
        with tempfile.TemporaryDirectory(prefix='aster-pdf-') as temp:
            path = Path(temp) / 'input.pdf'
            path.write_bytes(blob)
            args = [sys.executable, '-m', 'service.pdf_worker', str(path),
                    str(settings.max_pages - len(pages)), str(settings.max_text_chars - sum(len(p.text) for p in pages)),
                    str(ocr_remaining), str(settings.ocr_enabled).lower(),
                    str(visual_remaining), str(visual_bytes_remaining), str(layout_remaining)]
            try:
                result = subprocess.run(args, capture_output=True, timeout=remaining_time(), check=False)
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
            warnings.extend(f"{source}: {warning}" for warning in content['warnings'])
            ocr_remaining -= content.get('ocr_pages', 0)
            visual_remaining -= content.get('visual_pages', 0)
            visual_bytes_remaining -= content.get('visual_bytes', 0)
            layout_remaining -= content.get('layout_chars', 0)
            ocr_pages = set(content.get('ocr_page_numbers', []))
            layouts = content.get('layout_pages', [])
            images = content.get('page_images', {})
            for index, page in enumerate(content['pages'], 1):
                provenance = f'{source}; PDF page {index}' + ('; local OCR' if index in ocr_pages else '')
                add(page, provenance, layouts[index - 1] if index <= len(layouts) else None,
                    images.get(str(index)))

    if suffix == '.pdf':
        pdf(data, 'document')
    elif suffix == '.txt':
        for text in decode_text(data).split('\f'):
            add(text, 'document')
    else:
        # One budget for the entire message tree, including ignored MIME parts.
        # Nested messages do not receive a fresh upload, OCR, page or time budget.
        attachment_count = part_count = parsed_part_count = decoded_total = 0
        attachment_limit = getattr(settings, 'max_email_attachments', 8)
        part_limit = getattr(settings, 'max_email_parts', 32)
        depth_limit = getattr(settings, 'max_nested_eml_depth', 3)

        def bounded_message_factory(*args, **kwargs):
            # Enforce allocation limits while the email parser is building its
            # tree, not only afterwards while walking an already large tree.
            nonlocal parsed_part_count
            remaining_time()
            parsed_part_count += 1
            if parsed_part_count > part_limit:
                raise DocumentError('EML MIME part limit exceeded')
            return EmailMessage(*args, **kwargs)

        def parse_email_bytes(blob):
            remaining_time()
            header = blob[:8192].lower()
            if b'\n' not in blob or not any(header.startswith(h) or b'\n' + h in header
                                             for h in (b'from:', b'subject:', b'mime-version:')):
                raise DocumentError('Invalid EML header signature')
            try:
                return BytesParser(policy=policy.default.clone(message_factory=bounded_message_factory)).parsebytes(blob)
            except DocumentError:
                raise
            except (ValueError, RecursionError) as exc:
                raise DocumentError('EML is malformed or exceeded nesting limits') from exc

        def account_bytes(blob):
            nonlocal decoded_total
            decoded_total += len(blob)
            if decoded_total > settings.max_file_bytes:
                raise DocumentError('Decoded attachment size limit exceeded')

        def email(message, ancestry='', depth=0):
            nonlocal attachment_count, part_count
            remaining_time()
            if depth > depth_limit:
                raise DocumentError('Nested EML depth limit exceeded')
            parts, stack = [], [(message, 0)]
            while stack:
                part, mime_depth = stack.pop()
                remaining_time()
                part_count += 1
                if part_count > part_limit:
                    raise DocumentError('EML MIME part limit exceeded')
                if mime_depth > 12:
                    raise DocumentError('EML MIME nesting limit exceeded')
                parts.append(part)
                # An attached message owns its body selection and provenance.
                if part.is_multipart() and part.get_content_type() != 'message/rfc822':
                    stack.extend((child, mime_depth + 1) for child in reversed(list(part.iter_parts())))
            queued, decoded_body = [], {}
            for part in parts:
                remaining_time()
                content_type = part.get_content_type()
                nested = content_type == 'message/rfc822'
                if part.is_multipart() and not nested:
                    continue
                blob = part.get_payload(decode=True) or b''
                account_bytes(blob)
                name = part.get_filename()
                if nested or name or part.get_content_disposition() == 'attachment':
                    attachment_count += 1
                    if attachment_count > attachment_limit or len(blob) > 5 * 1024 * 1024:
                        raise DocumentError('Attachment count or size limit exceeded')
                    source = f'{ancestry}attachment {attachment_count}'
                    extension = Path(name or '').suffix.lower()
                    if nested:
                        if depth >= depth_limit:
                            raise DocumentError('Nested EML depth limit exceeded')
                        children = part.get_payload()
                        if not isinstance(children, list) or len(children) != 1:
                            raise DocumentError('Nested EML must contain exactly one message')
                        child = children[0]
                        transfer = (part.get('Content-Transfer-Encoding') or '').lower()
                        if transfer in ('base64', 'quoted-printable'):
                            # Some mail exporters encode RFC822 despite the MIME
                            # restriction. Decode the encapsulated body only.
                            encoded = child.get_payload()
                            if child.items() or not isinstance(encoded, str):
                                raise DocumentError('Invalid encoded nested EML')
                            try:
                                wire = encoded.encode('ascii')
                                nested_blob = (base64.b64decode(b''.join(wire.split()), validate=True)
                                               if transfer == 'base64' else quopri.decodestring(wire))
                            except (UnicodeError, ValueError, binascii.Error) as exc:
                                raise DocumentError('Invalid encoded nested EML') from exc
                            if len(nested_blob) > 5 * 1024 * 1024:
                                raise DocumentError('Attachment count or size limit exceeded')
                            account_bytes(nested_blob)
                            child = parse_email_bytes(nested_blob)
                        else:
                            # Includes nested headers and MIME framing in the
                            # shared decoded-byte budget. Serialization is only
                            # for size accounting, never the stored original.
                            try:
                                nested_blob = child.as_bytes()
                            except (ValueError, RecursionError) as exc:
                                raise DocumentError('Nested EML is malformed') from exc
                            if len(nested_blob) > 5 * 1024 * 1024:
                                raise DocumentError('Attachment count or size limit exceeded')
                            account_bytes(nested_blob)
                        queued.append(('eml', child, source))
                    elif extension == '.eml' and content_type in allowed['.eml']:
                        if depth >= depth_limit:
                            raise DocumentError('Nested EML depth limit exceeded')
                        queued.append(('eml', parse_email_bytes(blob), source))
                    elif extension == '.pdf' and content_type in allowed['.pdf']:
                        queued.append(('pdf', blob, source))
                    elif extension == '.txt' and content_type in allowed['.txt']:
                        queued.append(('txt', blob, source))
                    else:
                        warnings.append(f'{source.capitalize()} skipped: unsupported type; nothing executed.')
                elif content_type in ('text/plain', 'text/html'):
                    charset = (part.get_content_charset() or 'utf-8').lower()
                    if charset not in ('utf-8', 'us-ascii', 'ascii', 'iso-8859-1', 'latin-1', 'windows-1252', 'cp1252'):
                        warnings.append(f'{ancestry}Email body part skipped: unsupported character encoding.')
                        continue
                    try:
                        decoded_body[id(part)] = decode_text(blob.decode(charset).encode('utf-8'))
                    except (UnicodeError, DocumentError):
                        warnings.append(f'{ancestry}Email body part skipped: invalid text encoding.')

            def body_parts(part):
                if part.get_content_type() == 'message/rfc822' or part.get_filename() or part.get_content_disposition() == 'attachment':
                    return []
                if not part.is_multipart():
                    return [part] if decoded_body.get(id(part), '').strip() else []
                children = list(part.iter_parts())
                if part.get_content_subtype() == 'related':
                    start = part.get_param('start')
                    root = next((child for child in children if start and child.get('Content-ID') == start),
                                children[0] if children else None)
                    return body_parts(root) if root is not None else []
                choices = [body_parts(child) for child in children]
                if part.get_content_subtype() == 'alternative':
                    for preferred in ('text/plain', 'text/html'):
                        for choice in choices:
                            if any(child.get_content_type() == preferred for child in choice):
                                return choice
                    return []
                return [child for choice in choices for child in choice]

            body, body_size = [], 0
            for part in body_parts(message):
                remaining_time()
                text = decoded_body[id(part)]
                if part.get_content_type() == 'text/html':
                    try:
                        text = html_to_text(text, settings.max_text_chars - body_size)
                    except HTMLTextError as exc:
                        raise DocumentError(str(exc)) from exc
                    warnings.append(f'{ancestry}HTML email body converted locally to visible text; scripts, styles and remote resources were not loaded.')
                body_size += len(text) + (1 if body else 0)
                if body_size > settings.max_text_chars:
                    raise DocumentError('Extracted text limit exceeded')
                body.append(text)
            add('\n'.join(body), f'{ancestry}email body')
            for kind, blob, source in queued:
                if kind == 'pdf':
                    pdf(blob, source)
                elif kind == 'eml':
                    before = decoded_total
                    email(blob, f'{source}; ', depth + 1)
                    if decoded_total - before > 5 * 1024 * 1024:
                        raise DocumentError('Attachment count or size limit exceeded')
                else:
                    for text in decode_text(blob).split('\f'):
                        add(text, source)

        email(parse_email_bytes(data))
    if not any(p.text.strip() for p in pages):
        warnings.append('No readable text; source images require visual review before any facts can be accepted.'
                        if any(p.image_png_base64 for p in pages)
                        else 'No readable text; no facts can be extracted.')
    return Document(pages, warnings)
