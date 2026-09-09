"""Independent orchestration controls; fake inference, actual local source pixels."""
from dataclasses import replace
import json
from pathlib import Path
import re
from unittest.mock import Mock

import pytest

from service import pipeline
from service.config import Settings
from service.documents import Document, Page, parse_document
from service.document_tools import DocumentTools, candidate_schema, resolve_candidate, source_blocks, utf8_prefix
from service.schema import AgentAction, Fact, ReferencedFact
from service.schema import ModelFacts
from service.ollama import LocalModelError, LocalOllama, MAX_MODEL_PROMPT_BYTES, prompt_bytes


TOKEN = 'synthetic-document-orchestration-control-token'
SETTINGS = Settings(TOKEN)
NOTICE = ('Investment: Alder Orchard Fund\nThe valuation dated 2026-07-31 records '
          'a net asset value of EUR 100.00 for your investor interest. '
          'Review the administrator source before approval.')


class Relevant:
    def predict(self, text):
        return True, 0.9


class FakeModel:
    def __init__(self, replies=(), vision=False):
        self.replies = iter(replies)
        self.supports_vision = vision
        self.calls = self.rejected_candidates = 0
        self.requests = []
        self.closed = False
        self.verified = False

    def verify_local(self):
        self.verified = True

    def close(self):
        self.closed = True

    def structured(self, schema, prompt, **kwargs):
        self.calls += 1
        self.requests.append({'schema': schema, 'prompt': prompt, **kwargs})
        reply = next(self.replies)
        value = reply(schema, prompt, kwargs) if callable(reply) else reply
        return schema.model_validate(value)


def action(name, page=None, query=None):
    return {'action': name, 'page': page, 'query': query}


def run(monkeypatch, document, mode, replies, vision=False, settings=SETTINGS):
    model = FakeModel(replies, vision)
    monkeypatch.setattr(pipeline, 'LocalOllama', lambda _: model)
    result = pipeline.process(document, 'synthetic-orchestration', mode, settings, Relevant())
    assert model.closed and model.verified
    return result, model


def fact_data(page=1, source_id=None, **updates):
    data = {'kind': 'valuation', 'investmentName': 'Alder Orchard Fund', 'effectiveDate': '2026-07-31',
            'amount': '100.00', 'currency': 'EUR', 'dueDate': None, 'summary': 'Synthetic source candidate.',
            'evidence': {'page': page, 'sourceId': source_id} if source_id else {'page': page, 'quote': NOTICE}}
    data.update(updates)
    return data


def context(prompt):
    return json.loads(prompt.rsplit('\n', 1)[1])


@pytest.fixture(scope='module')
def actual_native_document():
    path = Path(__file__).parent / 'fixtures/synthetic-native-text.pdf'
    document = parse_document(path.read_bytes(), path.name, 'application/pdf', SETTINGS)
    assert document.pages[0].layout_text and document.pages[0].image_png_base64
    return document


@pytest.mark.parametrize('mode', ['workflow', 'agentic'])
def test_both_modes_send_actual_source_pixels_layout_and_bound_source_schema(monkeypatch, actual_native_document, mode):
    replies = [{'facts': []}]
    if mode == 'agentic':
        replies = [action('inspect_layout', 1), action('inspect_image', 1), {'facts': []}, action('finish')]
    result, model = run(monkeypatch, actual_native_document, mode, replies, vision=True)
    extracts = [r for r in model.requests if r['schema'] is not AgentAction]
    assert len(extracts) == 1
    request = extracts[0]
    page = actual_native_document.pages[0]
    assert request['images'] == [page.image_png_base64]
    state = context(request['prompt'])
    assert state['layout'] == page.layout_text and state['imageAttached'] is True
    source = state['source']
    assert source['text'] in page.text and source['page'] == 1
    reference = request['output_schema']['$defs']['SourceReference']['properties']
    assert reference['sourceId']['enum'] == [source['sourceId']]
    assert reference['page']['enum'] == [1]
    assert any(t.stage == 'vision' and t.status == 'ok' for t in result.trace)
    assert not any('quote_not_in_page' in warning for warning in result.warnings)


