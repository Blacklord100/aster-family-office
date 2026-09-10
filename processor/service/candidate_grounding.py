"""Candidate-directed evidence checks independent of deterministic enumeration.

A model may locate an unfamiliar literal owner or financial wording. It cannot
create a value, resolve an ambiguous currency, select another owner's fields, or
escape a source withdrawal. This path verifies a proposition's local subject and
field roles; it does not require the rules extractor to predict that proposition.
"""
import re
from .source_parsing import mask_instructions, normalize, money_mentions
from .source_events import (KIND_PATTERNS, NameMention, SourceEvent, _units, _name_for,
                            _dates_for, _currency_context, _entity_context, _source_tables,
                            _apply_retractions, _apply_illustration_scope, name_mentions,
                            INCIDENTAL, _non_investor_amount_scope, _conditional_amount, _amount_clause)

# Wider event predicates are intentionally used for candidate verification only.
# Their subject and monetary role must still be independently grounded below.
CANDIDATE_PATTERNS = {
    'valuation': r'\b(?:fair (?:market )?value|carrying amount|account value|closing value|marked (?:your|the) (?:holding|interest)|(?:your|the investor.s) (?:holding|interest)(?:\s+in\s+[^\n.;!?]{2,200}?)?\s+(?:is|was|has been)\s+(?:marked|carried|valued))\b',
    'capital_call': r'\b(?:contribution requested|requested contribution|amount to be funded|additional funding (?:required|requested)|funding requirement)\b',
    'distribution': r'\b(?:cash returned|cash proceeds remitted|proceeds paid|cash payout|payment to your account)\b',
    'news': r'\b(?:commenced operations|began operating|completed (?:the |an? )?(?:acquisition|merger)|secured (?:a |the )?contract|obtained regulatory approval)\b',
}
OWNER_LABEL = r'(?:investment|fund|company|security|portfolio investment|holding|vehicle|position|portfolio company|legal investment|investment name)'
EXCLUDED_LABEL = r'(?:manager|administrator|investor|account holder|custodian|reference|from|to|underlying issuer|counterparty)'
NEGATIVE = re.compile(r'(?i)\b(?:no|not|never|without|neither|excluding|illustrative|hypothetical|example|withdrawn|superseded|erroneous|forecast|projected|projection|target|planned|plans? to)\b')


def _candidate_units(text, boundaries=()):
    labels = [edge for match in re.finditer(r'(?im)^\s*(?:'+OWNER_LABEL+'|'+EXCLUDED_LABEL+r')\s*:[^\n]*(?:\n|$)',text)
              for edge in (match.start(),match.end())]
    return _units(text,[*boundaries,*labels])


def _narrative_subjects(text):
    # Detect competing explicit subjects even if their spelling/capitalization
    # is unfamiliar to deterministic entity enumeration. Financial noun phrases
    # and pronouns continue an existing owner; new named subjects end that scope.
    token = r"[A-Za-zÀ-ž][\wÀ-ž&'’.-]*"
    verbs = r'(?:has|have|had|is|was|were|reports?|recorded|confirmed|commenced|began|completed|secured|obtained)'
    roles = r'(?i)(?:fair (?:market )?value|carrying amount|account value|closing value|investor NAV|net asset value|capital call|requested contribution|contribution requested|additional funding|funding requirement|cash payout|cash proceeds)'
    for start,_,unit in _candidate_units(text):
        match = re.match(r'\s*>?\s*(?P<name>'+token+r'(?:[ \t]+'+token+r'){1,11}?)\s+'+verbs+r'\b',unit,re.I)
        if not match:
            continue
        value = normalize(match.group('name')).strip(' .;')
        if (re.match(r'(?i)^(?:the|this|that|your|our|its|their|these|those|a|an|we|it)\b',value)
                or re.fullmatch(roles+r'(?: (?:of|for|attributable to|remitted to) your (?:holding|interest))?',value)):
            continue
        yield NameMention(value,start+match.start('name'),start+match.end('name'))


def _positions(text, kind):
    pattern = '(?:'+KIND_PATTERNS[kind]+'|'+CANDIDATE_PATTERNS[kind].replace(' ', r'\s+')+')'
    for match in re.finditer(pattern,text,re.I):
        # Negation is clause-local, while status is checked again against the
        # complete source, including material outside the model's quote.
        prefix = re.split(r'[.;!?]|\bbut\b|\bhowever\b',text[:match.start()],flags=re.I)[-1]
        suffix = text[match.end():]
        if NEGATIVE.search(prefix):
            continue
        if re.match(r'(?i)\s+(?:is|was|are|were|has been)\s+(?:not|never|withdrawn|unavailable)',suffix):
            continue
        yield match


