"""Conservative event/role inference from literal source spans, independent of a model."""
from dataclasses import dataclass
from decimal import Decimal
import re
from .source_parsing import (CURRENCIES, DATE_RE, DateMention, MoneyMention, date_mentions,
                             money_mentions, mask_instructions, normalize)

KIND_PATTERNS = {
    'valuation': r'\b(?:valuation|net asset value|NAV|carrying value|value of your interest|value attributable to your interest|your (?:closing|reported) value)\b',
    'capital_call': r'\b(?:capital call|drawdown(?: notice)?|capital requested|capital called|funding notice|calls? (?:an? )?additional|capital request)\b',
    'distribution': r'\b(?:distribution|distributed)\b|\breturned\b(?=[\s\S]{0,200}\bcash to your (?:partnership )?interest\b)',
    'news': r'\b(?:portfolio update|investment update|company update|news update|business update|appointed|appointment|announced|launched|resigned|new director|joins? the board|opened|operating update)\b',
}
# Physical PDF wraps and HTML layout whitespace do not change an event phrase.
# Keep source text/offsets untouched so evidence remains an exact source quote.
KIND_PATTERNS = {kind: pattern.replace(' ', r'\s+') for kind, pattern in KIND_PATTERNS.items()}
INCIDENTAL = re.compile(r'(?i)\b(?:commitment|contributions? (?:made|paid|before)|previously contributed|manager(?:-wide)?|assets under management|AUM|revenue|sales|enterprise value|total of|aggregate|previously issued|withdrawn|superseded|erroneous|replaces? (?:the )?(?:old|original|previous))\b')
WITHDRAWN = re.compile(r'(?i)\b(?:withdrawn|superseded|previously issued|erroneous|must not be treated|no longer valid|cancelled|canceled|revoked|rescinded|invalidated|must not be used)\b')
DATE_LABEL = re.compile(r'(?im)\b(?P<label>effective date|valuation date|reporting date|distribution date|notice date|as of|as at|payment due|due date|payment date|date)\s*:\s*')
WORD = r"[A-ZÀ-ÖØ-Þ][\wÀ-ž&'’.-]*"
NAME = WORD + r'(?:[ \t]+(?:' + WORD + r'|of|and|the|&)){0,11}'
NAME = NAME.replace("[\\wÀ-ž&'’.-]*", "[\\wÀ-ž&'’-]*")
NAME_VERB = r'(?:is issuing|issues|issued (?:this |a |the )?(?:capital call|drawdown)|will (?:make|pay) (?:a |the )?distribution|reports? (?:a |the )?(?:capital call|drawdown|distribution|(?:investor )?NAV|valuation|net asset value)|capital call|valuation|distribution|distributed|paid|returned|appointed|announced|launched|opened|operating update|company update|portfolio update|news update)\b'
NAME_VERB = NAME_VERB.replace(' ', r'\s+')


@dataclass(frozen=True)
class NameMention:
    name: str
    start: int
    end: int


@dataclass(frozen=True)
class SourceEvent:
    kind: str
    investmentName: str
    effectiveDate: str | None
    amount: str | None
    currency: str | None
    dueDate: str | None
    start: int
    end: int

    def fields(self):
        return {key: getattr(self, key) for key in ('kind','investmentName','effectiveDate','amount','currency','dueDate')}


def _positive_matches(text, kind):
    found = []
    for match in re.finditer(KIND_PATTERNS[kind], text, re.I):
        before = text[max(0, match.start()-95):match.start()]
        clause = re.split(r'[.;]|\bbut\b|\bhowever\b', before, flags=re.I)[-1]
        if re.search(r'(?i)\b(?:no|not|without|neither|excluding)\b', clause):
            continue
        after = text[match.end():match.end()+300]
        negative_predicate = r'(?i:\s+(?:is|are|was|were)\s+(?:not|unavailable|withdrawn))'
        # In an event-first clause the explicit owner's name can separate the
        # event noun from its negated predicate: "call for <Name> is not ...".
        if (re.match(negative_predicate, after)
                or re.match(r'(?i:\s+for)\s+' + NAME + negative_predicate, after)):
            continue
        found.append(match)
    return found


def has_event_semantics(text: str, kind: str) -> bool:
    return any(_positive_matches(unit,kind) for _,_,unit in _units(mask_instructions(text)))


def has_candidate_financial_text(text: str) -> bool:
    safe = mask_instructions(text)
    return any(_positive_matches(unit, kind) for _, _, unit in _units(safe) for kind in KIND_PATTERNS)


def _units(text, extra_boundaries=()):
    # Paragraphs and structural header/label lines are separate contexts. Ordinary
    # physical PDF wraps remain inside a sentence, including wrapped event names.
    boundaries = {0, len(text)}
    boundaries.update(extra_boundaries)
    boundaries.update(m.end() for m in re.finditer(r'(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ>])', text))
    boundaries.update(m.end() for m in re.finditer(r'\n[ \t]*\n', text))
    for line in re.finditer(r'(?m)^[^\n]+(?:\n|$)', text):
        value = line.group().strip()
        letters = ''.join(c for c in value if c.isalpha())
        heading = len(letters) >= 4 and letters.isupper()
        label = re.match(r'(?i)^(?:Investment|Fund|Company|Security|Portfolio investment|Effective date|Valuation date|Reporting date|Notice date|Distribution date|Due date|Payment due)\s*:',value)
        page_number = re.fullmatch(r'(?i)page\s+\d+(?:\s+(?:of|/)\s*\d+)?', value)
        notice_title = re.fullmatch(r'(?i)(?:capital call notice|drawdown notice|valuation statement|distribution confirmation)(?:\s+(?:no[.]?\s*)?\d+)?', value)
        if heading or label or page_number or notice_title:
            boundaries.update((line.start(),line.end()))
    boundaries = sorted(boundaries)
    return [(start, end, text[start:end]) for start, end in zip(boundaries, boundaries[1:]) if text[start:end].strip()]


