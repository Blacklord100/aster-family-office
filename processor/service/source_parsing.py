"""Bounded, source-anchored lexical parsing; no models, external data or posting."""
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
import re

CURRENCIES = 'EUR|USD|GBP|CHF|SEK|NOK|DKK|JPY|CAD|AUD|SGD|HKD|CNY'
MONTHS = {name.casefold(): number for number, names in enumerate([
    ('January', 'Jan'), ('February', 'Feb'), ('March', 'Mar'), ('April', 'Apr'),
    ('May',), ('June', 'Jun'), ('July', 'Jul'), ('August', 'Aug'),
    ('September', 'Sep', 'Sept'), ('October', 'Oct'), ('November', 'Nov'), ('December', 'Dec')], 1)
    for name in names}
MONTH = '(?:' + '|'.join(sorted(MONTHS, key=len, reverse=True)) + r')\.?'
DATE_RE = re.compile(r'\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+' + MONTH +
                     r'\s+\d{4}|' + MONTH + r'\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\b', re.I)
# Numeric tokens are consumed whole. Partial matches of unsupported separators are forbidden.
MONEY_RE = re.compile(r'(?<![\w])(?P<currency>' + CURRENCIES + r'|€|£|\$)\s*'
                      r'(?P<amount>[-−]?\d(?:\d|[.,\'’_]+(?=\d)|[ \u00a0\u202f]+(?=\d))*)(?![\w]|[.,\'’_]\d)'
                      r'(?:\s*(?P<scale>million|billion|thousand|mn|bn)\b)?', re.I)
INSTRUCTION = re.compile(r'(?i)\b(?:ignore\s+(?:all\s+|any\s+)?(?:prior|previous|system|developer|the)\s+instructions?'
                         r'|(?:invent|fabricate)\s+(?:an?\s+|additional\s+)?(?:NAV|valuation|amount|fact)'
                         r'|(?:invent|fabricate)\b[^.!?\n]{0,100}\b(?:NAV|valuation|amount|facts?)'
                         r'|ignore\s+(?:the|all|previous)\s+source\s+facts?'
                         r'|(?:automation|processing|software|AI|agent)\s+(?:directive|instruction)'
                         r'|(?:output|print|set)\s+(?:(?:a|an|the|this)\s+)?(?:NAV|valuation|amount|facts?)\b'
                         r'|approve\s+(?:it|this)\s+(?:now|automatically)'
                         r'|auto[- ]?approve|system\s*prompt|developer\s*message|execute\s+(?:this|the)\s+(?:code|command))\b')


@dataclass(frozen=True)
class DateMention:
    start: int
    end: int
    value: str
    raw: str


@dataclass(frozen=True)
class MoneyMention:
    start: int
    end: int
    amount: str
    currency: str | None
    raw: str


def normalize(text: str) -> str:
    return ' '.join(text.split())


def parse_date(raw: str) -> str | None:
    text = re.sub(r'(\d)(?:st|nd|rd|th)\b', r'\1', raw.strip(), flags=re.I)
    try:
        if re.fullmatch(r'\d{4}-\d{2}-\d{2}', text):
            return date.fromisoformat(text).isoformat()
        parts = text.replace(',', '').replace('.', '').split()
        if len(parts) != 3:
            return None
        if parts[0].isdigit():
            day, month, year = int(parts[0]), MONTHS[parts[1].casefold()], int(parts[2])
        else:
            month, day, year = MONTHS[parts[0].casefold()], int(parts[1]), int(parts[2])
        return date(year, month, day).isoformat()
    except (ValueError, KeyError):
        return None


def date_mentions(text: str) -> list[DateMention]:
    return [DateMention(match.start(), match.end(), value, match.group())
            for match in DATE_RE.finditer(text) if (value := parse_date(match.group())) is not None]