@pytest.mark.parametrize('mode', ['workflow', 'agentic'])
def test_text_only_engine_has_explicit_vision_fallback_without_images(monkeypatch, actual_native_document, mode):
    replies = [{'facts': []}]
    if mode == 'agentic':
        replies = [action('extract', 1), {'facts': []}, action('finish')]
    result, model = run(monkeypatch, actual_native_document, mode, replies, vision=False)
    assert all('images' not in request for request in model.requests)
    assert any(t.stage == 'vision' and t.status == 'skipped' and 'no verified image capability' in t.detail for t in result.trace)
    assert result.model == SETTINGS.ollama_model
    if mode == 'agentic':
        allowed = model.requests[0]['output_schema']['anyOf']
        assert 'inspect_image' not in [item['properties']['action']['const'] for item in allowed]


@pytest.mark.parametrize('mode', ['workflow', 'agentic'])
def test_image_only_proposals_cannot_become_trusted_facts(monkeypatch, mode):
    path = Path(__file__).parent / 'fixtures/synthetic-scan.pdf'
    document = parse_document(path.read_bytes(), path.name, 'application/pdf', replace(SETTINGS, ocr_enabled=False))
    assert document.pages[0].image_png_base64 and not document.pages[0].text
    replies = [{'facts': [fact_data()]}]
    if mode == 'agentic':
        replies = [action('inspect_image', 1), *replies, action('finish')]
    result, model = run(monkeypatch, document, mode, replies, vision=True)
    assert not result.facts
    assert any('quote_not_in_page' in warning for warning in result.warnings)
    assert any('image-only candidates require manual review' in warning for warning in result.warnings)
    assert any(t.stage == 'coverage' and 'full model context inspected 0/1' in t.detail for t in result.trace)
    assert len([request for request in model.requests if 'images' in request]) == 1


def test_source_reference_is_bound_to_exact_page_and_block():
    pages = [Page(1, NOTICE, 'source one'), Page(2, NOTICE.replace('100.00', '200.00'), 'source two')]
    blocks = source_blocks(pages[0])
    reference = ReferencedFact(**fact_data(source_id=blocks[0].source_id))
    resolved = resolve_candidate(reference, blocks)
    assert resolved.evidence.quote == NOTICE and resolved.evidence.page == 1
    assert candidate_schema(blocks[0])['$defs']['SourceReference']['properties']['sourceId']['enum'] == [blocks[0].source_id]
    with pytest.raises(ValueError, match='unknown_source_reference'):
        resolve_candidate(reference.model_copy(update={'evidence': reference.evidence.model_copy(update={'page': 2})}), blocks)
    with pytest.raises(ValueError, match='unknown_source_reference'):
        resolve_candidate(reference, source_blocks(pages[1]))


def test_unknown_source_id_rejected_and_wrong_owner_amount_cannot_be_reassigned(monkeypatch):
    text = (NOTICE + '\n\nInvestment: Birch Meadow Fund\nThe valuation dated 2026-07-31 records '
            'a net asset value of EUR 200.00 for your investor interest.')
    document = Document([Page(1, text, 'synthetic combined source')], [])

    def candidates(schema, prompt, kwargs):
        source = context(prompt)['source']['sourceId']
        return {'facts': [fact_data(source_id='p1-s0-unknown'), fact_data(source_id=source, amount='200.00')]}

    result, _ = run(monkeypatch, document, 'workflow', [candidates])
    assert any('unknown_source_reference' in warning for warning in result.warnings)
    assert not any(f.investmentName == 'Alder Orchard Fund' and f.amount == '200.00' for f in result.facts)
    assert any('Candidate rejected by evidence validator' in warning for warning in result.warnings)


def test_agent_receives_search_layout_read_and_validation_feedback(monkeypatch):
    document = Document([Page(1, NOTICE, 'synthetic source', layout_text='Alder Orchard Fund      EUR 100.00')], [])

    def invalid(schema, prompt, kwargs):
        return {'facts': [fact_data(source_id='p1-s0-unknown')]}

    def valid(schema, prompt, kwargs):
        state = context(prompt)
        assert 'unknown_source_reference' in state['previousValidation']['reasons']
        return {'facts': [fact_data(source_id=state['source']['sourceId'])]}

    replies = [action('search', query='valuation'), action('read_page', 1), action('inspect_layout', 1),
               action('extract', 1), invalid, action('review_coverage'), action('extract', 1), valid, action('finish')]
    result, model = run(monkeypatch, document, 'agentic', replies)
    assert any(t.stage == 'agent_finish' for t in result.trace)
    planner_states = [context(request['prompt']) for request in model.requests if request['schema'] is AgentAction]
    assert all(not state['recentToolResults']['truncated'] for state in planner_states)
    tools = {item['tool'] for state in planner_states for item in json.loads(state['recentToolResults']['text'])}
    assert tools >= {'search', 'read_page', 'inspect_layout', 'extract', 'review_coverage'}
    assert any('unknown_source_reference' in str(state['validationFeedback']) for state in planner_states)
    assert {f.amount for f in result.facts} == {'100.00'}


