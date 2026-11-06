import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { handleDonnaApiRequest } from '../api.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../firmDb.js';
import { setClientFlagStage } from '../clientConfig.js';
import { applyInventoryOperation } from './db.js';
import { upsertLedgerAccountForJournal } from '../db/ledger.js';
import { writeValidatedJournalWithinTransaction } from '../ledgerPostingGateway.js';
import { valueInventoryOperations } from './valuation.js';
import { buildInventoryJournalDraft } from './posting.js';

// Actual mounted HTTP auth + scoped database membership + original document admission.
// Only the external identity/storage providers are fixtures.
test('physical API: scoped named actor, enrollment, photo custody, no parse/accounting, and revocation', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL required for real physical API proof');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
  const name = `physical_api_${process.pid}_${Date.now()}`; await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() }); __setFirmDbPoolForTests(pool);
  const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID:'physical-f', DONNA_DESKTOP_BLOB_DIR:'', DONNA_ACCESS_TOKEN:'infra-only',
    SUPABASE_URL:'https://physical.invalid',SUPABASE_ANON_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture',SUPABASE_PUBLISHABLE_KEY:'',SUPABASE_SERVICE_KEY:'',SUPABASE_SECRET_KEY:'',
    DONNA_AUTH_ALLOWED_EMAILS:'', DONNA_EVIDENCE_BUCKET:'donna-evidence',SUPABASE_EVIDENCE_BUCKET:'' };
  const saved = Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
  const realFetch=globalThis.fetch;
  const photo=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS8cAAAAASUVORK5CYII=','base64');
  const checksum=createHash('sha256').update(photo).digest('hex');
  let storageReads=0;
  globalThis.fetch=async(address,init={})=>{
    const u=new URL(String(address));
    if(u.origin==='https://physical.invalid'&&u.pathname==='/auth/v1/user'){
      const token=init.headers.Authorization.replace('Bearer ','');
      if(!['owner','member','reviewer','viewer','junior'].includes(token))return new Response('{}',{status:401});
      return new Response(JSON.stringify({id:`user-${token}`,email:`${token}@physical.invalid`}));
    }
    if(u.origin==='https://physical.invalid'&&u.pathname.startsWith('/storage/v1/object/')){storageReads++;return new Response(photo);}
    throw new Error(`Unexpected outbound request ${address}`);
  };
  const server=http.createServer((req,res)=>Promise.resolve(handleDonnaApiRequest(req,res)).catch(e=>{res.statusCode=500;res.end(JSON.stringify({error:e.message}));}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{
    server.closeAllConnections();await new Promise(r=>server.close(r));globalThis.fetch=realFetch;
    __resetFirmDbPoolForTests();await pool.end();for(const[k,v]of Object.entries(saved))if(v==null)delete process.env[k];else process.env[k]=v;
    await admin.query(`drop database "${name}"`);await admin.end();
  });
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const migrations=new URL('../../../db/migrations/',import.meta.url);
  for(const f of(await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,migrations),'utf8'));
  await pool.query(`insert into firms(id,name,slug) values('physical-f','Physical','physical'),('other-f','Other','other');
    insert into clients(id,firm_id,company_name,status) values('own','physical-f','Own','active'),('other','other-f','Other','active');
    insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level) values('member','physical-f','user-member','member@physical.invalid','Member','admin','active','owner');
    insert into firm_collaborators(id,firm_id,user_id,email,name,status) values
      ('owner','physical-f','user-owner','owner@physical.invalid','Owner','active'),
      ('reviewer','physical-f','user-reviewer','reviewer@physical.invalid','Reviewer','active'),
      ('viewer','physical-f','user-viewer','viewer@physical.invalid','Viewer','active'),
      ('junior','physical-f','user-junior','junior@physical.invalid','Junior','active');
    insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role) values
      ('owner-a','physical-f','own','firm_collaborator','owner','owner'),
      ('reviewer-a','physical-f','own','firm_collaborator','reviewer','reviewer'),
      ('viewer-a','physical-f','own','firm_collaborator','viewer','viewer'),
      ('junior-a','physical-f','own','firm_collaborator','junior','junior');`);
  const path='/api/donna/firms/inventory/physical-reconciliation';
  const call=(token,suffix='',data=null,clientId='own',firmId='physical-f')=>new Promise((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port:server.address().port,path:`${path}${suffix}?firm_id=${firmId}&client_id=${clientId}`,method:data?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}},res=>{
      let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text||'{}')}));
    });request.on('error',reject);request.end(data?JSON.stringify(data):undefined);
  });
  assert.equal((await call('invalid')).status,401);
  assert.equal((await call('infra-only')).body.code,'PHYSICAL_PERSON_REQUIRED');
  assert.equal((await call('owner')).body.code,'PHYSICAL_RECONCILIATION_DISABLED');
  assert.equal((await call('owner','',null,'other','other-f')).status,403);
  const conn=await pool.connect();try{await setClientFlagStage(conn,{firmId:'physical-f',clientId:'own',flagKey:'PHYSICAL_RECONCILIATION',stage:'canary',actorType:'firm_member',actorId:'member',reason:'Synthetic isolated test'});}finally{conn.release();}
  assert.equal((await call('junior')).body.code,'PHYSICAL_REVIEW_AUTHORITY_REQUIRED');
  assert.equal((await call('reviewer')).status,200);
  const document={id:'photo',client_id:'own',filename:'stock.png',mime_type:'image/png',file_size:photo.length,storage_provider:'supabase_storage',storage_bucket:'donna-evidence',storage_object_key:'physical-f/own/evidence/photo.png',checksum_sha256:checksum};
  assert.equal((await call('viewer','/evidence',{document})).status,403);
  assert.equal((await call('owner','/evidence',{document:{...document,client_id:'other'}})).body.code,'PHYSICAL_EVIDENCE_SCOPE');
  assert.equal((await call('owner','/evidence',{document:{...document,checksum_sha256:'0'.repeat(64)}})).body.code,'PHYSICAL_EVIDENCE_BYTES_MISMATCH');
  const accepted=await call('owner','/evidence',{document});assert.equal(accepted.status,200,JSON.stringify(accepted.body));
  assert.equal(accepted.body.document.parse_status,'skipped');assert.equal(accepted.body.document.parse_run_id,null);
  const row=(await pool.query("select * from documents where id='photo'")).rows[0];
  assert.equal(row.document_type,'unknown');assert.equal(row.payload.evidence_purpose,'physical_inventory_count');assert.equal(row.parse_enqueued_at,null);assert.equal(row.checksum_sha256,checksum);
  assert.equal(row.payload.physical_provenance.actor_id,'owner');
  assert.equal((await pool.query("select count(*) from ledger_journals where client_id='own'")).rows[0].count,'0');
  assert.equal((await pool.query("select count(*) from inventory_operations where client_id='own'")).rows[0].count,'0');
  assert.equal((await pool.query("select actor_id from audit_events where action='document.physical_evidence.received'")).rows[0].actor_id,'owner');
  const duplicate=await call('owner','/evidence',{document});assert.equal(duplicate.status,200);assert.equal((await pool.query("select count(*) from documents where id='photo'")).rows[0].count,'1');
  // Continue through the actual mounted physical routes and sanctioned stock/ledger owners.
  await pool.query(`update clients set profile=$1::jsonb where id='own'`,[JSON.stringify({physical_reconciliation:{
    reviewer:{principalType:'firm_member',principalId:'member'},senior:{principalType:'firm_collaborator',principalId:'reviewer'},
    calendar:{timeZone:'Europe/London',workingDays:[1,2,3,4,5],holidays:[]},
    variancePolicy:{maxAbsoluteValue:100,maxPercentage:30,currency:'GBP'}}})]);
  const db=await pool.connect();
  try {
    for(const flagKey of ['INVENTORY_CORE','PHYSICAL_INVENTORY_APPLY','INVENTORY_ACCOUNTING'])await setClientFlagStage(db,{firmId:'physical-f',clientId:'own',flagKey,stage:'canary',actorType:'firm_member',actorId:'member',reason:'Isolated physical lifecycle'});
    await db.query(`insert into inventory_units_of_measure(id,firm_id,client_id,code,name,kind) values('each','physical-f','own','EA','Each','count');
      insert into inventory_locations(id,firm_id,client_id,code,name) values('shelf','physical-f','own','A','Shelf A');`);
    for(let i=0;i<5;i++){
      await db.query("insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values($1,'physical-f','own',$1,$1,'each')",[`item-${i}`]);
      const opening=await applyInventoryOperation({client:db,firmId:'physical-f',clientId:'own',actorId:'member',itemId:`item-${i}`,locationId:'shelf',uomId:'each',
        operationType:'opening_balance',quantity:10,unitCostAmount:5,unitCostCurrency:'GBP',occurredAt:'2026-01-01',idempotencyKey:`opening-${i}`});
      assert.equal(opening.applied,true,JSON.stringify(opening));
    }
    for(const [i,role]of ['asset.inventory','pnl.inventory_count_variance'].entries())await upsertLedgerAccountForJournal({client:db,firmId:'physical-f',clientId:'own',account:{code:`100${i}`,name:role,type:i?'expense':'asset',canonical_role:role},currency:'GBP'});
    // A real historical receipt and shrinkage establish prior account use. The
    // current ten units are unchanged; first-use control is never overridden.
    const roles={
      'asset.inventory':{code:'1000',name:'asset.inventory',type:'asset',canonical_role:'asset.inventory'},
      'pnl.inventory_count_variance':{code:'1001',name:'pnl.inventory_count_variance',type:'expense',canonical_role:'pnl.inventory_count_variance'},
      'liability.grni':{code:'2000',name:'Goods received not invoiced',type:'liability',canonical_role:'liability.grni'}
    };
    for(const [i,movement] of [{operationType:'receipt',quantity:2,unitCostAmount:5,unitCostCurrency:'GBP'},{operationType:'count_correction',quantity:-2}].entries()){
      const scope={client:db,firmId:'physical-f',clientId:'own',actorId:'member'};
      const result=await applyInventoryOperation({...scope,itemId:'item-1',locationId:'shelf',uomId:'each',idempotencyKey:`historical-${i}`,occurredAt:`2026-02-0${i+1}T00:00:00Z`,...movement});
      assert.equal(result.applied,true,JSON.stringify(result));
      const operations=(await db.query("select * from inventory_operations where client_id='own' order by occurred_at,id")).rows;
      const valuation=valueInventoryOperations({operations});
      const effect=valuation.receipt.operationEffects.find(e=>String(e.operationId)===String(result.receipt.operationId));
      const draft=buildInventoryJournalDraft({effect,roleAccounts:roles,valuationRunId:valuation.receipt.valuationRunId});
      assert.equal(draft.applied,true,JSON.stringify(draft));
      await db.query('begin');
      try{await writeValidatedJournalWithinTransaction(db,draft.journal,scope);await db.query('commit');}
      catch(error){await db.query('rollback');throw error;}
    }
    await db.query(`insert into inventory_posting_authority_grants(id,firm_id,client_id,allowed_posting_kinds,allowed_accounts,per_journal_ceiling,currency,evidence_required,authorized_by_actor_type,authorized_by_actor_id,source,status,valid_from)
      values('grant','physical-f','own',ARRAY['count_adjustment'],ARRAY['asset.inventory','pnl.inventory_count_variance'],1000,'GBP',true,'user','member','accountant_approval','active','2026-01-01')`);
  } finally {db.release();}
  const opened=await call('owner','',{location_id:'shelf',item_ids:Array.from({length:5},(_,i)=>`item-${i}`),idempotency_key:'http-open'});
  assert.equal(opened.body.applied,true,JSON.stringify(opened));assert.equal(opened.body.lines.length,5);
  assert.ok(opened.body.lines.every(l=>l.expected_quantity===null),'API first count must be blind');
  const sessionId=opened.body.session.id, lineId=i=>opened.body.lines.find(l=>l.item_id===`item-${i}`).id;
  const firstAsk=opened.body.lines[0].payload.owner.ask;
  assert.equal((await call('member',`/${sessionId}/acknowledgements`,{line_id:lineId(0),ask_id:firstAsk.id})).status,403,'another reviewer cannot forge delivery');
  const acknowledged=await call('owner',`/${sessionId}/acknowledgements`,{line_id:lineId(0),ask_id:firstAsk.id});assert.equal(acknowledged.body.deliveryStatus,'acknowledged',JSON.stringify(acknowledged));
  let reread=await call('owner',`/${sessionId}`);assert.equal(reread.body.lines[0].payload.owner.ask.deliveryStatus,'acknowledged');
  const observe=async(i,quantity,uncertain=false)=>call('owner',`/${sessionId}/observations`,{line_id:lineId(i),observed_quantity:quantity,evidence_refs:[{documentId:'photo',checksum}],observed_at:new Date().toISOString(),human_confirmed:true,confidence:null,uncertain,idempotency_key:`observe-${i}`});
  const matched=await observe(0,10);assert.equal(matched.body.lines[0].physical_status,'matched',JSON.stringify(matched));
  const compared=await observe(1,8);assert.equal(compared.body.applied,true,JSON.stringify(compared));
  const proposal=compared.body.lines.find(l=>l.item_id==='item-1');assert.equal(proposal.physical_observation.variance,-2);
  const resolution={line_id:lineId(1),action:'confirmed_shortage',reason:'Independent recount confirms missing stock',expected_observation_digest:proposal.physical_observation.inputDigest,idempotency_key:'accept-shortage'};
  assert.equal((await call('owner',`/${sessionId}/resolutions`,resolution)).body.reason,'second_reviewer_required');
  assert.equal((await call('reviewer',`/${sessionId}/resolutions`,resolution)).status,403,'reviewer cannot inherit founder posting authority');
  assert.equal((await call('member',`/${sessionId}/resolutions`,{...resolution,expected_observation_digest:'old-view'})).body.reason,'stale_observation');
  const applied=await call('member',`/${sessionId}/resolutions`,resolution);assert.equal(applied.body.applied,true,JSON.stringify(applied));assert.equal(applied.body.receipt.accounting.status,'posted');
  assert.equal((await call('member',`/${sessionId}/resolutions`,resolution)).body.receipt.replayed,true);
  assert.equal(Number((await pool.query("select on_hand from inventory_item_levels where item_id='item-1'")).rows[0].on_hand),8);
  assert.equal((await pool.query("select count(*) from inventory_operations where client_id='own' and operation_type='count_correction'")).rows[0].count,'2');
  const journalId=applied.body.receipt.accounting.ledger_journal_id;
  assert.ok(journalId);const amounts=(await pool.query('select sum(debit) as debit,sum(credit) as credit from ledger_lines where journal_id=$1',[journalId])).rows[0];assert.equal(Number(amounts.debit),10);assert.equal(Number(amounts.credit),10);
  const staleObserved=await observe(2,8);const staleLine=staleObserved.body.lines.find(l=>l.item_id==='item-2');
  const moving=await pool.connect();try{assert.equal((await applyInventoryOperation({client:moving,firmId:'physical-f',clientId:'own',actorId:'member',itemId:'item-2',locationId:'shelf',uomId:'each',operationType:'receipt',quantity:1,unitCostAmount:5,unitCostCurrency:'GBP',occurredAt:new Date().toISOString(),idempotencyKey:'late-receipt'})).applied,true);}finally{moving.release();}
  assert.equal((await call('member',`/${sessionId}/resolutions`,{...resolution,line_id:lineId(2),expected_observation_digest:staleLine.physical_observation.inputDigest,idempotency_key:'stale-apply'})).body.reason,'stale_expectation');
  const uncertain=await observe(3,null,true);const unknown=uncertain.body.lines.find(l=>l.item_id==='item-3');assert.equal(unknown.physical_status,'uncertain');assert.equal(unknown.physical_observation.quantity,null);assert.ok(unknown.payload.owner.ask.recipient.principalId);
  const juniorInput={line_id:lineId(4),observed_quantity:9,evidence_refs:[{documentId:'photo',checksum}],observed_at:new Date().toISOString(),human_confirmed:true,confidence:null,uncertain:false,idempotency_key:'junior-observation'};
  const juniorObservation=await call('junior',`/${sessionId}/observations`,juniorInput);
  assert.equal(juniorObservation.body.applied,true,JSON.stringify(juniorObservation));
  assert.deepEqual(Object.keys(juniorObservation.body.receipt).sort(),['lineId','replayed','sessionId']);
  assert.equal(juniorObservation.body.lines.length,1,'capture cannot read other count lines');
  const juniorLine=juniorObservation.body.lines[0];
  assert.equal(juniorLine.physical_observation.quantity,9);
  assert.equal(juniorLine.physical_observation.variance,undefined);
  for(const privateField of ['expected_quantity','physical_basis','physical_resolution','movements','evidence'])assert.equal(juniorLine[privateField],undefined,privateField);
  assert.equal(juniorLine.payload.versions,undefined);
  assert.ok(juniorLine.payload.owner.ask);
  assert.equal((await call('junior',`/${sessionId}`)).body.code,'PHYSICAL_REVIEW_AUTHORITY_REQUIRED');
  const reviewerRead=await call('reviewer',`/${sessionId}`);assert.equal(reviewerRead.status,200);
  assert.equal(reviewerRead.body.lines.find(l=>l.item_id==='item-4').physical_observation.variance,-1);
  assert.ok(reviewerRead.body.lines.find(l=>l.item_id==='item-1').physical_resolution.accounting.ledger_journal_id);
  const reviewLine=reviewerRead.body.lines.find(l=>l.item_id==='item-4');
  const recount=await call('reviewer',`/${sessionId}/resolutions`,{line_id:lineId(4),action:'recount_required',reason:'Private valuation £50 needs review',expected_observation_digest:reviewLine.physical_observation.inputDigest,idempotency_key:'reviewer-recount'});
  assert.equal(recount.body.applied,true,JSON.stringify(recount));
  const juniorReplay=await call('junior',`/${sessionId}/observations`,juniorInput);
  assert.equal(juniorReplay.body.receipt.replayed,true);
  assert.equal(juniorReplay.body.lines[0].payload.owner.ask.question,undefined);
  assert.doesNotMatch(JSON.stringify(juniorReplay.body),/Private valuation|£50/);


  const config=await pool.connect();try{await setClientFlagStage(config,{firmId:'physical-f',clientId:'own',flagKey:'PHYSICAL_RECONCILIATION',stage:'off',actorType:'firm_member',actorId:'member',reason:'Pause isolated pilot'});}finally{config.release();}
  assert.equal((await call('owner',`/${sessionId}`)).body.code,'PHYSICAL_RECONCILIATION_DISABLED');
  const restore=await pool.connect();try{await setClientFlagStage(restore,{firmId:'physical-f',clientId:'own',flagKey:'PHYSICAL_RECONCILIATION',stage:'canary',actorType:'firm_member',actorId:'member',reason:'Resume isolated pilot'});}finally{restore.release();}
  reread=await call('member',`/${sessionId}`);assert.equal(reread.body.lines.find(l=>l.item_id==='item-1').physical_resolution.accounting.ledger_journal_id,journalId);
  assert.equal(reread.body.lines.find(l=>l.item_id==='item-2').movements.length,1);
  await pool.query("update client_assignments set ends_at=now()-interval '1 minute' where id='owner-a'");
  const before=storageReads;assert.equal((await call('owner','/evidence',{document})).status,403);assert.equal(storageReads,before,'revoked actor must not fetch media');
});
