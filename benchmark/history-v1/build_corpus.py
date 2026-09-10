"""Author a separate 100-email, 12-quarter fictional history corpus.

No model/processor imports. Answers are written before PDF/email authoring and
must never be placed in the ingestion directory. Existing corpus is immutable.
Use --output <new-directory> to check deterministic reproducibility.
"""
from __future__ import annotations
import argparse
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from email import policy
from email.message import EmailMessage
from email.utils import format_datetime
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab import rl_config
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

rl_config.invariant = 1
OFFICES = [
    {'id':'harbor-family','name':'Harbor Family Office','currency':'EUR','names':['Harbor Meridian Infrastructure I','Harbor Orchard Credit II','Harbor operating cash balance']},
    {'id':'maple-family','name':'Maple Family Office','currency':'GBP','names':['Maple Meridian Infrastructure I','Maple Orchard Credit II','Maple operating cash balance']},
    {'id':'willow-family','name':'Willow Family Office','currency':'CHF','names':['Willow Meridian Infrastructure I','Willow Orchard Credit II','Willow operating cash balance']},
]
DATES = ['2023-09-30','2023-12-31','2024-03-31','2024-06-30','2024-09-30','2024-12-31','2025-03-31','2025-06-30','2025-09-30','2025-12-31','2026-03-31','2026-06-30']
FACTORS = ['1','1.038','1.052','1.024','1.071','1.114','1.083','1.162','1.178','1.139','1.224','1.257']
FX = {'EUR':'1','USD':'0.92','GBP':'1.18','CHF':'1.04'}
STYLES = getSampleStyleSheet()
STYLES.add(ParagraphStyle('TitleAster', fontName='Helvetica-Bold', fontSize=22, leading=27, textColor=colors.HexColor('#203e46'), spaceAfter=16))
STYLES.add(ParagraphStyle('BodyAster', fontName='Helvetica', fontSize=10, leading=15, spaceAfter=12, textColor=colors.HexColor('#25353a')))
STYLES.add(ParagraphStyle('CellAster', fontName='Helvetica', fontSize=9, leading=13))

def fixed(amount): return str(Decimal(amount).quantize(Decimal('0.01')))
def display(amount): return f'{Decimal(amount):,.2f}'
def money(family, fund, quarter): return fixed((Decimal(1000000 + family * 240000 + fund * 180000) + Decimal('123.45')) * Decimal(FACTORS[quarter]))
def currency(office, fund): return office['currency'] if fund == 0 else 'USD'
def fact(kind, name, effective, amount=None, ccy=None, due=None, key=None, page=1):
    return {'kind':kind,'investmentName':name,'effectiveDate':effective,'amount':fixed(amount) if amount is not None else None,'currency':ccy,'dueDate':due,'eventKey':key,'evidencePage':page,'evidenceAnchors':[name]}
def paragraph(value): return Paragraph(escape(value), STYLES['BodyAster'])
def footer(canvas, doc):
    canvas.setFont('Helvetica',7); canvas.setFillColor(colors.HexColor('#647379'))
    canvas.drawString(38,24,'FICTIONAL HISTORY DEMO | No real investor, account or payment | history-v1')
    canvas.drawRightString(A4[0]-38,24,f'Page {doc.page}')
def pdf(title, paragraphs, rows=None):
    out = BytesIO()
    story = [Paragraph(escape(title), STYLES['TitleAster']), *[paragraph(text) for text in paragraphs]]
    if rows:
        table = Table([[Paragraph(escape(str(value)), STYLES['CellAster']) for value in row] for row in rows], colWidths=[260,100,110], repeatRows=1)
        table.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#eaf0ee')),('LINEBELOW',(0,0),(-1,0),.7,colors.HexColor('#99aca6')),('LINEBELOW',(0,1),(-1,-1),.3,colors.HexColor('#d6dfdc')),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10),('VALIGN',(0,0),(-1,-1),'TOP')]))
        story += [Spacer(1,12), table]
    SimpleDocTemplate(out, pagesize=A4, leftMargin=42,rightMargin=42,topMargin=42,bottomMargin=52,title=title,author='Aster fictional history corpus').build(story,onFirstPage=footer,onLaterPages=footer)
    return out.getvalue()

