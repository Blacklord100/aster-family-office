"""Read-only corpus integrity and source decoder checks; never invokes a model."""
from __future__ import annotations
import argparse
from hashlib import sha256
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent.parent

def load_frozen(root=ROOT):
    root=Path(root).resolve(); manifest=json.loads((root/'manifest.json').read_text())
    for entry in manifest['files']:
        target=(root/entry['path']).resolve()
        if not target.is_relative_to(root) or sha256(target.read_bytes()).hexdigest()!=entry['sha256']: raise ValueError('Source checksum mismatch: '+entry['path'])
    for filename,key in [('gold.json','goldSha256'),('expected-history.json','expectedHistorySha256'),('catalog.json','catalogSha256')]:
        if sha256((root/filename).read_bytes()).hexdigest()!=manifest[key]: raise ValueError('Frozen metadata checksum mismatch: '+filename)
    gold=json.loads((root/'gold.json').read_text());catalog=json.loads((root/'catalog.json').read_text())
    if len(gold['cases'])!=100 or len(catalog['documents'])!=100 or len(set(row['sha256'] for row in catalog['documents']))!=97: raise ValueError('Corpus count mismatch')
    return manifest,gold,catalog

def decode(output: Path):
    manifest,gold,catalog=load_frozen()
    output=output.resolve()
    if output.exists() or output.is_relative_to(APP): raise ValueError('Use a new private directory outside the application repository.')
    output.mkdir(parents=True,mode=0o700)
    sys.path.insert(0,str(APP/'processor'))
    os.environ['PYTHONPATH'] = str(APP/'processor')  # The unchanged decoder launches service.pdf_worker in a child.
    from service.config import Settings
    from service.documents import parse_document
    settings=Settings(token='synthetic-history-decode-'+uuid4().hex)
    before={str(file.relative_to(APP)):sha256(file.read_bytes()).hexdigest() for file in (APP/'processor/service').glob('*.py')}
    checks=[]
    by_path={row['path']:row for row in catalog['documents']}
    for case in gold['cases']:
        source=(ROOT/case['path']).read_bytes()
        if sha256(source).hexdigest()!=by_path[case['path']]['sha256']: raise ValueError('Changed source')
        doc=parse_document(source,Path(case['path']).name,'message/rfc822',settings)
        pages=[{'number':page.number,'text':page.text,'source':page.source} for page in doc.pages]
        errors=[]
        for fact in case['facts']:
            page=next((page for page in pages if page['number']==fact['evidencePage']),None)
            if page is None or any(re.sub(r'\s+',' ',anchor).strip() not in re.sub(r'\s+',' ',page['text']).strip() for anchor in fact['evidenceAnchors']): errors.append(fact['investmentName'])
        decoded_file = output/(case['id']+'.json')
        decoded_file.write_text(json.dumps({'pages':pages,'warnings':doc.warnings,'contentHash':sha256(source).hexdigest()},indent=2)+'\n')
        checks.append({'caseId':case['id'],'pages':len(pages),'goldAnchorErrors':errors,'warnings':doc.warnings,'decodedSha256':sha256(decoded_file.read_bytes()).hexdigest()})
    after={str(file.relative_to(APP)):sha256(file.read_bytes()).hexdigest() for file in (APP/'processor/service').glob('*.py')}
    if before!=after: raise ValueError('Decoder changed during source checks')
    summary={'goldSha256':manifest['goldSha256'],'manifestSha256':sha256((ROOT/'manifest.json').read_bytes()).hexdigest(),'decoderUnchanged':True,'decoderHashes':before,'modelCalls':0,'documents':checks}
    (output/'decode-index.json').write_text(json.dumps(summary,indent=2)+'\n')
    failures=[row for row in checks if row['goldAnchorErrors']]
    print(json.dumps({'decoded':len(checks),'anchorFailures':failures,'modelCalls':0}))
    if failures: raise SystemExit(1)

def score(exports: Path, decoded: Path):
    manifest,gold,catalog=load_frozen()
    index=json.loads((decoded/'decode-index.json').read_text())
    if index['goldSha256']!=manifest['goldSha256'] or index['manifestSha256']!=sha256((ROOT/'manifest.json').read_bytes()).hexdigest() or index['decoderUnchanged'] is not True: raise ValueError('Decoded source registry does not match this corpus')
    decoded_entries={row['caseId']:row for row in index['documents']}
    data=json.loads(exports.read_text())
    if data.get('dataset')!='history-v1' or data.get('goldProvidedToProcessor') is not False: raise ValueError('Use an isolated history-v1 result export with no answer-key exposure')
    spec=importlib.util.spec_from_file_location('strict_source_score',ROOT.parent/'holdout-v1/score.py');strict=importlib.util.module_from_spec(spec);spec.loader.exec_module(strict)
    jobs={job['contentHash']:job for job in data['jobs']};source_by_path={row['path']:row for row in catalog['documents']};records=[]
    if len(jobs)!=len(data['jobs']): raise ValueError('Ambiguous multiple jobs per immutable source; do not silently choose an outcome')
    for case in gold['cases']:
        source=source_by_path[case['path']];job=jobs.get(source['sha256']);decoded_file=decoded/(case['id']+'.json')
        if sha256(decoded_file.read_bytes()).hexdigest()!=decoded_entries.get(case['id'],{}).get('decodedSha256'): raise ValueError('Decoded source page file changed')
        page_record=json.loads(decoded_file.read_text())
        if page_record['contentHash']!=source['sha256']: raise ValueError('Source page checksum identity mismatch')
        result=job.get('result') if job else None
        records.append({'caseId':case['id'],'jobId':job.get('id') if job else None,'status':job.get('status') if job else 'missing','resultPresent':result is not None,'score':strict.score_case(case,result,page_record['pages'])})
    correct=sum(row['score']['supportedExactMatches'] for row in records);returned=sum(row['score']['returnedFactCount'] for row in records);expected=sum(row['score']['goldFactCount'] for row in records)
    return {'organizationId':data['organizationId'],'dataset':'history-v1','goldSha256':manifest['goldSha256'],'receipts':100,'uniqueExpectedSources':97,'exportedJobs':len(data['jobs']),'expectedFacts':expected,'supportedExactFacts':correct,'returnedFacts':returned,'recall':correct/expected,'precision':correct/returned if returned else None,'factPerfectReceipts':sum(row['resultPresent'] and row['score']['factPerfect'] for row in records),'missingOrUnprocessed':sum(not row['resultPresent'] for row in records),'denominator':'Per source receipt, including duplicate-forward receipts; no missing/failed source is excluded.','records':records}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--decode',type=Path);parser.add_argument('--exports',type=Path);parser.add_argument('--decoded',type=Path);parser.add_argument('--output',type=Path);args=parser.parse_args()
    if args.decode: decode(args.decode)
    elif args.exports:
        if not args.decoded or not args.output: parser.error('--exports requires --decoded and --output')
        if args.output.exists(): raise ValueError('Use a fresh score output; previous scoring records remain immutable.')
        result=score(args.exports,args.decoded);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({key:value for key,value in result.items() if key!='records'}))
    else:
        manifest,_,_=load_frozen();print(json.dumps({key:manifest[key] for key in ['emailCount','uniqueSourceCount','pdfAttachmentCount','expectedFactCount']}))
