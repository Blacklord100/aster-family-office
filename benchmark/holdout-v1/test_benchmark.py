from copy import deepcopy
from email import policy
from email.parser import BytesParser
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import pytest
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from score import load_frozen,score_case,aggregate

CORPUS=ROOT.parent/'holdout-v1.1'
MANIFEST,GOLD=load_frozen(CORPUS)

def case(case_id):return deepcopy(next(row for row in GOLD['cases'] if row['id']==case_id))
def pages_for(row):
    path=CORPUS/row['path']
    if path.suffix=='.pdf':return [{'number':index+1,'text':page.extract_text()} for index,page in enumerate(PdfReader(path).pages)]
    message=BytesParser(policy=policy.default).parsebytes(path.read_bytes())
    return [{'number':1,'text':message.get_body(preferencelist=('plain',)).get_content()}]
def perfect(row):
    pages=pages_for(row)
    facts=[{key:value for key,value in fact.items() if key not in ['evidencePage','evidenceAnchors']}|{'summary':'Unit-test constructed gold response, not model output','evidence':{'page':fact['evidencePage'],'quote':pages[fact['evidencePage']-1]['text']}} for fact in row['facts']]
    return {'facts':facts,'relevant':row['relevant']},pages

def test_frozen_v11_preserves_every_v1_source_and_gold_case():
    old_manifest,old_gold=load_frozen(ROOT)
    assert GOLD['cases'][:13]==old_gold['cases']
    assert len(GOLD['cases'])==14
    for path,digest in old_manifest['files'].items():
        if path!='gold.json':assert MANIFEST['files'][path]==digest
    assert (CORPUS/'fixtures/04-capital-call.eml').read_bytes()==(CORPUS/'fixtures/07-identical-call-copy.eml').read_bytes()

def test_scan_contains_no_native_text_and_has_image_content():
    page=PdfReader(CORPUS/'fixtures/14-scanned-nav.pdf').pages[0]
    assert not page.extract_text().strip()
    assert list(page.images)

@pytest.mark.parametrize('row',[row for row in GOLD['cases'] if not row.get('imageOnlyPDF')],ids=lambda row:row['id'])
def test_source_grounded_gold_is_scored_exactly(row):
    output,pages=perfect(row);score=score_case(row,output,pages)
    assert score['factPerfect'];assert score['unsupportedFacts']==[];assert score['reviewCorrectionProxy']['totalUnits']==0

def test_wrong_due_date_is_missed_unsupported_and_a_measurable_field_correction():
    row=case('capital-call');output,pages=perfect(row);output['facts'][0]['dueDate']='2026-06-18'
    score=score_case(row,output,pages)
    assert score['supportedExactMatches']==0;assert score['missedGoldIndices']==[0];assert len(score['unsupportedFacts'])==1
    assert score['reviewCorrectionProxy']['fieldEdits']==1

def test_duplicate_predictions_cannot_inflate_recall_or_precision():
    row=case('capital-call');output,pages=perfect(row);output['facts']*=2
    score=score_case(row,output,pages)
    assert score['supportedExactMatches']==1;assert score['precision']==.5;assert score['recall']==1

def test_fabricated_evidence_and_wrong_page_are_not_supported_matches():
    row=case('capital-call');output,pages=perfect(row);output['facts'][0]['evidence']['quote']='Fennel Ridge Growth VII fabricated quote 86,412.75'
    score=score_case(row,output,pages);assert score['supportedExactMatches']==0;assert score['reviewCorrectionProxy']['evidenceEdits']==1
    output,pages=perfect(row);output['facts'][0]['evidence']['page']=2
    assert score_case(row,output,pages)['supportedExactMatches']==0

def test_decimal_comparison_is_exact_and_missing_null_is_not_a_match():
    row=case('capital-call');output,pages=perfect(row);output['facts'][0]['amount']='86412.75000000'
    assert score_case(row,output,pages)['supportedExactMatches']==1
    output['facts'][0]['amount']='86412.75000001'
    assert score_case(row,output,pages)['supportedExactMatches']==0
    row=case('ambiguous-currency');output,pages=perfect(row);del output['facts'][0]['currency']
    assert score_case(row,output,pages)['supportedExactMatches']==0

def test_currency_inference_and_withdrawn_mark_are_critical_failures():
    row=case('ambiguous-currency');output,pages=perfect(row);output['facts'][0]['currency']='USD'
    assert score_case(row,output,pages)['criticalBoundaryFailures'][0]['reason']=='invented_currency_for_ambiguous_symbol'
    row=case('withdrawn-only');output,pages=perfect(row);output['facts']=[{'kind':'valuation','investmentName':'Cobalt Quay Continuation II','effectiveDate':'2026-04-30','amount':'412608.55','currency':'EUR','dueDate':None,'evidence':{'page':1,'quote':pages[0]['text']}}]
    assert score_case(row,output,pages)['criticalBoundaryFailures'][0]['reason']=='explicitly_forbidden_source_amount'

def test_failures_keep_all_expected_facts_in_the_denominator():
    row=case('nav-table');score=score_case(row,None,[])
    assert len(score['missedGoldIndices'])==2;assert not score['factPerfect'];assert score['recall']==0
    summary=aggregate([{'model':'unit-test','mode':'workflow','status':'timeout','wallSeconds':5,'score':score}])[0]
    assert summary['goldFacts']==2;assert summary['executionErrors']==1;assert summary['recall']==0

def test_unknown_constituents_are_an_explicit_schema_gap_not_accuracy_credit():
    row=case('unknown-constituent-weights');output,pages=perfect(row);score=score_case(row,output,pages)
    assert score['goldFactCount']==1
    assert score['capabilityProbe']['currentExtractionSchemaSupports'] is False
    assert score['capabilityProbe']['goldConstituents'][1]['weight'] is None

def test_default_plan_has_no_network_or_inference_and_contains_full_matrix():
    result=subprocess.run([sys.executable,str(ROOT/'run.py'),'--gemma-model','gemma4:e4b-m3'],capture_output=True,text=True,check=True)
    plan=json.loads(result.stdout)
    assert plan['planOnly'];assert plan['networkRequests']==0;assert plan['plannedAttempts']==28
    assert {item['mode'] for item in plan['matrix']}=={'workflow','agentic'}
