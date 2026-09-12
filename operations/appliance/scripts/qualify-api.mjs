// Actual HTTPS/MFA/ingestion/archive checks in a newly bootstrapped SYNTHETIC office.
// No host DNS or trust-store changes; requests resolve only the exact test hostname.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import { createOTP } from '@better-auth/utils/otp';
import { base32 } from '@better-auth/utils/base32';

const [phase, root, privateState, output] = process.argv.slice(2);
assert(['initial', 'restored'].includes(phase));
assert(root && privateState && output);
const installation = JSON.parse(await fs.readFile(root + '/installation.json', 'utf8'));
assert.equal(installation.hostname, 'aster-qualification.example.invalid');
assert.equal(installation.profile, 'offline');
const origin = 'https://' + installation.hostname;
const ca = await fs.readFile(root + '/data/caddy/data/caddy/pki/authorities/local/root.crt');
const state = JSON.parse(await fs.readFile(privateState, 'utf8'));
const cookies = new Map();
let organizationId;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [];
const financialDigest = workspace => sha(JSON.stringify({portfolio:workspace.portfolio, finance:workspace.finance}));

function call(path, method = 'GET', body, type = 'application/json') {
  assert(path.startsWith('/api/'));
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request(origin + path, {
      method, ca, rejectUnauthorized: true,
      lookup: (_hostname, options, callback) => options?.all ? callback(null, [{address:'127.0.0.1',family:4}]) : callback(null, '127.0.0.1', 4),
      headers: {Origin:origin, Cookie:[...cookies].map(([key,value])=>key+'='+value).join('; '),
        ...(organizationId ? {'x-aster-organization':organizationId} : {}),
        ...(bytes ? {'Content-Type':type,'Content-Length':bytes.length} : {})},
    }, response => {
      for (const cookie of response.headers['set-cookie'] || []) {
        const pair = cookie.split(';')[0], equal = pair.indexOf('=');
        const name = pair.slice(0,equal), value = pair.slice(equal+1);
        if (/max-age=0/i.test(cookie)) cookies.delete(name); else cookies.set(name,value);
      }
      const chunks=[];let count=0;
      response.on('data', chunk=>{count+=chunk.length;if(count>20*1024**2){response.destroy(new Error('Oversized QA response'));return;}chunks.push(chunk);});
      response.on('error', reject);
      response.on('end',()=>{
        const raw=Buffer.concat(chunks);let json;
        if((response.headers['content-type']||'').includes('json')){try{json=JSON.parse(raw);}catch(error){reject(error);return;}}
        resolve({status:response.statusCode,headers:response.headers,bytes:raw,json});
      });
    });
    request.on('error',reject);request.setTimeout(30000,()=>request.destroy(new Error('QA request timeout')));
    if(bytes)request.write(bytes);request.end();
  });
}
async function ok(path, method, body, type) {
  const result=await call(path,method,body,type);
  assert(result.status>=200 && result.status<300, `${method||'GET'} ${path}: ${result.status} ${JSON.stringify(result.json?.error||'')}`);
  return result;
}
async function json(path,method,body){return (await ok(path,method,body)).json;}
async function login(){
  const result=await ok('/api/auth/sign-in/email','POST',{email:state.email,password:state.password});
  assert((result.headers['set-cookie']||[]).some(c=>/httponly/i.test(c)&&/secure/i.test(c)&&/samesite=lax/i.test(c)));
  if(phase==='initial'){
    assert.equal((await call('/api/workspace')).status,403,'MFA must gate protected workspace');
    const enrollment=await json('/api/auth/two-factor/enable','POST',{password:state.password,method:'totp'});
    assert.equal(enrollment.backupCodes.length,10);
    state.totpSecret=new TextDecoder().decode(base32.decode(new URL(enrollment.totpURI).searchParams.get('secret')));
  }
  await ok('/api/auth/two-factor/verify-totp','POST',{code:await createOTP(state.totpSecret).totp()});
  const session=await json('/api/auth/get-session');assert(session.session.mfaVerifiedAt);
  const workspace=await json('/api/workspace');assert.equal(workspace.officeName,'SYNTHETIC appliance qualification');
  organizationId=workspace.identity.organizationId;
  if(state.organizationId)assert.equal(organizationId,state.organizationId);else state.organizationId=organizationId;
  checks.push('TLS certificate and hostname verified; actual owner sign-in and MFA succeeded');
  return workspace;
}
function pdf(lines=['SYNTHETIC appliance attachment. No financial assertions.']){
  const escaped=lines.map(line=>line.replace(/([\\()])/g,'\\$1'));
  const text='BT /F1 11 Tf 30 740 Td '+escaped.map((line,i)=>(i?'0 -20 Td ':'')+'('+line+') Tj').join(' ')+' ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let data='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(data));data+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(data);data+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(data);
}
function email(){
  const boundary='aster-'+randomUUID(),attachment=pdf();state.pdfSha256=sha(attachment);
  return Buffer.from(['From: synthetic-source@example.invalid','To: synthetic-office@example.invalid','Date: '+new Date().toUTCString(),
    'Subject: SYNTHETIC appliance qualification','Message-ID: <'+randomUUID()+'@example.invalid>','MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="'+boundary+'"','','--'+boundary,'Content-Type: text/plain; charset=UTF-8','',
    'This is a synthetic installation check. There are no holdings, valuations, amounts, transactions, commitments, news or financial assertions.',
    '--'+boundary,'Content-Type: application/pdf; name="synthetic-attachment.pdf"','Content-Disposition: attachment; filename="synthetic-attachment.pdf"',
    'Content-Transfer-Encoding: base64','',attachment.toString('base64').match(/.{1,76}/g).join('\r\n'),'--'+boundary+'--',''].join('\r\n'));
}
async function upload(bytes,mode,filename='SYNTHETIC-appliance.eml'){
  const boundary='multipart-'+randomUUID();
  const data=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: message/rfc822\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return (await ok('/api/documents','POST',data,'multipart/form-data; boundary='+boundary)).json;
}
async function archiveProof(source=state){
  const record=(await json('/api/archive/documents/'+source.documentId)).records.find(x=>x.status==='archived');
  assert(record?.receipt);assert.equal(record.receipt.originalSha256,source.emlSha256);
  for(const suffix of ['.eml','.png','manifest.json'])assert(record.receipt.files.some(f=>f.path.endsWith(suffix)));
  assert(record.receipt.files.some(f=>f.path.startsWith('attachments/')&&f.path.endsWith('.pdf')));
  for(let i=0;i<record.receipt.files.length;i++){
    const file=record.receipt.files[i],download=await ok(`/api/archive/records/${record.id}/files/${i}`);
    assert.equal(sha(download.bytes),file.sha256);
    if(file.path.startsWith('attachments/')&&file.path.endsWith('.pdf'))assert.equal(file.sha256,source.pdfSha256);
  }
  checks.push('Original EML, PDF attachment, readable email snapshot and every manifest file downloaded with exact matching hashes');
  return record.receipt.manifestSha256;
}
async function financialProof(){
  const workspace=await json('/api/workspace');
  const holding=workspace.portfolio.holdings.find(h=>h.id===state.financial.holdingId);
  assert(holding);assert.equal(holding.valueEUR,1200000);assert.equal(holding.valuationDate,'2026-09-01');
  const marks=workspace.finance.valuations.filter(v=>v.holdingId===holding.id&&v.effectiveDate==='2026-09-01');
  assert.equal(marks.length,1);assert.equal(Number(marks[0].amount),1200000);assert.equal(marks[0].currency,'EUR');
  const calls=(workspace.finance.obligations||[]).filter(v=>v.holdingId===holding.id&&v.kind==='capital_call');
  assert.equal(calls.length,1);assert.equal(Number(calls[0].amount),100000);assert.equal(calls[0].currency,'EUR');
  assert.equal(calls[0].effectiveDate,'2026-09-02');assert.equal(calls[0].dueDate,'2026-10-15');
  for(const record of [marks[0],calls[0]]){
    const source=workspace.portfolio.evidence.find(e=>e.id===record.sourceId);
    assert(source);assert.equal(source.documentId,state.financial.documentId);assert.equal(source.holdingId,holding.id);
  }
  for(const id of state.financial.jobs){const job=(await json('/api/processing?jobId='+id)).jobs.find(j=>j.id===id);assert.equal(job.status,'accepted');assert(job.review.facts.every(f=>f.status==='accepted'));}
  checks.push('Exactly one EUR1,200,000 sourced NAV and one EUR100,000 capital-call notice retained with exact dates; both processing modes reviewed and no double posting');
  return workspace;
}
async function financialFixture(){
  const name='SYNTHETIC Aster Test Fund I';
  await json('/api/workspace','POST',{type:'addHolding',name,familyName:'SYNTHETIC Appliance Family',assetClass:'Private equity',
    valueEUR:1000000,costBasisEUR:1000000,unfundedCommitmentEUR:1000000,valuationDate:'2026-06-30'});
  const holding=(await json('/api/workspace')).portfolio.holdings.find(h=>h.name===name);assert(holding);
  const lines=['SYNTHETIC INVESTOR STATEMENT','Family: SYNTHETIC Appliance Family','Investment: '+name,
    'Valuation date: 2026-09-01','Net asset value (NAV): EUR 1,200,000.00',
    'Capital call notice date: 2026-09-02','Capital call amount: EUR 100,000.00','Payment due: 2026-10-15',
    'This is a fictional qualification fixture. No payment has been made.'];
  const attachment=pdf(lines),boundary='aster-financial-'+randomUUID();
  const bytes=Buffer.from(['From: synthetic-manager@example.invalid','To: synthetic-office@example.invalid',
    'Date: Wed, 02 Sep 2026 09:00:00 +0000','Subject: SYNTHETIC investment update','Message-ID: <'+randomUUID()+'@example.invalid>',
    'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="'+boundary+'"','','--'+boundary,
    'Content-Type: text/plain; charset=UTF-8','','Please review the attached fictional investor statement. Economic dates are in the PDF.',
    '--'+boundary,'Content-Type: application/pdf; name="synthetic-attachment.pdf"','Content-Disposition: attachment; filename="synthetic-attachment.pdf"',
    'Content-Transfer-Encoding: base64','',attachment.toString('base64').match(/.{1,76}/g).join('\r\n'),'--'+boundary+'--',''].join('\r\n'));
  const workflow=await upload(bytes,'workflow','SYNTHETIC-investment-update.eml');
  const agentic=await upload(bytes,'agentic','SYNTHETIC-investment-update.eml');
  assert.equal(workflow.documentId,agentic.documentId);
  state.financial={holdingId:holding.id,documentId:workflow.documentId,jobs:[workflow.jobId,agentic.jobId],emlSha256:sha(bytes),pdfSha256:sha(attachment)};
  const started=Date.now();let jobs;
  while(Date.now()-started<15*60*1000){
    jobs=await Promise.all(state.financial.jobs.map(async id=>(await json('/api/processing?jobId='+id)).jobs.find(j=>j.id===id)));
    assert(!jobs.some(j=>j?.status==='failed'),'Synthetic financial extraction failed');
    const archive=await json('/api/archive/documents/'+state.financial.documentId);
    assert(!archive.records.some(r=>r.status==='failed'),'Synthetic financial archive failed');
    if(jobs.every(j=>j?.status==='awaiting_review')&&archive.records.some(r=>r.status==='archived'))break;
    await new Promise(r=>setTimeout(r,2000));
  }
  assert(jobs?.every(j=>j?.status==='awaiting_review'),'Financial workflow/agentic extraction timed out');
  const original=await ok('/api/documents/'+state.financial.documentId);assert.equal(sha(original.bytes),sha(bytes));
  const normalize=s=>s.toLowerCase().replace(/[^a-z0-9]/g,'');
  for(const [modeIndex,job] of jobs.entries()){
    assert.equal(job.engine.model,'gemma4:e4b-it-qat');assert.equal(job.engine.execution,'local');
    assert.equal(job.result.facts.length,2,'Require exactly the two known financial facts, not arbitrary extractions');
    const facts=job.result.facts;
    const nav=facts.find(f=>f.kind==='valuation'),callFact=facts.find(f=>f.kind==='capital_call');
    assert(nav&&callFact);assert.equal(Number(nav.amount),1200000);assert.equal(nav.effectiveDate,'2026-09-01');
    assert.equal(Number(callFact.amount),100000);assert.equal(callFact.effectiveDate,'2026-09-02');assert.equal(callFact.dueDate,'2026-10-15');
    for(const fact of facts){
      assert.equal(fact.investmentName.toLowerCase(),name.toLowerCase());assert.equal(fact.currency,'EUR');
      assert(fact.evidence.page>=1);assert(fact.evidence.quote.length>=10);
      assert(normalize(lines.join(' ')).includes(normalize(fact.evidence.quote)),'Evidence quote must occur in the known original PDF text');
    }
    const result=await json('/api/processing/'+job.id,'PATCH',{action:'review',expectedRevision:job.review.revision,
      decisions:facts.map((_fact,index)=>({factIndex:index,status:'accepted',holdingId:holding.id,evidenceVerified:true,
        rationale:'Verified exact amounts and dates against the generated synthetic PDF and downloaded retained original.'}))});
    assert.equal(result.status,'accepted');assert.equal(result.applied,modeIndex===0?2:0);assert.equal(result.duplicates,modeIndex===0?0:2);
  }
  state.financial.manifestSha256=await archiveProof(state.financial);
  const workspace=await financialProof();state.financialDigest=financialDigest(workspace);
}

