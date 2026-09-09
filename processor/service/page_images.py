"""Bounded pixels of a local source PDF, never document URLs or generated art."""
from io import BytesIO
from pathlib import Path

from .ocr_worker import MAX_EDGE, MAX_PIXELS, bounded_scale

MAX_IMAGE_BYTES = 4 * 1024 * 1024


def render_source_page(path: str | Path, index: int, byte_limit: int) -> bytes:
    """Called only inside the CPU/memory/time-limited PDF child process."""
    import pypdfium2 as pdfium

    if not 0 <= index < 40 or not 1 <= byte_limit <= 16 * 1024 * 1024:
        raise ValueError('Invalid source image bounds')
    document = pdfium.PdfDocument(path)
    page = bitmap = None
    image = None
    try:
        if index >= len(document):
            raise ValueError('Invalid source image page')
        page = document[index]
        bitmap = page.render(scale=bounded_scale(*page.get_size()), may_draw_forms=False, rev_byteorder=True)
        if (bitmap.width > MAX_EDGE or bitmap.height > MAX_EDGE
                or bitmap.width * bitmap.height > MAX_PIXELS):
            raise ValueError('Source image pixel limit exceeded')
        image = bitmap.to_pil()
        output = BytesIO()
        image.save(output, format='PNG')
        if output.tell() > min(byte_limit, MAX_IMAGE_BYTES):
            raise ValueError('Source image byte limit exceeded')
        return output.getvalue()
    finally:
        if image is not None:
            image.close()
        if bitmap is not None:
            bitmap.close()
        if page is not None:
            page.close()
        document.close()
