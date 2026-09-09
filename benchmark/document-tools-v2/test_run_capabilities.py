"""Offline controls for staging and recording; never contact a processor or model."""
import importlib.util
import json
from pathlib import Path
import pytest
import httpx

SPEC=importlib.util.spec_from_file_location('capability_runner',Path(__file__).with_name('run_capabilities.py'))
runner=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def test_prepare_retains_original_hashes_and_refuses_overwrite(tmp_path):
    run=tmp_path/'run'
    runner.prepare(run,['model-only-fair-value'])
    plan=json.loads((run/'preflight-plan.json').read_text())
    index=json.loads((run/'decoded/decode-index.json').read_text())
    assert len(plan['work'])==4
    assert len({work['id'] for work in plan['work']})==4
    assert index['manifestSha256']==plan['manifestSha256']
    source=(run/'originals/model-only-fair-value.txt').read_bytes()
    assert runner.digest(source)==index['rows'][0]['sourceSha256']
    assert source==(runner.ROOT/'sources/model-only-fair-value.txt').read_bytes()
    with pytest.raises(ValueError,match='overwrite'):
        runner.prepare(run,['model-only-fair-value'])


def test_execute_requires_external_credential_before_any_network(tmp_path,monkeypatch):
    monkeypatch.delenv('PROCESSOR_TOKEN',raising=False)
    with pytest.raises(ValueError,match='PROCESSOR_TOKEN'):
        runner.execute(tmp_path/'not-prepared')


def test_actual_request_interface_and_context_mismatch_fail_without_retry(tmp_path,monkeypatch):
    run=tmp_path/'run'
    runner.prepare(run,['model-only-fair-value'])
    calls=[]
    token='synthetic-test-token-never-real'
    monkeypatch.setenv('PROCESSOR_TOKEN',token)
    class FakeClient:
        def __init__(self,**kwargs):
            assert kwargs['base_url']=='http://127.0.0.1:8000'
            assert kwargs['trust_env'] is False and kwargs['follow_redirects'] is False
        def __enter__(self):return self
        def __exit__(self,*args):return False
        def post(self,path,**kwargs):
            calls.append(kwargs)
            assert path=='/v1/extract'
            assert kwargs['headers']=={'x-processor-key':token}
            engine=json.loads(kwargs['data']['engine'])
            assert engine['provider']=='ollama'
            current=json.loads((run/'current.json').read_text())
            assert current['model']==engine['model']
            assert kwargs['files']['file'][1]==(run/'originals/model-only-fair-value.txt').read_bytes()
            return httpx.Response(200,json={'documentId':'wrong-id','mode':current['mode'],'execution':'local',
                                            'model':engine['model'],'facts':[],'trace':[]})
    monkeypatch.setattr(httpx,'Client',FakeClient)
    with pytest.raises(ValueError,match='processor_context_mismatch'):
        runner.execute(run)
    assert len(calls)==1
    results=json.loads((run/'results.json').read_text())
    assert len(results)==1 and results[0]['status']=='failed'
    assert results[0]['error']=='processor_context_mismatch'
    for path in run.rglob('*'):
        if path.is_file():assert token not in path.read_text()
    with pytest.raises(ValueError,match='rerun'):
        runner.execute(run)


def test_tampered_decoded_artifact_fails_before_execution(tmp_path,monkeypatch):
    run=tmp_path/'run'
    runner.prepare(run,['model-only-fair-value'])
    monkeypatch.setenv('PROCESSOR_TOKEN','synthetic-registry-test-token')
    path=run/'decoded/model-only-fair-value.json'
    decoded=json.loads(path.read_text())
    decoded['pages'][0]['text']='Changed source text with a different value.'
    path.write_text(json.dumps(decoded))
    with pytest.raises(ValueError,match='decoded artifact'):
        runner.execute(run)
    assert not (run/'execution.json').exists()


def test_tampered_index_fails_even_if_it_rehashes_a_changed_artifact(tmp_path,monkeypatch):
    run=tmp_path/'run'
    runner.prepare(run,['model-only-fair-value'])
    monkeypatch.setenv('PROCESSOR_TOKEN','synthetic-registry-test-token')
    index_path=run/'decoded/decode-index.json'
    index=json.loads(index_path.read_text())
    index['rows'][0]['artifactSha256']='f'*64
    index_path.write_text(json.dumps(index))
    with pytest.raises(ValueError,match='decode registry'):
        runner.execute(run)
    assert not (run/'execution.json').exists()
