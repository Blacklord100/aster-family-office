"""Invoked only with a generated local tempfile; no document-provided commands."""
import base64
import json
import re
import resource
import subprocess
import sys
import time

from .ocr_worker import available_backend
from .page_images import render_source_page


def needs_visual_view(text, layout, had_native_text):
    """Keep visual work for scans and pages whose spatial structure matters."""
    if not had_native_text:
        return True
    if '|' in text or '\t' in text:
        return True
    if layout and any(re.search(r'\S {3,}\S', line) for line in layout.splitlines()):
        return True
    # Multiple amounts/percentages frequently indicate a table, even if pypdf
    # has collapsed its columns. This is a reading heuristic, never a fact rule.
    return len(re.findall(r'\d[\d,.]*[.,]\d{2}\b|\d+(?:[.,]\d+)?\s*%', text)) >= 3


def extract_pdf(path, max_pages, max_chars, ocr_limit, ocr_requested=None,
                visual_limit=0, visual_bytes_limit=8 * 1024 * 1024, layout_chars_limit=None):
    from pypdf import PdfReader
    if ocr_requested is None:
        ocr_requested = bool(ocr_limit)
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted:
        return {'error': 'Encrypted PDFs are not accepted'}
    if len(reader.pages) > max_pages:
        return {'error': 'PDF page limit exceeded'}
    root = reader.trailer['/Root']
    if '/OpenAction' in root or '/AA' in root or '/AcroForm' in root or '/JavaScript' in root.get('/Names', {}) or '/EmbeddedFiles' in root.get('/Names', {}):
        return {'error': 'Active content, forms, or embedded files are not accepted in PDFs'}
    pages, warnings, ocr_page_numbers, layout_pages = [], [], [], []
    page_images = {}
    ocr_count = 0
    total_chars = layout_chars = visual_count = visual_bytes = 0
    if layout_chars_limit is None:
        layout_chars_limit = max_chars
    ocr_deadline = time.monotonic() + 60
    backend = available_backend() if ocr_limit else None
    for index, page in enumerate(reader.pages):
        if '/AA' in page:
            return {'error': 'PDF page actions are not accepted'}
        contents = page.get_contents()
        if contents and len(contents.get_data()) > 12 * 1024 * 1024:
            return {'error': 'PDF content stream limit exceeded'}
        text = page.extract_text() or ''
        had_native_text = bool(text.strip())
        layout = None
        if had_native_text:
            if layout_chars >= layout_chars_limit:
                warnings.append(f'PDF page {index + 1}: layout text budget exhausted; original text retained.')
            else:
                try:
                    candidate = page.extract_text(extraction_mode='layout', layout_mode_space_vertically=False) or ''
                    if len(candidate) <= layout_chars_limit - layout_chars:
                        layout = candidate
                        layout_chars += len(candidate)
                    else:
                        warnings.append(f'PDF page {index + 1}: layout text exceeded its bounded budget; original text retained.')
                except Exception:
                    warnings.append(f'PDF page {index + 1}: layout text unavailable; original text retained.')
        if not text.strip():
            remaining = ocr_deadline - time.monotonic()
            if ocr_count < ocr_limit and backend and remaining > 1 and max_chars > total_chars:
                ocr_count += 1
                try:
                    result = subprocess.run(
                        [sys.executable, '-m', 'service.ocr_worker', path, str(index), str(max_chars - total_chars)],
                        capture_output=True, timeout=min(15, remaining), check=False)
                    if result.returncode or len(result.stdout) > (max_chars - total_chars) * 6 + 4096:
                        raise ValueError('OCR result limit exceeded')
                    content = json.loads(result.stdout)
                    if content.get('error') or not isinstance(content.get('text'), str):
                        raise ValueError('OCR result unavailable')
                    text = content['text']
                    if len(text) > max_chars - total_chars:
                        raise ValueError('OCR text limit exceeded')
                    ocr_page_numbers.append(index + 1)
                    warnings.append(f'PDF page {index + 1} used local OCR ({backend}); evidence quotes OCR text and requires visual review.')
                    if not text.strip():
                        warnings.append(f'PDF page {index + 1}: local OCR found no readable text.')
                except (subprocess.TimeoutExpired, ValueError, UnicodeDecodeError):
                    text = ''
                    warnings.append(f'PDF page {index + 1}: local OCR failed or exceeded its bounded page budget; no text was inferred.')
            else:
                reason = ('disabled' if not ocr_requested else 'page budget exhausted' if ocr_count >= ocr_limit
                          else 'unavailable' if not backend else 'page or time budget exhausted')
                warnings.append(f'PDF page {index + 1} has no native text; local OCR {reason}.')
        pages.append(text)
        layout_pages.append(layout)
        total_chars += len(text)
        if total_chars > max_chars:
            return {'error': 'PDF extracted text limit exceeded'}
        if needs_visual_view(text, layout, had_native_text):
            if visual_count >= visual_limit or visual_bytes >= visual_bytes_limit:
                warnings.append(f'PDF page {index + 1}: source image not prepared; visual page/byte budget unavailable or exhausted.')
            elif ocr_deadline - time.monotonic() <= 1:
                warnings.append(f'PDF page {index + 1}: source image not prepared; decoding time budget exhausted.')
            else:
                # Spend the page budget on attempts too; a malicious render
                # cannot make the following pages receive unlimited attempts.
                visual_count += 1
                try:
                    pixels = render_source_page(path, index, visual_bytes_limit - visual_bytes)
                    visual_bytes += len(pixels)
                    page_images[str(index + 1)] = base64.b64encode(pixels).decode('ascii')
                except Exception:
                    warnings.append(f'PDF page {index + 1}: source image rendering failed or exceeded bounds; text retained.')
    return {'pages': pages, 'warnings': warnings, 'ocr_pages': ocr_count, 'ocr_page_numbers': ocr_page_numbers,
            'layout_pages': layout_pages, 'layout_chars': layout_chars, 'page_images': page_images,
            'visual_pages': visual_count, 'visual_bytes': visual_bytes}


def main():
    # Limits apply before native PDF decoding or rendering starts.
    resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
    if sys.platform == 'linux':
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    path, max_pages, max_chars, ocr_limit, *requested = sys.argv[1:]
    return extract_pdf(path, int(max_pages), int(max_chars), int(ocr_limit),
                       requested[0] == 'true' if requested else None,
                       int(requested[1]) if len(requested) > 1 else 0,
                       int(requested[2]) if len(requested) > 2 else 8 * 1024 * 1024,
                       int(requested[3]) if len(requested) > 3 else int(max_chars))


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception:
        # Never expose confidential parser contents/paths in the HTTP response.
        print(json.dumps({'error': 'PDF is malformed or exceeded processing limits'}))