def test_workflow_retry_receives_validator_feedback_and_stays_bounded(monkeypatch):
    document = Document([Page(1, NOTICE, 'synthetic source')], [])
    monkeypatch.setattr(pipeline, 'has_unresolved_financial_text', lambda *_: True)

    def invalid(schema, prompt, kwargs):
        return {'facts': [fact_data(source_id='p1-s0-unknown')]}

    result, model = run(monkeypatch, document, 'workflow', [invalid, invalid], settings=replace(SETTINGS, max_page_extractions=2))
    assert model.calls == 2
    assert 'unknown_source_reference' in context(model.requests[1]['prompt'])['previousValidation']['reasons']
    assert any(t.stage == 'workflow_retry' for t in result.trace)


@pytest.mark.parametrize('bad_action', [action('finish'), action('read_page', 99), action('inspect_image', 1)])
def test_agent_unread_finish_unknown_page_and_unavailable_image_stop_safely(monkeypatch, bad_action):
    document = Document([Page(1, NOTICE, 'synthetic source'), Page(2, NOTICE, 'second source')], [])
    result, model = run(monkeypatch, document, 'agentic', [bad_action])
    assert model.calls == 1 and not result.facts
    assert not any(t.stage == 'agent_finish' for t in result.trace)
    assert any('execution stopped' in warning for warning in result.warnings)
    assert any('0 of 2' in warning for warning in result.warnings)


def test_agent_read_loop_hits_python_tool_allowlist(monkeypatch):
    document = Document([Page(1, NOTICE, 'synthetic source')], [])
    result, model = run(monkeypatch, document, 'agentic', [action('read_page', 1)] * 3)
    assert model.calls == 3
    assert len([t for t in result.trace if t.stage == 'agent_read']) == 2
    assert any('exhausted tool budget' in warning for warning in result.warnings)


def test_agent_extraction_attempts_cannot_exceed_page_budget(monkeypatch):
    document = Document([Page(1, NOTICE, 'synthetic source')], [])
    replies = [action('extract', 1), {'facts': []}, action('extract', 1)]
    result, model = run(monkeypatch, document, 'agentic', replies, settings=replace(SETTINGS, max_page_extractions=1))
    assert model.calls == 3
    assert len([t for t in result.trace if t.stage == 'agent_extract']) == 1
    assert any('exhausted tool budget' in warning for warning in result.warnings)


@pytest.mark.parametrize('settings', [replace(SETTINGS, max_model_calls=2), replace(SETTINGS, max_agent_steps=1)])
def test_agent_model_and_action_budgets_preserve_incomplete_coverage(monkeypatch, settings):
    document = Document([Page(1, NOTICE, 'first source'), Page(2, NOTICE, 'second source')], [])
    result, model = run(monkeypatch, document, 'agentic', [action('extract', 1), {'facts': []}], settings=settings)
    assert model.calls == 2
    assert not any(t.stage == 'agent_finish' for t in result.trace)
    assert any('1 of 2' in warning for warning in result.warnings)


def test_exhausted_model_budget_does_not_claim_unsent_image_coverage(monkeypatch, actual_native_document):
    page = actual_native_document.pages[0]
    document = Document([replace(page, number=1), replace(page, number=2)], [])
    result, model = run(monkeypatch, document, 'workflow', [{'facts': []}], vision=True,
                        settings=replace(SETTINGS, max_model_calls=1))
    assert model.calls == 1
    assert not any(t.stage == 'vision' and t.status == 'ok' and 'Page 2:' in t.detail for t in result.trace)
    assert any('Page 2 model context budget reached' in warning for warning in result.warnings)
    assert any(t.stage == 'coverage' and 'full model context inspected 1/2' in t.detail for t in result.trace)


def test_literal_search_returns_original_unicode_offsets_and_bounded_snippets():
    text = 'Straße investor source. NAV: EUR 100.00. ' + 'NAV: EUR 100.00. ' * 20
    tools = DocumentTools(Document([Page(1, text, 'synthetic source')], []))
    result = tools.search('nav')
    assert len(result['hits']) == 8
    assert result['hits'][0]['offset'] == text.index('NAV')
    assert all(text[hit['offset']:hit['offset'] + 3] == 'NAV' for hit in result['hits'])
    assert all(len(hit['text']) <= 403 for hit in result['hits'])
    assert tools.search('https://example.invalid')['hits'] == []


