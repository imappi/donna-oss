import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApplianceForTest, applianceHarnessSkipReason } from './testSupport/applianceHarness.js';
import { FI_PROFILE } from './testSupport/fiReliabilitySources.js';
import { loadPgPool } from './db/pool.js';
import { runCodingConvergenceInDb } from './codingConvergence.js';
import { getFirmSnapshotFromDb, withFirmDbClient, __writeLedgerJournalRows } from './firmDb.js';
import { updateReconciliationMatchInDb } from './db/reconcile.js';
import { setClientFlagStage, ENTITY_READINESS_ADMISSION_FLAG } from './clientConfig.js';
import { provisionEntityReadiness } from './runtimeReadiness.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';

const latch = () => { let resolve; const promise = new Promise(done => { resolve=done; }); return {promise,resolve}; };
test('real PG max-two: admitted convergence releases discovery checkout before independent work and interactive reads/writes',
  {skip:applianceHarnessSkipReason(),timeout:30000},async()=>{
    const app=await bootApplianceForTest({env:{DATABASE_POOL_MAX:'2'},firm:{jurisdiction:'FI',currency:'EUR'}});
    const gate=latch(),entered=latch(); let arrived=0;
    try {
      assert.equal((await app.read.host()).status,'PASS',JSON.stringify(await app.read.host()));
      const {clientId}=await app.createClient({profile:FI_PROFILE}); const firmId=app.firmId;
      await app.query('select 1');
      await withFirmDbClient(client=>setClientFlagStage(client,{firmId,clientId,flagKey:ENTITY_READINESS_ADMISSION_FLAG,stage:'canary',source:'manual',reason:'isolated real pool admission proof',actorId:app.memberId,actorType:'firm_member'}));
      const ready=await provisionEntityReadiness({withFirmDbClientFn:withFirmDbClient,firmId,clientId,retry:true,creationPath:'desktop_firm_intake'});
      assert.equal(ready.row.state,'ready',JSON.stringify(ready.certificate));
      const pool=await loadPgPool(); assert.equal(pool.options.max,2);
      // Only this disposable proof shortens acquisition failure; no production
      // pool, timeout or retry policy is changed.
      pool.options.connectionTimeoutMillis=700;
      const admission=await withFirmDbClient(client=>evaluateEntityReadinessAdmissionWithClient({client,firmId,clientId,boundary:'worker_discovery'}));
      assert.equal(admission.enforced,true);assert.equal(admission.allowed,true);
      for(const suffix of ['worker-a','worker-b','interactive','late-refusal']){
        await app.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload) values($1,$2,$3,'2026-03-03','Rent',600,'EUR','needs_review','{}')",[suffix,firmId,clientId]);
        await app.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,document_date,payload) values($1,$2,$3,$1,'supplier_bill','completed',600,'EUR','2026-03-03','{}')",['doc-'+suffix,firmId,clientId]);
        await app.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'supplier_bill',$5,600,.95,'suggested','fixture','{}')",['match-'+suffix,firmId,clientId,suffix,'doc-'+suffix]);
      }
      const confirm=suffix=>updateReconciliationMatchInDb({firmId,clientId,matchId:'match-'+suffix,patch:{status:'confirmed'},actorId:app.memberId,captureBeforeState:true});
      const args={firmId,discoverCoderClientsFn:async()=>[{client_id:clientId}],discoverSweepClientsFn:async()=>[],discoverLedgerPostClientsFn:async()=>[],
        recoverOwnerRepliesFn:null,recoverReconciliationProviderFailuresFn:null,recoverChangedEvidenceFn:null,recoverRefusedEvidenceFn:null,recoverAeVatLegacyCodingFn:null,
        releaseWaitingFn:async()=>[],recoverAskDraftFn:async()=>[],requestAskDraftFn:async()=>({enqueued:0})};
      const workers=['worker-a','worker-b'].map(suffix=>runCodingConvergenceInDb({...args,batchSuggestFn:async()=>{
        if(++arrived===2)entered.resolve(); await gate.promise;
        return (await confirm(suffix)).snapshot;
      }}));
      await entered.promise;
      // Both callbacks are outstanding (e.g. provider work). Independent owner
      // operations must have usable pool slots, before either callback finishes.
      const interactive=await Promise.allSettled([confirm('interactive'),getFirmSnapshotFromDb({firmId})]);
      gate.resolve(); const summaries=await Promise.all(workers);
      assert.deepEqual(interactive.map(result=>result.status==='fulfilled'?'ok':result.reason.message),['ok','ok']);
      assert.ok(interactive[0].value.snapshot.clients.some(client=>client.id===clientId));
      assert.deepEqual(summaries.map(summary=>summary.errors),[0,0],JSON.stringify(summaries));
      const receipts=(await app.query("select resource_id,count(*)::int n from audit_events where action='reconciliation_match.update' group by resource_id order by resource_id")).rows;
      assert.deepEqual(receipts.map(row=>[row.resource_id,row.n]),[['match-interactive',1],['match-worker-a',1],['match-worker-b',1]]);
      assert.equal((await app.query('select count(*)::int n from ledger_journals')).rows[0].n,0,'confirmation invents no accounting journal');
      // Discovery is intentionally not a whole-work lease. A real dependency
      // change after admission is still rejected by the named writer itself.
      const late=await runCodingConvergenceInDb({...args,batchSuggestFn:async()=>{
        await app.query("update clients set jurisdiction='GB' where id=$1",[clientId]);
        return withFirmDbClient(async client=>{
          await client.query('begin');
          try { return await __writeLedgerJournalRows({client,firmId,clientId,journal:{source_type:'transaction',source_id:'late-refusal'}}); }
          finally { await client.query('rollback'); }
        });
      }});
      assert.equal(late.errors,1);assert.match(late.coder[0].error,/readiness|recovery/i);
      assert.equal((await app.query("select status from reconciliation_matches where id='match-late-refusal'")).rows[0].status,'suggested');
      let workCalls=0;
      const refused=await runCodingConvergenceInDb({...args,batchSuggestFn:async()=>{workCalls+=1;}});
      assert.equal(workCalls,0);assert.equal(refused.errors,1);
      const blocked=await app.query("select metadata from audit_events where action='runtime.readiness_admission_blocked' and client_id=$1",[clientId]);
      assert.ok(blocked.rows.length>0,'refusal remains audited');
      assert.equal(pool.waitingCount,0);
    } finally {gate.resolve();await app.stop();}
  });