def schedule():
    cases=[]
    def add(office,category,facts,**extra):
        n=len(cases)+1; role=['principal','controller','investment'][(n-1)%3]
        cases.append({'id':f'history-{n:03d}','path':f'fixtures/emails/{n:03d}-{office["id"]}-{category}.eml','office_id':office['id'],'mailbox_id':office['id']+'-'+role,'category':category,'relevant':bool(facts),'facts':facts,'receivedHeaderDate':extra.pop('received','2026-09-09'),'review_boundaries':{'noticeIsSettlementProof':False,'automaticSettlementPermitted':False,'lifecycleRequiresExplicitReview':True},**extra})
    for q,day in enumerate(DATES):
        for family,office in enumerate(OFFICES):
            for fund in [0,1]:
                amount=money(family,fund,q)
                add(office,'quarterly_nav',[fact('valuation',office['names'][fund],day,amount,currency(office,fund),key=f'{office["id"]}:fund{fund}:{day}')],family=family,fund=fund,quarter=q,pdf=q%3!=0,received=(date.fromisoformat(day)+timedelta(days=24)).isoformat())
    for family,office in enumerate(OFFICES):
        add(office,'late_archive_report',[fact('valuation',office['names'][0],DATES[5],money(family,0,5),office['currency'],key=f'{office["id"]}:fund0:{DATES[5]}')],family=family,fund=0,quarter=5,pdf=True)
    for family,office in enumerate(OFFICES):
        amount=fixed(Decimal(money(family,0,9))-Decimal('7777.77'))
        add(office,'corrected_nav',[fact('valuation',office['names'][0],DATES[9],amount,office['currency'],key=f'{office["id"]}:fund0:{DATES[9]}:restated')],family=family,fund=0,quarter=9,pdf=True,supersedesAmount=money(family,0,9),manualCorrectionRequired=True)
    for family,office in enumerate(OFFICES):
        add(office,'capital_call',[fact('capital_call',office['names'][0],'2026-09-02','40000.25',office['currency'],'2026-09-08',f'{office["id"]}:call-sep')],family=family,pdf=False,received='2026-09-03')
        add(office,'distribution',[fact('distribution',office['names'][0],'2026-09-02','12500.10',office['currency'],'2026-09-08',f'{office["id"]}:distribution-sep')],family=family,pdf=True,received='2026-09-03')
    for family,office in enumerate(OFFICES):
        original=next(case for case in cases if case['office_id']==office['id'] and case['category']=='capital_call')
        add(office,'duplicate_forward',original['facts'],family=family,pdf=False,identicalTo=original['id'])
    for family,office in enumerate(OFFICES):
        add(office,'bank_statement',[
            fact('valuation',office['names'][2],'2026-09-01','500000',office['currency'],key=office['id']+':cash-opening'),
            fact('capital_call',office['names'][0],'2026-09-02','40000.25',office['currency'],'2026-09-08',office['id']+':call-sep'),
            fact('distribution',office['names'][0],'2026-09-02','12500.10',office['currency'],'2026-09-08',office['id']+':distribution-sep'),
        ],family=family,pdf=True,bankSettlementDate='2026-09-08')
    for family,office in enumerate(OFFICES):
        add(office,'acquisition_certificate',[fact('news',office['names'][fund],'2023-07-01',key=office['id']+f':fund{fund}:opened') for fund in [0,1]],family=family,pdf=True,lifecycleRecords=[{'investmentName':office['names'][fund],'kind':'opened','effectiveDate':'2023-07-01','sourceQuote':f'{office["names"][fund]}: this investor position was legally acquired on 2023-07-01.'} for fund in [0,1]])
    for family,office in enumerate(OFFICES):
        add(office,'incomplete_call',[fact('capital_call',office['names'][1],'2026-09-04',None,'USD',None,office['id']+':incomplete-call')],family=family,pdf=False,manualDetailsRequired=True)
    for family,office in enumerate(OFFICES):
        add(office,'office_administration',[],family=family,pdf=False)
    add(OFFICES[0],'shared_consolidation',[fact('valuation',office['names'][fund],DATES[-1],money(family,fund,11),currency(office,fund),key=f'{office["id"]}:fund{fund}:{DATES[-1]}') for family,office in enumerate(OFFICES) for fund in [0,1]],pdf=True,crossFamilySource=True)
    for case in cases:
        if case.get('pdf'):
            for item in case['facts']: item['evidencePage'] = 2  # MIME body occupies decoded page 1.
    assert len(cases)==100
    return cases