const before=await login();
if(phase==='initial'){
  state.financialDigest=financialDigest(before);
  await json('/api/archive','POST',{action:'configure',expectedRevision:0,idempotencyKey:randomUUID(),destination:{provider:'local',label:'SYNTHETIC qualification archive',directory:'synthetic-qualification',enabled:true}});
  const bytes=email();state.emlSha256=sha(bytes);
  const workflow=await upload(bytes,'workflow'),duplicate=await upload(bytes,'workflow');
  assert.equal(workflow.documentId,duplicate.documentId);assert.equal(duplicate.deduplicated,true);assert.equal(workflow.jobId,duplicate.jobId);
  const agentic=await upload(bytes,'agentic');assert.equal(workflow.documentId,agentic.documentId);
  state.documentId=workflow.documentId;state.jobs=[workflow.jobId,agentic.jobId];
  const started=Date.now();let done=false;
  while(Date.now()-started<15*60*1000){
    const jobs=await Promise.all(state.jobs.map(async id=>(await json('/api/processing?jobId='+id)).jobs.find(j=>j.id===id)));
    if(jobs.some(j=>j?.status==='failed'))throw new Error('Synthetic extraction failed: '+jobs.map(j=>j?.errorCode||j?.status).join(','));
    const archive=await json('/api/archive/documents/'+state.documentId);
    if(archive.records.some(r=>r.status==='failed'))throw new Error('Synthetic archive failed');
    if(jobs.every(j=>j?.status==='awaiting_review')&&archive.records.some(r=>r.status==='archived')){
      for(const job of jobs){assert.equal(job.result.facts.length,0,'No financial facts may be invented from this empty synthetic notice');assert.equal(job.engine.model,'gemma4:e4b-it-qat');}
      done=true;break;
    }
    await new Promise(r=>setTimeout(r,2000));
  }
  assert(done,'Synthetic workflow/agentic processing or archival timed out');
  checks.push('Actual local workflow and agentic extraction completed; duplicate upload reused the source/job; no financial facts invented');
  state.manifestSha256=await archiveProof();
  assert.equal(financialDigest(await json('/api/workspace')),state.financialDigest);
  checks.push('Synthetic ingestion left accepted portfolio and finance unchanged');
  await financialFixture();
  await fs.writeFile(privateState,JSON.stringify(state),{mode:0o600});
}else{
  assert.equal(financialDigest(before),state.financialDigest);
  assert.equal(await archiveProof(),state.manifestSha256);
  assert.equal(await archiveProof(state.financial),state.financial.manifestSha256);
  await financialProof();
  for(const id of state.jobs){const result=await json('/api/processing?jobId='+id);assert.equal(result.jobs.find(j=>j.id===id)?.status,'awaiting_review');}
  checks.push('Restored authentication/decryption, accepted-state digest, review jobs and original archive hashes survived');
}
await fs.writeFile(output,JSON.stringify({phase,checks,organizationId,documentId:state.documentId,financialDigest:state.financialDigest,checkedAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({phase,checks}));