test('real PG max-two: source recovery reuses its serialization client for extraction context while owner work keeps the other slot',
  {skip:applianceHarnessSkipReason(),timeout:30000},async()=>{
    const app=await bootApplianceForTest({env:{DATABASE_POOL_MAX:'2'},firm:{jurisdiction:'FI',currency:'EUR'}});
    const providerEntered=latch(),providerFinish=latch();let blocker;
    try {
      const {clientId}=await app.createClient({profile:FI_PROFILE});const firmId=app.firmId;
      for(const flagKey of [ENTITY_READINESS_ADMISSION_FLAG]) {
        await withFirmDbClient(client=>setClientFlagStage(client,{firmId,clientId,flagKey,stage:flagKey===ENTITY_READINESS_ADMISSION_FLAG?'canary':'auto',source:'manual',reason:'isolated source recovery pool proof',actorId:app.memberId,actorType:'firm_member'}));
      }
      const certified=await provisionEntityReadiness({withFirmDbClientFn:withFirmDbClient,firmId,clientId,retry:true,creationPath:'desktop_firm_intake'});
      assert.equal(certified.row.state,'ready',JSON.stringify(certified.certificate?.checks.filter(c=>c.status!=='PASS')));
      await app.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state,payload) values('source-recheck',$1,$2,'2026-03-03','Rent',1200,'EUR','needs_review','applied',$3)",[firmId,clientId,{ai_suggestion:{proposed_account:'Rent'},ai_suggestion_status:'auto_applied',ledger_post_refusal:{code:'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH',error:'Synthetic printed tax mismatch'}}]);
      await app.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,storage_bucket,storage_object_key,payload) values('recheck-doc',$1,$2,'Rent.pdf','supplier_bill','completed',1200,0,'EUR','2026-03-03','fixture-bucket','fixture-rent.pdf','{}')",[firmId,clientId]);
      await app.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values('recheck-match',$1,$2,'source-recheck','supplier_bill','recheck-doc',1200,.99,'auto_matched','fixture','{}')",[firmId,clientId]);
      const {fiSource,fiDocumentBytes,fiExtractionFixture}=await import('./testSupport/fiReliabilitySources.js');
      const {recoverRefusedCodingEvidenceInDb}=await import('./db/codingRefusalRecovery.js');
      const bytes=await fiDocumentBytes(fiSource('rent'));
      const providerFetch=globalThis.fetch;
      // Real cloud object-read path at a synthetic HTTP boundary, no actual
      // storage or provider access and no local-object nested pool lookup.
      process.env.DONNA_DESKTOP_BLOB_DIR='';process.env.SUPABASE_URL='https://storage.pool-proof.invalid';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only-not-a-key';
      globalThis.fetch=async(address,init)=>String(address)==='https://storage.pool-proof.invalid/storage/v1/object/fixture-bucket/fixture-rent.pdf'
        ? new Response(bytes,{status:200,headers:{'content-type':'application/pdf'}}) : providerFetch(address,init);
      app.providers.script('unified_extraction',[{respond:async body=>{
        assert.ok(JSON.stringify(body).includes(FI_PROFILE.companyName),'actual persisted company context reaches the source reader');
        providerEntered.resolve();await providerFinish.promise;return fiExtractionFixture(fiSource('rent'));
      }}]);
      const pool=await loadPgPool();pool.options.connectionTimeoutMillis=700;
      blocker=await pool.connect();await blocker.query('begin');
      // A second legitimate checkout is occupied. Recovery must not borrow a
      // third client to read its extraction identity before calling the model.
      const recovery=runCodingConvergenceInDb({firmId,
        recoverRefusedEvidenceFn:options=>recoverRefusedCodingEvidenceInDb({...options,limit:1}),
        recoverOwnerRepliesFn:null,recoverReconciliationProviderFailuresFn:null,recoverChangedEvidenceFn:null,recoverAeVatLegacyCodingFn:null,
        discoverCoderClientsFn:async()=>[],discoverSweepClientsFn:async()=>[],discoverLedgerPostClientsFn:async()=>[],releaseWaitingFn:async()=>[],recoverAskDraftFn:async()=>[]});
      const reached=await Promise.race([providerEntered.promise.then(()=>true),recovery.then(()=>false)]);
      await blocker.query('rollback');await blocker.release();blocker=null;
      const snapshot=await getFirmSnapshotFromDb({firmId});assert.ok(snapshot.clients.some(client=>client.id===clientId));
      // The provider is still paused while this actual owner confirmation runs.
      const confirmed=await updateReconciliationMatchInDb({firmId,clientId,matchId:'recheck-match',patch:{status:'confirmed'},actorId:app.memberId,captureBeforeState:true});
      assert.ok(confirmed.snapshot.clients.some(client=>client.id===clientId));
      providerFinish.resolve();const summary=await recovery;
      assert.equal(reached,true,JSON.stringify(summary));
      assert.equal(summary.errors,0,JSON.stringify(summary));
      // The owner changed the same evidence during inference. Existing locked
      // freshness refuses the stale source result rather than applying it.
      assert.equal(summary.posting_source_recovery[0].skipped,'source_changed');
      assert.equal((await app.query('select count(*)::int n from ledger_journals')).rows[0].n,0);
      assert.equal((await app.query("select count(*)::int n from audit_events where action='coding.posting_source_rechecked'")).rows[0].n,0);
      assert.equal(pool.waitingCount,0);
    } finally {providerFinish.resolve();if(blocker){await blocker.query('rollback');await blocker.release();}await app.stop();}
  });