def _clean_name(raw):
    value = normalize(raw).strip(' >:;,.—–-')
    value = re.split(r'\s+(?:Effective date|Valuation date|Reporting date|Notice date|NAV amount|Amount|Due date)\s*:', value)[0]
    if not 2 <= len(value) <= 200:
        return None
    if re.fullmatch(CURRENCIES,value,re.I):
        return None
    if re.fullmatch(r'(?:illustrative|hypothetical|example|corrected|actual|approved|final|current|previous|reported|original|quarterly|monthly|annual|semiannual|interim)',value,re.I):
        return None
    if re.match(r'(?i)^(?:Dear\b|SYNTHETIC\b|DIAGNOSTIC\b|Investor (?:Relations|Services|Administration|account)|Fund Administration|From\b|Subject\b|This\b|The\b|On\b|At\b|Please\b|No\b|Not\b|Without\b)', value):
        return None
    return value


def _ownership_mentions(text):
    """Explicit topic/object owners also delimit unfamiliar lower-case names."""
    patterns = [
        r'(?im)(?:^|(?<=[;.!?])\s+)\s*(?:for|regarding|as regards|on behalf of|in respect of|concerning)\s+(?P<name>[^\n,:;]{2,200}?)\s*[,;:]',
        r'(?i)\b(?:holding|interest|position)\s+in\s+(?P<name>[^\n,;:]{2,200}?)\s+(?:is|was|were|has|had|stood|amounted|at)\b',
        r'(?i)\b(?:carrying amount|fair (?:market )?value|closing value|net asset value|NAV|valuation|capital call|distribution)\s+(?:of|for|attributable to)\s+(?P<name>[^\n,;:]{2,200}?)\s+(?:is|was|were|has|had|at|as of|as at|equals|stands)\b',
    ]
    for pattern in patterns:
        for match in re.finditer(pattern,text):
            raw = normalize(match.group('name')).strip(' .;:')
            if (re.match(r'(?i)^(?:your|our|their|its|the|an?|all|each|this|that|no|not)\b',raw)
                    or re.fullmatch(r'(?i)(?:reference|comparison|administrative convenience|information|review|illustration|discussion|approval|(?:reporting|accounting|administrative|reconciliation|recordkeeping|review) purposes)\s*(?:only)?',raw)):
                continue
            if name := _clean_name(raw):
                yield NameMention(name,match.start('name'),match.end('name'))


def _amount_clause(unit, token):
    separators = list(re.finditer(r'[;!?]|\bbut\b|\bhowever\b',unit,re.I))
    start = max((match.end() for match in separators if match.end() <= token.start),default=0)
    end = min((match.start() for match in separators if match.start() >= token.end),default=len(unit))
    return unit[start:end]


def _non_investor_amount_scope(unit, token):
    before = re.split(r'[;!?]|\bbut\b|\bhowever\b',unit[:token.start],flags=re.I)[-1]
    wide = list(re.finditer(r'(?i)\b(?:(?:whole|entire)\s+fund|fund[- ]wide|manager[- ]wide|all\s+investors(?:\s+(?:combined|together))?|fund\s+total)\b',before))
    if not wide:
        return False
    # A subsequent explicit investor allocation can supersede the wide context;
    # a bare NAV/valuation label cannot turn whole-fund figures into an LP value.
    return not re.search(r'(?i)\b(?:your\s+(?:holding|interest|account|allocation)|investor[- ]specific|attributable\s+to\s+your)\b',before[wide[-1].end():])


def _conditional_amount(unit, token):
    prefix = re.split(r'[;!?]|\bbut\b|\bhowever\b',unit[:token.start],flags=re.I)[-1]
    return bool(re.search(r'(?i)\b(?:would|could|might)\s+(?:be|equal|amount|stand|have)|\b(?:assuming|hypothetical|pro[- ]forma|conditional on|contingent upon)\b',prefix)
                or re.search(r'(?i)\b(?:only if|conditional upon|contingent on)\b',_amount_clause(unit,token)))