def parse_decimal(raw: str, *, decimal_comma: bool | None = None) -> str | None:
    """Unambiguous grouped/decimal formats; a lone 3-digit separator needs context."""
    text = raw.strip().replace('\u00a0', ' ').replace('\u202f', ' ').replace('’', "'").replace('−','-')
    sign = '-' if text.startswith('-') else ''
    if sign:
        text = text[1:]
    if "'" in text:
        if not re.fullmatch(r"\d{1,3}(?:'\d{3})+(?:[.,]\d{1,8})?", text):
            return None
        # Apostrophe grouping is explicit, unlike an ambiguous single comma/dot.
        integer, *fraction = re.split(r'[.,]', text)
        text = integer.replace("'", '') + ('.' + fraction[0] if fraction else '')
        try:
            value = Decimal(sign + text)
            return format(value, 'f') if len(integer.replace("'", '').lstrip('0')) <= 18 else None
        except InvalidOperation:
            return None
    if ' ' in text:
        if not re.fullmatch(r'\d{1,3}(?: \d{3})+(?:[.,]\d{1,8})?', text):
            return None
        text = text.replace(' ', '')
    if '.' in text and ',' in text:
        decimal = '.' if text.rfind('.') > text.rfind(',') else ','
        grouping = ',' if decimal == '.' else '.'
        integer, fraction = text.rsplit(decimal, 1)
        if not re.fullmatch(r'\d{1,3}(?:' + re.escape(grouping) + r'\d{3})+', integer) or not re.fullmatch(r'\d{1,8}', fraction):
            return None
        text = integer.replace(grouping, '') + '.' + fraction
    elif ',' in text or '.' in text:
        separator = ',' if ',' in text else '.'
        parts = text.split(separator)
        if len(parts) > 2:
            if not re.fullmatch(r'\d{1,3}(?:' + re.escape(separator) + r'\d{3})+', text):
                return None
            text = ''.join(parts)
        else:
            integer, fraction = parts
            if not integer.isdigit() or not re.fullmatch(r'\d{1,8}', fraction):
                return None
            if len(fraction) == 3 and decimal_comma is None:
                return None
            if decimal_comma is not None and (separator == ',') != decimal_comma:
                if len(fraction) != 3 or not 1 <= len(integer) <= 3:
                    return None
                text = integer + fraction
            else:
                text = integer + '.' + fraction
    elif not text.isdigit():
        return None
    try:
        value = Decimal(sign + text)
        if not value.is_finite() or len(text.split('.')[0].lstrip('0')) > 18:
            return None
        return format(value, 'f')
    except InvalidOperation:
        return None


def money_mentions(text: str) -> list[MoneyMention]:
    comma = True if re.search(r'(?i)comma\s+(?:separates|is\s+the)\s+decimals?|European\s+(?:numeric|number)\s+format', text) else None
    values = []
    for match in MONEY_RE.finditer(text):
        prefix = text[:match.start()].rstrip()
        preceding_minus = bool(prefix and prefix[-1] in '-−')
        before_sign = prefix[:-1].rstrip() if preceding_minus else prefix
        # Parentheses can denote a negative accounting amount or prose emphasis.
        # Without an explicit convention neither sign is safe to assume.
        if before_sign.endswith('('):
            continue
        if preceding_minus and (match.start() == 0 or text[match.start()-1] not in '-−'):
            # A spaced dash may be a label separator, not a unary minus.
            continue
        # An unsupported punctuation sequence connecting more digits must never
        # turn a malformed/full numeric token into a valid numeric prefix.
        if re.match(r'[^\w\s]+\d', text[match.end():]):
            continue
        raw = match.group('amount').strip()
        amount = parse_decimal(raw, decimal_comma=comma)
        # Standard comma-thousands spelling is explicit with another decimal mark,
        # or multiple grouping blocks. A bare EUR1,234 remains ambiguous without locale.
        if amount is None:
            continue
        if preceding_minus:
            if raw.startswith(('-', '−')):
                continue
            amount = format(-Decimal(amount), 'f')
        currency = match.group('currency').upper()
        currency = {'€': 'EUR', '£': 'GBP', '$': None}.get(currency, currency)
        if match.group('scale'):
            power = {'thousand':3,'million':6,'billion':9,'mn':6,'bn':9}[match.group('scale').casefold()]
            amount = format(Decimal(amount) * Decimal(10) ** power, 'f')
        if len(amount.lstrip('-').split('.')[0]) <= 18:
            values.append(MoneyMention(match.start(), match.end(), amount, currency, match.group()))
    return values


def mask_instructions(text: str) -> str:
    """Keep offsets stable and exclude instruction-bearing lines from semantic evidence."""
    chunks = []
    for line in text.splitlines(keepends=True):
        # A model may quote a page with whitespace collapsed; mask only the
        # instruction-bearing sentence in that case, retaining legitimate notices.
        pieces = re.split(r'(?<=[.!?])(?=\s+[A-Z])', line)
        for piece in pieces:
            chunks.append(''.join('\n' if c == '\n' else ' ' for c in piece) if INSTRUCTION.search(piece) else piece)
    return ''.join(chunks)
