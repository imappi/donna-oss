import assert from 'node:assert/strict';
import test from 'node:test';
import { bootApplianceForTest } from './testSupport/applianceHarness.js';
import { syncDocumentsAndTransactionsInDb, withFirmDbClient, resolveClientEvidenceRequestInDb, lockClosePeriodInDb, runCloseChecksInDb, postAeOpeningBalanceJournalWithClient } from './firmDb.js';
import { actAeOpeningFromDb, prepareAeOpeningPostWithClient } from './ae/openingBalanceDb.js';
import { provisionEntityReadiness } from './runtimeReadiness.js';
import { resolveCountryInboundReply } from './inboundCountryRegistry.js';

test('U02-S1 real PostgreSQL: actual AE create, period intake, complete TB, owner replies and named journal', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL,'INCOMPLETE: own disposable PostgreSQL URL is required.');
  const app=await bootApplianceForTest({firm:{jurisdiction:'AE',currency:'AED'},env:{DATABASE_POOL_MAX:'2'}});
  t.after(()=>app.stop());
  assert.equal(process.env.DATABASE_POOL_MAX,'2');
  const {clientId}=await app.createClient({profile:{companyName:'Opening fixture LLC',jurisdiction:'AE',entityType:'ae-llc',incorporationDate:'2020-01-01',currency:'AED'}});
  const firmId=app.firmId, actorId=app.memberId;
  const q=app.query;
  const uploaded=await app.uploadDocument({clientId,bytes:Buffer.from('Account,Debit AED,Credit AED\nBank,100.25,0\nFixed assets,49.75,0\nCapital,0,150.00\n'),filename:'Closing trial balance.csv',mimeType:'text/csv',documentType:'unknown'});
  const sourceId=uploaded.documentId;
  for(const flag of ['AE_OPENING_BALANCES','FISCAL_PERIOD_INTAKE'])await q(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason) values($1,$2,$3,$4,'auto','manual','Synthetic U02 opening intake test') on conflict(id) do nothing`,[`${clientId}-${flag}`,firmId,clientId,flag]);
  const api=(action,intake={})=>app.api.request({method:'POST',path:`/api/donna/firms/clients/${clientId}/ae-opening-balances`,auth:true,body:{firm_id:firmId,action,...intake}});
  const missingPeriod=await api('submit',{intake:{as_of:'2026-01-01'}});
  assert.equal(missingPeriod.json.code,'AE_OPENING_OPEN_PERIOD_REQUIRED',missingPeriod.text);
  const period=await app.api.request({method:'POST',path:`/api/donna/firms/clients/${clientId}/fiscal-periods`,auth:true,body:{firm_id:firmId,starts_on:'2026-01-01',ends_on:'2026-12-31'}});
  assert.equal(period.status,201,period.text);assert.equal(period.json.statutory.bound_enforced,false);
  const periodAgain=await app.api.request({method:'POST',path:`/api/donna/firms/clients/${clientId}/fiscal-periods`,auth:true,body:{firm_id:firmId,starts_on:'2026-01-01',ends_on:'2026-12-31'}});
  assert.equal(periodAgain.status,200,periodAgain.text);
  const missing=await api('submit',{intake:{as_of:'2026-01-01'}});
  assert.equal(missing.status,200,missing.text);assert.equal(missing.json.action,'missing');
  const repeated=await api('submit',{intake:{as_of:'2026-01-01'}});assert.equal(repeated.json.ask.id,missing.json.ask.id);
  await syncDocumentsAndTransactionsInDb({firmId,documents:[{id:sourceId,client_id:clientId,filename:'Closing trial balance',document_type:'unknown',currency:'AED',document_date:'2025-12-31',source:'owner_trial_balance_fixture',checksum_sha256:'fixture-tb-v1'}],transactions:[]});
  let chart=(await q(`select * from ledger_accounts where client_id=$1 order by code`,[clientId])).rows;
  // The actual user account-setup endpoint consumes the fresh AE seed chart.
  for(const [code,name,type,role,balance] of [['OBBANK','Opening bank','bank','asset.cash','debit'],['OBFIX','Opening fixed assets','asset','asset.fixed','debit'],['OBCAP','Opening capital','equity','equity.share_capital','credit']]){
    if(!chart.some(a=>a.canonical_role===role)){const setup=await api('setup_account',{intake:{as_of:'2026-01-01',account:{code,name,canonical_role:role,currency:'AED'}}});assert.equal(setup.status,200,setup.text);assert.equal(setup.json.readiness,'ready',setup.text);}
  }
  chart=(await q(`select * from ledger_accounts where client_id=$1 order by code`,[clientId])).rows;

  const control=chart.find(a=>a.canonical_role==='liability.sales_tax_payable');assert.ok(control,'actual AE seed has sales tax control');
  const controlSetup=await api('setup_account',{intake:{as_of:'2026-01-01',account:{account_id:control.id,currency:'AED'}}});
  const concurrentSetup=await Promise.all([api('setup_account',{intake:{as_of:'2026-01-01',account:{account_id:control.id,currency:'AED'}}}),api('setup_account',{intake:{as_of:'2026-01-01',account:{account_id:control.id,currency:'AED'}}})]);
  assert.ok(concurrentSetup.every(result=>result.status===200 && result.json.readiness==='ready'),JSON.stringify(concurrentSetup));
  assert.equal(controlSetup.status,200,controlSetup.text);assert.equal(controlSetup.json.account_id,control.id);assert.equal(controlSetup.json.readiness,'ready');
  assert.equal((await q('select currency from ledger_accounts where id=$1',[control.id])).rows[0].currency,'AED');

  const account=role=>{const rows=chart.filter(a=>a.canonical_role===role&&a.status==='active');assert.equal(rows.length,1,JSON.stringify(chart.map(a=>[a.name,a.canonical_role])));return rows[0].id;};
  const intake={as_of:'2026-01-01',source_as_of:'2025-12-31',source_document_id:sourceId,currency:'AED',complete:true,declared_lines:[
    {account_id:account('asset.cash'),debit:'100.25',credit:'0'},
    {account_id:account('asset.fixed'),debit:'49.75',credit:'0'},
    {account_id:account('equity.share_capital'),debit:'0',credit:'150.00'}]};
  const proposed=await api('submit',{intake});assert.equal(proposed.status,200,proposed.text);
  let ask=proposed.json.ask;assert.equal(ask.request_payload.ae_opening_balance.proposal.totals.assets,150);
  const old=(await q('select * from client_evidence_requests where id=$1',[missing.json.ask.id])).rows[0];assert.equal(old.status,'resolved');
  let confirm={ask_id:ask.id,proposal_digest:ask.request_payload.ae_opening_balance.proposal_digest};
  const bad=await api('confirm',{...confirm,proposal_digest:'stale'});assert.equal(bad.json.code,'AE_OPENING_CONFIRMATION_REQUIRED',bad.text);
  // Reproduce the saved-state exploit: a balanced replacement and matching
  // proposal still cannot retain the owner's original confirmation digest.
  const tampered=structuredClone(ask.request_payload);
  tampered.ae_opening_balance.intake.declared_lines[0].debit='900.25';
  tampered.ae_opening_balance.intake.declared_lines[2].credit='950';
  tampered.ae_opening_balance.proposal.openingLines[0].debit=900.25;
  tampered.ae_opening_balance.proposal.openingLines[2].credit=950;
  tampered.ae_opening_balance.proposal.totals={debit:950,credit:950,assets:950,liabilities:0,equity:950};
  await q('update client_evidence_requests set request_payload=$2::jsonb where id=$1',[ask.id,JSON.stringify(tampered)]);
  const corrupt=await api('confirm',confirm);assert.equal(corrupt.json.code,'AE_OPENING_CONFIRMATION_STALE',corrupt.text);
  assert.equal((await q('select count(*)::int n from ledger_journals where client_id=$1',[clientId])).rows[0].n,0);
  const beforeSource=await api('submit',{intake});ask=beforeSource.json.ask;
  confirm={ask_id:ask.id,proposal_digest:ask.request_payload.ae_opening_balance.proposal_digest};
  await q("update documents set checksum_sha256='source-revision-2' where id=$1",[sourceId]);
  const stale=await api('confirm',confirm);assert.equal(stale.status,409,stale.text);assert.equal(stale.json.code,'AE_OPENING_CONFIRMATION_STALE');
  assert.equal((await q('select status from client_evidence_requests where id=$1',[ask.id])).rows[0].status,'resolved');
  assert.equal((await q("select count(*)::int n from ledger_journals where client_id=$1",[clientId])).rows[0].n,0);
  const fresh=await api('submit',{intake});assert.equal(fresh.status,200,fresh.text);ask=fresh.json.ask;
  confirm={ask_id:ask.id,proposal_digest:ask.request_payload.ae_opening_balance.proposal_digest};
  const confirmed=await api('confirm',confirm);assert.equal(confirmed.status,200,confirmed.text);
  assert.equal(confirmed.json.action,'posted');
  const journal=(await q("select * from ledger_journals where client_id=$1 and source_type='opening_balance'",[clientId])).rows;
  assert.equal(journal.length,1);assert.equal(journal[0].source_id,`AE:${period.json.fiscal_period.id}`);assert.equal(journal[0].currency,'AED');
  assert.equal(journal[0].payload.opening_source.source_document_id,sourceId);
  const lines=(await q('select * from ledger_lines where journal_id=$1 order by line_no',[journal[0].id])).rows;
  assert.equal(lines.length,3);assert.equal(lines.reduce((n,l)=>n+Number(l.debit),0),150);assert.equal(lines.reduce((n,l)=>n+Number(l.credit),0),150);
  const audit=(await q("select * from audit_events where client_id=$1 and action='ledger.post_opening_balance'",[clientId])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].actor_id,actorId);
  assert.equal((await q('select status from client_evidence_requests where id=$1',[ask.id])).rows[0].status,'resolved');
  for(const response of await Promise.all([api('confirm',confirm),api('confirm',confirm)]))assert.equal(response.json.receipt.journal_id,journal[0].id,response.text);
  assert.equal((await q("select count(*)::int n from audit_events where client_id=$1 and action='ledger.post_opening_balance'",[clientId])).rows[0].n,1);
  assert.equal((await q("select count(*)::int n from client_evidence_requests where client_id=$1 and status='open'",[clientId])).rows[0].n,0);

  const askCount=(await q('select count(*)::int n from client_evidence_requests where client_id=$1',[clientId])).rows[0].n;
  const restart=await api('submit',{intake});assert.equal(restart.json.action,'posted',restart.text);assert.equal(restart.json.replay,true);
  assert.equal((await q('select count(*)::int n from client_evidence_requests where client_id=$1',[clientId])).rows[0].n,askCount);

  // A changed amount cannot reuse the prior confirmation. A new proposal is
  // explicit correction authority and must itself be reconfirmed.
  const changed=structuredClone(intake);changed.declared_lines[0].debit='200.25';changed.declared_lines[2].credit='250';
  const reproposed=await api('submit',{intake:changed});assert.equal(reproposed.status,200,reproposed.text);
  const correctionAsk=reproposed.json.ask;
  assert.equal(correctionAsk.request_payload.ae_opening_balance.prior_journal_id,journal[0].id);
  const channel=resolveCountryInboundReply(correctionAsk);
  const sent=[];
  const channelResult=await channel.run({firmId,anchor:{clientId,phoneHash:'fixture-phone'},ask:correctionAsk,text:'confirm',message:{id:'fixture-confirm-2'},actorId,
    sendText:async args=>sent.push(args),from:'fixture-owner',recordLedger:async()=>{}});
  assert.equal(channelResult.result.action,'posted');assert.equal(sent.length,1);
  assert.equal((await q("select count(*)::int n from ledger_journals where client_id=$1 and source_type='opening_balance'",[clientId])).rows[0].n,1);
  const cancelProposal=await api('submit',{intake});assert.equal(cancelProposal.status,200,cancelProposal.text);
  const cancel=await api('reply',{ask_id:cancelProposal.json.ask.id,reply:'cancel'});assert.equal(cancel.json.action,'cancelled');
  assert.equal((await q('select status from client_evidence_requests where id=$1',[cancelProposal.json.ask.id])).rows[0].status,'resolved');
  const evidenceApi=(id,reply)=>app.api.request({method:'POST',path:`/api/donna/firms/evidence/requests/${id}/resolve`,auth:true,body:{firm_id:firmId,reply}});
  const genericProposal=await api('submit',{intake});
  const generic=await evidenceApi(genericProposal.json.ask.id,'confirm');assert.equal(generic.status,200,generic.text);assert.equal(generic.json.opening_balance.action,'posted');
  const dbProposal=await api('submit',{intake:changed});
  const direct=await resolveClientEvidenceRequestInDb({firmId,evidenceRequestId:dbProposal.json.ask.id,reply:'confirm',actorId});
  assert.equal(direct.opening_balance.action,'posted');assert.equal(direct.evidence_request.status,'resolved');
  const permissionProposal=await api('submit',{intake});
  const effects=async()=>JSON.stringify({journals:(await q('select * from ledger_journals where client_id=$1 order by id',[clientId])).rows,
    asks:(await q('select * from client_evidence_requests where client_id=$1 order by id',[clientId])).rows});
  const beforeDenied=await effects();
  const originalRole=(await q('select role from firm_members where id=$1',[actorId])).rows[0].role;
  await q("update firm_members set role='viewer' where id=$1",[actorId]);
  assert.equal((await api('submit',{intake})).status,403);
  assert.equal((await evidenceApi(permissionProposal.json.ask.id,'confirm')).status,403);
  await q('update firm_members set role=$2 where id=$1',[actorId,originalRole]);
  const collaborator=`${clientId}-viewer`;
  await q("insert into firm_collaborators(id,firm_id,email,name) values($1,$2,'opening-viewer@example.invalid','Viewer')",[collaborator,firmId]);
  await q("insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role) values($1,$2,$3,'firm_collaborator',$4,'viewer')",[`${collaborator}-assignment`,firmId,clientId,collaborator]);
  const denied=()=>actAeOpeningFromDb({firmId,clientId,actorId:collaborator,authorityBasis:{source:'owner_portal_intake'},action:'confirm',askId:permissionProposal.json.ask.id,proposalDigest:permissionProposal.json.ask.request_payload.ae_opening_balance.proposal_digest});
  await assert.rejects(denied,{statusCode:403});
  await q("update client_assignments set role='owner',ends_at=now()-interval '1 minute' where principal_id=$1",[collaborator]);
  await assert.rejects(denied,{statusCode:403});
  assert.equal(await effects(),beforeDenied,'denied authority has no ask or journal effects');
  await api('cancel',{ask_id:permissionProposal.json.ask.id});
  await q('delete from client_assignments where principal_id=$1',[collaborator]);
  await q('delete from firm_collaborators where id=$1',[collaborator]);
  const unchanged=JSON.stringify((await q('select * from ledger_lines where journal_id=$1 order by line_no',[journal[0].id])).rows);
  for(const [name,patch,code] of [
    ['currency absent',{currency:null},'AE_OPENING_CURRENCY_REQUIRED'],
    ['currency mismatch',{currency:'USD'},'AE_OPENING_CURRENCY_REQUIRED'],
    ['unbalanced',{declared_lines:[intake.declared_lines[0]]},'AE_OPENING_UNBALANCED'],
    ['source absent',{source_document_id:null},'AE_OPENING_SOURCE_REQUIRED'],
    ['foreign source',{source_document_id:'another-client-document'},'AE_OPENING_SOURCE_REQUIRED'],
    ['source date',{source_as_of:'2025-12-30'},'AE_OPENING_SOURCE_DATE_CONFLICT'],
    ['mid-period',{as_of:'2026-02-01'},'AE_OPENING_PERIOD_START_REQUIRED'],
    ['duplicate account',{declared_lines:[...intake.declared_lines,intake.declared_lines[0]]},'AE_OPENING_ACCOUNT_DUPLICATE'],
    ['unknown account',{declared_lines:[{account_id:'not-current',debit:1}]},'AE_OPENING_ACCOUNT_REQUIRED'],
    ['tax carry-forward',{statutory_carry_forwards:[{kind:'loss'}]},'AE_OPENING_CARRY_IN_UNSUPPORTED']
  ]) { const response=await api('submit',{intake:{...intake,...patch}});assert.equal(response.json.code,code,`${name}: ${response.text}`); }
  // Mutation probes alter INPUT facts only, never seed a desired journal or ask.
  for(const [column,value,restore,code] of [
    ['jurisdiction','gb','ae','AE_OPENING_JURISDICTION_REQUIRED'],
    ['incorporation_date','2026-01-01','2020-01-01','OPENING_BALANCE_GREENFIELD_NO_SEED']
  ]) {
    await q(`update clients set ${column}=$2 where id=$1`,[clientId,value]);
    const response=await api('submit',{intake});assert.equal(response.json.code,code,response.text);
    await q(`update clients set ${column}=$2 where id=$1`,[clientId,restore]);
  }
  for(const role of ['asset.accounts_receivable','liability.accounts_payable','liability.sales_tax_payable']) {
    const existing=chart.find(a=>a.canonical_role===role);
    const selected=existing || chart.find(a=>a.canonical_role==='asset.fixed');
    if(!existing)await q('update ledger_accounts set canonical_role=$2,account_type=$3,normal_balance=$4 where id=$1',
      [selected.id,role,role.startsWith('asset.')?'asset':'liability',role.startsWith('asset.')?'debit':'credit']);
    const response=await api('submit',{intake:{...intake,declared_lines:[{account_id:selected.id,debit:'1'}]}});
    assert.equal(response.json.code,'AE_OPENING_CARRY_IN_UNSUPPORTED',response.text);
    if(!existing)await q('update ledger_accounts set canonical_role=$2,account_type=$3,normal_balance=$4 where id=$1',
      [selected.id,selected.canonical_role,selected.account_type,selected.normal_balance]);
  }
  await q("update fiscal_years set status='closed' where id=$1",[period.json.fiscal_period.id]);
  assert.equal((await api('submit',{intake})).json.code,'AE_OPENING_OPEN_PERIOD_REQUIRED');
  await q("update fiscal_years set status='open' where id=$1",[period.json.fiscal_period.id]);
  await q("insert into fiscal_years(id,firm_id,client_id,label,starts_on,ends_on,status) values('overlap-fixture',$1,$2,'overlap','2025-12-01','2026-03-31','open')",[firmId,clientId]);
  assert.equal((await api('submit',{intake})).json.code,'AE_OPENING_OPEN_PERIOD_REQUIRED');
  await q("delete from fiscal_years where id='overlap-fixture'");
  assert.equal(JSON.stringify((await q('select * from ledger_lines where journal_id=$1 order by line_no',[journal[0].id])).rows),unchanged);
  // Refusal probes invalidate readiness even when their source facts are
  // restored. Re-run the real certificate before the next positive mutation.
  const ready=await provisionEntityReadiness({withFirmDbClientFn:withFirmDbClient,firmId,clientId,
    creationPath:'generic_client_route',retry:true,lifecycle:'retry',compatibilityScope:'current_generation_compatibility',
    initiatingPrincipal:{actor_type:'firm_member',actor_id:actorId},authorityBasis:{source:'restored_fixture_inputs'}});
  assert.equal(ready.row.state,'ready',JSON.stringify(ready));
  // Two real connections: opening holds the shared client close boundary;
  // the named close writer must wait, then close the committed opening.
  const raceProposal=await api('submit',{intake});assert.equal(raceProposal.status,200,raceProposal.text);
  const race={firmId,clientId,actorId,authorityBasis:{source:'owner_portal_intake'},askId:raceProposal.json.ask.id,proposalDigest:raceProposal.json.ask.request_payload.ae_opening_balance.proposal_digest};
  let closing;
  await withFirmDbClient(async client=>{
    await client.query('begin');
    try {
      await prepareAeOpeningPostWithClient({client,...race});
      closing=lockClosePeriodInDb({firmId,clientId,periodStart:'2026-01-01',periodEnd:'2026-01-31',actorId,force:true}).then(value=>({value}),error=>({error}));
      let waiting=false;
      for(let attempt=0;attempt<100&&!waiting;attempt++) {
        waiting=(await q("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like '%pg_advisory_xact_lock%') value")).rows[0].value;
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(waiting,true,'named close waits on the same client boundary');
      await postAeOpeningBalanceJournalWithClient({client,...race});
      await client.query('commit');
    }catch(error){await client.query('rollback');throw error;}
  });
  const staleClose=await closing;assert.equal(staleClose.error?.code,'CLOSE_BOOK_CHANGED_RETRY');
  assert.equal((await q('select status from ledger_journals where id=$1',[journal[0].id])).rows[0].status,'posted');
  // Pin the OTHER gap: hold the real check receipt just before commit,
  // queue an opening on the shared boundary, then release checks. The opening
  // lands after those checks but before the named final lock can acquire it.
  const finalGapProposal=await api('submit',{intake:changed});assert.equal(finalGapProposal.status,200,finalGapProposal.text);
  await q(`create function u02_close_receipt_barrier() returns trigger language plpgsql as $$
    begin if NEW.action='close.checks_run' then perform pg_advisory_xact_lock(42420002); end if; return NEW; end $$`);
  await q('create trigger u02_close_receipt_barrier after insert on audit_events for each row execute function u02_close_receipt_barrier()');
  await q('select pg_advisory_lock(42420002)');
  let finalGapClose,finalGapOpening;
  try {
    finalGapClose=lockClosePeriodInDb({firmId,clientId,periodStart:'2026-01-01',periodEnd:'2026-01-31',actorId,force:true}).then(value=>({value}),error=>({error}));
    const waitForAdvisory=async minimum=>{
      for(let attempt=0;attempt<200;attempt++) {
        const count=(await q("select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event='advisory'")).rows[0].n;
        if(count>=minimum)return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail(`expected ${minimum} blocked database boundaries`);
    };
    await waitForAdvisory(1);
    finalGapOpening=api('confirm',{ask_id:finalGapProposal.json.ask.id,proposal_digest:finalGapProposal.json.ask.request_payload.ae_opening_balance.proposal_digest});
    await waitForAdvisory(2);
  } finally { await q('select pg_advisory_unlock(42420002)'); }
  const finalGapPosted=await finalGapOpening;assert.equal(finalGapPosted.json.action,'posted',finalGapPosted.text);
  const finalGapRefused=await finalGapClose;assert.equal(finalGapRefused.error?.code,'CLOSE_BOOK_CHANGED_RETRY');
  await q('drop trigger u02_close_receipt_barrier on audit_events');
  await q('drop function u02_close_receipt_barrier()');
  assert.equal((await q('select status from ledger_journals where id=$1',[journal[0].id])).rows[0].status,'posted');
  const closed=await lockClosePeriodInDb({firmId,clientId,periodStart:'2026-01-01',periodEnd:'2026-01-31',actorId,force:true});assert.equal(closed.close_lock.status,'locked');
  const parallelCloses=await Promise.all(Array.from({length:3},()=>lockClosePeriodInDb({firmId,clientId,periodStart:'2026-01-01',periodEnd:'2026-01-31',actorId,force:true})));
  assert.ok(parallelCloses.every(result=>result.close_lock.status==='locked'),'concurrent same-client closes progress with pool size two');
  assert.equal((await q('select status from ledger_journals where id=$1',[journal[0].id])).rows[0].status,'closed');
  const closedLines=JSON.stringify((await q('select * from ledger_lines where journal_id=$1 order by line_no',[journal[0].id])).rows);
  assert.equal((await api('submit',{intake})).json.code,'LEDGER_LOCKED_PERIOD_IMMUTABLE');
  assert.equal(JSON.stringify((await q('select * from ledger_lines where journal_id=$1 order by line_no',[journal[0].id])).rows),closedLines);
  // A forced check refresh must not erase the historical lock authority of
  // an empty period that has never had an opening journal.
  const nextPeriod=await app.api.request({method:'POST',path:`/api/donna/firms/clients/${clientId}/fiscal-periods`,auth:true,body:{firm_id:firmId,starts_on:'2027-01-01',ends_on:'2027-12-31'}});
  assert.equal(nextPeriod.status,201,nextPeriod.text);
  await lockClosePeriodInDb({firmId,clientId,periodStart:'2027-01-01',periodEnd:'2027-01-31',actorId,force:true});
  await runCloseChecksInDb({firmId,clientId,periodStart:'2027-01-01',periodEnd:'2027-01-31',actorId,force:true});
  assert.equal((await api('submit',{intake:{as_of:'2027-01-01'}})).json.code,'LEDGER_LOCKED_PERIOD_IMMUTABLE');

});