def name_mentions(text, hint=None):
    candidates = list(_ownership_mentions(text))
    labelled = []
    for match in re.finditer(r'(?im)(?:^|(?<=[.!?])\s+)\s*>?\s*(?:Investment|Fund|Company|Security|Portfolio investment)\s*:\s*([^\n]+)', text):
        if name := _clean_name(match.group(1)):
            start = match.start(1) + match.group(1).find(name)
            mention = NameMention(name, start, start+len(name))
            candidates.append(mention)
            labelled.append(mention)
    patterns = [
        r'(?P<name>' + NAME + r')\s+(?i:' + NAME_VERB + r')',
        r'(?i:interest in|statement for|statement\s*[-:]|(?:valuation|net\s+asset\s+value|NAV) (?:of|for)|(?:capital\s+call|drawdown|distribution)\s+for)\s+(?P<name>' + NAME + r')',
        r'(?P<name>' + NAME + r')\s*:\s*(?i:(?:investor\s+)?(?:NAV|net\s+asset\s+value|valuation))\b',
        r'(?P<name>' + NAME + r')\s*[-–—]\s*(?i:your|update|news|company|business|portfolio|capital|valuation|distribution)',
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text):
            if name := _clean_name(match.group('name')):
                candidates.append(NameMention(name, match.start('name'), match.start('name')+len(name)))
    # A title naming an investment may precede a prose notice with pronouns.
    for match in re.finditer(r'(?m)^\s*(?P<name>' + NAME + r')\s*$', text):
        name = _clean_name(match.group('name'))
        if name and re.search(r'\b(?:Fund|Equity|Growth|Credit|Assets|Opportunities|SPV|Partnership|Ventures|Lending|Infrastructure|Partners|Robotics|Systems|Holdings|Property|Real Estate|Strategies)\b', name):
            candidates.append(NameMention(name, match.start('name'), match.end('name')))
    # A name-only sentence directly introducing a notice is an explicit subject,
    # including terse forwards. Restrict it to a whole proper-name sentence and
    # an immediately following event, not an arbitrary nearby/signature name.
    event_opening = r'(?:capital\s+call|drawdown|distribution|(?:investor\s+)?NAV|valuation)\b'
    for match in re.finditer(r'(?m)(?:^|(?<=[.!?])[ \t]+)(?P<name>' + NAME + r')\.[ \t\n]*(?=' + event_opening + r')', text, re.I):
        raw = match.group('name')
        if re.fullmatch(NAME, raw) and len(raw.split()) >= 2 and (name := _clean_name(raw)):
            candidates.append(NameMention(name, match.start('name'), match.end('name')))
    # A model hint cannot create an entity. Only independently anchored names
    # participate in role attribution; keep the argument for caller compatibility.
    # Repeated labelled names may wrap in later prose. Resolve only an exact
    # whitespace-flexible source occurrence, never a guessed alias or model hint.
    canonical = []
    for name in {item.name for item in labelled}:
        pattern = r'(?<!\w)' + r'\s+'.join(re.escape(part) for part in name.split()) + r'(?!\w)'
        canonical.extend(NameMention(name,match.start(),match.end()) for match in re.finditer(pattern,text))
    canonical = [item for item in canonical if not any(
        other.start <= item.start and item.end <= other.end and other.end-other.start > item.end-item.start
        for other in canonical)]
    candidates = [item for item in candidates if not any(
        other.start <= item.start and item.end <= other.end for other in canonical)] + canonical
    unique = {}
    for item in candidates:
        unique.setdefault((normalize(item.name).casefold(), item.start), item)
    return sorted(unique.values(), key=lambda item: (item.start, -len(item.name)))


def _name_for(names, start, end, position):
    local = [name for name in names if start <= name.start < end]
    preceding = [name for name in local if name.start <= position]
    if preceding:
        last_start = max(name.start for name in preceding)
        return max((name for name in preceding if name.start == last_start), key=lambda name: len(name.name))
    earlier = [name for name in names if name.start <= start]
    if earlier:
        return max(earlier, key=lambda name: (name.start, len(name.name)))
    # A name first appearing after an amount cannot establish its owner. In
    # particular, a later underlying-issuer table must never label an earlier
    # fund NAV, even when that issuer is the only independently recognized name.
    # Explicit event-first phrases bind the named owner before their amount.
    return None


def _date_role(text, mention):
    before = normalize(text[max(0, mention.start-90):mention.start]).casefold()
    if re.search(r'(?:due(?: date)?(?: on)?|payment due|payable(?: by| on| no later than)?|settlement by|settle by)\s*:?\s*$', before):
        return 'due'
    if re.search(r'\b(?:funds|payment|remittance|called capital)\b[^.!?]{0,65}\b(?:reach|arrive|be received)\b[^.!?]{0,45}\b(?:by|no later than)\s*$',before):
        clause = re.split(r'[.;]|\bbut\b|\bhowever\b',before)[-1]
        # "No later than" asserts a deadline; it does not negate the payment.
        status = re.sub(r'\bno later than\b','',clause)
        if not re.search(r'\b(?:no|not|never|without)\b',status):
            return 'due'
    if re.search(r'(?:valuation date|reporting date|as of|as at|as-of|quarter ended|books for)\s*:?\s*$', before):
        return 'valuation'
    if re.search(r'distribution date\s*:?\s*$', before):
        return 'distribution'
    if re.search(r'(?:notice date|effective date|dated)\s*:?\s*$', before):
        return 'effective'
    if re.search(r'(?:capital call|drawdown|funding notice)(?:\s+was)?(?:\s+issued)?\s+on\s*$',before):
        return 'effective'
    if re.search(r'(?:issued|issue dated|prepared|published|publication date|statement dated)\s*:?\s*$', before):
        return 'issue'
    return 'context'


