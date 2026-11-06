// Production seam for the supported synthetic month; never imports expected books.
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApplianceForTest } from '../server/donna/testSupport/applianceHarness.js';
import { withFirmDbClient, getFinancialReportFromDb } from '../server/donna/firmDb.js';
import { deleteEvidenceObjects } from '../server/donna/evidenceStorage.js';
import { finishAeMonth, completeAeMonthStatutoryIntake } from './eval_world_ae_month_finish.js';
import { setClientFlagStage } from '../server/donna/clientConfig.js';
import { bindProductionOperations } from './eval_world_db_close.js';
import { observeAeRuntime } from './eval_world_ae_runtime_worker.js';
import { MONTH_PROFILE, MONTH_SOURCES, MONTH_ORDERS, monthInvoiceBytes, monthBankStatementBytes, monthBankExtractionFixture, monthOpeningBytes,
  monthVatFixture, monthDocumentDispositionFixture, monthBankDispositionFixture, monthRoutingFixture, monthExtractionFixture, monthOpeningExtractionFixture, monthCodingFixture, monthMatchingFixture } from './eval_world_ae_month_sources.js';

const fail=(code,message,details)=>Object.assign(new Error(message),{code,details});
const requireResponse=(response,status=200)=>{
  if(response.status!==status)throw fail(response.json?.code||'AE_MONTH_API_REFUSED',response.text,{status:response.status});return response.json;
};
export async function runAeMonthWorker({postgresUrl,runToken,order='document_first',continuation=false,withholdOwnerAnswer=false,onCheckpoint=()=>{}}={}) {
  if(!MONTH_ORDERS.includes(order))throw fail('AE_MONTH_ORDER_UNKNOWN',order);
  const app=await bootApplianceForTest({pgTestUrl:postgresUrl,runToken,firm:{jurisdiction:'AE',currency:'AED'},env:{DATABASE_POOL_MAX:'2'}});
  const receipt={version:'ae.month-rehearsal.v1',assurance:'synthetic provider integration only',order,status:'INCOMPLETE',operations:[],blockers:[]};
  const ops=bindProductionOperations();let clientId;
  const checkpoint=async(name,value)=>{receipt.operations.push({name,result:value});await onCheckpoint(name,receipt);return value;};
  try {
    ({clientId}=await app.createClient({profile:MONTH_PROFILE}));
    const firmId=app.firmId,actorId=app.memberId,common={firmId,clientId};receipt.identity={...common,actorId};
    await checkpoint('entity_admission',await app.read.readiness(clientId));
    for(const flagKey of ['AE_OPENING_BALANCES','FISCAL_PERIOD_INTAKE',...(continuation?['AE_VAT_FACT_AUTOMATION']:[])])
      await withFirmDbClient(client=>setClientFlagStage(client,{...common,flagKey,stage:'auto',source:'manual',reason:'Synthetic supported-month engineering rehearsal',actorType:'firm_member',actorId}));
    requireResponse(await app.api.request({method:'POST',path:`/api/donna/firms/clients/${clientId}/fiscal-periods`,auth:true,
      body:{firm_id:firmId,starts_on:'2026-09-01',ends_on:'2027-08-31'}}),201);
    const opening=(action,fields)=>app.api.request({method:'POST',path:`/api/donna/firms/clients/${clientId}/ae-opening-balances`,auth:true,body:{firm_id:firmId,action,...fields}});
    const accounts={};
    for(const [key,role,code,name] of [['bank','asset.cash','BANK','Business Checking'],['capital','equity.share_capital','CAPITAL','Share capital'],
      ['sales','revenue.operating','SALES','Operating revenue'],['cost','expense.operating_supplies','COST','Operating supplies'],['vat','liability.sales_tax_payable','VAT','VAT control']]){
      const chart=(await app.query('select * from ledger_accounts where firm_id=$1 and client_id=$2 order by id',[firmId,clientId])).rows;
      const existing=chart.find(row=>row.canonical_role===role&&row.status==='active');
      const setup=requireResponse(await opening('setup_account',{intake:{as_of:'2026-09-01',account:existing?{account_id:existing.id,currency:'AED'}:{code,name,canonical_role:role,currency:'AED'}}}));
      accounts[key]=(await app.query('select * from ledger_accounts where id=$1',[setup.account_id])).rows[0];
    }
    app.providers.script('document_routing',[monthRoutingFixture('opening')]);
    app.providers.script('generic_document_extraction',[monthOpeningExtractionFixture()]);
    const declared=await app.uploadDocument({clientId,bytes:await monthOpeningBytes(),filename:'complete-opening-trial-balance.pdf',mimeType:'application/pdf',documentType:'unknown'});
    await checkpoint('opening_source_parse',await app.tick({functions:['parse-document']}));
    await checkpoint('opening_source',await app.read.document(declared.documentId));
    const proposal=requireResponse(await opening('submit',{intake:{as_of:'2026-09-01',source_as_of:'2026-08-31',source_document_id:declared.documentId,currency:'AED',complete:true,
      declared_lines:[{account_id:accounts.bank.id,debit:'10000',credit:'0'},{account_id:accounts.capital.id,debit:'0',credit:'10000'}]}}));
    // Ordinary answer drives the existing consumer, not a journal seed.
    const confirmation=requireResponse(await app.api.request({method:'POST',path:`/api/donna/firms/evidence/requests/${proposal.ask.id}/resolve`,auth:true,
      body:{firm_id:firmId,reply:'confirm'}}));
    await checkpoint('opening_confirmation',confirmation);
    if(continuation)await completeAeMonthStatutoryIntake({app,clientId,checkpoint});
    const uploaded={};
    if(continuation)app.providers.script('ae_vat_facts',[{respond:monthVatFixture,times:Infinity}]);
    app.providers.script('document_disposition',[{...monthDocumentDispositionFixture(),times:Infinity}]);
    app.providers.script('bank_line_disposition',[{respond:monthBankDispositionFixture,times:Infinity}]);
    const uploadSource=async(source)=>{
      app.providers.script('document_routing',[monthRoutingFixture(source)]);
      app.providers.script('unified_extraction',[monthExtractionFixture(source)]);
      app.providers.script('reconciliation_reasoning',[monthMatchingFixture(source)]);
      const file=await app.uploadDocument({clientId,bytes:await monthInvoiceBytes(source),filename:`${source.reference}.pdf`,mimeType:'application/pdf',documentType:source.type});
      uploaded[source.key]=file.documentId;
      await checkpoint(`parse_${source.key}`,await app.tick({functions:['parse-document']}));
    };
    const uploadBank=async()=>{
      app.providers.script('document_routing',[monthRoutingFixture('bank')]);
      app.providers.script('bank_statement_extraction',[monthBankExtractionFixture()]);
      const bank=await app.uploadDocument({clientId,bytes:await monthBankStatementBytes(),filename:'September-bank.pdf',mimeType:'application/pdf',documentType:'bank_statement'});uploaded.bank=bank.documentId;
      // Bank-first ordering can code before the invoices arrive. The shared
      // evidence revision then requires one fresh coding against those sources.
      // The late-source order deliberately runs one intermediate coding with
      // two invoices, then another after the final invoice. Each source revision
      // gets exactly one response; any extra call remains unscripted.
      app.providers.script('transaction_coding',Array.from({length:order==='late_document'?3:2},()=>monthCodingFixture(bank.documentId,accounts)));
      await checkpoint('parse_bank',await app.tick({functions:['parse-document']}));
    };
    if(order==='document_first'){for(const source of MONTH_SOURCES)await uploadSource(source);await uploadBank();}
    else {await uploadBank();for(const source of MONTH_SOURCES){
      if(order==='late_document'&&source.key==='purpose'){
        // Advance a full cron interval before enqueueing. SQL uses wall time,
        // so a second tick at the SAME injected instant collapses the newly
        // queued wait and runs it before admitting the late source.
        const scheduledBefore=await checkpoint('schedule_before_late_document',await app.tick({advanceMs:300000,functions:['parse-cron:coding_convergence']}));
        const beforeLate=await checkpoint('before_late_document',await app.tick({advanceMs:0,functions:['parse-cron:coding_convergence']}));
        if(![...scheduledBefore.jobs,...beforeLate.jobs].some(job=>job.function_id==='parse-cron:coding_convergence'&&job.status==='succeeded'))
          throw fail('AE_MONTH_LATE_CODING_NOT_RUN','The late-source scenario must run the coding clock before the final invoice arrives.');
      }
      await uploadSource(source);
    }}
    receipt.sources=uploaded;
    await checkpoint('raw_sources_observed',await observeAeRuntime(common));
    await checkpoint('coding_convergence_due',await app.tick({advanceMs:300000,functions:['parse-cron:coding_convergence']}));
    await checkpoint('coding_convergence',await app.tick({functions:['parse-cron:coding_convergence']}));
    receipt.preContinuationSources={transactions:await app.read.transactions(clientId),asks:await app.read.asks(clientId)};
    if(continuation){await finishAeMonth({app,clientId,receipt,checkpoint,withholdOwnerAnswer});return receipt;}
    await checkpoint('posting',await ops.postLedgerPeriodInDb({...common,periodStart:'2026-09-01',periodEnd:'2026-09-30',dryRun:false,actorId}));
    receipt.observation=await observeAeRuntime(common);
    receipt.financialReport=await getFinancialReportFromDb({...common,periodStart:'2026-09-01',periodEnd:'2026-09-30',basis:'cash'});
    receipt.blockers.push({code:'AE_MONTH_CONTINUATION_PENDING',reason:'Automatic VAT facts/ordinary owner reply and final close require stable wave-3 dependency heads.'});
  } catch(error) {receipt.blockers.push({code:error.code||'AE_MONTH_RUNTIME_FAILED',message:error.message,details:error.details||null});}
  finally {
    if(clientId)receipt.financialReport=await getFinancialReportFromDb({firmId:app.firmId,clientId,periodStart:'2026-09-01',periodEnd:'2026-09-30',basis:'cash'}).catch(error=>({error:error.message}));
    if(clientId)receipt.matches=await app.read.matches(clientId);
    if(clientId)receipt.readiness=await app.read.readiness(clientId);
    if(clientId)receipt.lastObservation=await observeAeRuntime({firmId:app.firmId,clientId}).catch(error=>({error:error.message}));
    receipt.providerCalls=app.providers.calls;receipt.unscripted=app.providers.unscripted;receipt.migrations=app.migrations;
    if(clientId)try {
      const sources=await app.read.documents(clientId);
      for(const source of sources)if(source.storage_bucket&&source.storage_object_key)await deleteEvidenceObjects({bucket:source.storage_bucket,keys:[source.storage_object_key]});
      Object.assign(receipt,await retireIsolatedMonth({app,clientId}));
      receipt.blobResidue=(await app.query('select count(*)::int as count from local_evidence_objects')).rows[0].count;
    } catch(error) {receipt.status='INCOMPLETE';receipt.blockers.push({code:error.code||'AE_MONTH_RETIREMENT_FAILED',message:error.message});}
    await onCheckpoint('final',receipt);await app.stop();
  }
  return receipt;
}

