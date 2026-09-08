"""Bounded HTML-to-visible-text conversion; never renders or retrieves resources."""
from html.parser import HTMLParser
import re


class HTMLTextError(ValueError):
    pass


BLOCKS = frozenset({'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd',
                    'fieldset', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4',
                    'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
                    'section', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul'})
VOID = frozenset({'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
                  'meta', 'param', 'source', 'track', 'wbr'})
SUPPRESSED = frozenset({'script', 'style', 'head', 'template', 'noscript', 'iframe',
                        'object', 'embed', 'svg', 'math', 'audio', 'video', 'canvas'})


class _VisibleText(HTMLParser):
    def __init__(self, max_chars: int, max_depth: int, max_elements: int):
        super().__init__(convert_charrefs=True)
        self.max_chars, self.max_depth, self.max_elements = max_chars, max_depth, max_elements
        self.stack: list[tuple[str, bool]] = []
        self.chunks: list[str] = []
        self.size = 0
        self.elements = 0

    @property
    def suppressed(self):
        return bool(self.stack and self.stack[-1][1])

    def append(self, value: str):
        if not value:
            return
        self.size += len(value)
        if self.size > self.max_chars:
            raise HTMLTextError('HTML visible text limit exceeded')
        self.chunks.append(value)

    def separator(self, value='\n'):
        if not self.chunks:
            return
        if value == '\n':
            if not self.chunks[-1].endswith('\n'):
                self.append(value)
        elif not self.chunks[-1].endswith(('\n', '\t')):
            self.append(value)

    def handle_starttag(self, tag, attrs):
        self.elements += 1
        if self.elements > self.max_elements:
            raise HTMLTextError('HTML element limit exceeded')
        attrs = dict(attrs)
        css = re.sub(r'\s+', '', (attrs.get('style') or '').lower())
        hidden = ('hidden' in attrs or (attrs.get('aria-hidden') or '').lower() == 'true'
                  or re.search(r'(?:^|;)(?:display:none|visibility:(?:hidden|collapse))(?:!important)?(?:;|$)', css))
        suppressed = self.suppressed or tag in SUPPRESSED or bool(hidden)
        if not suppressed:
            if tag in BLOCKS or tag == 'br':
                self.separator()
            elif tag in ('td', 'th'):
                self.separator('\t')
        if tag not in VOID:
            if len(self.stack) >= self.max_depth:
                raise HTMLTextError('HTML nesting limit exceeded')
            self.stack.append((tag, suppressed))

    def handle_startendtag(self, tag, attrs):
        # HTML does not make script/style safe by writing a self-closing slash.
        # Keep suppression until an explicit end tag rather than leaking its text.
        self.handle_starttag(tag, attrs)
        if tag not in SUPPRESSED or tag in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        was_suppressed = self.suppressed
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index][0] == tag:
                del self.stack[index:]
                break
        if not was_suppressed:
            if tag in BLOCKS:
                self.separator()
            elif tag in ('td', 'th'):
                self.separator('\t')

    def handle_data(self, data):
        if not self.suppressed:
            # Preserve visible text and paragraph/table boundaries; decode entities once.
            self.append(re.sub(r'[\t\r\n\f\v ]+', ' ', data).replace('\xa0', ' '))


def html_to_text(html: str, max_chars: int, *, max_input_chars=1_000_000,
                 max_depth=128, max_elements=20_000) -> str:
    if len(html) > max_input_chars:
        raise HTMLTextError('HTML input limit exceeded')
    parser = _VisibleText(max_chars, max_depth, max_elements)
    parser.feed(html)
    parser.close()
    text = ''.join(parser.chunks)
    text = re.sub(r'[ \t]*\n[ \t]*', '\n', text)
    text = re.sub(r' *\t *', '\t', text)
    text = re.sub(r'\n+', '\n', text)
    return text.strip()
