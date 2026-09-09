"""Read-only tools scoped to one decoded, authorized document.

Source IDs identify immutable native/OCR text spans, not model transcriptions.
Layout and page images aid interpretation but cannot manufacture evidence.
"""
from dataclasses import dataclass
from hashlib import sha256
import re
import unicodedata
from pydantic import Field
from .documents import Document, Page
from .schema import Fact, ReferencedFact, StrictModel
from .source_parsing import CURRENCIES, date_mentions, mask_instructions, money_mentions
from .source_events import _date_role, _table_cells, _table_header


@dataclass(frozen=True)
class SourceBlock:
    source_id: str
    page: int
    text: str

    def payload(self):
        return {'sourceId': self.source_id, 'page': self.page, 'text': self.text}


class SourceCandidates(StrictModel):
    facts: list[ReferencedFact] = Field(max_length=30)


def utf8_prefix(text: str, maximum: int) -> str:
    """Bound model input without splitting a Unicode codepoint."""
    return text.encode('utf-8')[:maximum].decode('utf-8', errors='ignore')


def source_blocks(page: Page) -> list[SourceBlock]:
    blocks, start = [], 0
    while start < len(page.text):
        end = start + len(utf8_prefix(page.text[start:start + 2800], 2800))
        if end < len(page.text):
            boundary = page.text.rfind('\n', start + 1800, end)
            if boundary > start:
                end = boundary
        text = page.text[start:end]
        if len(text.strip()) >= 8:
            digest = sha256(text.encode()).hexdigest()[:12]
            blocks.append(SourceBlock(f'p{page.number}-s{start}-{digest}', page.number, text))
        if end == len(page.text):
            break
        # Keep overlap bounded in bytes too, so multilingual windows make
        # progress without multiplying model calls unnecessarily.
        overlap = len(page.text[max(start, end - 350):end].encode('utf-8')[-350:].decode('utf-8', errors='ignore'))
        start = max(start + 1, end - overlap)
    return blocks


SOURCE_DATE_LIMIT = 32


def _source_date_inventory(block: SourceBlock) -> list[dict[str,str]]:
    # Only literal, valid calendar dates from the untrusted-data view. This is
    # format discovery, not effective/due role assignment or a model correction.
    unique = {}
    for mention in date_mentions(mask_instructions(block.text)):
        unique.setdefault(mention.value,{'value':mention.value,'sourceText':mention.raw})
        if len(unique) > SOURCE_DATE_LIMIT:
            break
    return list(unique.values())


def source_date_options(block: SourceBlock) -> list[dict[str,str]]:
    """At most 32 source-provided ISO spellings for model reading assistance."""
    return _source_date_inventory(block)[:SOURCE_DATE_LIMIT]


def _deadline_options(text: str, all_values: list[str]) -> list[str]:
    # Use the same date-role witness as independent grounding. Inspect every
    # occurrence before deduplicating: one ISO date can be both a notice date
    # and a deadline in separate clauses.
    values = {mention.value for mention in date_mentions(text) if _date_role(text,mention) == 'due'}
    cells = _table_cells(text)
    # Flattened/wide table headers may be far from their row dates. Preserve all
    # literal date options when the header role cannot safely attach to a date;
    # the source row/owner validator still decides whether a candidate is valid.
    for cell,_,_ in cells:
        for part in re.split(r' {2,}',cell):
            header = _table_header(part)
            if header and header[0] == 'due':
                return all_values
    return [value for value in all_values if value in values]


def _currency_options(text: str, allowed: list[str]) -> list[str] | None:
    # Literal codes may be standalone header/table cells. The money parser is
    # the authority for recognized currency glyphs; a bare dollar stays unknown.
    known = set(CURRENCIES.split('|'))
    literal = {match.group().upper() for match in re.finditer(r'\b(?:' + CURRENCIES + r')\b',text,re.I)}
    literal.update(mention.currency for mention in money_mentions(text) if mention.currency)
    # Do not invent a mapping for an unsupported/ambiguous glyph or silently
    # narrow a future schema currency that the lexical inventory cannot read.
    if (any(unicodedata.category(character) == 'Sc' and character not in '€£$' for character in text)
            or any(code not in known and re.search(r'\b'+re.escape(code)+r'\b',text,re.I) for code in allowed)):
        return None
    return [code for code in allowed if code in literal]


