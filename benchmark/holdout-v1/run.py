"""Isolated, local-only engine/mode benchmark. Default is a no-network plan.

--execute is required for inference. Child processes receive source bytes and an
explicit model, never gold answers, owner data, application credentials or a DB.
"""
import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import uuid

ROOT=Path(__file__).resolve().parent
APP=ROOT.parent.parent
PROCESSOR=APP/'processor'
DEFAULT_OUTPUT=APP.parent/'validation-seven-items'/'benchmark'
sys.path.insert(0,str(PROCESSOR))
from score import load_frozen, score_case, aggregate, normalized


def write(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')

def stamp():return datetime.now(timezone.utc).isoformat()

def benchmark_code():return {name:sha256((ROOT/name).read_bytes()).hexdigest() for name in ['run.py','score.py']}

def fingerprint():
    paths=sorted((PROCESSOR/'service').glob('*.py'))+[PROCESSOR/'corpus'/'train.json',PROCESSOR/'requirements.lock.txt']
    files={str(path.relative_to(APP)):sha256(path.read_bytes()).hexdigest() for path in paths}
    return {'files':files,'digest':sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()}

def settings(model,timeout,steps):
    from service.config import Settings
    return Settings(token='synthetic-benchmark-'+uuid.uuid4().hex,ollama_model=model,ollama_timeout=timeout,max_agent_steps=steps,ocr_enabled=True,allow_cloud_engines=False)

def mime(path):return {'.pdf':'application/pdf','.eml':'message/rfc822','.txt':'text/plain'}[path.suffix]

def ocr_outcome(case,pages,warnings):
    if not case.get('imageOnlyPDF'):return None
    anchors=[anchor for fact in case['facts'] for anchor in fact['evidenceAnchors']]
    text=' '.join(page.get('text','') for page in pages)
    return {'imageOnlySource':True,'ocrEnabled':True,'pagesMarkedLocalOCR':sum('local OCR' in page.get('source','') for page in pages),'decodedTextCharacters':len(text),'goldAnchorsExpected':len(anchors),'goldAnchorsRecovered':sum(normalized(anchor) in normalized(text) for anchor in anchors),'warnings':[warning for warning in warnings if 'OCR' in warning or 'readable' in warning]}

def validate_corpus(output,corpus):
    from service.documents import parse_document
    os.chdir(PROCESSOR)  # PDF decoder child resolves its installed service module.
    _,gold=load_frozen(corpus)
    report=[]
    for case in gold['cases']:
        path=corpus/case['path'];document=parse_document(path.read_bytes(),path.name,mime(path),settings('gemma-placeholder',120,16))
        pages=[{'number':page.number,'source':page.source,'text':page.text} for page in document.pages]
        for fact in case['facts']:
            page=next((page for page in pages if page['number']==fact['evidencePage']),None)
            if not case.get('imageOnlyPDF') and (not page or any(normalized(anchor) not in normalized(page['text']) for anchor in fact['evidenceAnchors'])):raise ValueError('Gold anchor absent from decoded source: '+case['id'])
        write(output/'corpus-decoded'/(case['id']+'.json'),pages)
        report.append({'caseId':case['id'],'pages':len(pages),'warnings':document.warnings,'goldFacts':len(case['facts']),'sourceHash':sha256(path.read_bytes()).hexdigest(),'ocr':ocr_outcome(case,pages,document.warnings)})
    previous=[path for folder in [PROCESSOR/'tests'/'fixtures',PROCESSOR/'corpus'] for path in folder.glob('*') if path.is_file()]
    prior_hashes={sha256(path.read_bytes()).hexdigest() for path in previous}
    if any(item['sourceHash'] in prior_hashes for item in report):raise ValueError('A prior fixture was reused as new holdout')
    write(output/'corpus-validation.json',{'status':'passed','checkedAt':stamp(),'documents':report,'goldFacts':sum(len(case['facts']) for case in gold['cases']),'priorFixtureHashesChecked':len(prior_hashes),'inferencePerformed':False})
    print(json.dumps({'corpusValidation':'passed','documents':len(report),'goldFacts':sum(len(case['facts']) for case in gold['cases']),'inferencePerformed':False}))


def child(args):
    """Intercept transport only to preserve real local raw bytes; production prompts and logic are unchanged."""
    import httpx
    from service.classifier import RelevanceClassifier
    from service.documents import parse_document
    from service.ollama import LocalOllama, LocalModelError
    import service.engines as engines
    import service.pipeline as pipeline
    target=Path(args.attempt_dir);target.mkdir(parents=True,exist_ok=True)
    source=Path(args.source).resolve()
    if not source.is_relative_to(Path(args.corpus).resolve()/'fixtures'):raise ValueError('Only frozen synthetic benchmark inputs are allowed')
    class RecordingLocalOllama(LocalOllama):
        def __init__(self,configuration):super().__init__(configuration);self.transport_calls=0
        def _request(self,path,body):
            self.transport_calls+=1
            base=target/'raw'/f'{self.transport_calls:03d}-{path.rsplit("/",1)[-1]}'
            write(str(base)+'.request.json',{'endpoint':path,'body':body,'startedAt':stamp()})
            started=time.monotonic();metadata={'endpoint':path,'requestedModel':body.get('model')};data=bytearray()
            try:
                with self.client.stream('POST',path,json=body) as response:
                    metadata['httpStatus']=response.status_code
                    with Path(str(base)+'.response.bin').open('wb') as raw:
                        for chunk in response.iter_bytes():
                            room=2*1024*1024-len(data)
                            raw.write(chunk[:max(0,room)]);raw.flush();data.extend(chunk[:max(0,room)])
                            if len(chunk)>room:metadata['truncated']=True;raise LocalModelError('local_model_response_too_large')
                    if response.status_code!=200:raise LocalModelError('local_model_http_error')
                parsed=json.loads(data)
                if not isinstance(parsed,dict):raise LocalModelError('local_model_response_not_object')
                metadata['returnedModel']=parsed.get('model')
                for key in ['total_duration','load_duration','prompt_eval_count','prompt_eval_duration','eval_count','eval_duration','done_reason']:
                    if key in parsed:metadata[key]=parsed[key]
                return parsed
            except (httpx.HTTPError,ValueError) as error:
                metadata['errorType']=type(error).__name__;raise LocalModelError('local_model_unavailable_or_invalid_json') from error
            except Exception as error:
                metadata['errorType']=type(error).__name__;raise
            finally:
                metadata['wallSeconds']=round(time.monotonic()-started,6);write(str(base)+'.metadata.json',metadata)
    engines.LocalOllama=RecordingLocalOllama
    pipeline.LocalOllama=RecordingLocalOllama
    started=time.monotonic();configuration=settings(args.model,args.request_timeout,args.agent_steps)
    document=parse_document(source.read_bytes(),source.name,mime(source),configuration)
    write(target/'decoded-pages.json',[{'number':page.number,'text':page.text,'source':page.source} for page in document.pages])
    write(target/'decode.json',{'wallSeconds':time.monotonic()-started,'warnings':document.warnings})
    result=pipeline.process(document,args.document_id,args.mode,configuration,RelevanceClassifier(),engine={'name':'Synthetic benchmark explicit local model','provider':'ollama','model':args.model})
    write(target/'extraction.json',result.model_dump(mode='json'))
    write(target/'child-completed.json',{'at':stamp(),'returnedModel':result.model,'execution':result.execution})


def local_inventory(models):
    import httpx
    with httpx.Client(timeout=10,trust_env=False,follow_redirects=False) as client:
        response=client.get('http://127.0.0.1:11434/api/tags');response.raise_for_status()
        if len(response.content)>2*1024*1024:raise ValueError('Local model inventory exceeds bounds')
        rows=response.json().get('models',[])
    selected=[]
    for model in models:
        row=next((row for row in rows if row.get('name')==model or row.get('model')==model),None)
        if not row or row.get('remote_host') or row.get('remote_model') or row.get('details',{}).get('format')!='gguf':raise ValueError('Requested model is not an installed local GGUF: '+model)
        selected.append({key:row.get(key) for key in ['name','model','digest','size','modified_at','details']})
    return selected


def duplicate_consistency(records,gold):
    groups={case['id']:case.get('duplicateGroup') for case in gold['cases'] if case.get('duplicateGroup')}
    grouped={}
    from score import canonical,FIELDS
    for record in records:
        group=groups.get(record['caseId'])
        if not group:continue
        key=(record['model'],record['mode'],record['repetition'],group)
        output=record.get('output') or {};facts=output.get('facts',[])
        grouped.setdefault(key,[]).append({'caseId':record['caseId'],'economicFacts':[tuple(str(canonical(fact.get(field),field)) for field in FIELDS) for fact in facts if isinstance(fact,dict)]})
    return [{'model':key[0],'mode':key[1],'repetition':key[2],'group':key[3],'cases':len(rows),'uniqueReturnedEconomicFacts':len({fact for row in rows for fact in row['economicFacts']}),'consistentSingleEvent':len(rows)==3 and all(len(row['economicFacts'])==1 for row in rows) and len({fact for row in rows for fact in row['economicFacts']})==1,'postingDeduplicationTested':False} for key,rows in grouped.items()]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus',type=Path,default=ROOT.parent/'holdout-v1.1')
    parser.add_argument('--gemma-model');parser.add_argument('--qwen-model')
    parser.add_argument('--mode',choices=['workflow','agentic'],action='append')
    parser.add_argument('--case',action='append',dest='cases');parser.add_argument('--repeat',type=int,default=1)
    parser.add_argument('--request-timeout',type=float,default=120);parser.add_argument('--case-timeout',type=float,default=900);parser.add_argument('--agent-steps',type=int,default=16)
    parser.add_argument('--output',type=Path,default=DEFAULT_OUTPUT)
    parser.add_argument('--execute',action='store_true');parser.add_argument('--validate-corpus',action='store_true')
    parser.add_argument('--child',action='store_true',help=argparse.SUPPRESS);parser.add_argument('--model',help=argparse.SUPPRESS);parser.add_argument('--source',help=argparse.SUPPRESS);parser.add_argument('--attempt-dir',help=argparse.SUPPRESS);parser.add_argument('--document-id',help=argparse.SUPPRESS)
    args=parser.parse_args()
    if args.child:
        if not args.mode or len(args.mode)!=1:raise ValueError('One child mode required')
        args.mode=args.mode[0];child(args);return
    output=args.output.resolve()
    if output.is_relative_to(APP):parser.error('Run outputs must be outside the application repository.')
    if args.validate_corpus:validate_corpus(output,args.corpus.resolve());return
    if not args.gemma_model or 'gemma' not in args.gemma_model.lower():parser.error('Supply the exact installed Gemma tag with --gemma-model.')
    models=[args.gemma_model]+([args.qwen_model] if args.qwen_model else [])
    if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:/-]{0,120}',model) or 'cloud' in model.lower() for model in models):parser.error('Only explicit local model tags are allowed.')
    if args.qwen_model and 'qwen' not in args.qwen_model.lower():parser.error('--qwen-model must identify Qwen.')
    if not 1<=args.repeat<=5 or not 1<=args.agent_steps<=24 or not 1<=args.request_timeout<=180 or not 30<=args.case_timeout<=1800:parser.error('Bounds: repeat1..5, steps1..24, request timeout1..180s, case timeout30..1800s.')
    corpus=args.corpus.resolve();manifest,gold=load_frozen(corpus);cases=gold['cases']
    if args.cases:
        unknown=set(args.cases)-{case['id'] for case in cases}
        if unknown:parser.error('Unknown cases: '+', '.join(sorted(unknown)))
        cases=[case for case in cases if case['id'] in args.cases]
    modes=list(dict.fromkeys(args.mode or ['workflow','agentic']))
    plan=[{'model':model,'mode':mode,'caseId':case['id'],'repetition':repetition} for repetition in range(1,args.repeat+1) for case in cases for model in models for mode in modes]
    if not args.execute:
        print(json.dumps({'planOnly':True,'networkRequests':0,'plannedAttempts':len(plan),'matrix':plan,'outputRoot':str(output),'notice':'Coordinate local capacity before running again with --execute.'},indent=2));return
    run=output/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]);run.mkdir(parents=True,exist_ok=False)
    source_code=fingerprint();bench_code=benchmark_code();inventory=local_inventory(models)
    context={'startedAt':stamp(),'corpusManifest':manifest,'manifestSha256':sha256((corpus/'manifest.json').read_bytes()).hexdigest(),'benchmarkCode':bench_code,'processor':source_code,'python':sys.version,'inventory':inventory,'plan':plan,'bounds':{'caseTimeoutSeconds':args.case_timeout,'requestTimeoutSeconds':args.request_timeout,'maxAgentSteps':args.agent_steps},'execution':'actual selected local Ollama GGUF through production pipeline with transport recording only','cloudExecution':False,'goldAvailableToModel':False}
    write(run/'run.json',context)
    results=[];interruption=None
    for index,item in enumerate(plan,1):
        if fingerprint()['digest']!=source_code['digest'] or benchmark_code()!=bench_code:interruption='Processor or benchmark source changed during matrix; remaining attempts were not run.';break
        case=next(case for case in cases if case['id']==item['caseId'])
        target=run/f'{index:03d}-{item["caseId"]}-{item["mode"]}-r{item["repetition"]}'
        target.mkdir();attempt={**item,'startedAt':stamp(),'documentId':str(uuid.uuid4()),'processorDigest':source_code['digest'],'sourceSha256':manifest['files'][case['path']]};write(target/'attempt.json',attempt)
        args_child=[sys.executable,str(Path(__file__).resolve()),'--child','--corpus',str(corpus),'--source',str(corpus/case['path']),'--model',item['model'],'--mode',item['mode'],'--attempt-dir',str(target),'--document-id',attempt['documentId'],'--request-timeout',str(args.request_timeout),'--agent-steps',str(args.agent_steps)]
        environment={key:value for key,value in os.environ.items() if key in ['PATH','TMPDIR','LANG','LC_ALL','SYSTEMROOT']};environment['PYTHONPATH']=str(PROCESSOR);environment['PYTHONDONTWRITEBYTECODE']='1'
        started=time.monotonic();status='completed'
        with (target/'stdout.txt').open('w') as stdout,(target/'stderr.txt').open('w') as stderr:
            process=subprocess.Popen(args_child,cwd=PROCESSOR,env=environment,stdout=stdout,stderr=stderr,start_new_session=True)
            try:
                code=process.wait(timeout=args.case_timeout)
                if code!=0:status='failed'
            except subprocess.TimeoutExpired:
                status='timeout';os.killpg(process.pid,signal.SIGKILL);process.wait()
            except KeyboardInterrupt:
                status='interrupted';os.killpg(process.pid,signal.SIGKILL);process.wait();interruption='Interrupted by operator; remaining attempts were not run.'
        extraction=json.loads((target/'extraction.json').read_text()) if (target/'extraction.json').exists() else None
        pages=json.loads((target/'decoded-pages.json').read_text()) if (target/'decoded-pages.json').exists() else []
        requests=[json.loads(path.read_text()) for path in (target/'raw').glob('*.request.json')]
        record={**attempt,'status':status,'wallSeconds':round(time.monotonic()-started,6),'modelChatCalls':sum(request['endpoint']=='/api/chat' for request in requests),'returnedModel':extraction.get('model') if extraction else None,'inferenceErrorCount':sum(step.get('status')=='error' for step in (extraction or {}).get('trace',[])),'attemptPath':target.name,'ocr':ocr_outcome(case,pages,(extraction or {}).get('warnings',[])),'score':score_case(case,extraction,pages),'output':extraction}
        write(target/'score.json',record['score']);write(target/'attempt.json',{key:value for key,value in record.items() if key not in ['score','output']});results.append(record)
        write(run/'results.json',results)
        print(json.dumps({'attempt':index,'planned':len(plan),'caseId':item['caseId'],'model':item['model'],'mode':item['mode'],'status':status,'seconds':record['wallSeconds'],'gold':record['score']['goldFactCount'],'supportedExact':record['score']['supportedExactMatches'],'missed':len(record['score']['missedGoldIndices']),'unsupported':len(record['score']['unsupportedFacts']),'modelCalls':record['modelChatCalls']}),flush=True)
        if interruption:break
    try:final_inventory=local_inventory(models)
    except Exception:final_inventory=None
    write(run/'summary.json',{'finishedAt':stamp(),'plannedAttempts':len(plan),'recordedAttempts':len(results),'unrunPlan':plan[len(results):],'interruption':interruption,'modelInventoryUnchanged':inventory==final_inventory,'benchmarkCodeUnchanged':bench_code==benchmark_code(),'processorUnchanged':source_code['digest']==fingerprint()['digest'],'matrix':aggregate(results),'duplicateConsistency':duplicate_consistency(results,gold),'accuracyScope':'Six-field source-grounded fact extraction; underlying constituent extraction remains unsupported.','ocrOutcomes':[{'caseId':row['caseId'],'model':row['model'],'mode':row['mode'],'status':row['status'],'ocr':row['ocr']} for row in results if row['ocr'] is not None],'capabilityGaps':[case['capabilityProbe'] for case in cases if case.get('capabilityProbe')],'limitations':['Small English synthetic diagnostic set, authored and gold-labeled together; no independent human adjudication or production generalization.','All attempted runs and repetitions, including failures/timeouts, are retained; no best-of selection.','Exact match covers six financial fields plus source-grounded evidence; summary wording is not scored.','Review correction units are deterministic edit proxies, not observed human corrections or review time.','Constituent extraction is not supported by the current extraction schema and is reported as a capability gap, never as a passing look-through result.','Source-rule-only cases do not measure the selected model; model-call counts are reported.','Sequential warm-cache ordering and local resource contention affect timings.','Native-text PDFs plus one clean image-only scan; no general OCR, noisy scan, multilingual, email delivery or posting-deduplication quality claim.','No cloud engine was run; no cloud accuracy claim is supported.']})
    print('Preserved benchmark run: '+str(run))

if __name__=='__main__':main()
