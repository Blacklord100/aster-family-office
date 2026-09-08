"""Strict source-grounded scoring for frozen v1; never repairs or rewrites outputs."""
from statistics import median
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from pathlib import Path
import re

FIELDS=('kind','investmentName','effectiveDate','amount','currency','dueDate')

def normalized(value): return re.sub(r'\s+',' ',value).strip() if isinstance(value,str) else value

def canonical(value,field):
    if field=='amount' and value is not None:
        if not isinstance(value,str) or not re.fullmatch(r'-?\d+(?:\.\d+)?',value): return ('invalid',repr(value))
        try:return Decimal(value)
        except InvalidOperation:return ('invalid',repr(value))
    if field=='investmentName' and isinstance(value,str):return normalized(value).casefold()
    return value

def same_fields(gold,predicted):
    return all(field in predicted and canonical(gold.get(field),field)==canonical(predicted.get(field),field) for field in FIELDS)

def evidence_issue(gold,predicted,pages):
    evidence=predicted.get('evidence')
    if not isinstance(evidence,dict) or not isinstance(evidence.get('quote'),str): return 'missing_evidence'
    if type(evidence.get('page')) is not int:return 'invalid_evidence_page'
    source=next((page.get('text','') for page in pages if page.get('number')==evidence['page']),None)
    quote=normalized(evidence['quote'])
    if not quote or source is None or quote not in normalized(source):return 'quote_not_contiguous_in_source_page'
    if evidence['page']!=gold['evidencePage']:return 'wrong_gold_evidence_page'
    if any(normalized(anchor) not in quote for anchor in gold.get('evidenceAnchors',[])):return 'quote_missing_required_gold_anchor'
    return None

def load_frozen(root):
    root=Path(root).resolve();manifest=json.loads((root/'manifest.json').read_text())
    for relative,digest in manifest['files'].items():
        target=(root/relative).resolve()
        if not target.is_relative_to(root) or not target.is_file() or sha256(target.read_bytes()).hexdigest()!=digest:
            raise ValueError('Frozen corpus checksum mismatch: '+relative)
    gold=json.loads((root/'gold.json').read_text())
    if len(gold['cases'])!=manifest['expectedDocuments']:raise ValueError('Manifest document count mismatch')
    return manifest,gold

def score_case(case,output,pages):
    expected=case['facts']
    valid_envelope=isinstance(output,dict) and isinstance(output.get('facts'),list)
    predicted=output['facts'] if valid_envelope else []
    used=set();matches=[];unsupported=[];evidence_errors=[]
    for pi,prediction in enumerate(predicted):
        if not isinstance(prediction,dict):unsupported.append({'predictionIndex':pi,'reason':'malformed_fact'});continue
        exact=[gi for gi,fact in enumerate(expected) if gi not in used and same_fields(fact,prediction)]
        supported=next((gi for gi in exact if evidence_issue(expected[gi],prediction,pages) is None),None)
        if supported is not None:
            used.add(supported);matches.append({'goldIndex':supported,'predictionIndex':pi});continue
        reason=evidence_issue(expected[exact[0]],prediction,pages) if exact else 'fields_not_in_gold_or_duplicate'
        unsupported.append({'predictionIndex':pi,'reason':reason})
        if exact:evidence_errors.append({'predictionIndex':pi,'goldIndex':exact[0],'reason':reason})
    missed=[index for index in range(len(expected)) if index not in used]
    # Explicit deterministic edit proxy, not observed human work or a minimum edit distance.
    remaining_pred={item['predictionIndex'] for item in unsupported}
    remaining_gold=set(missed);corrections=[]
    pairs=[]
    for gi in remaining_gold:
        for pi in remaining_pred:
            item=predicted[pi]
            if not isinstance(item,dict):continue
            if canonical(expected[gi]['investmentName'],'investmentName')==canonical(item.get('investmentName'),'investmentName') and expected[gi]['kind']==item.get('kind'):
                changed=[field for field in FIELDS if field not in item or canonical(expected[gi].get(field),field)!=canonical(item.get(field),field)]
                issue=evidence_issue(expected[gi],item,pages)
                pairs.append((len(changed)+int(issue is not None),gi,pi,changed,issue))
    for _,gi,pi,fields,issue in sorted(pairs):
        if gi not in remaining_gold or pi not in remaining_pred:continue
        remaining_gold.remove(gi);remaining_pred.remove(pi)
        corrections.append({'operation':'amend','goldIndex':gi,'predictionIndex':pi,'fields':fields,'evidenceCorrectionRequired':issue is not None})
    corrections.extend({'operation':'add_missing_fact','goldIndex':gi} for gi in sorted(remaining_gold))
    corrections.extend({'operation':'remove_unsupported_fact','predictionIndex':pi} for pi in sorted(remaining_pred))
    field_edits=sum(len(item.get('fields',[])) for item in corrections)
    evidence_edits=sum(item.get('evidenceCorrectionRequired',False) for item in corrections)
    forbidden=set(Decimal(value) for value in case.get('forbiddenAmounts',[]))
    critical=[]
    for index,item in enumerate(predicted):
        if not isinstance(item,dict):continue
        amount=canonical(item.get('amount'),'amount')
        if isinstance(amount,Decimal) and amount in forbidden:critical.append({'predictionIndex':index,'reason':'explicitly_forbidden_source_amount','amount':str(amount)})
        if case['id']=='ambiguous-currency' and item.get('currency') is not None:critical.append({'predictionIndex':index,'reason':'invented_currency_for_ambiguous_symbol'})
    recall=len(matches)/len(expected) if expected else None
    precision=len(matches)/len(predicted) if predicted else None
    return {'caseId':case['id'],'validOutputEnvelope':valid_envelope,'goldFactCount':len(expected),'returnedFactCount':len(predicted),'supportedExactMatches':len(matches),'matches':matches,'missedGoldIndices':missed,'unsupportedFacts':unsupported,'evidenceErrors':evidence_errors,'precision':precision,'recall':recall,'factPerfect':valid_envelope and len(matches)==len(expected) and len(predicted)==len(expected),'expectedRelevant':case['relevant'],'predictedRelevant':output.get('relevant') if valid_envelope else None,'classificationCorrect':output.get('relevant')==case['relevant'] if valid_envelope else False,'criticalBoundaryFailures':critical,'reviewCorrectionProxy':{'operations':corrections,'fieldEdits':field_edits,'evidenceEdits':evidence_edits,'additions':len(remaining_gold),'removals':len(remaining_pred),'totalUnits':field_edits+evidence_edits+len(remaining_gold)+len(remaining_pred),'observedHumanCorrections':None},'capabilityProbe':case.get('capabilityProbe')}

