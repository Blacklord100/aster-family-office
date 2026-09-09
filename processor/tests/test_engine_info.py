"""No inference: metadata, identity, resource and sandbox boundaries."""
from dataclasses import replace
import json
import httpx
import pytest
from fastapi.testclient import TestClient
from service.config import Settings
from service.engines import EngineSelection
from service.engine_info import inspect_engine
from service.ollama import LocalOllama, LocalModelError
from service.app import create_app

TOKEN = 'synthetic-inspection-authentication-token'
SETTINGS = Settings(TOKEN)
ENGINE = EngineSelection(name='Synthetic', provider='ollama', model='gemma4:fixture')
DIGEST = 'a' * 64


def mocked_metadata(monkeypatch, show=None, tags=None):
    requests = []
    real_client = httpx.Client
    def handler(request):
        requests.append(request)
        if request.url.path == '/api/show':
            assert request.method == 'POST'
            assert json.loads(request.content) == {'model': ENGINE.model}
            return httpx.Response(200, json=show if show is not None else {'details': {'format': 'gguf'}, 'capabilities': ['vision']})
        assert request.url.path == '/api/tags' and request.method == 'GET'
        return httpx.Response(200, json=tags if tags is not None else {'models': [{'name': ENGINE.model, 'details': {'format': 'gguf'}, 'digest': DIGEST, 'size': 1}]})
    def client(*args, **kwargs):
        assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        return real_client(*args, **kwargs, transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, 'Client', client)
    return requests


def test_inspection_uses_only_exact_alias_metadata_and_actual_settings(monkeypatch):
    requests = mocked_metadata(monkeypatch)
    settings = replace(SETTINGS, max_pages=7, max_file_bytes=1234, max_agent_steps=11,
                       max_nested_eml_depth=2, max_model_calls=9, max_page_extractions=3)
    result = inspect_engine(settings, ENGINE)
    assert len(requests) == 2 and result.observedDigest == DIGEST
    assert result.vision.advertised == 'supported' and result.vision.effective == 'enabled'
    assert not result.vision.imageTested and not result.generationPerformed and not result.digestPinned and not result.autoDownload
    assert result.limits.maxPages == 7 and result.limits.maxFileBytes == 1234 and result.limits.maxAgentSteps == 11
    assert result.limits.maxNestedEmailDepth == 2 and result.limits.maxModelCalls == 9 and result.limits.maxPageExtractions == 3
    assert (result.limits.contextTokens, result.limits.outputTokens, result.limits.maxPromptBytes) == (16384, 3200, 11500)
    assert TOKEN not in result.model_dump_json() and SETTINGS.ollama_base_url not in result.model_dump_json()


@pytest.mark.parametrize('caps,advertised,effective', [
    (['completion'], 'unsupported', 'model_unsupported'), ([], 'unsupported', 'model_unsupported'),
    (None, 'unknown', 'metadata_unknown'), ('vision', 'unknown', 'metadata_unknown'),
    (['vision', 1], 'unknown', 'metadata_unknown'), (['vision'], 'supported', 'enabled'),
])
def test_unknown_is_not_unsupported(monkeypatch, caps, advertised, effective):
    mocked_metadata(monkeypatch, show={'details': {'format': 'gguf'}, 'capabilities': caps})
    result = inspect_engine(SETTINGS, ENGINE)
    assert (result.vision.advertised, result.vision.effective) == (advertised, effective)


@pytest.mark.parametrize('setting', [{'visual_pages_enabled': False}, {'max_visual_pages': 0}, {'max_visual_bytes': 0}])
def test_deployment_can_disable_a_capable_model(monkeypatch, setting):
    mocked_metadata(monkeypatch)
    result = inspect_engine(replace(SETTINGS, **setting), ENGINE)
    assert result.vision.advertised == 'supported' and result.vision.effective == 'deployment_disabled'


@pytest.mark.parametrize('tags', [
    {'models': []}, {'models': None}, [],
    {'models': [{'name': 'unrelated:other', 'details': None, 'size': 1, 'digest': DIGEST}]},
    {'models': [{'name': 'gemma4:other', 'details': {'format': 'gguf'}, 'size': 1, 'digest': DIGEST}]},
    {'models': [{'name': ENGINE.model, 'details': {'format': 'gguf'}, 'size': 1, 'digest': 'invalid'}]},
    {'models': [{'name': ENGINE.model, 'details': {'format': 'gguf'}, 'size': 1, 'digest': DIGEST}] * 2},
])
def test_optional_digest_does_not_infer_identity_or_lose_capability(monkeypatch, tags):
    mocked_metadata(monkeypatch, tags=tags)
    result = inspect_engine(SETTINGS, ENGINE)
    assert result.observedDigest is None and result.vision.advertised == 'supported'


