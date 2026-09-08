"""Append a fresh image-only PDF without changing the frozen v1 corpus."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import shutil

from reportlab import rl_config
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
import pypdfium2 as pdfium
from PIL import ImageFilter, ImageOps

ROOT=Path(__file__).resolve().parent
OLD=ROOT.parent/'holdout-v1'
OUTPUT=ROOT.parent.parent.parent/'validation-seven-items'/'benchmark'/'scan-authoring'
rl_config.invariant=1

def main():
    if (ROOT/'manifest.json').exists():raise SystemExit('v1.1 is frozen; publish another version for changes.')
    (ROOT/'fixtures').mkdir(exist_ok=True);OUTPUT.mkdir(parents=True,exist_ok=True)
    manifest=json.loads((OLD/'manifest.json').read_text())
    for relative,digest in manifest['files'].items():
        if sha256((OLD/relative).read_bytes()).hexdigest()!=digest:raise ValueError('Original v1 checksum changed')
        if relative.startswith('fixtures/'):shutil.copyfile(OLD/relative,ROOT/relative)
    native=OUTPUT/'source-before-scanning.pdf'
    document=canvas.Canvas(str(native),pagesize=A4,invariant=1)
    document.setFillColorRGB(.15,.2,.23);document.setFont('Helvetica-Bold',20)
    document.drawString(44,780,'Investor valuation statement')
    document.setFont('Helvetica',11)
    lines=[
        'Thistledown Maritime Yield V',
        'Statement issued: 7 July 2026',
        '',
        'The investor NAV for Thistledown Maritime Yield V',
        'as of 30 June 2026 is CHF 482,617.09.',
        '',
        'This figure is the investor position, not the whole fund value.',
        'No capital call, distribution or currency conversion is reported.',
        '',
        'This image-only copy was prepared for a synthetic OCR benchmark.',
        'No real investor, account or payment is represented.',
    ]
    y=735
    for line in lines:document.drawString(44,y,line);y-=23
    document.setFont('Helvetica',8);document.drawString(44,38,'SYNTHETIC BENCHMARK V1.1 - scanned source - page 1')
    document.save()
    pdf=pdfium.PdfDocument(native)
    image=pdf[0].render(scale=2.35).to_pil().convert('L').filter(ImageFilter.GaussianBlur(.25))
    image=ImageOps.autocontrast(image)
    raster=OUTPUT/'scan-raster.png';image.save(raster)
    encoded=BytesIO();image.save(encoded,format='PNG');encoded.seek(0)
    target=ROOT/'fixtures'/'14-scanned-nav.pdf'
    scan=canvas.Canvas(str(target),pagesize=A4,invariant=1)
    scan.setTitle('Synthetic image-only investor statement');scan.setAuthor('Aster benchmark v1.1')
    scan.drawImage(ImageReader(encoded),0,0,width=A4[0],height=A4[1]);scan.save()
    gold=json.loads((OLD/'gold.json').read_text())
    gold['corpusVersion']='synthetic-review-holdout-v1.1'
    gold['derivedFrom']={'corpusVersion':manifest['corpusVersion'],'manifestSha256':sha256((OLD/'manifest.json').read_bytes()).hexdigest(),'change':'Append one independently specified image-only statement; all 13 original source files and gold cases remain unchanged.'}
    gold['cases'].append({'id':'scanned-nav','path':'fixtures/14-scanned-nav.pdf','category':'image_only_scanned_nav','relevant':True,'imageOnlyPDF':True,'facts':[{'kind':'valuation','investmentName':'Thistledown Maritime Yield V','effectiveDate':'2026-06-30','amount':'482617.09','currency':'CHF','dueDate':None,'evidencePage':1,'evidenceAnchors':['Thistledown Maritime Yield V','482,617.09']}],'ocrExpectation':{'nativeTextCharacters':0,'readableImage':True,'goldReviewedVisuallyBeforeInference':True,'nativeCurrency':'CHF','amount':'482617.09','effectiveDate':'2026-06-30','limits':'One clean printed scan with mild blur; not a general OCR quality claim.'}})
    (ROOT/'gold.json').write_text(json.dumps(gold,indent=2)+'\n')
    files={case['path']:sha256((ROOT/case['path']).read_bytes()).hexdigest() for case in gold['cases']}
    files['gold.json']=sha256((ROOT/'gold.json').read_bytes()).hexdigest()
    (ROOT/'manifest.json').write_text(json.dumps({'corpusVersion':gold['corpusVersion'],'files':files,'expectedDocuments':14,'expectedPDFs':7,'expectedEmails':7,'goldFacts':14,'parentManifestSha256':gold['derivedFrom']['manifestSha256'],'appendedCaseIds':['scanned-nav'],'duplicateGroups':manifest['duplicateGroups']},indent=2)+'\n')
    pdfium.PdfDocument(target)[0].render(scale=1.5).to_pil().save(OUTPUT/'scanned-final.png')
    print('Frozen v1.1: original13 preserved, one image-only scanned PDF appended.')

if __name__=='__main__':main()
