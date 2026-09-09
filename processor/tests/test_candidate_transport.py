"""Schema-specialized salvage must preserve valid source IDs without coercion."""
import json

import pytest

from service.config import Settings
from service.engines import CloudModel, EngineSelection
from service.ollama import LocalModelError, LocalOllama
from service.schema import Fact, ReferencedFact, ReferencedModelFacts


TOKEN = 'synthetic-candidate-adapter-token'
QUOTE = 'Investment: Sable Lantern Fund II\nNAV as of 2026-08-31: EUR 734215.60'


def candidate(**updates):
    data = dict(kind='valuation', investmentName='Sable Lantern Fund II',
                effectiveDate='2026-08-31', amount='734215.60', currency='EUR',
                dueDate=None, summary='Synthetic investor valuation',
                evidence={'page': 1, 'sourceId': 'p1:b0'})
    return {**data, **updates}


def adapter(provider, payload):
    settings = Settings(TOKEN, allow_cloud_engines=True)
    if provider == 'ollama':
        model = LocalOllama(settings)
        response = {'done': True, 'message': {'content': json.dumps(payload)}}
    else:
        model = CloudModel(settings, EngineSelection(name='Synthetic cloud',
                           provider=provider, model='synthetic-test',
                           apiKey='synthetic-provider-key-only'))
        content = json.dumps({'result': payload})
        response = ({'status': 'completed', 'output': [{'type': 'message',
                     'content': [{'type': 'output_text', 'text': content}]}]}
                    if provider == 'openai' else
                    {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': content}]})
    model._request = lambda *args: response
    return model


@pytest.mark.parametrize('provider', ['ollama', 'openai', 'anthropic'])
def test_specialized_candidate_salvage_keeps_both_valid_source_and_legacy_evidence(provider):
    legacy = candidate(evidence={'page': 1, 'quote': QUOTE})
    payload = {'facts': [candidate(amount=734215.60), candidate(), legacy,
                         candidate(evidence={'page': '1', 'sourceId': 'p1:b0'}),
                         candidate(evidence={'page': 1, 'sourceId': 42})]}
    model = adapter(provider, payload)
    try:
        result = model.structured(ReferencedModelFacts, 'Synthetic sources.')
        assert type(result) is ReferencedModelFacts
        assert len(result.facts) == 2 and model.rejected_candidates == 3
        assert type(result.facts[0]) is ReferencedFact
        assert result.facts[0].evidence.sourceId == 'p1:b0'
        assert type(result.facts[1]) is Fact and result.facts[1].evidence.quote == QUOTE
        assert all(fact.amount == '734215.60' for fact in result.facts)
    finally:
        model.close()


@pytest.mark.parametrize('provider', ['ollama', 'openai', 'anthropic'])
@pytest.mark.parametrize('payload', [
    {'facts': [candidate()], 'untrusted': True},
    {'facts': [candidate()] * 31},
    {'facts': 'not a list'},
])
def test_specialized_salvage_still_rejects_invalid_envelopes_and_oversized_lists(provider, payload):
    model = adapter(provider, payload)
    try:
        with pytest.raises(LocalModelError, match='model_schema_invalid'):
            model.structured(ReferencedModelFacts, 'Synthetic sources.')
        assert model.calls == 1
    finally:
        model.close()