def _dates_for(text, unit_start, unit_end, kind, names, name, position):
    all_dates = date_mentions(text)
    local = [d for d in all_dates if unit_start <= d.start < unit_end]
    # Bound inheritance at another explicitly named investment, never borrow its dates.
    other = [n for n in names if normalize(n.name).casefold() != normalize(name.name).casefold()]
    previous = max((n.end for n in other if n.end < position), default=0)
    # A new fund starts its own scope at its first named mention after the prior
    # fund, not at the prior fund's name (which would retain its later deadline).
    previous = min((n.start for n in names if previous <= n.start <= position and
                    normalize(n.name).casefold() == normalize(name.name).casefold()),default=previous)
    following = min((n.start for n in other if n.start > position), default=len(text))
    scoped = [d for d in all_dates if previous <= d.start < following]
    roles = {d.start:_date_role(text,d) for d in all_dates}
    first_name = min((item.start for item in names), default=0)
    header_dates = [d for d in all_dates if d.end <= first_name and roles[d.start] in ('valuation','due')]
    scoped = list({d.start:d for d in scoped+header_dates}.values())
    due_local = [d for d in local if roles[d.start] == 'due']
    due_scope = [d for d in scoped if roles[d.start] == 'due']
    dues = due_local or due_scope
    due_values = {d.value for d in dues}
    due = next(iter(due_values)) if kind == 'capital_call' and len(due_values) == 1 else None
    good = [d for d in local if roles[d.start] not in ('due','issue')]
    wanted = ('valuation','effective') if kind == 'valuation' else ('distribution','effective') if kind == 'distribution' else ('effective',)
    preferred = [d for d in good if roles[d.start] in wanted]
    # A common labelled reporting date outranks unrelated header or publication dates.
    if preferred:
        chosen = min(preferred, key=lambda d: abs(d.start-position))
    else:
        labelled = [d for d in scoped if roles[d.start] in wanted]
        before = [d for d in labelled if d.start <= position]
        if before:
            chosen = max(before, key=lambda d:d.start)
        elif len({d.value for d in good}) == 1:
            chosen = good[0]
        elif good:
            # Two dates in one event sentence require a local association, not guessing.
            chosen = None
        elif len({d.value for d in labelled}) == 1:
            chosen = labelled[0]
        else:
            chosen = None
    return chosen.value if chosen else None, due


def _kind_for_amount(unit, token, fallback):
    if _non_investor_amount_scope(unit,token) or _conditional_amount(unit,token):
        return None
    clause = _amount_clause(unit,token)
    if re.search(r'(?i)\b(?:illustrative|hypothetical|example calculation|for illustration|not (?:an? )?actual)\b',clause):
        return None
    positions = [(kind, match.start()) for kind in KIND_PATTERNS if kind != 'news'
                 for match in _positive_matches(unit, kind)]
    before = [(kind, pos) for kind,pos in positions if pos <= token.start]
    nearby_bad = [m.start() for m in INCIDENTAL.finditer(unit) if m.start() <= token.start]
    if before:
        kind, pos = max(before, key=lambda item:item[1])
        if nearby_bad and max(nearby_bad) > pos:
            return None
        if WITHDRAWN.search(clause) and not re.search(r'(?i)\bcorrected\b', unit[:token.start]):
            return None
        return kind
    if nearby_bad:
        return None
    after = [(kind,pos) for kind,pos in positions if 0 <= pos-token.end < 100]
    if len({kind for kind,_ in after}) == 1:
        return after[0][0]
    if fallback and not WITHDRAWN.search(clause) and re.match(r'(?is)\s*(?:>\s*)?(?:Amount|NAV amount|Capital call amount|Distribution amount)\s*:', unit):
        return fallback
    return None


def _currency_context(text):
    pattern = (r'(?i)\b(?:reports? in|denominated in|currency\s*:|'
               r'all (?:investment )?amounts (?:are(?: in)?|in))\s*(' + CURRENCIES + r')\b')
    codes = set()
    for match in re.finditer(pattern,text):
        before = re.split(r'[.;!?\n]|\bbut\b|\bhowever\b',text[max(0,match.start()-160):match.start()],flags=re.I)[-1]
        if re.search(r'(?i)\b(?:comparison|illustrative|example|hypothetical|translation|translated|converted|indicative|not|no)\b',before):
            continue
        codes.add(match.group(1).upper())
    return next(iter(codes)) if len(codes) == 1 else None


def _table_amount_unit(value):
    """Only explicit column-wide units; this is normalization, never FX conversion."""
    match = re.fullmatch(r'(?i)(.*?)\s*\(\s*(' + CURRENCIES + r")(?:\s+(000|['’]000|000s|thousands?|millions?|billions?))?\s*\)", normalize(value))
    if not match:
        return normalize(value), None, Decimal(1)
    unit = (match.group(3) or '').casefold()
    power = 9 if unit.startswith('billion') else 6 if unit.startswith('million') else 3 if unit else 0
    return match.group(1).strip(), match.group(2).upper(), Decimal(10) ** power