@pytest.mark.parametrize('provider', ['openai', 'anthropic'])
def test_cloud_does_not_create_any_http_client_or_return_secret(monkeypatch, provider):
    def forbidden(*args, **kwargs):
        pytest.fail('Cloud metadata inspection must not contact a provider or local runtime')
    monkeypatch.setattr(httpx, 'Client', forbidden)
    engine = EngineSelection(name='Cloud', provider=provider, model='future-model', apiKey='synthetic-secret-not-a-real-credential')
    result = inspect_engine(replace(SETTINGS, allow_cloud_engines=True), engine)
    assert result.vision.advertised == 'unknown' and result.vision.effective == 'provider_disabled'
    assert result.vision.basis == 'provider_policy' and result.observedDigest is None
    assert result.limits.outputTokens == 3200 and result.limits.contextTokens is None
    assert 'synthetic-secret' not in result.model_dump_json()


def test_remote_or_unverified_model_fails_closed(monkeypatch):
    requests = mocked_metadata(monkeypatch, show={'details': {'format': 'gguf'}, 'capabilities': ['vision'], 'remote_host': 'remote.invalid'})
    with pytest.raises(LocalModelError, match='not_verified_local'):
        inspect_engine(SETTINGS, ENGINE)
    assert len(requests) == 1


def test_metadata_authentication_body_and_selection_before_child(monkeypatch):
    import service.app as module
    monkeypatch.setattr(module.subprocess, 'Popen', lambda *args, **kwargs: pytest.fail('Must reject before subprocess'))
    with TestClient(create_app(SETTINGS)) as client:
        assert client.post('/v1/engine-info', json=ENGINE.model_dump()).status_code == 401
        assert client.post('/v1/engine-info', headers={'X-Processor-Key': TOKEN}, content=b'x' * 65537).status_code == 413
        assert client.post('/v1/engine-info', headers={'X-Processor-Key': TOKEN}, json={**ENGINE.model_dump(), 'endpoint': 'http://remote.invalid'}).status_code == 422


def test_inspection_hard_deadline_kills_child(monkeypatch):
    import service.app as module
    killed = []
    class Child:
        pid = 123456788
        returncode = -9
        calls = 0
        def poll(self): return None
        def communicate(self, *args, **kwargs):
            self.calls += 1
            if self.calls == 1:
                assert kwargs['timeout'] == 20
                assert json.loads(args[0])['operation'] == 'engine_info'
                raise module.subprocess.TimeoutExpired('synthetic-worker', 20)
            return b'', b''
    monkeypatch.setattr(module.subprocess, 'Popen', lambda *args, **kwargs: Child())
    monkeypatch.setattr(module.os, 'killpg', lambda pid, signal: killed.append(pid))
    with TestClient(create_app(SETTINGS)) as client:
        response = client.post('/v1/engine-info', headers={'X-Processor-Key': TOKEN}, json=ENGINE.model_dump())
    assert response.status_code == 504 and killed == [123456788]


def test_capability_observation_resets_on_failed_reverification():
    model = LocalOllama(SETTINGS)
    try:
        model._request = lambda *args: {'details': {'format': 'gguf'}, 'capabilities': ['vision']}
        model.verify_local()
        assert model.capabilities_known and model.supports_vision
        model._request = lambda *args: {'details': {'format': 'gguf'}, 'remote_host': 'remote.invalid'}
        with pytest.raises(LocalModelError): model.verify_local()
        assert not model.capabilities_known and not model.supports_vision
    finally:
        model.close()


def test_worker_metadata_operation_cannot_decode_or_generate(monkeypatch, capsys):
    from dataclasses import asdict
    import io
    import service.request_worker as worker
    from service.engine_info import EngineInfo
    def forbidden(*args, **kwargs):
        pytest.fail('Metadata worker must not decode documents, classify or generate')
    monkeypatch.setattr(worker, 'parse_document', forbidden)
    monkeypatch.setattr(worker, 'RelevanceClassifier', forbidden)
    monkeypatch.setattr(worker, 'process', forbidden)
    monkeypatch.setattr(httpx, 'Client', forbidden)
    payload = {'operation': 'engine_info', 'settings': asdict(replace(SETTINGS, allow_cloud_engines=True)),
               'engine': {'name': 'Synthetic cloud', 'provider': 'openai', 'model': 'future-model', 'apiKey': 'synthetic-secret-not-a-real-key'}}
    monkeypatch.setattr(worker.sys, 'stdin', io.StringIO(json.dumps(payload)))
    worker.main()
    raw = capsys.readouterr().out
    result = EngineInfo.model_validate_json(raw)
    assert not result.generationPerformed and result.vision.effective == 'provider_disabled'
    assert 'synthetic-secret' not in raw and TOKEN not in raw
