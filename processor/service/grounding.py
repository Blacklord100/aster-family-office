from decimal import Decimal
import re
from .documents import Page
from .schema import Fact

CURRENCIES = 'EUR|USD|GBP|CHF|SEK|NOK|DKK|JPY|CAD|AUD|SGD|HKD|CNY'
MONEY = re.compile(r'\b(' + CURRENCIES + r')\s+(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,8})?)(?!\d|[.,]\d|\s+\d)\b')
KINDS = {'capital_call': r'\bcapital call\b|\bdrawdown notice\b',
         'distribution': r'\bdistribution\b',
         'valuation': r'\bvaluation\b|\bnet asset value\b|\bNAV\b',
         'news': r'\bportfolio update\b|\binvestment update\b|\bcompany update\b'}


def normalize(text: str) -> str:
    return ' '.join(text.split())


def field(text: str, label: str) -> str | None:
    match = re.search(r'(?im)^\s*(?:' + label + r')\s*:\s*([^\n]+)', text)
    return match.group(1).strip() if match else None


def verify_fact(fact: Fact, pages: list[Page]) -> tuple[Fact | None, str | None]:
    page = next((p for p in pages if p.number == fact.evidence.page), None)
    quote = normalize(fact.evidence.quote)
    if not page or quote not in normalize(page.text):
        return None, 'quote_not_in_page'
    if normalize(fact.investmentName).casefold() not in quote.casefold():
        return None, 'investment_not_in_quote'
    if not re.search(KINDS[fact.kind], quote, re.I):
        return None, 'event_kind_not_supported'
    amounts = [(currency, Decimal(value.replace(',', ''))) for currency, value in MONEY.findall(quote)]
    if fact.amount is not None:
        if fact.currency is None or (fact.currency, Decimal(fact.amount)) not in amounts:
            return None, 'amount_currency_not_in_quote'
    elif fact.currency is not None and not re.search(r'\b' + fact.currency + r'\b', quote):
        return None, 'currency_not_in_quote'
    for name, value in [('effectiveDate', fact.effectiveDate), ('dueDate', fact.dueDate)]:
        if value is not None and value not in quote:
            return None, name + '_not_in_quote'
    # Detect contradictory labelled dates even when both dates appear in a quote.
    for name, label in [('effectiveDate', r'Effective date|Valuation date|As of'), ('dueDate', r'Due date|Payment due')]:
        explicit = field(fact.evidence.quote, label)
        value = getattr(fact, name)
        if explicit and value is not None and value != explicit[:10]:
            return None, name + '_contradicts_label'
    explicit_name = field(fact.evidence.quote, r'Investment|Fund|Company')
    if explicit_name and normalize(explicit_name).casefold() != normalize(fact.investmentName).casefold():
        return None, 'investment_contradicts_label'
    # Summaries are source excerpts; free model prose is never accepted as evidence.
    return fact.model_copy(update={'summary': quote[:1000]}), None


def deterministic_facts(pages: list[Page]) -> list[Fact]:
    result = []
    for page in pages:
        # Separate explicit notices in one text page. Narrow supported format is intentional.
        for block in re.split(r'\n\s*\n', page.text):
            investment = field(block, 'Investment|Fund|Company')
            kinds = [kind for kind, pattern in KINDS.items() if re.search(pattern, block, re.I)]
            if not investment or len(kinds) != 1 or len(block) > 3000:
                continue
            kind = kinds[0]
            amount_field = field(block, 'Amount|NAV|Net asset value|Capital called|Distribution amount')
            amounts = MONEY.findall(amount_field or '')
            amount, currency = None, None
            if len(amounts) == 1:
                currency, raw = amounts[0]
                amount = format(Decimal(raw.replace(',', '')), 'f')
            effective = field(block, 'Effective date|Valuation date|As of')
            due = field(block, 'Due date|Payment due')
            try:
                fact = Fact(kind=kind, investmentName=investment, effectiveDate=effective,
                            amount=amount, currency=currency, dueDate=due,
                            summary=normalize(block)[:1000], evidence={'page': page.number, 'quote': block.strip()})
            except ValueError:
                continue
            accepted, _ = verify_fact(fact, pages)
            if accepted:
                result.append(accepted)
    return result


def deduplicate(facts: list[Fact]) -> list[Fact]:
    unique = {}
    for fact in facts:
        key = (fact.kind, fact.investmentName.casefold(), fact.effectiveDate, fact.amount, fact.currency, fact.dueDate)
        unique.setdefault(key, fact)
    return list(unique.values())[:100]
