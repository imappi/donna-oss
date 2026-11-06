import assert from 'node:assert/strict';
import test from 'node:test';
import { runAeMonthRehearsal, certifyAeMonthReceipt } from './eval_world_ae_month.js';

const assertLateSourceSequence=order=>{
  if(order.order!=='late_document')return;
  const before=order.operations.filter(operation=>['schedule_before_late_document','before_late_document'].includes(operation.name));
  assert.ok(before.flatMap(operation=>operation.result.jobs).some(job=>job.function_id==='parse-cron:coding_convergence'&&job.status==='succeeded'));
  assert.equal(order.providerCalls.filter(call=>call.lane==='transaction_coding').length,3,'bank, partial sources, and complete sources each receive one coding');
};


test('real PG: AE month raw admission, opening reply, both source orders and late document reach actual production VAT gate',async()=>{
  assert.ok(process.env.DONNA_PG_TEST_URL,'INCOMPLETE: disposable PostgreSQL is required.');
  const receipt=await runAeMonthRehearsal({postgresUrl:process.env.DONNA_PG_TEST_URL,runToken:`ae-month-${process.pid}`,continuation:false});
  assert.equal(receipt.ae7Status,'INCOMPLETE');
  for(const order of receipt.orders){
    assertLateSourceSequence(order);
    assert.equal(order.retirement?.residue_verified,true,JSON.stringify(order.blockers));
    assert.equal(order.residue?.residue_rows,0);assert.equal(order.blobResidue,0);
    assert.equal(order.unscripted.length,0,JSON.stringify(order.unscripted));
    assert.equal(order.lastObservation.documents.length,5,JSON.stringify(order.blockers));
    assert.ok(order.lastObservation.documents.every(d=>d.parse_status==='completed'));
    assert.equal(order.lastObservation.transactions.length,3);
    assert.equal(order.matches.filter(m=>m.status==='auto_matched').length,3);
    assert.ok(order.lastObservation.asks.some(ask=>ask.status==='resolved'&&ask.question.includes('complete AED trial balance')));
    assert.equal(order.lastObservation.journalCount.count,1,'dark automation must not manufacture native VAT facts');
    assert.ok(order.blockers.some(b=>b.code==='TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'),JSON.stringify(order.blockers));
  }
});

test('real PG: unanswered business use refuses close and custody export remains explicitly provisional',async()=>{
  assert.ok(process.env.DONNA_PG_TEST_URL,'INCOMPLETE: disposable PostgreSQL is required.');
  const receipt=await runAeMonthRehearsal({postgresUrl:process.env.DONNA_PG_TEST_URL,runToken:`ae-month-held-${process.pid}`,
    orders:['document_first'],continuation:true,withholdOwnerAnswer:true});
  const order=receipt.orders[0];
  assert.equal(receipt.status,'INCOMPLETE');assert.equal(receipt.ae7Status,'INCOMPLETE');
  assert.deepEqual(order.blockers.map(b=>b.code),['AE_MONTH_OWNER_FACT_PENDING']);
  assert.equal(order.financialReport.draft.is_draft,true);
  assert.equal(order.lastObservation.journalCount.count,3,'opening and two complete sources only');
  assert.equal(order.preContinuationSources.asks.filter(a=>a.evidence_type==='ae_vat_business_use'&&['open','draft','replied'].includes(a.status)).length,1);
  assert.equal(order.closeCrashResume,undefined);assert.equal(order.deliveryArtifact,undefined);
  assert.equal(order.withheldAttempts.close.accepted,false,JSON.stringify(order.withheldAttempts.close));
  assert.equal(order.withheldAttempts.close.code,'CLOSE_PERIOD_NOT_LOCKABLE');
  assert.equal(order.withheldAttempts.archive.accepted,true);
  assert.equal(order.withheldAttempts.export.accepted,true);
  const provisional=order.withheldAttempts.export.result;
  assert.equal(provisional.files['period.json'].close_status,'blocked');
  assert.equal(provisional.files['period.json'].lockable,false);
  assert.equal(provisional.files['period.json'].locked_at,null);
  assert.ok(JSON.stringify(provisional.files).includes('PALM-0921'),'pending source identity remains in evidence custody');
  assert.ok(JSON.stringify(provisional.files).includes(order.blockers[0].askId),'unanswered ask identity remains in evidence custody');
  assert.ok(provisional.files['close.json'].checks.some(check=>check.check_type==='posting_completeness'&&check.status==='blocked'));
  assert.equal(certifyAeMonthReceipt({...order,deliveryArtifact:provisional}).status,'INCOMPLETE','custody export cannot certify final books');
  assert.equal(order.retirement.residue_verified,true);assert.equal(order.residue.residue_rows,0);assert.equal(order.blobResidue,0);
  assert.equal(order.unscripted.length,0);
});


test('real PG: all three source orders close with independent economics and production observer agreement',async()=>{
  assert.ok(process.env.DONNA_PG_TEST_URL,'INCOMPLETE: disposable PostgreSQL is required.');
  const receipt=await runAeMonthRehearsal({postgresUrl:process.env.DONNA_PG_TEST_URL,runToken:`ae-month-final-${process.pid}`});
  assert.equal(receipt.ae7Status,'INCOMPLETE','one month cannot graduate the original six-world gate');
  for(const order of receipt.orders){
    assert.equal(order.certificate.status,'PASS',JSON.stringify({order:order.order,blockers:order.blockers,checks:order.certificate.checks,economics:order.economics}));
    assertLateSourceSequence(order);
  }
  assert.equal(receipt.status,'PASS');
  const changed=structuredClone(receipt.orders[0]);
  [changed.matches[0].matched_object_id,changed.matches[1].matched_object_id]=[changed.matches[1].matched_object_id,changed.matches[0].matched_object_id];
  assert.equal(certifyAeMonthReceipt(changed).status,'INCOMPLETE','balanced books cannot excuse the wrong source pairing');
  const wrongProfit=structuredClone(receipt.orders[0]);wrongProfit.financialReport.profit_and_loss.net_income+=1;
  assert.equal(certifyAeMonthReceipt(wrongProfit).status,'INCOMPLETE','locked production state cannot excuse incorrect economics');
});