def _table_header(value):
    value, _, _ = _table_amount_unit(value)
    value = value.casefold().rstrip(':')
    if value in {'investment','fund','security','portfolio investment','holding'}:
        return 'name',None
    if value in {'currency','ccy'}:
        return 'currency',None
    if value in {'status','record status'}:
        return 'status',None
    if value in {'due date','payment due','payment due date'}:
        return 'due',None
    dates = {'distribution date':'distribution','valuation date':'valuation',
             'reporting date':'valuation','notice date':'capital_call','effective date':None,
             'date':None,'as of':None,'as at':None}
    if value in dates:
        return 'effective',dates[value]
    amounts = {'cash distribution':'distribution','distribution amount':'distribution',
               'distribution':'distribution','nav':'valuation','investor nav':'valuation',
               'net asset value':'valuation','investor net asset value':'valuation',
               'valuation amount':'valuation','capital call amount':'capital_call',
               'capital called':'capital_call','drawdown amount':'capital_call','amount':None}
    return ('amount',amounts[value]) if value in amounts else None


def _table_owner(text, before):
    # A table without an owner column may inherit one explicit nearby heading.
    # Multiple competing headings are ambiguous, even if a model picks one.
    window_start = max(0,before-1000)
    candidates = [name for name in name_mentions(text[:before]) if name.start >= window_start]
    unique = {normalize(name.name).casefold() for name in candidates}
    return max(candidates,key=lambda name:name.start) if len(unique) == 1 else None


def _table_first_cell(role, value):
    if role == 'name':
        return bool(_clean_name(value) and re.fullmatch(NAME,value))
    if role in {'effective','due'}:
        return bool(DATE_RE.fullmatch(value))
    if role == 'currency':
        return bool(re.fullmatch(CURRENCIES,value,re.I))
    if role == 'status':
        return bool(re.fullmatch(r'(?i)current|approved|final|withdrawn|superseded|cancelled|illustrative',value))
    return bool(re.fullmatch(r"[-−]?\d[\d.,'’ \u00a0\u202f]*",value))


def _table_cells(text):
    cells = []
    # Preserve literal offsets. Tabs/pipes are explicit cell separators; ordinary
    # spaces inside names and PDF line wraps are not guessed column boundaries.
    for line in re.finditer(r'(?m)^[^\n]+',text):
        for part in re.finditer(r'[^\t|]+',line.group()):
            raw = part.group()
            value = raw.strip()
            if value:
                start = line.start()+part.start()+len(raw)-len(raw.lstrip())
                cells.append((value,start,start+len(value)))
    return cells


def _table_cell_like(value):
    if re.match(r'(?i)^(?:Investment|Fund|Company|Security)\s*:',value):
        return False
    return bool(re.fullmatch(NAME,value) or DATE_RE.fullmatch(value)
                or re.fullmatch(CURRENCIES,value,re.I)
                or re.fullmatch(r"[-−(]?\d[\d.,'’_ \u00a0\u202f]*(?:[)−-])?",value)
                or re.fullmatch(r'(?i)(?:pending|unknown|unavailable|n/a|—|current|approved|final|withdrawn|superseded|cancelled|canceled|illustrative|hypothetical|total|combined total|grand total)',value)
                or (len(value) <= 200 and not re.search(r'[.!?]$',value)
                    and not re.match(r'(?i)^(?:the|these|this|please|issued|questions|note)\b',value)))


