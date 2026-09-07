"""Invoked only with a generated local tempfile; no document-provided commands."""
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys


def main():
    # On Linux this constrains even decompression before text-size checks.
    resource.setrlimit(resource.RLIMIT_CPU, (50, 50))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
    if sys.platform == 'linux':
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
    from pypdf import PdfReader
    path, max_pages, max_chars, ocr_limit = sys.argv[1:]
    max_pages, max_chars, ocr_limit = int(max_pages), int(max_chars), int(ocr_limit)
    reader = PdfReader(path, strict=True)
    if reader.is_encrypted:
        return {'error': 'Encrypted PDFs are not accepted'}
    if len(reader.pages) > max_pages:
        return {'error': 'PDF page limit exceeded'}
    root = reader.trailer['/Root']
    if '/OpenAction' in root or '/AA' in root or '/AcroForm' in root or '/JavaScript' in root.get('/Names', {}) or '/EmbeddedFiles' in root.get('/Names', {}):
        return {'error': 'Active content, forms, or embedded files are not accepted in PDFs'}
    pages, warnings = [], []
    ocr_count = 0
    for index, page in enumerate(reader.pages):
        if '/AA' in page:
            return {'error': 'PDF page actions are not accepted'}
        contents = page.get_contents()
        if contents and len(contents.get_data()) > 12 * 1024 * 1024:
            return {'error': 'PDF content stream limit exceeded'}
        text = page.extract_text() or ''
        if not text.strip():
            if ocr_count < ocr_limit and shutil.which('pdftoppm') and shutil.which('tesseract'):
                ocr_count += 1
                prefix = str(Path(path).parent / f'page-{index}')
                subprocess.run(['pdftoppm', '-f', str(index + 1), '-l', str(index + 1), '-singlefile',
                                '-scale-to', '2000', '-png', path, prefix],
                               check=True, capture_output=True, timeout=12)
                output = subprocess.run(['tesseract', prefix + '.png', 'stdout', '-l', 'eng'],
                                        check=True, capture_output=True, timeout=12,
                                        env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
                text = output.stdout.decode('utf-8')
                warnings.append(f'Page {index + 1} used local OCR; evidence refers to OCR text and requires visual review.')
            else:
                warnings.append(f'Page {index + 1} has no native text; local OCR unavailable, disabled, or page budget exhausted.')
        pages.append(text)
        if sum(map(len, pages)) > max_chars:
            return {'error': 'PDF extracted text limit exceeded'}
    return {'pages': pages, 'warnings': warnings, 'ocr_pages': ocr_count}


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception:
        # Never expose confidential parser contents/paths in the HTTP response.
        print(json.dumps({'error': 'PDF is malformed or exceeded processing limits'}))
