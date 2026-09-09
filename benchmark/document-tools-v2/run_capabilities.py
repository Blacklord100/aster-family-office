"""Record bounded actual local-model capability probes against frozen source bytes.

Prepare has no inference. Run requires --execute and a separately started recorder
and processor. Gold is used only after each HTTP response by the existing strict
scorer; it is never passed to the processor or model. Failed first requests remain
visible and are not silently retried.
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import os
import time
import uuid

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent.parent
MODELS = ('gemma4:e4b-m3','qwen3-aster-cpu:1.7b')


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.partial')
    tmp.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
    tmp.replace(path)


def manifest():
    data=(ROOT/'manifest.json').read_bytes()
    parsed=json.loads(data)
    for relative,expected in parsed['files'].items():
        source=(ROOT/relative).resolve()
        if not source.is_relative_to(ROOT) or digest(source.read_bytes())!=expected:
            raise ValueError('Frozen capability source hash mismatch: '+relative)
    return digest(data),json.loads((ROOT/'holdout.json').read_text())


def fingerprint():
    paths=[*sorted((APP/'processor/service').glob('*.py')),APP/'processor/corpus/train.json',
           ROOT/'manifest.json',ROOT/'holdout.json',Path(__file__).resolve()]
    return {str(path.relative_to(APP)):digest(path.read_bytes()) for path in paths}


def prepare(run, chosen):
    if run.exists():
        raise ValueError('Refusing to overwrite an existing run directory')
    manifest_hash,gold=manifest()
    by_id={case['id']:case for case in gold['cases']}
    if not chosen or len(set(chosen))!=len(chosen) or any(case not in by_id for case in chosen):
        raise ValueError('Select distinct known case IDs')
    run.mkdir(parents=True)
    rows=[]
    for case_id in chosen:
        case=by_id[case_id]
        payload=(ROOT/case['path']).read_bytes()
        original=run/'originals'/(case_id+'.txt')
        original.parent.mkdir(exist_ok=True)
        original.write_bytes(payload)
        decoded={'pages':[{'number':1,'source':'plain text','text':payload.decode('utf-8')}],
                 'warnings':[],'decodeError':None}
        write(run/'decoded'/(case_id+'.json'),decoded)
        rows.append({'caseId':case_id,'sourceSha256':digest(payload),'pageImages':[],
                     'artifactSha256':digest((run/'decoded'/(case_id+'.json')).read_bytes())})
    work=[]
    for cell,(model,mode) in enumerate((model,mode) for model in MODELS for mode in ('workflow','agentic')):
        for case_id in chosen:
            identity=str(uuid.uuid4())
            work.append({'id':identity,'documentId':identity,'sourceId':case_id,'sourceIds':[case_id],
                         'model':model,'mode':mode,'cell':cell})
    plan={'schemaVersion':1,'preparedAt':now(),'manifestSha256':manifest_hash,'cases':chosen,'work':work,
          'label':'Actual local-model development capability probes; not population accuracy measurement.'}
    write(run/'decoded/decode-index.json',{'decoderUnchanged':True,'manifestSha256':manifest_hash,'rows':rows})
    plan.update({'decodedDirectory':str((run/'decoded').resolve()),
                 'decodeIndexSha256':digest((run/'decoded/decode-index.json').read_bytes())})
    write(run/'preflight-plan.json',plan)
    write(run/'progress.json',{'prepared':True,'started':False,'planned':len(work),'finished':0})
    print(json.dumps({'plan':str(run/'preflight-plan.json'),'decoded':str(run/'decoded'),'planned':len(work)}))


def verify_decoded_registry(run, plan):
    directory = run/'decoded'
    index_path = directory/'decode-index.json'
    if (plan.get('decodedDirectory') != str(directory.resolve()) or directory.is_symlink()
            or index_path.is_symlink() or digest(index_path.read_bytes()) != plan.get('decodeIndexSha256')):
        raise ValueError('Prepared decode registry changed or is unpinned')
    index = json.loads(index_path.read_text())
    rows = index.get('rows',[])
    if (index.get('decoderUnchanged') is not True or index.get('manifestSha256') != plan['manifestSha256']
            or len(rows) != len(plan['cases']) or {row.get('caseId') for row in rows} != set(plan['cases'])):
        raise ValueError('Prepared decode registry identity mismatch')
    for row in rows:
        case_id = row['caseId']
        path = directory/(case_id+'.json')
        original = run/'originals'/(case_id+'.txt')
        if (path.is_symlink() or original.is_symlink() or digest(path.read_bytes()) != row.get('artifactSha256')
                or digest(original.read_bytes()) != row.get('sourceSha256')):
            raise ValueError('Prepared decoded artifact or original bytes changed')
        data = json.loads(path.read_text())
        if (data.get('decodeError') is not None or len(data.get('pages',[])) != 1
                or data['pages'][0].get('number') != 1
                or data['pages'][0].get('text') != original.read_text()):
            raise ValueError('Prepared TXT decode no longer matches the exact original')


def execute(run):
    import httpx
    token=os.environ.get('PROCESSOR_TOKEN')
    if not token:
        raise ValueError('PROCESSOR_TOKEN must be provided in the environment')
    manifest_hash,gold=manifest()
    by_id={case['id']:case for case in gold['cases']}
    plan=json.loads((run/'preflight-plan.json').read_text())
    if plan['manifestSha256']!=manifest_hash:
        raise ValueError('Capability manifest changed after preparation')
    if (run/'execution.json').exists():
        raise ValueError('Refusing to rerun or silently retry an existing attempt set')
    verify_decoded_registry(run,plan)
    plan_hash = digest((run/'preflight-plan.json').read_bytes())
    spec=importlib.util.spec_from_file_location('strict_source_score',ROOT.parent/'holdout-v1/score.py')
    scorer=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scorer)
    pinned=fingerprint()
    execution={'startedAt':now(),'processorBaseUrl':'http://127.0.0.1:8000',
               'manifestSha256':manifest_hash,'planSha256':plan_hash,'sourceFiles':pinned,'completed':False}
    write(run/'execution.json',execution)
    results=[]
    with httpx.Client(base_url='http://127.0.0.1:8000',timeout=650,trust_env=False,follow_redirects=False) as client:
        for work in plan['work']:
            verify_decoded_registry(run,plan)
            if digest((run/'preflight-plan.json').read_bytes()) != plan_hash:
                raise ValueError('Prepared plan changed during capability execution')
            if fingerprint()!=pinned:
                raise ValueError('Processor revision changed during the capability run')
            case=by_id[work['sourceId']]
            payload=(run/'originals'/(case['id']+'.txt')).read_bytes()
            if payload!=(ROOT/case['path']).read_bytes():
                raise ValueError('Prepared source bytes no longer match the frozen source')
            decoded=json.loads((run/'decoded'/(case['id']+'.json')).read_text())
            directory=run/'attempts'/work['id']
            directory.mkdir(parents=True,exist_ok=False)
            write(run/'current.json',work)
            started=now()
            clock=time.monotonic()
            response_bytes=None
            status=None
            output=None
            error=None
            try:
                response=client.post('/v1/extract',headers={'x-processor-key':token},
                    files={'file':(case['id']+'.txt',payload,'text/plain')},
                    data={'document_id':work['documentId'],'mode':work['mode'],
                          'engine':json.dumps({'name':'SYNTHETIC comparison '+work['model'],
                                               'provider':'ollama','model':work['model']})})
                status=response.status_code
                response_bytes=response.content
                (directory/'response.body').write_bytes(response_bytes)
                try:
                    output=response.json()
                except ValueError:
                    error='non_json_response'
                if status!=200:
                    error='processor_http_'+str(status)
                elif (not isinstance(output,dict) or output.get('documentId')!=work['documentId']
                      or output.get('mode')!=work['mode'] or output.get('execution')!='local'
                      or output.get('model') not in (work['model'],None)):
                    error='processor_context_mismatch'
            except httpx.HTTPError as exc:
                error=type(exc).__name__
            wall=time.monotonic()-clock
            if fingerprint()!=pinned:
                error='processor_revision_changed'
            try:
                verify_decoded_registry(run,plan)
                if digest((run/'preflight-plan.json').read_bytes()) != plan_hash:
                    raise ValueError('Prepared plan changed')
            except (ValueError,OSError,KeyError,TypeError):
                error='source_provenance_changed'
            score=scorer.score_case(case,output if status==200 and not error else None,decoded['pages'])
            result={**work,'startedAt':started,'finishedAt':now(),'wallSeconds':wall,'httpStatus':status,
                    'status':'completed' if status==200 and isinstance(output,dict) and not error else 'failed',
                    'sourceSha256':digest(payload),'responseSha256':digest(response_bytes) if response_bytes else None,
                    'error':error,'score':score,'output':output}
            write(directory/'attempt.json',{key:value for key,value in result.items() if key!='output'})
            if output is not None:
                write(directory/'extraction.json',output)
            results.append(result)
            write(run/'results.json',results)
            write(run/'progress.json',{'prepared':True,'started':True,'planned':len(plan['work']),
                                      'finished':len(results),'current':work,'lastError':error})
            print(json.dumps({'finished':len(results),'planned':len(plan['work']),'case':case['id'],
                              'model':work['model'],'mode':work['mode'],'httpStatus':status,
                              'supported':score['supportedExactMatches'],'gold':score['goldFactCount'],
                              'unsupported':score['unsupportedFacts'],'seconds':round(wall,3)}),flush=True)
            if error in ('processor_revision_changed','processor_context_mismatch','source_provenance_changed'):
                raise ValueError(error)
            if score['unsupportedFacts'] or score['criticalBoundaryFailures']:
                raise ValueError('Unsupported fact or critical boundary failure: stop for review; retained first attempt')
            if output and any('context' in str(w.get('detail','')).lower() and w.get('status')=='error'
                              for w in output.get('trace',[])):
                raise ValueError('Model context failure: stop for review; retained first attempt')
    execution.update({'finishedAt':now(),'completed':True,'processorUnchanged':fingerprint()==pinned})
    write(run/'execution.json',execution)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['prepare','run'])
    parser.add_argument('--run',type=Path,required=True)
    parser.add_argument('--cases',nargs='+',default=['model-only-fair-value','model-only-requested-contribution'])
    parser.add_argument('--execute',action='store_true')
    args=parser.parse_args()
    if args.command=='prepare':
        prepare(args.run.resolve(),args.cases)
    elif args.execute:
        execute(args.run.resolve())
    else:
        parser.error('Actual processor inference requires --execute')


if __name__=='__main__':
    main()
