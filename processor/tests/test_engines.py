import json
from dataclasses import replace
import httpx
import pytest
from fastapi.testclient import TestClient
from service.app import create_app, child_environment
from service.config import Settings
from service.engines import EngineSelection, CloudModel, SyntheticCheck, cloud_schema, selection
from service.ollama import LocalModelError
from service.schema import AgentAction, ModelFacts
from service.pipeline import process
from service.documents import Document, Page
from service.classifier import RelevanceClassifier
from tests.fake_ollama import fake_ollama

TOKEN='synthetic-engine-auth-token-long'
SECRET='synthetic-provider-credential-only'
SETTINGS=Settings(TOKEN,allow_cloud_engines=True)

def cloud(provider='openai'):
    return EngineSelection(name='Synthetic test',provider=provider,model='gpt-5.3-codex' if provider=='openai' else 'claude-sonnet-4-6',apiKey=SECRET)

def response(provider, value):
    text=json.dumps({'result':value})
    return {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':text}]}]} if provider=='openai' else {'stop_reason':'end_turn','content':[{'type':'text','text':text}]}

@pytest.mark.parametrize('provider',['openai','anthropic'])
def test_fixed_provider_contract_and_credentials_outside_prompt(provider, monkeypatch):
    monkeypatch.setenv('HTTPS_PROXY','http://127.0.0.1:1')
    model=CloudModel(SETTINGS,cloud(provider)); calls=[]
    def handler(request):
        body=json.loads(request.content);calls.append(request)
        assert request.url.scheme=='https'
        assert request.url.host==('api.openai.com' if provider=='openai' else 'api.anthropic.com')
        assert SECRET not in request.content.decode()
        assert 'tools' not in body
        if provider=='openai':
            assert body['store'] is False and body['max_output_tokens']==3200
            assert body['text']['format']['strict'] is True
            assert request.headers['authorization']=='Bearer '+SECRET
        else:
            assert body['output_config']['format']['type']=='json_schema' and body['max_tokens']==3200
            assert request.headers['x-api-key']==SECRET
        return httpx.Response(200,json=response(provider,{'ok':True}))
    model.client.close();model.client=httpx.Client(transport=httpx.MockTransport(handler),trust_env=False,follow_redirects=False)
    try:
        assert model.structured(SyntheticCheck,'Synthetic harmless prompt').ok is True
        assert len(calls)==1 and model.calls==1
    finally: model.close()

@pytest.mark.parametrize('status',[302,401,429,500])
def test_provider_failures_never_follow_redirect_or_leak_response(status):
    model=CloudModel(SETTINGS,cloud());calls=[]
    def handler(request):
        calls.append(request)
        return httpx.Response(status,headers={'Location':'https://evil.invalid'},text=SECRET)
    model.client.close();model.client=httpx.Client(transport=httpx.MockTransport(handler),follow_redirects=False,trust_env=False)
    try:
        with pytest.raises(LocalModelError) as caught:model.structured(SyntheticCheck,'Synthetic check')
        assert SECRET not in str(caught.value) and len(calls)==1
    finally:model.close()

def test_schema_wraps_root_union_and_preserves_original_validation():
    schema=cloud_schema({'anyOf':[{'type':'object','properties':{'action':{'const':'read_page'},'page':{'type':'integer'}},'required':['action','page'],'additionalProperties':False}]})
    assert schema['type']=='object' and schema['required']==['result']
    assert schema['properties']['result']['anyOf'][0]['properties']['action']=={'enum':['read_page']}
    model=CloudModel(SETTINGS,cloud())
    model._request=lambda *args: response('openai',{'facts':[{'kind':'valuation','amount':'NaN'}]})
    try:
        assert model.structured(ModelFacts,'Synthetic').facts==[]
        assert model.rejected_candidates==1
    finally:model.close()

def test_cloud_disabled_and_secret_validation_are_safe():
    with pytest.raises(ValueError):selection(cloud().model_dump(),Settings(TOKEN))
    for value in [dict(name='x',provider='ollama',model='qwen:cloud'),dict(name='x',provider='openai',model='x'),dict(name='x',provider='ollama',model='qwen',apiKey=SECRET)]:
        with pytest.raises(ValueError):EngineSelection.model_validate(value)
    assert SECRET not in repr(cloud())
    with TestClient(create_app(Settings(TOKEN))) as client:
        for route in ['/v1/engine-test','/v1/models']:
            assert client.request('POST' if route.endswith('test') else 'GET',route).status_code==401
        result=client.post('/v1/engine-test',headers={'X-Processor-Key':TOKEN},json=cloud().model_dump())
        assert result.status_code==422 and SECRET not in result.text
        result=client.post('/v1/engine-test',headers={'X-Processor-Key':TOKEN},content=b'x'*65537)
        assert result.status_code==413

def test_selected_local_model_independent_of_mode_and_deployment_default():
    with fake_ollama([{'action':'read_page','page':1},{'action':'extract','page':1},{'facts':[]},{'action':'finish','page':None}]) as (url,requests):
        settings=replace(Settings(TOKEN),ollama_base_url=url,ollama_model='qwen-deployment-default')
        output=process(Document([Page(1,'SYNTHETIC TEST DATA ordinary office printer supplies.','document')],[]),'synthetic','agentic',settings,RelevanceClassifier(),{'name':'Gemma profile','provider':'ollama','model':'gemma4:e4b-m3'})
    assert output.execution=='local' and output.model=='gemma4:e4b-m3'
    assert all(body.get('model')=='gemma4:e4b-m3' for _,body in requests)
    assert settings.ollama_model=='qwen-deployment-default'

def test_cloud_refusal_cannot_become_fact_or_fallback():
    model=CloudModel(SETTINGS,cloud())
    model._request=lambda *args:{'status':'completed','output':[{'type':'message','content':[{'type':'refusal','refusal':SECRET}]}]}
    try:
        with pytest.raises(LocalModelError,match='incomplete_or_refused'):model.structured(AgentAction,'Synthetic')
        assert model.calls==1
    finally:model.close()

def test_child_environment_excludes_authentication_and_proxy_secrets(monkeypatch):
    for key in ['PROCESSOR_TOKEN','PROCESSOR_CLOUD_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY','DATABASE_URL','ENCRYPTION_KEY','HTTPS_PROXY']:
        monkeypatch.setenv(key,SECRET)
    env=child_environment('/tmp/synthetic-isolated')
    assert SECRET not in json.dumps(env)
    assert env['TMPDIR']=='/tmp/synthetic-isolated' and 'PATH' in env

@pytest.mark.parametrize('provider,payload',[
    ('openai',{'status':'completed','output':None}),
    ('openai',{'status':'completed','output':[None]}),
    ('openai',{'status':'completed','output':[{'type':'message','content':SECRET}]}),
    ('openai',{'status':'completed','output':[{'type':'message','content':[None]}]}),
    ('anthropic',{'stop_reason':'end_turn','content':None}),
    ('anthropic',{'stop_reason':'end_turn','content':[None]}),
])
def test_malformed_provider_envelopes_are_safe_model_errors(provider,payload):
    model=CloudModel(SETTINGS,cloud(provider))
    model._request=lambda *args:payload
    try:
        with pytest.raises(LocalModelError) as caught:model.structured(SyntheticCheck,'Synthetic')
        assert SECRET not in str(caught.value)
    finally:model.close()
