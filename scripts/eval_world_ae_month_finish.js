// Named production continuation; no expected-book import or direct mutations.
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFirmDbClient, getFinancialReportFromDb } from '../server/donna/firmDb.js';
import { drainAeCtRegistrationEscalations, drainAeVatReturnDeadlineEscalations } from '../server/donna/ae/statutoryDb.js';
import { prepareAeVatReturnFromDb } from '../server/donna/ae/vatReturnRoute.js';
import { bindProductionOperations } from './eval_world_db_close.js';
import { observeAeRuntime } from './eval_world_ae_runtime_worker.js';
import { monthToolFixture } from './eval_world_ae_month_sources.js';

export async function completeAeMonthStatutoryIntake({app,clientId,checkpoint}) {
  const firmId=app.firmId,actorId=app.memberId,common={firmId,clientId};
  const period={...common,periodStart:'2026-09-01',periodEnd:'2026-09-30',actorId};
  const ops=bindProductionOperations();
  const answer=(ask,text,facts)=>answerMonthQuestion({app,checkpoint,ask,text,facts});
  // Production statutory gathers mint the real factual asks. Only their external
  // delivery transport is suppressed: in-app asks and authenticated replies persist.
  await withFirmDbClient(async client=>{
    await drainAeCtRegistrationEscalations({client,firmId,asOf:'2026-09-09',deliverAsksImpl:async()=>{}});
    await drainAeVatReturnDeadlineEscalations({client,firmId,asOf:'2026-09-09',deliverAsksImpl:async()=>{}});
  });
  for(const ask of await app.read.asks(clientId)){
    if(!['open','draft'].includes(ask.status))continue;
    if(ask.evidence_type==='ct_registration_status')await answer(ask,
      'We registered for UAE corporate tax effective 1 January 2026. Our corporate tax TRN is 100987654321012.',
      {registered:true,trn:'100987654321012',registered_from:'2026-01-01'});
    if(ask.evidence_type==='vat_return_period_intake')await answer(ask,
      'Our FTA-assigned VAT period is 1 September 2026 to 30 September 2026, due on 28 October 2026.',
      {periods:[{period_key:'2026-09-01/2026-09-30',start_date:'2026-09-01',end_date:'2026-09-30',due_date:'2026-10-28'}]});
  }
}

async function answerMonthQuestion({app,checkpoint,ask,text,facts}) {
  const firmId=app.firmId;
    app.providers.script('owner_reply',[monthToolFixture('interpret_owner_reply',{answer:facts,confidence:0.99,clarification:null})]);
    const result=await app.api.request({method:'POST',path:`/api/donna/firms/evidence/requests/${ask.id}/resolve`,auth:true,body:{firm_id:firmId,reply:text}});
    if(result.status!==200||result.json?.recode?.error)throw Object.assign(new Error(result.text),{code:result.json?.code||result.json?.recode?.code});
    return checkpoint(`reply_${ask.evidence_type}`,result.json);
}

