"""Evidence-supported agent recovery; fake models and unchanged source evidence."""
from dataclasses import replace
import json

import pytest

from service import pipeline
from service.config import Settings
from service.documents import Document, Page
from service.grounding import deterministic_facts, verify_fact
from service.ollama import LocalModelError
from service.schema import AgentAction, Fact


SETTINGS = Settings('synthetic-independent-recovery-policy-token')
OWNER = 'larch harbour collective'
DATE = '2026-06-30'
USD_TEXT = f'Vehicle: {OWNER}\nThe carrying amount of your interest is USD 219,876.54 as of 30 June 2026.'
DOLLAR_TEXT = USD_TEXT.replace('USD ', '$')


def context(prompt):
    return json.loads(prompt.rsplit('\n', 1)[1])


def action(name, page=None):
    return {'action': name, 'page': page, 'query': None}


def fact(text=USD_TEXT, page=1, **updates):
    value = {'kind': 'valuation', 'investmentName': OWNER, 'effectiveDate': DATE,
             'amount': '219876.54', 'currency': 'USD', 'dueDate': None,
             'summary': 'Synthetic recovery control.', 'evidence': {'page': page, 'quote': text}}
    value.update(updates)
    return value


class Relevant:
    def predict(self, _):
        return True, 0.9


class FakeModel:
    supports_vision = False

    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = self.rejected_candidates = 0
        self.requests = []
        self.closed = False

    def verify_local(self):
        pass

    def close(self):
        self.closed = True

    def structured(self, schema, prompt, **kwargs):
        self.calls += 1
        self.requests.append((schema, prompt, kwargs))
        reply = next(self.replies)
        return schema.model_validate(reply(schema, prompt, kwargs) if callable(reply) else reply)


def run(monkeypatch, replies, text=USD_TEXT, settings=SETTINGS, pages=None):
    document = Document(pages or [Page(1, text, 'synthetic original')], [])
    # These controls must exercise model-only recovery, not rule discovery.
    assert deterministic_facts(document.pages) == []
    model = FakeModel(replies)
    monkeypatch.setattr(pipeline, 'LocalOllama', lambda _: model)
    result = pipeline.process(document, 'synthetic-recovery-policy', 'agentic', settings, Relevant())
    assert model.closed
    return result, model


def choices(kwargs):
    return kwargs['output_schema']['anyOf']


def names(kwargs):
    return [item['properties']['action']['const'] for item in choices(kwargs)]


def planner_state(prompt):
    return context(prompt)


def recovery_action(expected_updates=None):
    def choose(schema, prompt, kwargs):
        assert schema is AgentAction
        state = planner_state(prompt)
        assert state['pendingRecoveryPages'] == [1]
        assert state['validationFeedback']['1']['recoveryRequired'] is True
        assert 'finish' not in names(kwargs)
        assert names(kwargs)[0] == 'extract'
        if expected_updates is not None:
            hints = state['validationFeedback']['1']['candidateFeedback'][0]['sourceVerifiedFieldRepairs']
            assert expected_updates in hints
        return action('extract', 1)
    return choose


def finish_without_pending(schema, prompt, kwargs):
    assert schema is AgentAction
    assert planner_state(prompt)['pendingRecoveryPages'] == []
    assert 'finish' in names(kwargs)
    return action('finish')


def assert_manual_recovery_warning(result):
    assert any(step.stage == 'agent_recovery' and step.status == 'warning' for step in result.trace)
    assert any('review' in warning.lower() and ('recover' in warning.lower() or 'reject' in warning.lower())
               for warning in result.warnings)


