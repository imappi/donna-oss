import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { bootApplianceForTest } from './testSupport/applianceHarness.js';
import { syncDocumentsAndTransactionsInDb, withFirmDbClient } from './firmDb.js';
import { setClientFlagStage } from './clientConfig.js';
import { recordAeVatPeriod } from './ae/vatPeriods.js';
import { prepareAeVatReturnFromDb } from './ae/vatReturnRoute.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';

test('U08-S2 actual admitted AE client: setup existing name-only chart → invoice facts → native journal → VAT201',async t=>{
  assert.ok(process.env.DONNA_PG_TEST_URL,'INCOMPLETE: disposable PostgreSQL is required.');
  const app=await bootApplianceForTest({runToken:`u08-admitted-${process.pid}-${Date.now()}`,firm:{jurisdiction:'AE',currency:'AED'}});
  t.after(()=>app.stop());
  const firmId=app.firmId,actorId=app.memberId,q=app.query;
  const registration={status:'registered',registered_from:'2026-01-01',vat_registration_number:'100123456789012'};
  const {clientId}=await app.createClient({profile:{companyName:'Native VAT fixture LLC',jurisdiction:'AE',entityType:'ae-llc',
    incorporationDate:'2020-01-01',currency:'AED',accounting_view:'management_books',accountingBasis:'cash',
    vat_registration:registration,ae_establishment:{emirate:'DXB',qualifying_ecommerce_registrant:false}}});
  const ready=async()=> (await q('select state from entity_readiness_sagas where firm_id=$1 and client_id=$2',[firmId,clientId])).rows[0].state;
  assert.equal(await ready(),'ready');
  for(const flagKey of ['AE_OPENING_BALANCES','FISCAL_PERIOD_INTAKE'])await withFirmDbClient(client=>setClientFlagStage(client,
    {firmId,clientId,flagKey,stage:'auto',source:'manual',reason:'Synthetic native VAT integration setup',actorType:'firm_member',actorId}));
  const period=await app.api.request({method:'POST',path:`/api/donna/firms/clients/${clientId}/fiscal-periods`,auth:true,
    body:{firm_id:firmId,starts_on:'2026-01-01',ends_on:'2026-12-31'}});
  assert.equal(period.status,201,period.text);
  const chart=async()=>(await q('select * from ledger_accounts where firm_id=$1 and client_id=$2 order by id',[firmId,clientId])).rows;
  const selected={};
  for(const [key,role,code,name] of [['bank','asset.cash','BANK','Business Checking'],['sales','revenue.operating','SALES','Operating revenue'],
    ['cost','expense.operating_supplies','COST','Operating supplies'],['vat','liability.sales_tax_payable','VAT','VAT control']]){
    const existing=(await chart()).find(a=>a.canonical_role===role&&a.status==='active');
    const setup=await app.api.request({method:'POST',path:`/api/donna/firms/clients/${clientId}/ae-opening-balances`,auth:true,
      body:{firm_id:firmId,action:'setup_account',intake:{as_of:'2026-01-01',account:existing?{account_id:existing.id,currency:'AED'}:{code,name,canonical_role:role,currency:'AED'}}}});
    assert.equal(setup.status,200,setup.text);assert.equal(setup.json.readiness,'ready',JSON.stringify((await q('select * from entity_readiness_sagas where firm_id=$1 and client_id=$2',[firmId,clientId])).rows));
    selected[key]=(await chart()).find(a=>a.id===setup.json.account_id);assert.ok(selected[key]);
    if(existing)assert.equal(selected[key].code,existing.code,'currency confirmation must preserve seeded identity');
  }
  assert.equal(await ready(),'ready');
  assert.equal((await q('select count(*)::int n from ledger_journals where client_id=$1',[clientId])).rows[0].n,0);
  assert.ok(Object.values(selected).some(a=>!a.code),'exercise real name-only seed accounts');
  for(const [suffix,out] of [['sale',false],['purchase',true]]){
    const id=`${clientId}-${suffix}`;
    const pdf=await PDFDocument.create();const page=pdf.addPage();
    page.drawText(`Synthetic ${suffix} tax invoice - 9 September 2026`,{x:40,y:740,size:14});
    page.drawText('Net AED100.00 / VAT 5% AED5.00 / Total AED105.00',{x:40,y:710,size:12});
    const upload=await app.uploadDocument({clientId,bytes:Buffer.from(await pdf.save()),
      filename:`${suffix}-invoice.pdf`,mimeType:'application/pdf',documentType:out?'supplier_bill':'sales_invoice'});
    const target=selected[out?'cost':'sales'];
    await syncDocumentsAndTransactionsInDb({firmId,documents:[{id:upload.documentId,client_id:clientId,document_type:out?'supplier_bill':'sales_invoice',
      document_date:'2026-09-09',currency:'AED',total_amount:105,tax_amount:5,parse_status:'completed'}],transactions:[{id,client_id:clientId,
      date:'2026-09-09',description:`Synthetic ${suffix}`,money_in:out?0:105,money_out:out?105:0,currency:'AED',coding_state:'applied',status:'needs_review',
      ai_suggestion:{proposed_account:target.name,account_code:target.code||target.name,tax_treatment:'VAT 5% (standard rated)',confidence:'high',
        coding_policy:codingPolicyReceipt(resolveCodingPolicy({jurisdiction:'AE',entityType:'ae-llc',businessDate:'2026-09-09',accountingSystem:'none'}))}}]});
    await q(`insert into transaction_review_queue(id,firm_id,client_id,item_type,item_id,reason,status,payload)
      values($1,$2,$3,'transaction',$4,'synthetic retained invoice','open',$5)`,[`review-${id}`,firmId,clientId,id,{transaction_id:id}]);
    const facts={document_id:upload.documentId,explanation:'Synthetic retained ordinary domestic tax invoice and explicit full business-use declaration.',
      supply_class:'ordinary_domestic',payment_method:'bank_transfer',fully_paid:true,invoice_validity:'confirmed',direction:out?'in':'out',
      date_of_supply:'2026-09-09',reporting_date:'2026-09-09',taxable_amount:'100.00',vat_amount:'5.00',
      ...(out?{input_recovery:{basis:'direct_taxable',recovery_bps:10000,blocked:false,personal_use:false,supply_integrity:'verified',verification_evidence:'Synthetic supplier/supply verification.'}}:{})};
    const accepted=await app.api.request({method:'PATCH',path:`/api/donna/firms/transaction-review/review-${id}`,auth:true,
      body:{firm_id:firmId,patch:{status:'resolved',review_state:'accepted',proposed_account:target.name,account_name:target.name,account_code:target.code||target.name,tax_treatment:'VAT 5% (standard rated)',tax_posting_facts:facts}}});
    assert.equal(accepted.status,200,accepted.text);
    await q("update firm_members set role='viewer' where id=$1",[actorId]);
    const denied=await app.api.request({method:'POST',path:'/api/donna/firms/ledger/post-transaction',auth:true,body:{firm_id:firmId,client_id:clientId,transaction_id:id,dry_run:false}});
    assert.equal(denied.status,403,denied.text);
    assert.equal((await q('select count(*)::int n from ledger_journals where source_id=$1',[id])).rows[0].n,0);
    await q("update firm_members set role='owner' where id=$1",[actorId]);
    for(const dry_run of [true,false]){
      const posted=await app.api.request({method:'POST',path:'/api/donna/firms/ledger/post-transaction',auth:true,
        body:{firm_id:firmId,client_id:clientId,transaction_id:id,dry_run}});
      assert.equal(posted.status,200,posted.text+' '+JSON.stringify({selected:target}));
    }
    const journal=(await q('select * from ledger_journals where firm_id=$1 and client_id=$2 and source_id=$3',[firmId,clientId,id])).rows[0];
    assert.equal(journal.payload.tax_point.actor_id,actorId);
    const audit=(await q("select actor_id from audit_events where client_id=$1 and action='ledger.post_transaction' and resource_id=$2 order by id desc limit 1",[clientId,id])).rows[0];
    assert.equal(audit?.actor_id,actorId);
    const lines=(await q('select * from ledger_lines where journal_id=$1 order by line_no',[journal.id])).rows;
    assert.equal(lines.length,3);
    assert.equal(lines.find(l=>l.account_id===target.id)[out?'debit':'credit'], '100.00');
    assert.equal(Number(lines.find(l=>l.account_id===selected.vat.id)[out?'debit':'credit']),5);
  }
  await withFirmDbClient(client=>recordAeVatPeriod({client,firmId,clientId,registration,periodKey:'2026-Q3',startDate:'2026-07-01',
    endDate:'2026-09-30',dueDate:'2026-10-28',recordedBy:actorId,source:'Synthetic assigned period'}));
  const result=await prepareAeVatReturnFromDb({firmId,clientId,periodKey:'2026-Q3'});
  assert.deepEqual(result.vatReturn.fields.standard_rated_supplies.total,{amount:100,vat:5});
  assert.deepEqual(result.vatReturn.fields.standard_rated_expenses,{amount:100,recoverable_vat:5});
  assert.equal(result.vatReturn.netVat,0);assert.equal(await ready(),'ready');
});