def test_search_rejects_whitespace_padded_oversized_query():
    tools = DocumentTools(Document([Page(1, NOTICE, 'synthetic source')], []))
    with pytest.raises(ValueError, match='invalid_document_search'):
        tools.search(' ' * 1000 + 'NAV')


def test_source_windows_are_bounded_literal_and_layout_is_separate():
    text = NOTICE + '\n' + ('Administrative source context only.\n' * 300)
    page = Page(1, text, 'synthetic source', layout_text='UNTRUSTED AUXILIARY ' * 500)
    blocks = source_blocks(page)
    assert len(blocks) > 1
    assert all(8 <= len(block.text.strip()) and len(block.text) <= 2800 and block.text in text for block in blocks)
    assert len({block.source_id for block in blocks}) == len(blocks)
    tools = DocumentTools(Document([page], []))
    assert tools.inspect_layout(1)['truncated'] is True
    assert len(tools.inspect_layout(1)['layout']) == 6000
    assert len(tools.read_page(1)['preview']) == 1800
    assert all('UNTRUSTED AUXILIARY' not in block.text for block in blocks)


def test_long_document_retains_final_coverage_and_call_accounting_after_trace_limit(monkeypatch):
    document = Document([Page(number, NOTICE, f'synthetic source {number}') for number in range(1, 41)], [])
    result, model = run(monkeypatch, document, 'workflow', [{'facts': []}] * 40)
    assert model.calls == 40 and len(result.trace) == 100
    assert any(t.stage == 'trace_limit' for t in result.trace)
    assert any(t.stage == 'coverage' and 'full model context inspected 40/40' in t.detail for t in result.trace)
    assert any(t.stage == 'model_usage' and '40 local structured model calls' in t.detail for t in result.trace)


def test_agent_receives_explicit_bounded_truncation_for_large_tool_results(monkeypatch):
    document = Document([Page(1, NOTICE, 'synthetic source', layout_text='Spatial table context. ' * 500)], [])
    replies = [action('inspect_layout', 1), action('extract', 1), {'facts': []}, action('finish')]
    result, model = run(monkeypatch, document, 'agentic', replies)
    state = context(model.requests[1]['prompt'])
    assert state['recentToolResults']['truncated'] is True
    assert len(state['recentToolResults']['text']) <= 4000
    assert any(t.stage == 'agent_finish' for t in result.trace)


def test_unicode_source_blocks_keep_exact_native_spans_overlap_and_byte_limit():
    text = (NOTICE + '\n' + '財務報告：資產估值 € 投資人更新。\n' * 500 + '\n' + NOTICE)
    blocks = source_blocks(Page(1, text, 'synthetic multilingual source'))
    covered = set()
    previous_end = None
    for block in blocks:
        start = int(re.fullmatch(r'p1-s(\d+)-[a-f0-9]{12}', block.source_id).group(1))
        assert len(block.text.encode('utf-8')) <= 2800
        assert text[start:start + len(block.text)] == block.text
        assert '\ufffd' not in block.text
        if previous_end is not None:
            assert start < previous_end
        covered.update(range(start, start + len(block.text)))
        previous_end = start + len(block.text)
    assert len(covered) == len(text)


@pytest.mark.parametrize('prompt,output_schema', [
    ('財務報告' * 4000, None),
    ('Extract from a short source.', {'type': 'object', 'description': '財務報告' * 4000}),
], ids=['oversized-source', 'oversized-output-schema'])
def test_oversized_multilingual_context_fails_before_http_or_model_call(prompt, output_schema):
    model = LocalOllama(SETTINGS)
    request = Mock(side_effect=AssertionError('Oversized context must not reach HTTP'))
    model._request = request
    try:
        with pytest.raises(LocalModelError, match='model_context_budget_exceeded'):
            model.structured(ModelFacts, prompt, output_schema=output_schema)
        assert model.calls == 0
        request.assert_not_called()
    finally:
        model.close()