export async function finishAeMonth({app,clientId,receipt,checkpoint,withholdOwnerAnswer=false}) {
  const firmId=app.firmId,actorId=app.memberId,common={firmId,clientId};
  const period={...common,periodStart:'2026-09-01',periodEnd:'2026-09-30',actorId};
  const ops=bindProductionOperations();
  const answer=(ask,text,facts)=>answerMonthQuestion({app,checkpoint,ask,text,facts});
  const asks=(await app.read.asks(clientId)).filter(ask=>ask.evidence_type==='ae_vat_business_use'&&['open','draft','replied'].includes(ask.status));
  receipt.beforeOwnerAnswer={observation:await observeAeRuntime(common),report:await getFinancialReportFromDb({...period,basis:'cash'})};
  if(asks.length!==1)throw Object.assign(new Error(`Expected one source-bound business-use ask, saw ${asks.length}`),{code:'AE_MONTH_OWNER_ASK_COVERAGE'});
  if(withholdOwnerAnswer){
    receipt.blockers.push({code:'AE_MONTH_OWNER_FACT_PENDING',askId:asks[0].id});
    const attempt=async(action)=>{try{return {accepted:true,result:await action()};}catch(error){return {accepted:false,code:error.code,message:error.message};}};
    receipt.withheldAttempts={close:await attempt(()=>ops.lockClosePeriodInDb(period)),archive:await attempt(()=>ops.createCloseArchiveInDb(period))};
    const archiveId=receipt.withheldAttempts.archive.result?.close_archive?.archive_id;
    receipt.withheldAttempts.export=await attempt(()=>ops.getCloseArchiveExportFromDb({...period,archiveId:archiveId||'missing-unclosed-archive'}));
    receipt.withheldAttempts.persisted=(await app.query('select id, status, storage_status from close_archives where firm_id=$1 and client_id=$2',[firmId,clientId])).rows;
    return;
  }
  await answer(asks[0],'The PALM-0921 consumables were used exclusively in our taxable design business. There was no personal use.',
    {business_purpose:'Operating consumables for taxable design services',exclusively_taxable_business_use:true,personal_use:false});
  await checkpoint('answer_continuation',await app.tick({functions:['parse-cron:coding_convergence']}));
  receipt.automaticContinuation=await observeAeRuntime(common);
  if(receipt.automaticContinuation.transactions.length!==3||receipt.automaticContinuation.journalCount.count!==4
    ||receipt.automaticContinuation.transactions.some(tx=>!['posted','closed','synced'].includes(tx.coding_state)))
    throw Object.assign(new Error('The scheduled owner-answer continuation did not post every source transaction.'),{code:'AE_MONTH_AUTOMATIC_CONTINUATION_INCOMPLETE'});
  await checkpoint('period_post_replay',await ops.postLedgerPeriodInDb({...period,dryRun:false}));
  receipt.financialReport=await getFinancialReportFromDb({...period,basis:'cash'});
  receipt.vatReturn=await prepareAeVatReturnFromDb({...common,periodKey:'2026-09-01/2026-09-30'});
  receipt.beforeClose=await ops.getLedgerPeriodPreviewFromDb({...period,basis:'cash'});
  const closeRuns=await runCommittedWriterRestart({app,clientId,operation:'close'});
  receipt.closeCrashResume={boundary:'lockClosePeriodInDb:after_committed_effect',runs:closeRuns,
    sameCloseIdentity:closeRuns[0].closeLock.close_period_id===closeRuns[1].closeLock.close_period_id,
    separateProcesses:closeRuns[0].pid!==closeRuns[1].pid,replayIdempotent:closeRuns[1].closeLock.idempotent===true};
  await checkpoint('lock_close_crash_resume',receipt.closeCrashResume);
  const archive=await checkpoint('archive',await ops.createCloseArchiveInDb(period));
  const archiveId=archive?.close_archive?.archive_id;
  if(!archiveId)throw Object.assign(new Error('Archive writer returned no identity.'),{code:'AE_MONTH_ARCHIVE_MISSING'});
  const exportRuns=await runCommittedWriterRestart({app,clientId,operation:'export',archiveId});
  receipt.exportCrashResume={boundary:'getCloseArchiveExportFromDb:after_committed_handoff',
    separateProcesses:exportRuns[0].pid!==exportRuns[1].pid,exitCodes:exportRuns.map(run=>run.exitCode)};
  receipt.deliveryArtifact=exportRuns[0].deliveryArtifact;
  const repeatedExport=exportRuns[1].deliveryArtifact;
  receipt.exportReplayStable=typeof receipt.deliveryArtifact.manifest_checksum_sha256==='string'
    &&receipt.deliveryArtifact.manifest_checksum_sha256===repeatedExport.manifest_checksum_sha256
    &&receipt.deliveryArtifact.bundle_checksum_sha256===repeatedExport.bundle_checksum_sha256
    &&JSON.stringify(receipt.deliveryArtifact.files)===JSON.stringify(repeatedExport.files);
  receipt.exportReplayScope='retained archive manifest and complete file bundle; each download has its own attributed handoff timestamp';
  receipt.observation=await observeAeRuntime(common);
  receipt.financialReport=await getFinancialReportFromDb({...period,basis:'cash'});
  receipt.carryForward=await getFinancialReportFromDb({...common,periodStart:'2026-10-01',periodEnd:'2026-10-31',basis:'cash'});
  receipt.status='PASS';
}

async function runCommittedWriterRestart({app,clientId,operation,archiveId}) {
  const directory=await mkdtemp(join(tmpdir(),'ae-month-close-'));
  try {
    const input=join(directory,'input.json');
    await writeFile(input,JSON.stringify({runToken:app.runToken,firmId:app.firmId,clientId,actorId:app.memberId,operation,archiveId}));
    const runs=[];
    for(const phase of ['crash_after_commit','resume']){
      const output=join(directory,phase+'.json');
      const outcome=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[fileURLToPath(new URL('./eval_world_ae_month_checkpoint.js',import.meta.url)),input,output,phase],
          {cwd:directory,env:{PATH:process.env.PATH,HOME:directory,TZ:process.env.TZ||'UTC',DATABASE_URL:app.databaseUrl,DATABASE_POOL_MAX:'2'},stdio:['ignore','pipe','pipe']});
        let logs='';child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
        const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
        child.on('error',reject);child.on('close',(exitCode,signal)=>{clearTimeout(timer);resolve({exitCode,signal,logs});});
      });
      if(outcome.exitCode!==(phase==='crash_after_commit'?86:0))throw Object.assign(new Error(outcome.logs),{code:'AE_MONTH_CLOSE_RESTART_FAILED'});
      runs.push({...JSON.parse(await readFile(output,'utf8')),exitCode:outcome.exitCode});
    }
    return runs;
  } finally {await rm(directory,{recursive:true,force:true});}
}
