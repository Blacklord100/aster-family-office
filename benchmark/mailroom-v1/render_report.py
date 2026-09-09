"""Render a portable, network-free HTML/CSV view of preserved mailroom scores.

This renderer never runs a model or changes scorecard.json. Evidence is displayed
as text, including malicious source strings; no email HTML or PDF script executes.
"""
import argparse
import base64
from hashlib import sha256
import csv
from decimal import Decimal
import importlib.util
from datetime import datetime, timezone
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIELDS = ('kind', 'investmentName', 'effectiveDate', 'amount', 'currency', 'dueDate')
SPEC = importlib.util.spec_from_file_location('strict_mailroom_report_score', ROOT.parent / 'holdout-v1' / 'score.py')
strict = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(strict)


def economics_key(output):
    def canonical(value, field):
        value = strict.canonical(value, field)
        return format(value.normalize(), 'f') if isinstance(value, Decimal) else value
    facts = [[canonical(fact.get(field), field) for field in FIELDS] for fact in (output or {}).get('facts', [])]
    return json.dumps({'relevant': (output or {}).get('relevant'), 'facts': sorted(facts, key=lambda fact: json.dumps(fact, ensure_ascii=False))}, sort_keys=True, ensure_ascii=False)


def compact(row, sources):
    def outcome(which):
        value = row[which]
        score = value['score']
        return {
            'status': value['status'], 'httpStatus': value.get('httpStatus'),
            'seconds': value.get('wallSeconds'), 'calls': value.get('modelChatCalls'),
            'exact': score['supportedExactMatches'], 'expected': score['goldFactCount'],
            'returned': score['returnedFactCount'], 'perfect': score['factPerfect'],
            'classificationCorrect': score['classificationCorrect'],
            'unsupported': score['unsupportedFacts'], 'missed': score['missedGoldIndices'],
            'warnings': value.get('warnings', []),
            'facts': (value.get('output') or {}).get('facts', []),
            'relevant': (value.get('output') or {}).get('relevant'),
            'economicsKey': economics_key(value.get('output')),
        }
    source = sources[row['caseId']]
    return {
        'id': row['caseId'], 'subject': source['subject'], 'office': row['officeId'],
        'mailbox': row['mailboxId'], 'category': row['category'], 'model': row['model'],
        'mode': row['mode'], 'cell': row['cell'], 'jobId': row['jobId'],
        'filename': row['filename'], 'duplicateOf': row.get('duplicateOf'),
        'expected': row['expectedFacts'], 'decode': row['decode'],
        'boundaries': row.get('reviewExpectation', row.get('reviewBoundaries')),
        'safeInputBlockExpected': row.get('expectedSafeInputBlock'),
        'errorCode': row.get('errorCode'), 'attempts': row['processingHttpAttempts'],
        'allSeconds': row['allAttemptWallSeconds'],
        'firstAttempt': outcome('firstAttempt'), 'final': outcome('final'),
    }