def _source_tables(text, warnings=None):
    """Validate row-major cell roles without repairing or shifting missing cells.

    Explicit tabs/pipes preserve row boundaries. Flattened PDF cells must remain
    aligned; trailing prose can end a complete row but cannot become another row.
    Header currency/scale and a unique preceding owner heading are explicit roles.
    """
    cells = _table_cells(text)
    events,regions,names = [],[],[]
    warnings = warnings if warnings is not None else []
    index = 0
    while index < len(cells):
        headers = []
        cursor = index
        while cursor < len(cells) and (header := _table_header(cells[cursor][0])) is not None:
            headers.append(header)
            cursor += 1
        roles = [role for role,_ in headers]
        kinds = {kind for _,kind in headers if kind}
        owner = _table_owner(text,cells[index][1]) if 'name' not in roles and {'effective','amount'}.issubset(roles) else None
        amount_header = next((cells[index+i][0] for i,(role,_) in enumerate(headers) if role == 'amount'), '')
        _, header_currency, multiplier = _table_amount_unit(amount_header)
        recognized = {'effective','amount'}.issubset(roles) and ('name' in roles or 'currency' in roles or header_currency is not None)
        if not recognized:
            index = cursor if cursor > index else index+1
            continue
        valid_headers = (len(roles) == len(set(roles)) and 2 <= len(roles) <= 6 and len(kinds) == 1
                         and ('currency' in roles or header_currency is not None) and ('name' in roles or owner is not None))
        kind = next(iter(kinds)) if valid_headers else None
        body_start = cursor
        width = len(roles)
        while cursor < len(cells) and _table_cell_like(cells[cursor][0]):
            # A next header or prose after a complete row ends the row run.
            # Protection still extends over unsupported trailing financial text.
            if (cursor-body_start) % width == 0:
                if _table_header(cells[cursor][0]) is not None:
                    break
                if re.fullmatch(r'(?i)(?:total|combined total|grand total)',cells[cursor][0]):
                    break
                if not _table_first_cell(roles[0],cells[cursor][0]):
                    break
            cursor += 1
        body_end = cells[cursor-1][2] if cursor > body_start else cells[body_start-1][2]
        section = re.search(r'(?im)^\s*(?:Investment|Fund|Company|Security)\s*:',text[body_end:])
        protected_end = body_end+section.start() if section else len(text)
        if cursor < len(cells) and _table_header(cells[cursor][0]) is not None:
            protected_end = min(protected_end,cells[cursor][1])
        regions.append((cells[index][1],body_end))
        if protected_end > body_end:
            regions.append((body_end,protected_end))
        if money_mentions(text[body_end:protected_end]):
            warnings.append('Recognized financial table has unvalidated trailing content; its amounts were excluded from prose extraction and require manual review.')
        if not valid_headers:
            warnings.append('Recognized financial table has ambiguous, duplicate, or conflicting event headers; no facts were extracted from that table.')
            index = max(cursor,index+1)
            continue
        body = cells[body_start:cursor]
        if not body:
            warnings.append('Recognized financial table has no validated rows; unsupported table content requires manual review.')
            index = max(cursor,index+1)
            continue
        # A horizontal row's cells cannot spill into a neighbouring row. Pure
        # one-cell-per-line extraction remains supported, without guessing wraps.
        horizontal_lines = {}
        for cell in body:
            line_start = text.rfind('\n',0,cell[1])+1
            horizontal_lines.setdefault(line_start,[]).append(cell)
        explicit_rows = any('|' in text[start:text.find('\n',start) if '\n' in text[start:] else len(text)]
                            or '\t' in text[start:text.find('\n',start) if '\n' in text[start:] else len(text)]
                            for start in horizontal_lines)
        bad_row_boundaries = explicit_rows and any(len(row) != width for row in horizontal_lines.values())
        if len(body) % width or bad_row_boundaries:
            warnings.append('Recognized financial table has ambiguous missing, extra, or wrapped cells; no facts were extracted from that table.')
            index = max(cursor,index+1)
            continue
        if len(body)//width > 100:
            warnings.append('Recognized financial table exceeds the 100-row extraction budget; no facts were extracted from that table.')
            index = max(cursor,index+1)
            continue
        invalid_rows = 0
        for offset in range(0,len(body),width):
            row = body[offset:offset+width]
            fields = {role:cell for role,cell in zip(roles,row)}
            name = _clean_name(fields['name'][0]) if 'name' in fields else owner.name
            date = date_mentions(fields['effective'][0])
            due = date_mentions(fields['due'][0]) if 'due' in fields else []
            currency = fields['currency'][0].upper() if 'currency' in fields else header_currency
            if (not name or not re.fullmatch(NAME,name) or len(date) != 1
                    or normalize(date[0].raw) != normalize(fields['effective'][0])
                    or not re.fullmatch(CURRENCIES,currency or '',re.I)
                    or (header_currency and currency != header_currency)):
                invalid_rows += 1
                continue
            if 'due' in fields and (kind != 'capital_call' or len(due) != 1 or normalize(due[0].raw) != normalize(fields['due'][0])):
                invalid_rows += 1
                continue
            if 'status' in fields and not re.fullmatch(r'(?i)(?:current|approved|final)',fields['status'][0]):
                invalid_rows += 1
                continue
            source_money = currency+' '+fields['amount'][0]
            money = money_mentions(source_money)
            if len(money) != 1 or money[0].start != 0 or money[0].end != len(source_money):
                invalid_rows += 1
                continue
            amount = format(Decimal(money[0].amount)*multiplier,'f')
            if len(amount.lstrip('-').split('.')[0]) > 18:
                invalid_rows += 1
                continue
            mention = NameMention(name,fields['name'][1],fields['name'][2]) if 'name' in fields else owner
            names.append(mention)
            events.append(SourceEvent(kind,name,date[0].value,amount,currency,
                                      due[0].value if due else None,min(cells[index][1],mention.start),row[-1][2]))
        if invalid_rows:
            warnings.append('Recognized financial table contains unsupported, invalid, or non-current rows; those rows were excluded and require manual review.')
        index = max(cursor,index+1)
    if any(event.end-event.start > 3000 for event in events):
        warnings.append('Some financial table rows cannot fit a contiguous 3000-character header-and-row evidence quote; those rows require manual review.')
    return events,regions,names


def source_table_warnings(text: str) -> list[str]:
    """Bounded source-only table coverage diagnostics for the pipeline."""
    warnings = []
    _source_tables(mask_instructions(text),warnings)
    return list(dict.fromkeys(warnings))


def _continued_call_kind(units, unit_index, token, names, name):
    """An explicit new-contribution amount may continue an adjacent call notice.

    Do not inherit a page-wide kind: commitments, older contributions, a second
    investment, or a preceding sentence containing a different amount cannot
    establish this event's role.
    """
    if unit_index == 0:
        return None
    start, end, unit = units[unit_index]
    previous_start, previous_end, previous = units[unit_index-1]
    if start-previous_start > 1200 or money_mentions(previous) or WITHDRAWN.search(previous):
        return None
    if not _positive_matches(previous, 'capital_call'):
        return None
    before = normalize(unit[:token.start])
    if not re.search(r'(?i)\b(?:your additional contribution|(?:the|your) additional amount(?: payable)?)\b',before):
        return None
    if re.search(r'(?i)\b(?:no|not|previous|prior|historical|already|illustrative|hypothetical)\b',before) or INCIDENTAL.search(before):
        return None
    previous_name = _name_for(names,previous_start,previous_end,previous_end-1)
    if previous_name and normalize(previous_name.name).casefold() == normalize(name.name).casefold():
        return 'capital_call'
    return None


