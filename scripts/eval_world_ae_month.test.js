import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compareAeMonthEconomics, runAeMonthRehearsal } from './eval_world_ae_month.js';
import { MONTH_SOURCES, monthBankBytes, monthInvoiceBytes, monthBankDispositionFixture } from './eval_world_ae_month_sources.js';
import { validateDispositionRawOutput } from '../server/donna/bankLineDispositionGoldSet.js';
import { PDFDocument } from 'pdf-lib';

test('synthetic bank disposition obeys each real direction schema',()=>{
  for(const [label,direction] of [['DEBIT','money_out'],['CREDIT','money_in']]){
    const fixture=monthBankDispositionFixture({system:`You triage a single unmatched bank ${label} fixture`});
    assert.deepEqual(validateDispositionRawOutput(JSON.parse(fixture.body.content[0].text),direction),[]);
  }
  assert.throws(()=>monthBankDispositionFixture({system:'unknown direction'}));
});

test('AE month refuses missing isolated PostgreSQL before executing',async()=>{
  await assert.rejects(()=>runAeMonthRehearsal({runToken:'no-db'}),{code:'AE7_DISPOSABLE_POSTGRES_REQUIRED'});
});
test('AE month source economics balance independently and render three distinct raw invoices',async()=>{
  assert.equal(MONTH_SOURCES.reduce((sum,s)=>sum+(s.type==='sales_invoice'?s.total:-s.total),10000),10735);
  assert.equal(MONTH_SOURCES.reduce((sum,s)=>sum+(s.type==='sales_invoice'?s.vat:-s.vat),0),35);
  assert.equal(monthBankBytes().toString().trim().split('\n').length,4);
  for(const source of MONTH_SOURCES)assert.equal((await PDFDocument.load(await monthInvoiceBytes(source))).getPageCount(),1);
  const worker=await readFile(new URL('./eval_world_ae_month_worker.js',import.meta.url),'utf8');
  assert.ok(!worker.includes('AE_MONTH_EXPECTED'),'solver worker does not receive expected books');
  assert.ok(!worker.includes('syncDocumentsAndTransactionsInDb'),'raw pipeline cannot be replaced by verdict seeds');
});
test('AE month economic certificate refuses empty or partially balanced books',()=>{
  const empty=compareAeMonthEconomics({financialReport:{trial_balance:{total_debit:0,total_credit:0,balanced:true}}});
  assert.equal(empty.status,'INCOMPLETE');
  assert.equal(empty.checks.find(c=>c.name==='bank').pass,false);
  assert.equal(empty.checks.find(c=>c.name==='vat_net').pass,false);
});