// Child launch deliberately starts in an empty directory and inherits no app env.
if(process.argv[1] && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url)) {
  const {readFile,writeFile}=await import('node:fs/promises');
  const [input,output]=process.argv.slice(2);
  const receipt=await runAeMonthWorker(JSON.parse(await readFile(input,'utf8')));
  await writeFile(output,JSON.stringify(receipt,null,2),{flag:'wx'});
}

async function retireIsolatedMonth({app,clientId}) {
  const directory=await mkdtemp(join(tmpdir(),'ae-month-retire-'));
  try {
    const input=join(directory,'input.json'),output=join(directory,'output.json');
    await writeFile(input,JSON.stringify({runToken:app.runToken,firmId:app.firmId,clientId,actorId:app.memberId}));
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('./eval_world_ae_month_checkpoint.js',import.meta.url)),input,output,'retire'],
        {cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DATABASE_URL:app.databaseUrl,DATABASE_POOL_MAX:'2'},stdio:['ignore','pipe','pipe']});
      let logs='';child.stdout.on('data',chunk=>{logs+=chunk;});child.stderr.on('data',chunk=>{logs+=chunk;});
      const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
      child.on('error',reject);child.on('close',exitCode=>{clearTimeout(timer);exitCode===0?resolve():reject(new Error('AE_MONTH_RETIREMENT_FAILED '+logs));});
    });
    return JSON.parse(await readFile(output,'utf8'));
  } finally {await rm(directory,{recursive:true,force:true});}
}