@pytest.mark.parametrize('repair', [True, False], ids=['model-repairs-kind', 'model-ignores-hint'])
def test_kind_feedback_is_source_verified_and_only_a_new_valid_proposal_is_accepted(monkeypatch, repair):
    document = Document([Page(1, NOTICE, 'synthetic source')], [])
    # Isolate model candidate behavior from discovery; independent verification
    # still uses the real complete source and its financial roles.
    monkeypatch.setattr(pipeline, 'deterministic_facts', lambda _: [])

    def wrong_kind(schema, prompt, kwargs):
        return {'facts': [fact_data(source_id=context(prompt)['source']['sourceId'], kind='distribution')]}

    def reconsider(schema, prompt, kwargs):
        state = context(prompt)
        feedback = state['previousValidation']
        assert feedback['accepted'] == 0 and feedback['rejected'] == 1
        assert feedback['candidateFeedback'][0]['sourceVerifiedAlternativeKinds'] == ['valuation']
        assert feedback['candidateFeedback'][0]['candidate']['kind'] == 'distribution'
        assert feedback['candidateFeedback'][0]['rejection'] == 'event_kind_not_supported'
        assert 'not accepted facts' in feedback['candidateFeedback'][0]['instruction']
        return {'facts': [fact_data(source_id=state['source']['sourceId'],
                                    kind='valuation' if repair else 'distribution')]}

    replies = [action('extract', 1), wrong_kind, action('extract', 1), reconsider, action('finish')]
    result, model = run(monkeypatch, document, 'agentic', replies)
    assert model.calls == 5
    assert any(t.stage == 'validate' and 'model: 0 grounded candidates accepted; 1 rejected' in t.detail for t in result.trace)
    if repair:
        assert len(result.facts) == 1 and result.facts[0].kind == 'valuation'
        assert result.facts[0].amount == '100.00'
    else:
        assert not result.facts
        assert any('no supported facts' in warning for warning in result.warnings)


def test_wrong_amount_cannot_obtain_a_grounded_alternative_kind_hint(monkeypatch):
    document = Document([Page(1, NOTICE, 'synthetic source')], [])
    monkeypatch.setattr(pipeline, 'deterministic_facts', lambda _: [])

    def wrong_kind_and_amount(schema, prompt, kwargs):
        return {'facts': [fact_data(source_id=context(prompt)['source']['sourceId'],
                                    kind='distribution', amount='999999999.00')]}

    def reconsider(schema, prompt, kwargs):
        feedback = context(prompt)['previousValidation']
        assert feedback['candidateFeedback'][0]['sourceVerifiedAlternativeKinds'] == []
        assert feedback['candidateFeedback'][0]['candidate']['amount'] == '999999999.00'
        return {'facts': []}

    replies = [action('extract', 1), wrong_kind_and_amount, action('extract', 1), reconsider, action('finish')]
    result, _ = run(monkeypatch, document, 'agentic', replies)
    assert not result.facts


def test_prompt_budget_trims_auxiliary_diagnostics_before_primary_unicode_source(monkeypatch):
    dates = '; '.join(f'{day} September 2026' for day in range(1, 31))
    text = utf8_prefix(NOTICE + '\n' + dates + '\n' + '投資人財務資料與資產估值 ' * 300, 2800)
    page = Page(1, text, 'synthetic multilingual source', layout_text='欄位布局與補充註記 ' * 500)
    document = Document([page], [])
    assert len(source_blocks(page)) == 1
    monkeypatch.setattr(pipeline, 'deterministic_facts', lambda _: [])

    def rejected_candidates(schema, prompt, kwargs):
        state = context(prompt)
        assert state['source']['text'] == text
        assert prompt_bytes(prompt, kwargs['output_schema']) <= MAX_MODEL_PROMPT_BYTES
        return {'facts': [fact_data(source_id=state['source']['sourceId'],
                                    investmentName=('虛構候選投資名稱' * 22) + str(index)) for index in range(3)]}

    def limited_retry(schema, prompt, kwargs):
        state = context(prompt)
        assert state['source']['text'] == text
        assert '投資人財務資料' in prompt
        assert prompt_bytes(prompt, kwargs['output_schema']) <= MAX_MODEL_PROMPT_BYTES
        assert state['layoutTruncated'] is True
        assert len(state['layout'].encode('utf-8')) <= 800
        assert len(state['previousValidation'].get('candidateFeedback', [])) <= 1
        return {'facts': []}

    result, model = run(monkeypatch, document, 'workflow', [rejected_candidates, limited_retry])
    assert model.calls == 2 and not result.facts
    assert any(t.stage == 'source_context' and 'original source block preserved' in t.detail for t in result.trace)