HTML = r'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Aster · The 100-email experiment</title>
<style>
:root{color-scheme:light;--ink:#202a2b;--muted:#687775;--line:#dfe7e3;--paper:#f4f7f4;--green:#2b6656;--purple:#725ad1;--red:#a84635;--gold:#8a6621}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit}button,select,input{border:1px solid var(--line);background:white;border-radius:8px;padding:9px 12px;color:var(--ink)}button{cursor:pointer}button:hover{border-color:var(--green)}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #b6cbc1;outline-offset:2px}a{color:var(--green)}header{background:#e4ede7;border-bottom:1px solid #cbd9d0;padding:36px max(24px,calc((100vw - 1360px)/2)) 30px}.brand{font-weight:650;letter-spacing:-.05em;font-size:24px}.brand span{color:var(--purple);margin-right:8px}.eyebrow{margin-top:28px;color:#4a695c;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.15em}h1{font-size:clamp(30px,4vw,48px);line-height:1.12;letter-spacing:-.045em;font-weight:550;max-width:900px;margin:12px 0 18px}header p{max-width:870px;color:#4f6660;margin:0}.badge{display:inline-block;margin-top:18px;font-size:11px;border:1px solid #bccfc3;border-radius:20px;padding:4px 10px;background:#f2f7f2}.wrap{max-width:1408px;margin:auto;padding:28px 24px 64px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}.stat,.panel{background:white;border:1px solid var(--line);border-radius:12px}.stat{padding:19px 22px}.stat label{display:block;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}.stat strong{display:block;font-size:32px;line-height:1.4;letter-spacing:-.05em;font-weight:550}.stat small{color:var(--muted)}.panel{padding:24px;margin-bottom:22px}.sectionhead{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:18px}.sectionhead h2{margin:0;font-size:21px;letter-spacing:-.02em;font-weight:600}.sectionhead p{margin:5px 0 0;color:var(--muted);font-size:12px}.viewtabs{display:flex;gap:4px;background:var(--paper);padding:4px;border-radius:9px;white-space:nowrap}.viewtabs button{border-color:transparent;background:transparent;padding:7px 10px;font-size:12px}.viewtabs button[aria-pressed=true]{background:white;border-color:var(--line);box-shadow:0 1px 2px #00000005}.matrix{overflow-x:auto}.matrix table{width:100%;border-collapse:collapse;min-width:780px;text-align:left}th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;font-weight:500;color:var(--muted);padding:12px 10px;border-bottom:1px solid var(--line)}td{padding:15px 10px;border-bottom:1px solid #edf1ed;vertical-align:middle}td:first-child{font-weight:600}tr:last-child td{border-bottom:0}.bar{height:5px;background:#e8eee8;border-radius:6px;margin-top:7px;width:110px;overflow:hidden}.bar i{display:block;height:100%;background:var(--green)}.bar.purple i{background:var(--purple)}.metricnum{font-variant-numeric:tabular-nums}.note{color:var(--muted);font-size:12px;margin-top:16px;max-width:1040px}.filters{display:flex;flex-wrap:wrap;gap:8px;padding-bottom:16px}.filters input{flex:1;min-width:220px}.filters select{max-width:230px}.count{font-size:12px;color:var(--muted);margin:0 0 12px}.cards{border-top:1px solid var(--line)}.case{display:grid;grid-template-columns:minmax(0,1fr) repeat(4,125px);gap:12px;align-items:center;padding:15px 0;border-bottom:1px solid var(--line)}.casehead{font-size:10px;text-transform:uppercase;color:var(--muted);padding:0 0 12px;letter-spacing:.04em}.subject{display:block;border:0;padding:0;background:transparent;text-align:left;border-radius:3px;font-size:13px;font-weight:600}.sub{color:var(--muted);font-size:11px;margin-top:3px}.result{font-size:12px;font-weight:550;color:var(--green)}.result.bad{color:var(--red)}.result.wait{color:var(--gold)}.result small{display:block;font-weight:400;color:var(--muted);font-size:10px;margin-top:2px}.drawer{border:1px solid var(--line);border-radius:12px;width:min(980px,calc(100vw - 24px));max-height:88vh;padding:0;box-shadow:0 20px 100px #16372c30}.drawer::backdrop{background:#20372f66}.drawer .inside{padding:24px}.drawer h2{font-size:24px;line-height:1.25;letter-spacing:-.03em;margin:12px 0}.toprow{display:flex;justify-content:space-between;align-items:center;gap:12px}.facts{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:16px}.fact{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:9px;font-size:12px;overflow-wrap:anywhere}.fact strong{font-size:13px}blockquote{margin:10px 0 0;padding-left:10px;border-left:2px solid #b5c5ba;color:var(--muted);white-space:pre-wrap}.pills{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.pill{background:#eef2ed;padding:3px 8px;font-size:10px;border-radius:12px}.warnings{padding:10px 12px;border-left:3px solid var(--gold);background:#faf6e9;font-size:12px;white-space:pre-wrap}.fine{font-size:11px;color:var(--muted)}details{margin:12px 0}summary{cursor:pointer;color:var(--muted)}pre{font:11px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.limitations{columns:2;column-gap:40px;font-size:12px;color:var(--muted);padding-left:18px}.limitations li{break-inside:avoid;padding:0 0 9px}footer{overflow-wrap:anywhere;color:var(--muted);font-size:11px;border-top:1px solid var(--line);padding-top:18px}@media(max-width:800px){.stats{grid-template-columns:repeat(2,1fr)}.panel{padding:18px}.sectionhead{display:block}.viewtabs{margin-top:12px;width:max-content}.cards{min-width:790px}.mailwrap{overflow-x:auto}.facts{grid-template-columns:1fr}.limitations{columns:1}.wrap{padding:18px 12px}.case{grid-template-columns:minmax(260px,1fr) repeat(4,110px)}header{padding:25px 20px}.filters select{max-width:100%;flex:1}}
</style></head><body>
<header><div class="brand"><span>✳</span>Aster</div><div class="eyebrow">A real pipeline · fictional inboxes</div><h1>The 100-email experiment.</h1><p>Three offices. Nine mailboxes. Messy PDFs, brief notes, repeated reports and consolidations—collected through the production mailroom and processed with two models in two modes.</p><span class="badge" id="runstate"></span></header>
<main class="wrap"><div class="stats" id="stats"></div>
<section class="panel"><div class="sectionhead"><div><h2>What reached the review queue?</h2><p>Primary comparison counts each unique original once per office, model and mode.</p></div><div class="viewtabs"><button id="finaltab" aria-pressed="true">Stored outcome</button><button id="firsttab" aria-pressed="false">First attempt</button></div></div><div class="matrix" id="matrix"></div><p class="note">Collection completeness and extraction correctness are different. Missing and failed cases remain in the fact denominator. Gemma uses the existing GPU configuration; this Qwen alias uses the CPU. Latencies are observed on one 16 GiB Mac, not a controlled speed ranking. Timings cover the recorded HTTP request, excluding queue and retry waits; P95 is the nearest-rank 95th percentile. Exactness covers six structured fields and source evidence; summary quality and look-through proposal completeness are not scored.</p></section>
<section class="panel"><div class="sectionhead"><div><h2>Every email, every outcome.</h2><p>Select an email to inspect expected facts, extracted facts, quotations and warnings.</p></div><button id="download">Download filtered CSV</button></div><div class="filters"><input id="search" aria-label="Search emails" placeholder="Search subject, investment or category…"><select id="office" aria-label="Office"><option value="">All three offices</option></select><select id="category" aria-label="Content type"><option value="">All content types</option></select><select id="outcome" aria-label="Outcome"><option value="">All outcomes</option><option value="attention">Needs attention in any configuration</option><option value="difference">Workflow / agentic disagreement</option><option value="perfect">Exact in all four configurations</option></select></div><p class="count" id="count"></p><div class="mailwrap"><div class="cards" id="cases"></div></div></section>
<section class="panel"><h2>How to read this experiment</h2><ul class="limitations" id="limitations"></ul></section><footer id="footer"></footer></main>
<dialog class="drawer" id="drawer"><div class="inside"><div class="toprow"><span class="fine" id="caseid"></span><button id="close">Close</button></div><h2 id="detailtitle"></h2><p class="fine" id="detailmeta"></p><div class="filters"><select id="detailcell" aria-label="Configuration"></select><button id="original">Download original email</button></div><div id="detailbody"></div></div></dialog>
<script id="data" type="application/json">__DATA__</script>
<script>
'use strict';const data=JSON.parse(document.getElementById('data').textContent);let which='final',selected=null,filtered=[];
const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(cls)node.className=cls;return node};
const byId=id=>document.getElementById(id);const pct=n=>n==null?'—':(n*100).toFixed(1)+'%';const secs=n=>n==null?'—':n.toFixed(1)+' s';const num=n=>n==null?'—':Number(n).toLocaleString();
const label=(cell)=>['Gemma · workflow','Gemma · agentic','Qwen · workflow','Qwen · agentic'][cell];
const groups=Array.from(new Set(data.rows.map(r=>r.id))).map(id=>data.rows.filter(r=>r.id===id).sort((a,b)=>a.cell-b.cell));
const complete=data.matrix.uniqueSourcesStoredFinal.every(r=>r.complete);byId('runstate').textContent=complete?'Complete matrix · preserved evidence':'In progress · unrun work remains visible';
for(const [title,value,detail]of [['Mailbox receipts',data.collection?.receiptCount??0,'100 planned across nine inboxes'],['Unique originals',data.collection?.uniqueOriginals??0,'Duplicates retain their mailbox receipts'],['Processing outcomes',data.matrix.uniqueSourcesStoredFinal.reduce((n,r)=>n+r.finished,0),'388 planned unique-source jobs'],['Automatic postings',0,'All financial changes require review']]){const card=el('div',undefined,'stat');card.append(el('label',title),el('strong',num(value)),el('small',detail));byId('stats').append(card)}
for(const [id,key]of [['office','office'],['category','category']])for(const value of Array.from(new Set(data.rows.map(r=>r[key]))).sort()){const option=el('option',value.replaceAll('_',' '));option.value=value;byId(id).append(option)}
for(let cell=0;cell<4;cell++){const option=el('option',label(cell));option.value=cell;byId('detailcell').append(option)}
for(const text of data.limitations)byId('limitations').append(el('li',text));
byId('footer').textContent='Generated '+data.generatedAt+' · Run '+data.runId+' · Source manifest '+data.manifestSha256+' · This report has no network requests or external assets.';
function matrix(){const table=el('table'),head=el('tr');for(const text of ['Configuration','Completed','Exact facts','Recall','Precision','Unsupported','Median','P95','Max'])head.append(el('th',text));const thead=el('thead');thead.append(head);table.append(thead);const body=el('tbody');const rows=data.matrix[which==='final'?'uniqueSourcesStoredFinal':'uniqueSourcesFirstAttempt'];for(const row of rows){const tr=el('tr');tr.append(el('td',label(row.cell)),el('td',row.finished+'/'+row.planned),el('td',row.supportedExactFacts+'/'+row.goldFacts));for(const [value,cls]of [[row.fullPlanRecall,'bar'],[row.precision,'bar purple']]){const td=el('td',pct(value),'metricnum'),bar=el('div',undefined,cls),fill=el('i');fill.style.width=Math.max(0,Math.min(100,(value??0)*100))+'%';bar.append(fill);td.append(bar);tr.append(td)}tr.append(el('td',row.unsupportedFacts),el('td',secs(row.wallSecondsMedian)),el('td',secs(row.wallSecondsP95)),el('td',secs(row.wallSecondsMax)));body.append(tr)}table.append(body);byId('matrix').replaceChildren(table)}
function different(rows){for(const model of new Set(rows.map(r=>r.model))){const x=rows.filter(r=>r.model===model);if(x.length!==2||x.some(r=>r[which].status!=='completed'))continue;const a=x.map(r=>r[which].economicsKey);if(a[0]!==a[1])return true}return false}
function needsAttention(result){return !result.perfect||result.classificationCorrect!==true}
function render(){matrix();const query=byId('search').value.toLowerCase(),office=byId('office').value,category=byId('category').value,outcome=byId('outcome').value;filtered=groups.filter(rows=>{const row=rows[0];if(office&&row.office!==office||category&&row.category!==category)return false;if(query&&!JSON.stringify([row.subject,row.id,row.category,row.expected]).toLowerCase().includes(query))return false;if(outcome==='attention'&&!rows.some(r=>needsAttention(r[which])))return false;if(outcome==='perfect'&&!rows.every(r=>!needsAttention(r[which])))return false;if(outcome==='difference'&&!different(rows))return false;return true});byId('count').textContent=filtered.length+' of '+groups.length+' email receipts · '+(which==='final'?'eventual stored outcomes':'first HTTP attempts');const container=byId('cases'),header=el('div',undefined,'case casehead');for(const text of ['Email / source','Gemma workflow','Gemma agentic','Qwen workflow','Qwen agentic'])header.append(el('span',text));container.replaceChildren(header);for(const rows of filtered){const row=rows[0],line=el('div',undefined,'case'),title=el('div'),button=el('button',row.subject,'subject');button.onclick=()=>open(rows);title.append(button,el('div',row.office+' · '+row.category.replaceAll('_',' ')+' · '+row.id,'sub'));line.append(title);for(const r of rows){const result=r[which],waiting=['pending','unrun'].includes(result.status),caption=waiting?'Pending':result.status==='failed'?'Failed':result.perfect?(result.classificationCorrect?'Exact':'Check relevance'):result.exact+'/'+result.expected+' exact';const cell=el('div',caption,'result'+(waiting?' wait':needsAttention(result)?' bad':''));cell.append(el('small',waiting?'Not counted as a success':result.unsupported.length?result.unsupported.length+' unsupported · '+secs(result.seconds):secs(result.seconds)+' · '+(result.calls==null?'calls unknown':result.calls+' model calls')));line.append(cell)}container.append(line)}}
function factcard(f){const card=el('div',undefined,'fact');card.append(el('strong',f.investmentName??'Unknown investment'));const fields=el('div',undefined,'pills');for(const[k,v]of Object.entries({kind:f.kind,date:f.effectiveDate,amount:f.amount,currency:f.currency,due:f.dueDate}))fields.append(el('span',k+': '+(v??'unknown'),'pill'));card.append(fields);if(f.evidence?.quote)card.append(el('blockquote','Page '+f.evidence.page+' · '+f.evidence.quote));return card}
function details(){const r=selected.find(x=>x.cell===Number(byId('detailcell').value))??selected[0],result=r[which];byId('detailtitle').textContent=r.subject;byId('caseid').textContent=r.id+' · '+r.office;byId('detailmeta').textContent=r.mailbox+' · '+r.category.replaceAll('_',' ')+' · '+r.attempts+' recorded processor HTTP attempt(s)';const body=byId('detailbody');body.replaceChildren();const note=el('p',!needsAttention(result)?'Expected structured facts, source evidence and relevance matched.':result.status==='failed'?'No usable stored extraction. Inspect the recorded input/error boundary.':result.status==='completed'?'The extraction needs review against the expected source facts.':'This configuration has not completed.','note');body.append(note);if(r.duplicateOf)body.append(el('p','Byte-identical receipt of '+r.duplicateOf+'. Its job is shared within this office.','fine'));if(r.safeInputBlockExpected)body.append(el('p','This fixture deliberately expects an unreadable-source block or explicit review warning.','warnings'));if(r.errorCode)body.append(el('p',r.errorCode,'warnings'));if(result.warnings.length)body.append(el('div',result.warnings.map(w=>typeof w==='string'?w:JSON.stringify(w)).join('\n'),'warnings'));const columns=el('div',undefined,'facts');for(const[title,facts]of [['Expected source facts',r.expected],['Returned facts',result.facts]]){const column=el('div');column.append(el('h3',title));if(!facts.length)column.append(el('p','No structured facts.', 'fine'));for(const f of facts)column.append(factcard(f));columns.append(column)}body.append(columns);for(const[title,value]of [['Decode evidence',r.decode],['Review expectations',r.boundaries],['Exact scoring details',{matched:result.exact,expected:result.expected,missedIndices:result.missed,unsupported:result.unsupported,classificationCorrect:result.classificationCorrect}],['Provenance',{source:r.filename,job:r.jobId,model:r.model,mode:r.mode,allAttemptSeconds:r.allSeconds}]]){const section=el('details');section.append(el('summary',title),el('pre',JSON.stringify(value,null,2)));body.append(section)}}
function open(rows){selected=rows;byId('detailcell').value='0';details();byId('drawer').showModal()}
for(const id of ['search','office','category','outcome'])byId(id).addEventListener('input',render);byId('detailcell').onchange=details;byId('close').onclick=()=>byId('drawer').close();for(const[id,value]of [['finaltab','final'],['firsttab','firstAttempt']])byId(id).onclick=()=>{which=value;byId('finaltab').setAttribute('aria-pressed',value==='final');byId('firsttab').setAttribute('aria-pressed',value==='firstAttempt');render()};
byId('original').onclick=()=>{if(!selected)return;const original=data.originals[selected[0].id],bytes=Uint8Array.from(atob(original.base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:'message/rfc822'})),a=el('a');a.href=url;a.download=original.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
byId('download').onclick=()=>{const quote=x=>'"'+String(x??'').replaceAll('"','""')+'"',rows=[['case','office','mailbox','category','model','mode','view','status','expected','exact','unsupported','seconds','calls','job']];for(const group of filtered)for(const r of group){const x=r[which];rows.push([r.id,r.office,r.mailbox,r.category,r.model,r.mode,which,x.status,x.expected,x.exact,x.unsupported.length,x.seconds,x.calls,r.jobId])}const blob=new Blob([rows.map(r=>r.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download='aster-mailroom-filtered.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};render();
</script></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--corpus', type=Path, default=ROOT)
    args = parser.parse_args()
    scorecard = json.loads((args.run / 'scorecard.json').read_text())
    manifest = json.loads((args.corpus / 'manifest.json').read_text())
    if scorecard['manifestSha256'] != __import__('hashlib').sha256((args.corpus / 'manifest.json').read_bytes()).hexdigest():
        raise ValueError('Report and corpus do not share the same frozen manifest')
    sources = {source['id']: source for source in manifest['documents']}
    view = {key: scorecard[key] for key in ['generatedAt', 'runId', 'manifestSha256', 'collection', 'matrix', 'limitations']}
    view['rows'] = [compact(row, sources) for row in scorecard['rows']]
    view['originals'] = {}
    for source in sources.values():
        path = (args.corpus / source['path']).resolve()
        if not path.is_relative_to(args.corpus.resolve()):
            raise ValueError('Original must stay inside frozen corpus')
        raw = path.read_bytes()
        if sha256(raw).hexdigest() != source['sha256'] or len(raw) != source['bytes']:
            raise ValueError('Original changed after corpus freeze: ' + source['id'])
        view['originals'][source['id']] = {'filename': path.name, 'sha256': source['sha256'], 'base64': base64.b64encode(raw).decode('ascii')}
    encoded = json.dumps(view, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    target = args.run / 'report.html'
    target.write_text(HTML.replace('__DATA__', encoded))
    with (args.run / 'email-results.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['case_id', 'office', 'mailbox', 'category', 'model', 'mode', 'view', 'status', 'expected_facts', 'exact_facts', 'unsupported_facts', 'wall_seconds', 'model_calls', 'http_attempts', 'job_id'])
        for row in view['rows']:
            for which in ['firstAttempt', 'final']:
                outcome = row[which]
                writer.writerow([row['id'], row['office'], row['mailbox'], row['category'], row['model'], row['mode'], which, outcome['status'], outcome['expected'], outcome['exact'], len(outcome['unsupported']), outcome['seconds'], outcome['calls'], row['attempts'], row['jobId']])
    print(json.dumps({'html': str(target), 'csv': str(args.run / 'email-results.csv'), 'receiptRows': len(view['rows']), 'networkRequests': 0}))


if __name__ == '__main__':
    main()
