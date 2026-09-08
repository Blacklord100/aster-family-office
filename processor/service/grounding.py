"""Source-grounded candidate generation and validation shared by both execution modes."""
from decimal import Decimal
import re
from .documents import Page
from .schema import Fact
from .source_parsing import CURRENCIES, date_mentions, money_mentions, mask_instructions, normalize
from .source_events import KIND_PATTERNS, source_events, has_candidate_financial_text, has_event_semantics

KINDS = KIND_PATTERNS
# Kept as a compatibility name; structured callers should use money_mentions.
MONEY = re.compile(r'\b(' + CURRENCIES + r')\s+(-?\d[\d.,]*\d|\d)\b')
FIELDS = ('effectiveDate','amount','currency','dueDate')


def field(text: str, label: str) -> str | None:
    match = re.search(r'(?im)^\s*(?:' + label + r')\s*:\s*([^\n]+)', text)
    return match.group(1).strip() if match else None


def _equal(key, a, b):
    return Decimal(a) == Decimal(b) if key == 'amount' and a is not None and b is not None else a == b


def verify_fact(fact: Fact, pages: list[Page]) -> tuple[Fact | None, str | None]:
    page = next((page for page in pages if page.number == fact.evidence.page and
                 normalize(fact.evidence.quote) in normalize(page.text)), None)
    quote = normalize(fact.evidence.quote)
    if page is None:
        return None, 'quote_not_in_page'
    if normalize(fact.investmentName).casefold() not in quote.casefold():
        return None, 'investment_not_in_quote'
    safe_quote = mask_instructions(fact.evidence.quote)
    if not has_event_semantics(safe_quote,fact.kind):
        return None, 'event_kind_not_supported'
    # Validate roles against the full provided source, preventing a quote from hiding
    # a withdrawal/negation or borrowing another investment's amount/date.
    events = [event for event in source_events(page.text)
              if normalize(event.investmentName).casefold() == normalize(fact.investmentName).casefold()
              and event.kind == fact.kind]
    if not events:
        return None, 'event_kind_not_supported'
    quoted_events = source_events(safe_quote)
    quoted_amounts = money_mentions(safe_quote)
    if fact.amount is not None and not any(Decimal(value.amount) == Decimal(fact.amount) and
                                          (value.currency == fact.currency or value.currency is None)
                                          for value in quoted_amounts):
        # Explicit table headers can bind separated currency/amount cells. The
        # quote itself must independently contain that complete source row; a
        # model-supplied name or a bare amount is never sufficient evidence.
        if not any(event.kind == fact.kind and normalize(event.investmentName).casefold() == normalize(fact.investmentName).casefold()
                   and event.amount is not None and Decimal(event.amount) == Decimal(fact.amount)
                   and event.currency == fact.currency
                   and all(getattr(fact,key) is None or _equal(key,getattr(fact,key),getattr(event,key)) for key in FIELDS)
                   for event in quoted_events):
            return None, 'amount_currency_not_in_quote'
    if fact.currency is not None and not re.search(r'\b' + fact.currency + r'\b', safe_quote) and not any(value.currency == fact.currency for value in quoted_amounts):
        return None, 'currency_not_in_quote'
    quoted_dates = {value.value for value in date_mentions(safe_quote)}
    for key in ('effectiveDate','dueDate'):
        value = getattr(fact,key)
        if value is not None and value not in quoted_dates:
            return None, key + '_not_in_quote'
    compatible = [event for event in events if all(getattr(fact,key) is None or _equal(key,getattr(fact,key),getattr(event,key)) for key in FIELDS)]
    if not compatible:
        if fact.amount is not None and not any(_equal('amount',fact.amount,event.amount) and fact.currency == event.currency for event in events):
            return None, 'amount_currency_not_in_quote'
        for key in ('effectiveDate','dueDate'):
            if getattr(fact,key) is not None and not any(getattr(event,key) == getattr(fact,key) for event in events):
                return None, key + '_contradicts_label'
        return None, 'source_role_mismatch'
    unique = {tuple(getattr(event,key) for key in FIELDS) for event in compatible}
    if len(unique) > 1:
        return None, 'ambiguous_source_event'
    if not any(event.kind == fact.kind and normalize(event.investmentName).casefold() == normalize(fact.investmentName).casefold()
               and all(getattr(fact,key) is None or _equal(key,getattr(fact,key),getattr(event,key)) for key in FIELDS)
               for event in quoted_events):
        return None, 'quoted_event_role_mismatch'
    return fact.model_copy(update={'summary':quote[:1000]}), None