def _entity_context(text,names,name,position):
    canonical = normalize(name.name).casefold()
    others = [item for item in names if normalize(item.name).casefold() != canonical]
    previous = max((item.end for item in others if item.start < position),default=0)
    same = [item for item in names if normalize(item.name).casefold() == canonical and previous <= item.start <= position]
    start = min((item.start for item in same),default=previous)
    # A document-level currency header can scope its first investment, but a
    # later owner's section never inherits a prior investment's currency.
    if previous == 0:
        start = 0
    end = min((item.start for item in others if item.start > position),default=len(text))
    return text[start:end]


def _retraction_subject(head):
    # Event-first backward references take precedence over kind words that
    # happen to occur in an investment's legal name.
    base = r'(?:valuation|NAV|figure|amount|call|distribution|statement|notice)'
    direct = re.match(r'(?is)\s*(?:The|This|That)\s+(?:(?:preceding|above|previous|stated|reported)\s+)?(?P<kind>'+base+r')\b',head)
    if direct:
        return direct.group('kind').casefold()
    named = re.match(r'(?is)\s*(?:The|This|That)\s+[^.!?\n]{2,200}?\s+(?P<kind>'+base+r')\s+(?:above\s+|previously\s+)?(?:is|was|has|had|must|should)\b',head)
    return named.group('kind').casefold() if named else None


def _next_retracts(next_unit):
    # A backward reference can revoke or condition a prior source figure even
    # when the model crops that later sentence out of its evidence quote.
    money = money_mentions(next_unit)
    head = next_unit[:money[0].start] if money else next_unit
    if re.search(r'(?i)\b(?:this is an example calculation|not the value of your actual|illustration only)\b',head):
        return True
    conditional = re.match(r'(?is)\s*(?:This|That|The (?:preceding |above )?(?:value|amount|figure))\b',head) and re.search(
        r'(?i)\b(?:only if|conditional upon|contingent on|would apply)\b',head)
    return bool(conditional or (WITHDRAWN.search(head) and _retraction_subject(head)))


def _apply_retractions(events, units, names):
    """Apply explicit backward status references across administrative prose.

    Only the nearest preceding event of the stated kind is eligible. A named
    different investment is a scope boundary; an older mark must not disappear
    just because the newest mark is withdrawn. Numeric old-figure references
    are handled at their own source span, rather than rebinding a prior event.
    """
    removed = set()
    for start, _, unit in units:
        if not _next_retracts(unit):
            continue
        head = unit[:money_mentions(unit)[0].start] if money_mentions(unit) else unit
        word = _retraction_subject(head)
        kind = {'nav':'valuation','valuation':'valuation','call':'capital_call',
                'distribution':'distribution'}.get(word)
        candidates = [(index, event) for index, event in enumerate(events)
                      if event.end <= start and event.kind != 'news'
                      and (kind is None or event.kind == kind)]
        explicit_names = {normalize(item.name).casefold() for item in names if re.search(
            r'(?<!\w)'+r'\s+'.join(re.escape(word) for word in item.name.split())+r'(?!\w)',unit,re.I)}
        if explicit_names:
            candidates = [(index,event) for index,event in candidates
                          if normalize(event.investmentName).casefold() in explicit_names]
        status_marker = WITHDRAWN.search(head) or re.search(r'(?i)\b(?:would|conditional|contingent|only if)\b',head)
        status_dates = [mention for mention in date_mentions(head) if status_marker and mention.end <= status_marker.start()]
        if status_dates:
            # An explicitly dated withdrawal targets that period/deadline,
            # never an unrelated newer mark just because it appeared last.
            candidates = [(index,event) for index,event in candidates if all(
                (event.dueDate if _date_role(head,mention) == 'due' else event.effectiveDate) == mention.value
                for mention in status_dates)]
        if not candidates:
            continue
        nearest_end = max(event.end for _, event in candidates)
        for index, event in candidates:
            if event.end != nearest_end:
                continue
            if not explicit_names and any(event.end <= name.start < start and
                   normalize(name.name).casefold() != normalize(event.investmentName).casefold()
                   for name in names):
                continue
            removed.add(index)
    return [event for index, event in enumerate(events) if index not in removed]


def _positive_qualifier(unit, words):
    for match in re.finditer(words,unit,re.I):
        before = re.split(r'[.;]|\bbut\b|\bhowever\b',unit[max(0,match.start()-45):match.start()],flags=re.I)[-1]
        if not re.search(r'(?i)\b(?:not|no|neither)\b',before):
            return True
    return False


