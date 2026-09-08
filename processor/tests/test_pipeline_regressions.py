from service.documents import Document, Page
from service.config import Settings
from service.pipeline import process, expand_evidence
from service.schema import Fact, ModelFacts
from service.ollama import LocalOllama
from service.classifier import RelevanceClassifier
from tests.fake_ollama import fake_ollama

TOKEN = 'local-synthetic-regression-token-only'
NOTICE = ('Valuation statement\nInvestment: Orchard Ridge Fund\n'
          'Valuation date: 2026-07-31\nNAV: EUR 3170000.00')


def fact(text=NOTICE, **updates):
    data = dict(kind='valuation', investmentName='Orchard Ridge Fund',
                effectiveDate='2026-07-31', amount='3170000.00', currency='EUR', dueDate=None,
                summary='Source candidate', evidence={'page': 1, 'quote': text})
    data.update(updates)
    return data


def test_evidence_expansion_requires_a_real_source_quote():
    pages = [Page(1, NOTICE, 'document')]
    short = Fact(**fact(evidence={'page': 1, 'quote': 'NAV: EUR 3170000.00'}))
    assert expand_evidence(short, pages).evidence.quote == NOTICE
    invented = Fact(**fact(evidence={'page': 1, 'quote': 'NAV: EUR 999999999.00'}))
    assert expand_evidence(invented, pages).evidence.quote == invented.evidence.quote
    other_page = Fact(**fact(evidence={'page': 2, 'quote': 'NAV: EUR 3170000.00'}))
    assert expand_evidence(other_page, pages) == other_page


def test_invalid_individual_schema_does_not_erase_a_valid_candidate():
    # No numerical coercion: a JSON float is invalid money, even alongside a valid fact.
    with fake_ollama([{'facts': [fact(amount=3170000.0), fact()]}]) as (url, _):
        model = LocalOllama(Settings(TOKEN, ollama_base_url=url))
        try:
            result = model.structured(ModelFacts, 'Synthetic test')
            assert len(result.facts) == 1
            assert result.facts[0].amount == '3170000.00'
            assert model.rejected_candidates == 1
        finally:
            model.close()


def test_agent_cannot_finish_before_all_pages_are_extracted():
    doc = Document([Page(1, NOTICE, 'document'), Page(2, NOTICE.replace('3170000','3180000'), 'document')], [])
    replies = [{'action': 'read_page', 'page': 1}, {'action': 'extract', 'page': 1},
               {'facts': [fact()]}, {'action': 'finish', 'page': None}]
    with fake_ollama(replies) as (url, calls):
        output = process(doc, 'bounded-pages', 'agentic', Settings(TOKEN, ollama_base_url=url), RelevanceClassifier())
    assert any('unread or unextracted' in w for w in output.warnings)
    assert any('1 of 2' in w for w in output.warnings)
    assert not any(t.stage == 'agent_finish' for t in output.trace)
    assert len(calls) == 5


def test_complete_first_page_does_not_hide_later_narrative():
    second = ('Investment: Orchard Ridge Fund\n'
              'The valuation dated 2026-08-31 records a net asset value of EUR 3300000.00 '
              'for your investor interest. This is a later reporting period, not a replacement for July.')
    later = fact(second, effectiveDate='2026-08-31', amount='3300000.00', evidence={'page': 2, 'quote': second})
    with fake_ollama([{'facts': [later]}]) as (url, calls):
        result = process(Document([Page(1, NOTICE, 'document'), Page(2, second, 'document')], []),
                         'later-page', 'workflow', Settings(TOKEN, ollama_base_url=url), RelevanceClassifier())
    assert any(t.stage == 'local_extract' and 'Page 2' in t.detail for t in result.trace)
    assert any(path == '/api/chat' and 'later reporting period' in body['messages'][1]['content'] for path, body in calls)
    assert {f.effectiveDate for f in result.facts} >= {'2026-07-31', '2026-08-31'}


def test_empty_source_has_an_explicit_incomplete_coverage_trace():
    result = process(Document([Page(1, '', 'document')], ['Local OCR unavailable.']), 'empty',
                     'workflow', Settings(TOKEN), RelevanceClassifier())
    assert not result.facts
    assert any(t.stage == 'input_coverage' and t.status == 'warning' for t in result.trace)


def test_failed_model_cannot_introduce_an_amount_but_source_facts_survive():
    replies = [{'action': 'read_page', 'page': 1}, {'action': 'extract', 'page': 1},
               {'facts': [fact(amount='999999999.00')]}, {'action': 'finish', 'page': None}]
    with fake_ollama(replies) as (url, _):
        result = process(Document([Page(1, NOTICE, 'document')], []), 'source-survives', 'agentic',
                         Settings(TOKEN, ollama_base_url=url), RelevanceClassifier())
    assert result.facts and all(f.amount == '3170000.00' for f in result.facts)
    assert any('rejected by evidence' in w for w in result.warnings)
    assert any(t.stage == 'rules' for t in result.trace)


def test_short_unlabelled_narrative_requires_model_audit():
    from service.pipeline import canonical_notice
    from service.grounding import deterministic_facts
    page = Page(1, NOTICE + "\nA further distribution is pending.", 'document')
    assert not canonical_notice(page, deterministic_facts([page]))


def test_model_window_cannot_hide_full_page_withdrawal():
    text = NOTICE + '\n' + ('Administrative background with no financial event. ' * 65) + '\nThe preceding valuation is withdrawn and must not be used; corrected value pending.'
    with fake_ollama([{'facts': [fact()]}, {'facts': []}, {'facts': []}]) as (url, _):
        result = process(Document([Page(1, text, 'document')], []), 'withdrawn-window', 'workflow',
                         Settings(TOKEN, ollama_base_url=url), RelevanceClassifier())
    assert not result.facts


def test_negated_financial_topics_in_office_mail_do_not_trigger_inference():
    text = ('Office planning and catering. This is not an investment report, '
            'capital call, NAV or distribution notice.')
    result = process(Document([Page(1, text, 'email body')], []), 'operational-mail',
                     'workflow', Settings(TOKEN), RelevanceClassifier())
    assert not result.relevant and not result.facts and result.model is None
    assert not any(t.stage == 'local_model' for t in result.trace)