def _quote_for(page, event):
    if len(page.text.strip()) <= 3000:
        return page.text.strip()
    start, end = max(0,event.start), min(len(page.text),event.end)
    if end-start > 3000:
        return None
    return page.text[start:end].strip()


def deterministic_facts(pages: list[Page]) -> list[Fact]:
    candidates = []
    for page in pages:
        for event in source_events(page.text):
            quote = _quote_for(page,event)
            if not quote:
                continue
            try:
                fact = Fact(**event.fields(),summary=normalize(quote)[:1000],evidence={'page':page.number,'quote':quote})
            except ValueError:
                continue
            valid, _ = verify_fact(fact,[page])
            if valid:
                candidates.append(valid)
    return deduplicate(candidates)


def _key(fact):
    return (fact.kind,normalize(fact.investmentName).casefold(),fact.effectiveDate,
            Decimal(fact.amount) if fact.amount is not None else None,fact.currency,fact.dueDate)


def deduplicate(facts: list[Fact]) -> list[Fact]:
    """Collapse exact repeats and uniquely source-supported partial enrichment.

    Never merge conflicting amounts/dates, or choose among several possible periods.
    The pipeline, not this helper, enforces its explicit output-count budget.
    """
    unique = {}
    for fact in facts:
        unique.setdefault(_key(fact),fact)
    values = list(unique.values())
    result = []
    for fact in values:
        richer = []
        for other in values:
            if other is fact or other.kind != fact.kind or normalize(other.investmentName).casefold() != normalize(fact.investmentName).casefold():
                continue
            if fact.evidence.page != other.evidence.page:
                continue
            a,b = normalize(fact.evidence.quote),normalize(other.evidence.quote)
            if a not in b and b not in a:
                continue
            if not all(getattr(fact,key) is None or _equal(key,getattr(fact,key),getattr(other,key)) for key in FIELDS):
                continue
            if any(getattr(fact,key) is None and getattr(other,key) is not None for key in FIELDS):
                richer.append(other)
        # Several richer records may be a chain of the same unique complete event.
        maximal = [item for item in richer if not any(other is not item and
                   all(getattr(item,key) is None or _equal(key,getattr(item,key),getattr(other,key)) for key in FIELDS) and
                   sum(getattr(other,key) is not None for key in FIELDS) > sum(getattr(item,key) is not None for key in FIELDS)
                   for other in richer)]
        if len(maximal) != 1:
            result.append(fact)
    return result


def source_event_blocks(pages: list[Page]) -> list[dict]:
    """Source windows for optional pipeline planning; contains no model predictions."""
    blocks = []
    seen = set()
    for page in pages:
        for event in source_events(page.text):
            text = _quote_for(page,event)
            key = (page.number,text)
            if text and key not in seen:
                blocks.append({'page':page.number,'text':text})
                seen.add(key)
    return blocks


def has_unresolved_financial_text(page: Page, facts: list[Fact]) -> bool:
    """Conservative coverage signal; a single good rule fact does not certify a page."""
    if not has_candidate_financial_text(page.text):
        return False
    events = source_events(page.text)
    if not events:
        return True
    for event in events:
        if any(getattr(event,key) is None for key in ('effectiveDate','amount')) and event.kind != 'news':
            return True
        if not any(fact.kind == event.kind and normalize(fact.investmentName).casefold() == normalize(event.investmentName).casefold()
                   and all(_equal(key,getattr(fact,key),getattr(event,key)) for key in FIELDS) for fact in facts):
            return True
    # Narrative pages with extra role-bearing amounts deserve a model audit.
    safe = mask_instructions(page.text)
    return len(money_mentions(safe)) > sum(event.amount is not None for event in events)