def _apply_illustration_scope(events, units, names, table_regions=(), extra_patterns=None):
    """An explicit financial-illustration heading qualifies following source rows.

    Generic document metadata does not assert an event's status. A qualifier
    naming valuation/call/distribution does, and must survive intervening labels.
    Its scope ends at a different named investment or an explicit actual/approved
    statement of the same financial kind, never simply at a paragraph boundary.
    """
    extra_patterns = extra_patterns or {}
    def semantic(unit,kind):
        return bool(_positive_matches(unit,kind) or (kind in extra_patterns and re.search(extra_patterns[kind],unit,re.I)))
    markers = []
    for start,end,unit in units:
        qualifier = _positive_qualifier(unit,r'\b(?:illustrative|hypothetical|example|for illustration)\b')
        nonactual = bool(re.search(r'(?i)\bnot (?:an? )?actual\b',unit))
        sample_statement = bool(re.fullmatch(r'(?i)\s*(?:sample|specimen) (?:financial )?(?:statement|notice|valuation)(?: only)?\s*',unit))
        if not (qualifier or nonactual or sample_statement):
            continue
        generic_nonactual = nonactual and bool(re.search(r'(?i)\b(?:figures|amounts|values)\b',unit))
        kinds = ({kind for kind in KIND_PATTERNS if kind != 'news'} if sample_statement or generic_nonactual else
                 {kind for kind in KIND_PATTERNS if kind != 'news' and
                  (re.search(KIND_PATTERNS[kind],unit,re.I) or (kind in extra_patterns and re.search(extra_patterns[kind],unit,re.I)) if nonactual else semantic(unit,kind))})
        if not kinds:
            continue
        name = _name_for(names,start,end,end-1)
        if name is None:
            name = next((item for item in names if item.start >= end),None)
        if name:
            # A financial illustration heading immediately before a table
            # qualifies the entire table, including its second/later fund rows.
            table = next(((a,b) for a,b in table_regions if end <= a and a-end <= 1000
                          and not any(end <= item.start < a for item in names)),None)
            markers.append((start,end,kinds,normalize(name.name).casefold(),table))
    result = []
    for event in events:
        blocked = False
        event_name = normalize(event.investmentName).casefold()
        for start,end,kinds,name,table in markers:
            in_table = table is not None and table[0] <= event.start and event.end <= table[1]
            if end > event.end or event.kind not in kinds or (name != event_name and not in_table):
                continue
            if not in_table and any(end <= item.start < event.end and normalize(item.name).casefold() != name for item in names):
                continue
            reset = any(end <= unit_start < event.end and semantic(unit,event.kind)
                        and _positive_qualifier(unit,r'\b(?:actual|approved|final)\b')
                        and not _positive_qualifier(unit,r'\b(?:illustrative|hypothetical|example|for illustration)\b')
                        for unit_start,_,unit in units)
            if not reset:
                blocked = True
                break
        if not blocked:
            result.append(event)
    return result


def source_events(text: str, investment_hint: str | None = None) -> list[SourceEvent]:
    safe = mask_instructions(text)
    table_events, table_regions, table_names = _source_tables(safe)
    names = [name for name in name_mentions(safe, investment_hint)
             if not any(start <= name.start < end for start,end in table_regions)] + table_names
    names.sort(key=lambda item:(item.start,-len(item.name)))
    if not names:
        return []
    result = list(table_events)
    units = _units(safe,[boundary for region in table_regions for boundary in region])
    all_kinds = {kind for _,_,unit in units for kind in KIND_PATTERNS if _positive_matches(unit,kind)}
    financial_kinds = all_kinds - {'news'}
    fallback = next(iter(financial_kinds)) if len(financial_kinds) == 1 else None
    for unit_index,(start, end, unit) in enumerate(units):
        tokens = money_mentions(unit)
        accepted_amounts = 0
        for token in tokens:
            position = start + token.start
            if any(table_start <= position < table_end for table_start,table_end in table_regions):
                continue
            name = _name_for(names,start,end,position)
            if not name:
                continue
            kind = _kind_for_amount(unit, token, fallback)
            if not kind:
                kind = _continued_call_kind(units,unit_index,token,names,name)
            if not kind:
                continue
            effective, due = _dates_for(safe,start,end,kind,names,name,position)
            currency = token.currency
            if currency is None:
                context_currency = _currency_context(_entity_context(safe,names,name,position))
                # A dollar glyph can be scoped to an explicit dollar currency,
                # never relabelled EUR merely because another amount uses EUR.
                currency = context_currency if context_currency in {'USD','CAD','AUD','SGD','HKD'} else None
            result.append(SourceEvent(kind,name.name,effective,token.amount,currency,due,
                                      min(start,name.start),end))
            accepted_amounts += 1
        if accepted_amounts:
            continue
        kinds = [kind for kind in KIND_PATTERNS if _positive_matches(unit,kind)]
        # Do not convert incidental business numbers to NAVs or empty financial notices.
        if 'news' in kinds:
            kinds = ['news'] if not (set(kinds)-{'news'}) or not tokens else kinds
        for kind in kinds:
            if re.fullmatch(r'\s*(?:valuation statement|capital call notice|distribution confirmation)(?:\s+(?:no[.]?\s*)?\d+)?\s*',unit,re.I):
                continue
            if kind != 'news' and (tokens or not re.search(r'(?i)\b(?:pending|under .*review|not available|no approved value|unknown|valuation statement|capital call notice|distribution confirmation)\b', unit)):
                continue
            if kind == 'news' and not re.search(r'(?i)\b(?:appointed|announced|launched|resigned|new director|joins? the board|news update|company update|investment update|portfolio update|opened|operating update)\b', unit):
                continue
            name = _name_for(names,start,end,start+len(unit)//2)
            if not name:
                continue
            effective, due = _dates_for(safe,start,end,kind,names,name,start+len(unit)//2)
            currency = _currency_context(_entity_context(safe,names,name,start+len(unit)//2)) if kind != 'news' else None
            result.append(SourceEvent(kind,name.name,effective,None,currency,due,min(start,name.start),end))
    return _apply_illustration_scope(_apply_retractions(result, units, names), units, names,table_regions)