@pytest.mark.parametrize('text,bad_fields,repair_fields', [
    (USD_TEXT, {'dueDate': DATE}, {'dueDate': None}),
    (DOLLAR_TEXT, {'currency': 'USD'}, {'currency': None}),
    (DOLLAR_TEXT, {'currency': 'USD', 'dueDate': DATE}, {'currency': None, 'dueDate': None}),
])
def test_full_verified_field_witness_requires_new_model_proposal(monkeypatch, text, bad_fields, repair_fields):
    invalid = fact(text, **bad_fields)
    valid = {**invalid, **repair_fields}
    page = Page(1, text, 'synthetic original')
    assert verify_fact(Fact.model_validate(invalid), [page])[0] is None
    assert verify_fact(Fact.model_validate(valid), [page])[0] is not None

    def repair(schema, prompt, kwargs):
        feedback = context(prompt)['previousValidation']
        assert feedback['accepted'] == 0 and feedback['rejected'] == 1
        assert repair_fields in feedback['candidateFeedback'][0]['sourceVerifiedFieldRepairs']
        # Reporting hints never mutate the rejected model proposal.
        assert all(feedback['candidateFeedback'][0]['candidate'][key] == value for key, value in bad_fields.items())
        return {'facts': [valid]}

    result, model = run(monkeypatch, [action('extract', 1), {'facts': [invalid]},
                        recovery_action(repair_fields), repair, finish_without_pending], text=text)
    assert model.calls == 5 and len(result.facts) == 1
    assert all(getattr(result.facts[0], key) == value for key, value in repair_fields.items())
    assert result.facts[0].effectiveDate == DATE
    assert result.facts[0].amount == '219876.54'


def test_kind_witness_remains_a_recovery_obligation(monkeypatch):
    def choose(schema, prompt, kwargs):
        state = planner_state(prompt)
        assert state['pendingRecoveryPages'] == [1]
        assert state['validationFeedback']['1']['candidateFeedback'][0]['sourceVerifiedAlternativeKinds'] == ['valuation']
        assert 'finish' not in names(kwargs)
        return action('extract', 1)
    result, _ = run(monkeypatch, [action('extract', 1), {'facts': [fact(kind='distribution')]},
                    choose, {'facts': [fact()]}, finish_without_pending])
    assert len(result.facts) == 1 and result.facts[0].kind == 'valuation'


@pytest.mark.parametrize('invalid,source', [
    (fact(amount='999999.00', dueDate=DATE), USD_TEXT),
    (fact(investmentName='other fabricated holding', dueDate=DATE), USD_TEXT),
    (fact(effectiveDate='2026-05-31', dueDate=DATE), USD_TEXT),
    (fact(text=USD_TEXT + '\nThe preceding amount is cancelled and must not be used.', dueDate=DATE),
     USD_TEXT + '\nThe preceding amount is cancelled and must not be used.'),
])
def test_unsupported_owner_amount_date_or_status_cannot_manufacture_recovery(monkeypatch, invalid, source):
    def finish(schema, prompt, kwargs):
        feedback = planner_state(prompt)['validationFeedback']['1']
        assert feedback['recoveryRequired'] is False
        assert feedback['candidateFeedback'][0]['sourceVerifiedFieldRepairs'] == []
        assert feedback['candidateFeedback'][0]['sourceVerifiedAlternativeKinds'] == []
        return finish_without_pending(schema, prompt, kwargs)
    result, model = run(monkeypatch, [action('extract', 1), {'facts': [invalid]}, finish], text=source)
    assert not result.facts and model.calls == 3


def test_fourth_rejected_candidate_survives_display_feedback_limit(monkeypatch):
    rejected = [fact(amount=f'{900000 + number}.00', dueDate=DATE) for number in range(3)]
    rejected.append(fact(dueDate=DATE))
    result, model = run(monkeypatch, [action('extract', 1), {'facts': rejected}, recovery_action(),
                        {'facts': [fact()]}, finish_without_pending])
    assert len(result.facts) == 1 and model.calls == 5


@pytest.mark.parametrize('reversed_order', [False, True])
def test_equivalent_accepted_fact_suppresses_recovery_in_either_candidate_order(monkeypatch, reversed_order):
    proposed = [fact(), fact(dueDate=DATE)]
    if reversed_order:
        proposed.reverse()
    def finish(schema, prompt, kwargs):
        assert planner_state(prompt)['validationFeedback']['1']['recoveryRequired'] is False
        return finish_without_pending(schema, prompt, kwargs)
    result, model = run(monkeypatch, [action('extract', 1), {'facts': proposed}, finish])
    assert len(result.facts) == 1 and model.calls == 3