def aggregate(records):
    groups={}
    for record in records:groups.setdefault((record['model'],record['mode']),[]).append(record)
    summary=[]
    for (model,mode),rows in groups.items():
        scores=[row['score'] for row in rows];gold=sum(score['goldFactCount'] for score in scores);returned=sum(score['returnedFactCount'] for score in scores);correct=sum(score['supportedExactMatches'] for score in scores)
        seconds=sorted(row.get('wallSeconds',0) for row in rows)
        summary.append({'model':model,'mode':mode,'attempts':len(rows),'passedDocuments':sum(score['factPerfect'] for score in scores),'classificationCorrect':sum(score['classificationCorrect'] for score in scores),'executionErrors':sum(row['status']!='completed' for row in rows),'inferenceErrorAttempts':sum(row.get('inferenceErrorCount',0)>0 for row in rows),'attemptsWithModelCalls':sum(row.get('modelChatCalls',0)>0 for row in rows),'goldFacts':gold,'returnedFacts':returned,'supportedExactFacts':correct,'missedFacts':gold-correct,'unsupportedFacts':returned-correct,'precision':correct/returned if returned else None,'recall':correct/gold if gold else None,'criticalBoundaryFailures':sum(len(score['criticalBoundaryFailures']) for score in scores),'reviewCorrectionProxyUnits':sum(score['reviewCorrectionProxy']['totalUnits'] for score in scores),'wallSecondsTotal':sum(seconds),'wallSecondsMedian':median(seconds) if seconds else None,'wallSecondsMax':max(seconds) if seconds else None})
    return summary

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description='Re-score a preserved attempt without inference.')
    parser.add_argument('attempt',type=Path);parser.add_argument('--corpus',type=Path,default=Path(__file__).resolve().parent.parent/'holdout-v1.1');args=parser.parse_args()
    _,gold=load_frozen(args.corpus)
    metadata=json.loads((args.attempt/'attempt.json').read_text());case=next(case for case in gold['cases'] if case['id']==metadata['caseId'])
    output=json.loads((args.attempt/'extraction.json').read_text()) if (args.attempt/'extraction.json').exists() else None
    pages=json.loads((args.attempt/'decoded-pages.json').read_text()) if (args.attempt/'decoded-pages.json').exists() else []
    print(json.dumps(score_case(case,output,pages),indent=2))
