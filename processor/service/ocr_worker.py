"""One bounded local OCR page. Linux uses Tesseract; macOS may use Apple Vision.

References: pypdfium2.readthedocs.io/en/stable/python_api.html,
https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html,
https://developer.apple.com/documentation/vision/recognizing-text-in-images.
No URLs, document commands, cloud SDKs, or remote resource retrieval are accepted.
"""
import importlib.util
import json
import math
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys

MAX_EDGE = 2000
MAX_PIXELS = 4_000_000
MAX_OCR_CHARS = 120_000


def available_backend():
    if not importlib.util.find_spec('pypdfium2') or not importlib.util.find_spec('PIL'):
        return None
    if shutil.which('tesseract'):
        return 'tesseract'
    if sys.platform == 'darwin' and importlib.util.find_spec('Vision'):
        return 'apple-vision'
    return None


def bounded_scale(width, height):
    if not all(math.isfinite(value) and 0 < value <= 14400 for value in (width, height)):
        raise ValueError('OCR page dimensions exceed limits')
    scale = min(200 / 72, (MAX_EDGE - 1) / max(width, height))
    if math.ceil(width * scale) * math.ceil(height * scale) > MAX_PIXELS:
        raise ValueError('OCR pixel limit exceeded')
    return scale


def vision_text(image_bytes, max_chars):
    import Foundation
    import Vision
    data = Foundation.NSData.dataWithBytes_length_(image_bytes, len(image_bytes))
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setRecognitionLanguages_(['en-US'])
    # Preserve source spelling and numbers rather than applying dictionary rewrites.
    request.setUsesLanguageCorrection_(False)
    request.setUsesCPUOnly_(True)
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, {})
    success, error = handler.performRequests_error_([request], None)
    if not success or error is not None:
        raise ValueError('Local OCR failed')
    lines, size = [], 0
    observations = request.results() or []
    if len(observations) > 5000:
        raise ValueError('OCR line limit exceeded')
    for observation in observations:
        candidates = observation.topCandidates_(1)
        if candidates:
            value = str(candidates[0].string())
            size += len(value) + 1
            if size > max_chars:
                raise ValueError('OCR text limit exceeded')
            lines.append(value)
    return '\n'.join(lines)


def recognize_page(path: Path, index: int, max_chars: int):
    import pypdfium2 as pdfium
    if not 0 <= index < 40 or not 1 <= max_chars <= MAX_OCR_CHARS:
        raise ValueError('Invalid OCR bounds')
    backend = available_backend()
    if backend is None:
        raise ValueError('Local OCR backend unavailable')
    document = pdfium.PdfDocument(path)
    page = bitmap = None
    image_path = path.parent / f'ocr-page-{index}.png'
    output_base = path.parent / f'ocr-page-{index}'
    text_path = output_base.with_suffix('.txt')
    try:
        if index >= len(document):
            raise ValueError('Invalid OCR page')
        page = document[index]
        scale = bounded_scale(*page.get_size())
        bitmap = page.render(scale=scale, may_draw_forms=False, rev_byteorder=True)
        if bitmap.width > MAX_EDGE or bitmap.height > MAX_EDGE:
            raise ValueError('OCR render size exceeded')
        image = bitmap.to_pil()
        image.save(image_path, format='PNG')
        if image_path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('OCR image size exceeded')
        if backend == 'tesseract':
            # Output is an inherited-size-limited private file, never an unbounded pipe.
            subprocess.run(['tesseract', str(image_path), str(output_base), '-l', 'eng', '--psm', '3'],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           check=True, timeout=10, env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
            if text_path.stat().st_size > max_chars * 4:
                raise ValueError('OCR text limit exceeded')
            text = text_path.read_text(encoding='utf-8')
        else:
            text = vision_text(image_path.read_bytes(), max_chars)
        if len(text) > max_chars or '\x00' in text:
            raise ValueError('OCR text limit exceeded')
        return {'text': text, 'backend': backend}
    finally:
        if bitmap is not None:
            bitmap.close()
        if page is not None:
            page.close()
        document.close()
        image_path.unlink(missing_ok=True)
        text_path.unlink(missing_ok=True)


def main():
    resource.setrlimit(resource.RLIMIT_CPU, (12, 12))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    if sys.platform == 'linux':
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    path, index, max_chars = sys.argv[1:]
    return recognize_page(Path(path), int(index), int(max_chars))


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception:
        print(json.dumps({'error': 'Local OCR failed or exceeded page limits'}))
