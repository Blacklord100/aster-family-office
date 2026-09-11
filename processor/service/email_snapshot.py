"""Deterministic local email copies: text and pixels, never a browser or a model.

The caller retains the original EML. Rendered pages are a bounded reading aid;
canonicalText retains all accepted, sanitized text even when pages truncate.
"""
import base64
from functools import lru_cache
import hashlib
from io import BytesIO
from pathlib import Path
import time
import unicodedata
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from .html_text import html_to_text, HTMLTextError

REQUEST_BYTES = 512 * 1024
INPUT_CHARS = 200_000
MAX_PAGES = 8
WIDTH, HEIGHT = 1240, 1754
MAX_ARTIFACT_BYTES = 12 * 1024 * 1024
MAX_RESPONSE_BYTES = 18 * 1024 * 1024
RENDERER_VERSION = 'aster-email-copy-v1'
COPY_NOTICE = 'Rendered email copy; original.eml retained'


class SnapshotHeader(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    name: str = Field(min_length=1, max_length=78, pattern=r'^[A-Za-z0-9-]+$')
    value: str = Field(max_length=4096)


class EmailSnapshotRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    schemaVersion: Literal[1] = 1
    headers: list[SnapshotHeader] = Field(default_factory=list, max_length=32)
    textBody: str | None = Field(default=None, max_length=INPUT_CHARS)
    htmlBody: str | None = Field(default=None, max_length=INPUT_CHARS)
    attachmentNames: list[str] = Field(default_factory=list, max_length=64)
    sourceSha256: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')

    @model_validator(mode='after')
    def bounded_text(self):
        if any(len(name) > 1024 for name in self.attachmentNames):
            raise ValueError('Attachment name limit exceeded')
        size = sum(len(h.name) + len(h.value) for h in self.headers)
        size += len(self.textBody or '') + len(self.htmlBody or '')
        size += sum(len(name) for name in self.attachmentNames)
        if size > INPUT_CHARS:
            raise ValueError('Combined email text limit exceeded')
        return self


class SnapshotArtifact(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    base64: str = Field(max_length=MAX_RESPONSE_BYTES)
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')


class SnapshotPage(SnapshotArtifact):
    page: int = Field(ge=1, le=MAX_PAGES)
    width: Literal[1240] = WIDTH
    height: Literal[1754] = HEIGHT


class EmailSnapshotResult(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    schemaVersion: Literal[1] = 1
    rendererVersion: Literal['aster-email-copy-v1'] = RENDERER_VERSION
    canonicalText: str = Field(max_length=INPUT_CHARS * 10 + 4096)
    warnings: list[str] = Field(max_length=12)
    truncated: bool
    pageCount: int = Field(ge=1, le=MAX_PAGES)
    fontProfile: str = Field(max_length=160)
    pngPages: list[SnapshotPage] = Field(min_length=1, max_length=MAX_PAGES)
    pdf: SnapshotArtifact


def escaped(character: str) -> str:
    code = ord(character)
    return f'\\u{code:04X}' if code <= 0xFFFF else f'\\U{code:08X}'


def sanitize(value: str, *, single_line=False) -> tuple[str, bool]:
    """Expose control/bidi/zero-width characters; forbid injected header lines."""
    value = value.replace('\r\n', '\n').replace('\r', '\n')
    output, changed = [], False
    for character in value:
        if character == '\n' and not single_line:
            output.append(character)
        elif character == '\t' and not single_line:
            output.append('    ')
        elif (unicodedata.category(character).startswith('C')
              or character in ('\u2028', '\u2029') or (single_line and character == '\n')):
            output.append(escaped(character))
            changed = True
        else:
            output.append(character)
    return ''.join(output), changed


def canonical_email(query: EmailSnapshotRequest) -> tuple[str, list[str]]:
    warnings = []
    changed = False

    def clean(value, single_line=False):
        nonlocal changed
        result, replaced = sanitize(value, single_line=single_line)
        changed |= replaced
        return result

    sections = [COPY_NOTICE, 'This is a text rendering, not a screenshot of the original mailbox.']
    if query.sourceSha256:
        sections += ['Original EML SHA-256 (provided by archive):', query.sourceSha256]
    sections += ['', 'EMAIL HEADERS']
    sections += [h.name + ': ' + clean(h.value, True) for h in query.headers] or ['(No headers supplied)']
    sections += ['', 'ATTACHMENTS (names only; contents are separate originals)']
    sections += ['- ' + clean(name, True) for name in query.attachmentNames] or ['(None supplied)']
    if query.textBody is not None and query.textBody.strip():
        body = query.textBody
        if query.htmlBody:
            warnings.append('Plain text body selected; alternate HTML was not rendered.')
    elif query.htmlBody:
        try:
            body = html_to_text(query.htmlBody, INPUT_CHARS, max_input_chars=INPUT_CHARS)
            warnings.append('HTML converted to visible text. Styling, hidden content and remote resources were not rendered.')
        except HTMLTextError:
            body = '(HTML body could not be converted within safety limits; inspect original.eml.)'
            warnings.append('HTML body omitted after a safety limit. The original EML is required for complete review.')
    else:
        body = query.textBody or '(No readable body supplied)'
    sections += ['', 'EMAIL BODY', clean(body)]
    if changed:
        warnings.append('Control, invisible or directional formatting characters are displayed as Unicode escapes.')
    return '\n'.join(sections) + '\n', warnings


def _fonts(force_bitmap=False):
    from PIL import Image, ImageFont, features
    if not force_bitmap and features.check('freetype2'):
        # Fixed installation paths only; the request cannot select a font or path.
        for name in ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
                     '/System/Library/Fonts/Supplemental/Arial.ttf'):
            path = Path(name)
            if path.is_file():
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                return ImageFont.truetype(name, 24), ImageFont.truetype(name, 36), 'truetype:' + path.name + ':' + digest
        return ImageFont.load_default(size=24), ImageFont.load_default(size=36), 'pillow-bundled-aileron-v1'

    class ScaledBitmapFont(ImageFont.ImageFont):
        def __init__(self, scale):
            self.base = ImageFont.load_default_imagefont()
            self.scale = scale

        def getmask(self, text, mode='', *args, **kwargs):
            mask = self.base.getmask(text, 'L')
            if not all(mask.size):
                return mask
            im = Image.frombytes('L', mask.size, bytes(mask))
            return im.resize((im.width * self.scale, im.height * self.scale), Image.Resampling.NEAREST).im

        def getbbox(self, text, *args, **kwargs):
            return tuple(value * self.scale for value in self.base.getbbox(text))

        def getlength(self, text, *args, **kwargs):
            return self.base.getlength(text) * self.scale

    # The pinned minimal runtime intentionally omits FreeType. Its built-in font
    # stays readable at 2x; unsupported characters are escaped, never dropped.
    return ScaledBitmapFont(2), ScaledBitmapFont(3), 'pillow-bundled-bitmap-v1'


def _display_text(text, font, bitmap=False):
    missing = font.getmask('\U0010FFFF') if not bitmap else None
    missing_identity = (missing.size, bytes(missing)) if missing is not None else None

    @lru_cache(maxsize=4096)
    def visible(character):
        if character == '\n' or 32 <= ord(character) <= 126:
            return character
        if bitmap:
            # Restrict bitmap fallback to explicit ASCII rather than platform-
            # dependent Latin-1 glyphs or silent missing-character replacement.
            return escaped(character)
        mask = font.getmask(character)
        if (mask.size, bytes(mask)) == missing_identity:
            return escaped(character)
        return character

    result = ''.join(visible(character) for character in text)
    return result, result != text


def _wrapped_lines(text, font, width, limit):
    """Bounded wrapping, including single adversarially long words/combining runs."""
    lines = []
    for paragraph in text.split('\n'):
        if not paragraph:
            lines.append('')
        while paragraph:
            # A hard codepoint cap also bounds shaping work when combining marks
            # have no width. Every iteration consumes at least one character.
            maximum = min(len(paragraph), 160)
            lo, hi = 1, maximum
            while lo < hi:
                middle = (lo + hi + 1) // 2
                if font.getlength(paragraph[:middle]) <= width:
                    lo = middle
                else:
                    hi = middle - 1
            take = lo
            if take < len(paragraph):
                space = paragraph.rfind(' ', 0, take + 1)
                if space > take // 2:
                    take = space + 1
            lines.append(paragraph[:take].rstrip())
            paragraph = paragraph[take:]
            if len(lines) > limit:
                return lines[:limit], True
        if len(lines) > limit:
            return lines[:limit], True
    return lines, False


class _BoundedBuffer(BytesIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit

    def write(self, value):
        if self.tell() + len(value) > self.limit:
            raise ValueError('Email copy artifact byte limit exceeded')
        return super().write(value)


def render_email_snapshot(query: EmailSnapshotRequest, *, force_bitmap=False) -> EmailSnapshotResult:
    from PIL import Image, ImageDraw
    started = time.monotonic()
    canonical, warnings = canonical_email(query)
    font, heading_font, profile = _fonts(force_bitmap)
    # The first two canonical provenance lines appear in the fixed page header.
    display, escaped_glyphs = _display_text(canonical.split('\n', 2)[2], font, 'bitmap' in profile)
    if escaped_glyphs:
        warnings.append('Some characters are shown as Unicode escapes because the installed font lacks their glyphs; canonical text retains Unicode.')
    line_height, content_top, content_bottom, margin = 34, 238, 1506, 76
    lines_per_page = (content_bottom - content_top) // line_height
    lines, truncated = _wrapped_lines(display, font, WIDTH - 2 * margin, MAX_PAGES * lines_per_page)
    if truncated:
        warnings.append('Rendered pages truncated at 8 pages; complete accepted text is retained in canonicalText and original.eml.')
    page_count = max(1, (len(lines) + lines_per_page - 1) // lines_per_page)
    images, png_pages, byte_count = [], [], 0
    try:
        for index in range(page_count):
            if time.monotonic() - started > 15:
                raise ValueError('Email copy rendering time limit exceeded')
            im = Image.new('RGB', (WIDTH, HEIGHT), 'white')
            images.append(im)
            draw = ImageDraw.Draw(im)
            draw.rectangle((0, 0, WIDTH, 12), fill='#293E3A')
            draw.text((margin, 58), 'ASTER / EMAIL ARCHIVE', font=heading_font, fill='#233A35')
            draw.text((margin, 124), COPY_NOTICE, font=font, fill='#34433F')
            draw.text((margin, 167), 'Text rendering, not a mailbox screenshot. Attachments retained separately.', font=font, fill='#606B67')
            draw.line((margin, 209, WIDTH - margin, 209), fill='#D5DEDA', width=2)
            for offset, line in enumerate(lines[index * lines_per_page:(index + 1) * lines_per_page]):
                if line:
                    draw.text((margin, content_top + offset * line_height), line, font=font, fill='#172923')
            draw.line((margin, 1535, WIDTH - margin, 1535), fill='#D5DEDA', width=2)
            notes = []
            if truncated:
                notes.append('TRUNCATED COPY - read canonical text and original.eml for the complete email.')
            if escaped_glyphs:
                notes.append('Font coverage: unsupported characters shown as Unicode escapes.')
            if warnings and not notes:
                notes.append('Copy has rendering notes; see warnings in the archive manifest.')
            for offset, note in enumerate(notes[:2]):
                # Small, fixed wording has a separate bounded wrap budget.
                note_lines, _ = _wrapped_lines(note, font, WIDTH - 2 * margin, 2)
                for row, note_line in enumerate(note_lines):
                    draw.text((margin, 1558 + offset * 62 + row * 28), note_line, font=font, fill='#745728')
            draw.text((margin, 1686), f'{RENDERER_VERSION}  |  Page {index + 1} of {page_count}', font=font, fill='#68736E')
            png = _BoundedBuffer(MAX_ARTIFACT_BYTES - byte_count)
            im.save(png, format='PNG', optimize=False, compress_level=6)
            raw = png.getvalue(); byte_count += len(raw)
            png_pages.append(SnapshotPage(page=index + 1, base64=base64.b64encode(raw).decode('ascii'), sha256=hashlib.sha256(raw).hexdigest()))
        pdf = _BoundedBuffer(MAX_ARTIFACT_BYTES - byte_count)
        # No generated timestamp, random ID, filesystem name or active PDF
        # elements. Equal inputs and renderer/font versions produce equal bytes.
        fixed_date = time.gmtime(0)
        images[0].save(pdf, format='PDF', save_all=True, append_images=images[1:],
                       resolution=150.0, quality=95, subsampling=0,
                       title=COPY_NOTICE, author='Aster', creator=RENDERER_VERSION,
                       creationDate=fixed_date, modDate=fixed_date)
        raw_pdf = pdf.getvalue()
        result = EmailSnapshotResult(canonicalText=canonical, warnings=warnings, truncated=truncated,
                                     pageCount=page_count, fontProfile=profile, pngPages=png_pages,
                                     pdf=SnapshotArtifact(base64=base64.b64encode(raw_pdf).decode('ascii'), sha256=hashlib.sha256(raw_pdf).hexdigest()))
        if len(result.model_dump_json().encode()) > MAX_RESPONSE_BYTES:
            raise ValueError('Email copy response byte limit exceeded')
        return result
    finally:
        for im in images:
            im.close()
