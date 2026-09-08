// Bounded development recovery drill, not a replacement for streaming production backups.
import { Pool } from 'pg';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const order = ['auth_user','auth_session','auth_account','auth_verification','auth_two_factor','auth_rate_limit','app_organizations','app_engine_profiles','app_engine_revisions','app_engine_policy','app_memberships','app_workspace','app_documents','app_jobs','app_job_queue','app_audit','app_request_limits','app_accepted_facts','auth_invitation','app_mailboxes','app_mailbox_queue','app_mailbox_receipts','app_mailbox_oauth_states','app_integration_tokens','aster_migrations'];
let stage = 'configuration';
const quote = value => '"' + value.replaceAll('"','""') + '"';
async function dumpTable(client, name) {
 const keys = await client.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)`, ['public.'+name]);
 if (!keys.rowCount) throw new Error('Table requires a primary key');
 return (await client.query(`SELECT COALESCE(json_agg(t ORDER BY ${keys.rows.map(row=>'t.'+quote(row.attname)).join(',')}),'[]')::text AS data FROM public.${quote(name)} t`)).rows[0].data;
}
async function main() {
 if (process.env.ASTER_NATIVE_RECOVERY_DRILL !== '1') throw new Error('Explicit drill opt-in is required');
 const url = new URL(process.env.MIGRATION_DATABASE_URL);
 if (!['127.0.0.1','localhost'].includes(url.hostname) || url.port !== '55439' || url.pathname !== '/aster') throw new Error('This development drill only targets the isolated local Aster database on 55439');
 const appKey = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64'); if (appKey.length!==32) throw new Error('Application encryption key required');
 const started = Date.now(), dbName = 'aster_restore_' + randomBytes(8).toString('hex');
 stage = 'source-connection';
 const source = new Pool({ connectionString: url.toString(), max: 2 }), sourceClient = await source.connect();
 const folder = await mkdtemp(join(tmpdir(),'aster-recovery-')); let restored, report, created = false;
 try {
  stage = 'schema-and-size-guard';
  await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await sourceClient.query("SET LOCAL timezone='UTC'");
  const size = await sourceClient.query("SELECT COALESCE(sum(pg_total_relation_size(quote_ident(tablename)::regclass)),0)::bigint AS bytes FROM pg_tables WHERE schemaname='public'");
  if (BigInt(size.rows[0].bytes)>100n*1024n*1024n) throw new Error('Use streaming pg_dump for databases above this drill bound');
  const names = (await sourceClient.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row=>row.tablename);
  if (names.length!==order.length || names.some(name=>!order.includes(name))) throw new Error('Schema changed; update and review the drill before proceeding');
  const tables = {};
  stage = 'consistent-snapshot';
  for (const name of order) tables[name] = await dumpTable(sourceClient,name);
  await sourceClient.query('COMMIT');
  stage = 'encrypted-backup-round-trip';
  const plaintext=Buffer.from(JSON.stringify(tables)), key=randomBytes(32), iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('aster-development-recovery-v1'));
  const envelope=Buffer.concat([Buffer.from([1]),iv,cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
  await writeFile(join(folder,'snapshot.enc'),envelope,{mode:0o600});await writeFile(join(folder,'recovery.key'),key,{mode:0o600});
  const disk=await readFile(join(folder,'snapshot.enc')), decipher=createDecipheriv('aes-256-gcm',await readFile(join(folder,'recovery.key')),disk.subarray(1,13));
  decipher.setAAD(Buffer.from('aster-development-recovery-v1'));decipher.setAuthTag(disk.subarray(-16));
  const recovered=Buffer.concat([decipher.update(disk.subarray(13,-16)),decipher.final()]);
  if (!recovered.equals(plaintext)) throw new Error('Encrypted backup round-trip mismatch');
  stage = 'disposable-database-creation';
  await source.query('CREATE DATABASE '+quote(dbName));created=true;
  const destination=new URL(url);destination.pathname='/'+dbName;restored=new Pool({connectionString:destination.toString(),max:1});
  const target=await restored.connect();
  try {
   await target.query('BEGIN');await target.query("SET LOCAL timezone='UTC'");
   stage = 'migration-replay';
   for(const name of (await readdir('migrations')).filter(name=>name.endsWith('.sql')).sort()) await target.query(await readFile('migrations/'+name,'utf8'));
   await target.query('CREATE TABLE aster_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now())');
   const content=JSON.parse(recovered.toString());
   stage = 'record-restore';
   for(const name of order) await target.query(`INSERT INTO ${quote(name)} SELECT * FROM json_populate_recordset(NULL::${quote(name)},$1::json)`,[content[name]]);
   await target.query("SELECT setval(pg_get_serial_sequence('app_audit','sequence'),GREATEST(COALESCE((SELECT max(sequence) FROM app_audit),0),1),EXISTS(SELECT 1 FROM app_audit))");
   stage = 'restored-record-comparison';
   for(const name of order) if (await dumpTable(target,name)!==tables[name]) throw new Error('Restored table differs: '+name);
   await target.query('COMMIT');
  } catch(error){await target.query('ROLLBACK');throw error;} finally{target.release();}
  stage = 'application-decryption';
  let decrypted=0;const decryptedFields={};
  const contexts = {
   app_workspace: [['payload',row=>'workspace:'+row.organization_id]],
   app_documents: [['payload',row=>'document:'+row.organization_id+':'+row.id]],
   app_jobs: [['result',row=>'result:'+row.organization_id+':'+row.id],['engine_config',row=>'job-engine:'+row.organization_id+':'+row.id]],
   app_engine_revisions: [['payload',row=>'engine:'+row.organization_id+':'+row.profile_id+':'+row.revision]],
   app_mailboxes: [['credentials',row=>'mailbox-credentials:'+row.organization_id+':'+row.id],['cursor',row=>'mailbox-cursor:'+row.organization_id+':'+row.id]],
   app_mailbox_oauth_states: [['payload',row=>'mailbox-state:'+row.organization_id+':'+row.state_hash]],
  };
  for(const [table,fields] of Object.entries(contexts))for(const row of JSON.parse(tables[table]))for(const [field,context] of fields) {
   if(!row[field])continue;const value=Buffer.from(row[field].slice(2),'hex');if(value.length<30||value[0]!==1)throw new Error('Invalid encrypted record');const decipher=createDecipheriv('aes-256-gcm',appKey,value.subarray(1,13));
   decipher.setAAD(Buffer.from(context(row)));decipher.setAuthTag(value.subarray(13,29));Buffer.concat([decipher.update(value.subarray(29)),decipher.final()]);decrypted++;const counter=table+'.'+field;decryptedFields[counter]=(decryptedFields[counter]??0)+1;
  }
  report={result:'passed',tables:order.length,records:Object.values(tables).reduce((sum,text)=>sum+JSON.parse(text).length,0),decryptedRecords:decrypted,decryptedFields,encryptedBytes:envelope.length,format:'bounded development SQL snapshot; production pg_dump/age drill still separate'};
 } finally {
  if(report)stage='cleanup';
  try {
   await sourceClient.query('ROLLBACK').catch(()=>{});sourceClient.release();if(restored)await restored.end();
   if(created)await source.query('DROP DATABASE '+quote(dbName)+' WITH (FORCE)');
  } finally {
   try {await source.end();} finally {await rm(folder,{recursive:true,force:true});}
  }
 }
 console.log(JSON.stringify({...report,elapsedMs:Date.now()-started}));
}
main().catch(()=>{console.error('Native recovery drill failed at '+stage+'; credentials and record contents suppressed.');process.exitCode=1;});