def _constrain_optional_field(fields: dict, key: str, values: list[str], description: str):
    if values:
        for alternative in fields[key]['anyOf']:
            if alternative.get('type') == 'string':
                alternative['enum'] = values
        fields[key]['description'] = description
    else:
        fields[key] = {'title':fields[key].get('title',key),'type':'null','description':description}


def candidate_schema(block: SourceBlock) -> dict:
    schema = SourceCandidates.model_json_schema()
    properties = schema['$defs']['SourceReference']['properties']
    properties['sourceId']['enum'] = [block.source_id]
    properties['page']['enum'] = [block.page]
    safe = mask_instructions(block.text)
    fields = schema['$defs']['ReferencedFact']['properties']
    currency_branch = next(branch for branch in fields['currency']['anyOf'] if branch.get('type') == 'string')
    currencies = _currency_options(safe,currency_branch['enum'])
    if currencies is not None:
        _constrain_optional_field(fields,'currency',currencies,
            'Use a literal recognized source currency or null. A bare dollar symbol does not identify USD or another dollar currency; source owner and amount roles still require verification.')
    else:
        schema['$comment'] = 'Source currency inventory is uncertain; the original allowed currency enum is retained.'
    dates = _source_date_inventory(block)
    if len(dates) > SOURCE_DATE_LIMIT:
        # Never silently remove a valid 33rd/later source date. Keep the normal
        # strict ISO schema and explicitly report that the hint list is bounded.
        schema['$comment'] = (schema.get('$comment','')+' Source date inventory exceeds 32 unique dates; sourceDates is truncated and ISO date fields remain unconstrained by source enumeration.').strip()
        return schema
    date_values = [option['value'] for option in dates]
    # Enums stay on the string branches, retaining strict ISO patterns and null.
    _constrain_optional_field(fields,'effectiveDate',date_values,
        'Use a literal valid source calendar date in ISO form or null; reporting/event date roles still require verification.' if date_values else
        'No explicit valid calendar date occurs in this source block.')
    _constrain_optional_field(fields,'dueDate',_deadline_options(safe,date_values),
        'Use only a source-supported contractual payment deadline, or null. An event, valuation, payout or notice date is not itself a deadline. Table-header date options still require row/owner verification.')
    return schema


def resolve_candidate(candidate, blocks: list[SourceBlock]) -> Fact:
    if isinstance(candidate, Fact) and not isinstance(candidate, ReferencedFact):
        return candidate  # Legacy quote still goes through independent grounding.
    block = next((b for b in blocks if b.source_id == candidate.evidence.sourceId
                  and b.page == candidate.evidence.page), None)
    if block is None:
        raise ValueError('unknown_source_reference')
    return Fact.model_validate({**candidate.model_dump(), 'evidence': {'page': block.page, 'quote': block.text}})


class DocumentTools:
    def __init__(self, document: Document):
        self.pages = {page.number: page for page in document.pages}
        self.blocks = {number: source_blocks(page) for number, page in self.pages.items()}

    def read_page(self, number: int):
        page = self.pages[number]
        return {'page': number, 'source': page.source, 'preview': page.text[:1800],
                'textCharacters': len(page.text), 'sourceBlocks': len(self.blocks[number]),
                'hasLayout': bool(page.layout_text), 'hasImage': bool(page.image_png_base64)}

    def search(self, query: str, page: int | None = None):
        # Literal search only, no path, URL, shell, regex, or cross-document access.
        if not isinstance(query, str) or not 1 <= len(query) <= 160 or not query.strip():
            raise ValueError('invalid_document_search')
        query = query.strip()
        hits = []
        for number, source in self.pages.items():
            if page is not None and number != page:
                continue
            for match in re.finditer(re.escape(query), source.text, flags=re.I):
                if len(hits) >= 8:
                    break
                hits.append({'page': number, 'offset': match.start(),
                             'text': source.text[max(0, match.start() - 160):match.end() + 240]})
        return {'query': query, 'hits': hits, 'limit': 8}

    def inspect_layout(self, number: int):
        page = self.pages[number]
        return {'page': number, 'layout': (page.layout_text or '')[:6000],
                'available': bool(page.layout_text), 'truncated': len(page.layout_text or '') > 6000,
                'evidencePolicy': 'Auxiliary layout only; accepted values must match original text and event ownership.'}