def test_accepted_supported_deadline_already_covers_partial_repair_witness(monkeypatch):
    text = (f'Vehicle: {OWNER}\nThe contribution requested is USD 219,876.54, '
            'notice dated 30 June 2026, payable by 15 July 2026.')
    proposed = [fact(text, kind='capital_call', dueDate=DATE),
                fact(text, kind='capital_call', dueDate='2026-07-15')]
    def finish(schema, prompt, kwargs):
        assert planner_state(prompt)['validationFeedback']['1']['recoveryRequired'] is False
        return finish_without_pending(schema, prompt, kwargs)
    result, model = run(monkeypatch, [action('extract', 1), {'facts': proposed}, finish], text=text)
    assert len(result.facts) == 1 and result.facts[0].dueDate == '2026-07-15'
    assert model.calls == 3


@pytest.mark.parametrize('retry_facts', [[], [fact(dueDate=DATE)]], ids=['empty-retry', 'same-rejection'])
def test_one_failed_recovery_attempt_allows_finish_with_manual_warning(monkeypatch, retry_facts):
    result, model = run(monkeypatch, [action('extract', 1), {'facts': [fact(dueDate=DATE)]},
                        recovery_action({'dueDate': None}), {'facts': retry_facts}, finish_without_pending],
                        settings=replace(SETTINGS, max_page_extractions=3))
    assert model.calls == 5 and not result.facts
    assert any(step.stage == 'agent_finish' for step in result.trace)
    assert_manual_recovery_warning(result)


def test_transport_error_on_recovery_retains_original_witness_warning(monkeypatch):
    def transport_error(*_):
        raise LocalModelError('synthetic_timeout')
    result, model = run(monkeypatch, [action('extract', 1), {'facts': [fact(dueDate=DATE)]},
                        recovery_action({'dueDate': None}), transport_error, finish_without_pending])
    assert model.calls == 5 and not result.facts
    assert_manual_recovery_warning(result)


def test_one_page_attempt_budget_cannot_retry_and_is_explicit(monkeypatch):
    result, model = run(monkeypatch, [action('extract', 1), {'facts': [fact(dueDate=DATE)]}, finish_without_pending],
                        settings=replace(SETTINGS, max_page_extractions=1))
    assert model.calls == 3 and not result.facts
    assert_manual_recovery_warning(result)


def test_model_budget_exhaustion_preserves_unperformed_recovery_warning(monkeypatch):
    result, model = run(monkeypatch, [action('extract', 1), {'facts': [fact(dueDate=DATE)]}],
                        settings=replace(SETTINGS, max_model_calls=2))
    assert model.calls == 2 and not result.facts
    assert not any(step.stage == 'agent_finish' for step in result.trace)
    assert_manual_recovery_warning(result)


def test_extract_action_orders_unextracted_then_pending_recovery_without_removing_tools(monkeypatch):
    pages = [Page(1, USD_TEXT, 'synthetic original'), Page(2, 'Meeting scheduled tomorrow.', 'synthetic cover')]

    def initial(schema, prompt, kwargs):
        assert names(kwargs)[0] == 'extract'
        assert {'read_page', 'search', 'review_coverage'} <= set(names(kwargs))
        return action('extract', 1)

    def choose_unextracted(schema, prompt, kwargs):
        assert planner_state(prompt)['pendingRecoveryPages'] == [1]
        assert names(kwargs)[0] == 'extract'
        extraction = choices(kwargs)[0]
        assert extraction['properties']['page']['enum'][:2] == [2, 1]
        assert {'read_page', 'search', 'review_coverage'} <= set(names(kwargs))
        return action('extract', 2)

    result, model = run(monkeypatch, [initial, {'facts': [fact(dueDate=DATE)]}, choose_unextracted,
                        {'facts': []}, recovery_action({'dueDate': None}), {'facts': [fact()]}, finish_without_pending], pages=pages)
    assert len(result.facts) == 1 and model.calls == 7