def author_text(case):
    office=next(o for o in OFFICES if o['id']==case['office_id']); category=case['category']; facts=case['facts']; name=facts[0]['investmentName'] if facts else office['name']
    if category in ['quarterly_nav','late_archive_report','corrected_nav']:
        value=facts[0]; heading=('Corrected investor NAV' if category=='corrected_nav' else 'Quarterly investor statement')
        texts=[name, f'{name}: the investor NAV as of {value["effectiveDate"]} is {value["currency"]} {display(value["amount"])}.', 'This is the investor position value, not total manager assets. This statement is a valuation observation, not an investment-return calculation. Cash flows, book cost and liquidity are not supplied.']
        if category=='late_archive_report': texts.insert(0,'Late archive delivery on 2026-09-09. The original economic date below remains unchanged.')
        if category=='corrected_nav': texts += [f'This final correction supersedes our earlier {value["effectiveDate"]} investor NAV. The withdrawn figure was {value["currency"]} {display(case["supersedesAmount"])} and must not be treated as the current mark. Reason: the manager corrected an accrued expense allocation.']
        return heading,texts,None
    if category in ['capital_call','distribution','incomplete_call']:
        value=facts[0]; label='Capital call' if value['kind']=='capital_call' else 'Distribution'; amount=display(value['amount']) if value['amount'] is not None else None
        if amount is None: texts=[name,f'{name}: capital call notice dated 2026-09-04. Currency: USD. The amount and due date have not yet been supplied; operations will send a completed notice. No payment is confirmed.']
        else: texts=[name,f'{name}: {label.lower()} notice effective {value["effectiveDate"]}; amount {value["currency"]} {amount}; due date {value["dueDate"]}.', 'This is an expected payment notice. It is not evidence of bank settlement. Fees, recallability, carrying-value treatment and commitment movement require separate explicit review.']
        return label+' notice',texts,None
    if category=='bank_statement':
        ccy=office['currency']; fund=office['names'][0]
        return 'Bank statement and transfer confirmations',[
            f'{office["names"][2]}: opening cash balance as of 2026-09-01 is {ccy} 500,000.00.',
            f'{fund}: capital call notice effective 2026-09-02, amount {ccy} 40,000.25, due date 2026-09-08. Bank reference CALL-{office["id"]}: the debit settled on 2026-09-08.',
            f'{fund}: distribution notice effective 2026-09-02, amount {ccy} 12,500.10, due date 2026-09-08. Bank reference DIST-{office["id"]}: the credit settled on 2026-09-08.',
            'The two transfer confirmations repeat the original notice amounts. They do not create additional obligations. No closing balance or completeness of all period cash flows is asserted. Book cost, fees and distribution treatment are not established by this bank statement.',
        ],None
    if category=='acquisition_certificate':
        return 'Position acquisition certificate',[office['name'],*[item['sourceQuote'] for item in case['lifecycleRecords']],f'Legal holder: {office["name"]} - demo investment entity. Account: Source-derived private investments.', 'This certificate establishes legal acquisition dates only. It does not report acquisition cost, cash payment, a current NAV or a performance result. This source must be reviewed before recording lifecycle entries.'],None
    if category=='office_administration': return 'Office meeting room schedule',['The investment-team meeting has moved from room Pine to room Birch. Please bring your laptops. Catering preferences are due next Tuesday. No investment report or financial update is attached.'],None
    if category=='shared_consolidation':
        return 'Three-family manager report consolidation',['Consolidated copies of source-reported investor NAVs as of 2026-06-30. Every row is a different legally owned investor position. This is a shared-family original; grant access only when every family represented is authorized.',*[f'{value["investmentName"]}: investor NAV as of {value["effectiveDate"]} is {value["currency"]} {display(value["amount"])}.' for value in facts]], [['Investment','Currency','Investor NAV'],*[[value['investmentName'],value['currency'],display(value['amount'])] for value in facts]]
    raise ValueError(category)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parent);args=parser.parse_args();root=args.output.resolve()
    if (root/'manifest.json').exists() or (root/'gold.json').exists(): raise SystemExit('Frozen corpus exists. Refusing overwrite; use --output with a fresh directory.')
    root.mkdir(parents=True,exist_ok=True);cases=schedule()
    gold={'schemaVersion':1,'corpusVersion':'synthetic-history-v1','createdDate':'2026-09-10','frozenBeforeInference':True,'provenance':'Fresh deterministic fictional source documents; author-specified expected facts and history written before any PDF/email rendering or model invocation. Not independently human-adjudicated.','factsFields':['kind','investmentName','effectiveDate','amount','currency','dueDate'],'cases':cases}
    (root/'gold.json').write_text(json.dumps(gold,indent=2)+'\n')
    expected={'schemaVersion':1,'dates':DATES,'scope':'Six declared investor positions; acquisition must be explicitly reviewed. No inferred cashflow completeness or investment returns.','valuationCount':72,'correctionsRequireReview':3,'openingCashRequiresReview':False,'automaticSettlements':0,'positions':[],'manualSettlementScenarios':[]}
    for family,office in enumerate(OFFICES):
        for fund in [0,1]:
            marks=[{'date':day,'amount':money(family,fund,q),'currency':currency(office,fund)} for q,day in enumerate(DATES)]
            if fund==0: marks[9]['amount']=fixed(Decimal(marks[9]['amount'])-Decimal('7777.77'));marks[9]['basis']='After explicit correction review'
            expected['positions'].append({'familyId':office['id'],'investmentName':office['names'][fund],'effectiveOpeningDateAfterReview':'2023-07-01','marks':marks})
        expected['manualSettlementScenarios'].append({'familyId':office['id'],'investmentName':office['names'][0],'cashName':office['names'][2],'currency':office['currency'],'openingCash':'500000.00','callAmount':'40000.25','distributionAmount':'12500.10','settlementDate':'2026-09-08','cashAfterExplicitSettlements':'472499.85','requires':['Confirm account classification and restriction state','Confirm FX and funded book cost','Confirm distribution carrying-value and commitment treatment','Review retained bank source for both settlements'],'reconciled':False})
    (root/'expected-history.json').write_text(json.dumps(expected,indent=2)+'\n')
    (root/'fixtures/emails').mkdir(parents=True);(root/'fixtures/attachments').mkdir(parents=True)
    originals={};documents=[];attachments=[]
    for case in cases:
        office=next(o for o in OFFICES if o['id']==case['office_id'])
        if 'identicalTo' in case: blob=originals[case['identicalTo']]
        else:
            title,texts,rows=author_text(case); message=EmailMessage(policy=policy.SMTP)
            message['From']=f'reporting@{office["id"]}.example.invalid';message['To']=f'{case["mailbox_id"].removeprefix(office["id"]+"-")}@{office["id"]}.example.invalid'
            message['Date']=format_datetime(datetime.fromisoformat(case['receivedHeaderDate']).replace(hour=9,tzinfo=timezone.utc));message['Subject']=title+' - '+office['name'];message['Message-ID']=f'<{case["id"]}@history-v1.example.invalid>'
            if case.get('pdf'):
                message.set_content('Please review the attached investor source. Economic dates are inside the report.\nFictional history demonstration.',cte='quoted-printable')
                filename=case['id']+'-'+case['category']+'.pdf';payload=pdf(title,texts,rows);(root/'fixtures/attachments'/filename).write_bytes(payload)
                attachments.append({'path':'fixtures/attachments/'+filename,'sha256':sha256(payload).hexdigest(),'caseId':case['id']})
                message.add_attachment(payload,maintype='application',subtype='pdf',filename=filename)
            else: message.set_content('\n\n'.join(texts)+'\n\nFICTIONAL HISTORY DEMO - No real investor or payment.',cte='quoted-printable')
            for index,part in enumerate(message.walk()):
                if part.is_multipart():part.set_boundary(f'=_aster_history_v1_{case["id"]}_{index}')
            blob=message.as_bytes()
        originals[case['id']]=blob;(root/case['path']).write_bytes(blob)
        documents.append({'path':case['path'],'office_id':case['office_id'],'mailbox_id':case['mailbox_id'],'sha256':sha256(blob).hexdigest()})
    catalog={'corpusVersion':'synthetic-history-v1','offices':OFFICES,'mailboxes':[{'id':office['id']+'-'+role,'office_id':office['id'],'address':role+'@'+office['id']+'.example.invalid','persona':label} for office in OFFICES for role,label in [('principal','Principal'),('controller','Controller'),('investment','Investment team')]],'documents':documents}
    (root/'catalog.json').write_text(json.dumps(catalog,indent=2)+'\n')
    manifest={'schemaVersion':1,'corpusVersion':'synthetic-history-v1','createdDate':'2026-09-10','emailCount':len(cases),'uniqueSourceCount':len(set(doc['sha256'] for doc in documents)),'pdfAttachmentCount':len(attachments),'expectedFactCount':sum(len(case['facts']) for case in cases),'files':documents+attachments,'goldSha256':sha256((root/'gold.json').read_bytes()).hexdigest(),'expectedHistorySha256':sha256((root/'expected-history.json').read_bytes()).hexdigest(),'catalogSha256':sha256((root/'catalog.json').read_bytes()).hexdigest()}
    assert manifest['uniqueSourceCount']==97 and len(attachments)==64
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({key:manifest[key] for key in ['emailCount','uniqueSourceCount','pdfAttachmentCount','expectedFactCount','goldSha256']}))
if __name__=='__main__': main()