def _literal_owners(text, candidate_name):
    """Literal subject/label attribution, never a free-floating name hint."""
    names = [*name_mentions(text),*_narrative_subjects(text)]
    for match in re.finditer(r'(?im)^\s*'+OWNER_LABEL+r'\s*:\s*([^\n]+)',text):
        value = normalize(match.group(1)).strip(' .;')
        if 2 <= len(value) <= 200:
            names.append(NameMention(value,match.start(1),match.end(1)))
    exact = r'(?<!\w)' + r'\s+'.join(re.escape(word) for word in candidate_name.split()) + r'(?!\w)'
    canonical = normalize(candidate_name).casefold()
    for match in re.finditer(exact,text,re.I):
        if any(item.start <= match.start() and match.end() <= item.end
               and normalize(item.name).casefold() != canonical for item in names):
            continue
        # A standalone label supplies a role. A narrative owner must be the
        # clause's explicit subject, or the object of "holding/interest in".
        unit = next(((a,b,s) for a,b,s in _candidate_units(text) if a <= match.start() < b),None)
        if unit is None:
            continue
        start,end,value = unit
        prefix = text[start:match.start()]
        suffix = text[match.end():end]
        labelled = re.fullmatch(r'(?is)\s*'+OWNER_LABEL+r'\s*:\s*',prefix)
        labelled = labelled and not suffix.strip(' \t\r\n.;')
        if re.search(r'(?i)'+EXCLUDED_LABEL+r'\s*:\s*$',prefix):
            continue
        # Restrict the end of the source name so a model cannot truncate a
        # longer unlabelled legal name. A finite verb or possession follows.
        subject = (not prefix.strip(' \t\r\n>') and re.match(
            r"(?i)\s*(?:[:,]|[’']s\s+|(?:has|have|had|is|was|were|reports?|recorded|confirmed|commenced|began|completed|secured|obtained)\b)",suffix))
        interest = re.search(r'(?i)\b(?:holding|interest|position)\s+in\s*$',prefix) and re.match(
            r'(?i)\s*(?:[:,]|(?:is|was|has|had|at|stood|amounted)\b)',suffix)
        if labelled or subject or interest:
            names.append(NameMention(candidate_name,match.start(),match.end()))
    unique = {(normalize(item.name).casefold(),item.start,item.end):item for item in names}
    return sorted(unique.values(),key=lambda item:(item.start,-len(item.name)))


def candidate_source_events(text, fact):
    """Return only literal locally role-bound witnesses for the supplied owner/kind.

    Source facts can be richer than a model's null fields. Distinct periods are
    retained so the caller can reject an ambiguous partial candidate. Ambiguous
    tables remain quarantined; this prose path never repairs a broken cell grid.
    """
    safe = mask_instructions(text)
    canonical = normalize(fact.investmentName).casefold()
    names = _literal_owners(safe,fact.investmentName)
    if not any(normalize(item.name).casefold() == canonical for item in names):
        return []
    _,regions,_ = _source_tables(safe)
    units = _candidate_units(safe,[boundary for region in regions for boundary in region])
    result = []
    for start,end,unit in units:
        if any(a <= start < b for a,b in regions):
            continue
        positions = list(_positions(unit,fact.kind))
        if not positions:
            continue
        # A plan to open a factory is news only when explicitly reported as a
        # plan; the current event schema cannot encode that distinction safely.
        tokens = money_mentions(unit) if fact.kind != 'news' else [None]
        for token in tokens:
            clause = _amount_clause(unit,token) if token else unit
            if re.search(r'(?i)\b(?:illustrative|hypothetical|example|forecast|projected|withdrawn|superseded|erroneous)\b',clause):
                continue
            local_position = token.start if token else positions[0].start()
            position = start+local_position
            name = _name_for(names,start,end,position)
            if not name or normalize(name.name).casefold() != canonical or position-name.start > 1200:
                continue
            # The last same-clause predicate before an amount controls its role.
            # A second financial amount/role cannot be borrowed from elsewhere.
            preceding = [match for match in positions if match.start() <= local_position]
            if token and (not preceding or _non_investor_amount_scope(unit,token) or _conditional_amount(unit,token)):
                continue
            predicate = preceding[-1] if preceding else positions[0]
            between = unit[predicate.end():local_position]
            if token and (INCIDENTAL.search(between) or NEGATIVE.search(between)
                          or re.search(r'[;!?]',between)):
                continue
            if token and any(other.start >= predicate.end() and other.end <= token.start for other in money_mentions(unit)):
                continue
            # No other independently anchored owner may intervene between the
            # selected predicate/owner and value, even when figures coincide.
            if any(min(start+predicate.start(),name.start) < other.start <= position
                   and normalize(other.name).casefold() != canonical for other in names):
                continue
            effective,due = _dates_for(safe,start,end,fact.kind,names,name,position,predicate_matches=_positions)
            currency = token.currency if token else None
            if token and currency is None:
                contextual = _currency_context(_entity_context(safe,names,name,position))
                currency = contextual if contextual in {'USD','CAD','AUD','SGD','HKD'} else None
            result.append(SourceEvent(fact.kind,fact.investmentName,effective,
                                      token.amount if token else None,currency,due,
                                      min(start,name.start),end))
    return _apply_illustration_scope(_apply_retractions(result,units,names),units,names,regions,CANDIDATE_PATTERNS)


def candidate_has_semantics(text, kind):
    return any(next(_positions(unit,kind),None) is not None
               for _,_,unit in _candidate_units(mask_instructions(text)))
