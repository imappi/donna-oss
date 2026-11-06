// AC09 read prerequisite: fully migrated PostgreSQL and the real stock/posting owners.
// Synthetic books only. No movement bridge, historical count apply or close sign-off.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyInventoryOperation, reverseInventoryOperation } from './db.js';
import { valueInventoryOperations } from './valuation.js';
import { buildInventoryJournalDraft } from './posting.js';
import { postInventoryJournalWithinTransaction, reverseInventoryJournalWithinTransaction } from './postingDb.js';
import { runInventoryReconciliationFromDb } from './reconciliationDb.js';

let admin, testUrl, databaseName;
before(async () => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL required for cutoff lifecycle');
  admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
  databaseName = `inventory_cutoff_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create database "${databaseName}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${databaseName}`; testUrl = url.toString();
  const db = new pg.Client({ connectionString: testUrl }); await db.connect();
  try {
    await db.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
    const root = new URL('../../../db/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file, root), 'utf8'));
  } finally { await db.end(); }
});
after(async () => {
  if (admin) { try { if (databaseName) await admin.query(`drop database "${databaseName}"`); } finally { await admin.end(); } }
});
const ok = result => { assert.equal(result.applied, true, JSON.stringify(result)); return result.receipt; };
const fixture = async fn => {
  const db = new pg.Client({ connectionString: testUrl }); await db.connect();
  const prefix = `cutoff-${randomUUID()}`, firmId = `${prefix}-firm`, clientId = `${prefix}-client`;
  const itemId = `${prefix}-item`, locationId = `${prefix}-location`, uomId = `${prefix}-each`;
  const base = { client: db, firmId, clientId, actorId: 'test-owner' };
  let seq = 0;
  try {
    await db.query("insert into firms(id,name,slug) values($1,'Cutoff fixture',$1)", [firmId]);
    await db.query("insert into clients(id,firm_id,company_name) values($1,$2,'Cutoff fixture')", [clientId,firmId]);
    await db.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage) values($1,$2,$3,'INVENTORY_CORE','auto')", [prefix,firmId,clientId]);
    await db.query("insert into inventory_units_of_measure(id,firm_id,client_id,code,name,kind) values($1,$2,$3,'each','Each','unit')", [uomId,firmId,clientId]);
    await db.query("insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values($1,$2,$3,'sku','SKU',$4)", [itemId,firmId,clientId,uomId]);
    await db.query("insert into inventory_locations(id,firm_id,client_id,code,name) values($1,$2,$3,'main','Main')", [locationId,firmId,clientId]);
    const operations = async () => (await db.query('select * from inventory_operations where firm_id=$1 and client_id=$2 order by occurred_at,id', [firmId,clientId])).rows;
    const receipt = async (quantity, occurredAt, cost=10) => {
      const operation = ok(await applyInventoryOperation({ ...base,itemId,locationId,uomId,operationType:'receipt',quantity,
        unitCostAmount:cost,unitCostCurrency:'EUR',occurredAt,idempotencyKey:`${prefix}:${++seq}` }));
      const valuation = ok(valueInventoryOperations({operations:await operations()}));
      const draft = buildInventoryJournalDraft({effect:valuation.operationEffects.find(e=>String(e.operationId)===String(operation.operationId)),
        roleAccounts:{'asset.inventory':{code:'1400',name:'Inventory',type:'asset',normal_balance:'debit'},
          'liability.grni':{code:'2100',name:'GRNI',type:'liability',normal_balance:'credit'}},valuationRunId:valuation.valuationRunId});
      assert.equal(draft.applied,true,JSON.stringify(draft));
      await db.query('begin');
      const posted = await postInventoryJournalWithinTransaction(db,{...base,draft,valuationIdentity:valuation});
      assert.equal(posted.status,'posted',JSON.stringify(posted)); await db.query('commit');
      return {...operation,journalId:posted.ledger_journal_id};
    };
    const read = (cutoff, extra={}) => runInventoryReconciliationFromDb({...base,cutoff,...extra});
    await fn({db,base,firmId,clientId,itemId,locationId,uomId,prefix,receipt,read,operations});
  } finally { await db.query('rollback'); await db.end(); }
};

test('cutoff is inclusive, UTC-based, and excludes later, draft and voided journals; closed books stay included', async()=>fixture(async f=>{
  const boundary=await f.receipt(2,'2026-10-01T23:59:59.999999Z');
  await f.receipt(3,'2026-10-02T00:00:00Z');
  const draft=await f.receipt(5,'2026-10-02T01:00:00Z');
  const voided=await f.receipt(7,'2026-10-02T02:00:00Z');
  await f.db.query("update ledger_journals set status='closed' where id=$1",[boundary.journalId]);
  await f.db.query("update ledger_journals set status='draft',journal_date='2026-10-01' where id=$1",[draft.journalId]);
  await f.db.query("update ledger_journals set status='voided',journal_date='2026-10-01' where id=$1",[voided.journalId]);
  const out=await f.read('2026-10-01',{subledger:{inventoryValue:170,operationEffects:[]}});
  assert.equal(out.state.inventoryToGl.glInventoryGross,20); assert.equal(out.state.inventoryToGl.subledgerValue,20);
  assert.equal(out.verdict.tied,true,JSON.stringify(out));
  const subledger=ok(valueInventoryOperations({operations:await f.operations()}));
  const current=await runInventoryReconciliationFromDb({...f.base,subledger});
  assert.equal(current.state.inventoryToGl.glInventoryGross,50);
  assert.equal(current.verdict.tied,false,'unposted later stock is a real current desync');
}));

test('later reversal does not erase the original; backdated receipt and reversal change the rebuilt cutoff basis', async()=>fixture(async f=>{
  const original=await f.receipt(2,'2026-09-30T23:00:00Z');
  const before=await f.read('2026-10-01'); assert.equal(before.verdict.tied,true);
  ok(await reverseInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,reversesOperationId:original.operationId,occurredAt:'2026-10-02T00:00:00Z',idempotencyKey:`${f.prefix}:reverse`}));
  await f.db.query('begin');
  const reversal=await reverseInventoryJournalWithinTransaction(f.db,{...f.base,targetJournalId:original.journalId,reversalDate:'2026-10-02',reason:'Synthetic rescinded receipt'});
  await f.db.query('commit');
  const after=await f.read('2026-10-01');
  assert.equal(after.verdict.tied,true); assert.equal(after.state.inventoryToGl.glInventoryGross,20);
  assert.equal(after.state.basis.scopes[0].inputHash,before.state.basis.scopes[0].inputHash);
  const next=await f.read('2026-10-02'); assert.equal(next.verdict.tied,true); assert.equal(next.state.inventoryToGl.subledgerValue,0);
  await f.receipt(3,'2026-10-01T00:00:00Z');
  const backdated=await f.read('2026-10-01');
  assert.equal(backdated.verdict.tied,true); assert.equal(backdated.state.inventoryToGl.subledgerValue,50);
  assert.notEqual(backdated.state.basis.scopes[0].inputHash,before.state.basis.scopes[0].inputHash);
  // Fixture represents an already persisted backdated reversal; reader must not cache the old cutoff.
  await f.db.query("update inventory_operations set occurred_at='2026-10-01T22:00:00Z' where reverses_operation_id=$1",[original.operationId]);
  await f.db.query("update ledger_journals set journal_date='2026-10-01' where id=$1",[reversal.reversal_journal_id]);
  const revised=await f.read('2026-10-01');
  assert.equal(revised.verdict.tied,true); assert.equal(revised.state.inventoryToGl.subledgerValue,30);
  assert.notEqual(revised.state.basis.scopes[0].inputHash,backdated.state.basis.scopes[0].inputHash);
}));

test('whole-client valuation folds scopes independently and uses server cost facts',async()=>fixture(async f=>{
  await f.receipt(2,'2026-10-01T10:00:00Z');
  const loc2=`${f.prefix}-other-location`;
  await f.db.query("insert into inventory_locations(id,firm_id,client_id,code,name) values($1,$2,$3,'other','Other')",[loc2,f.firmId,f.clientId]);
  ok(await applyInventoryOperation({...f.base,itemId:f.itemId,locationId:loc2,uomId:f.uomId,operationType:'receipt',quantity:3,unitCostAmount:7,unitCostCurrency:'EUR',occurredAt:'2026-10-01T11:00:00Z',idempotencyKey:`${f.prefix}:other`}));
  const out=await f.read('2026-10-01',{subledger:{inventoryValue:20,operationEffects:[]}});
  assert.equal(out.state.inventoryToGl.subledgerValue,41); assert.equal(out.state.basis.scopes.length,2);
  assert.equal(out.verdict.engines.inventory_to_gl.status,'breach','caller cannot hide the unposted scope');
}));

test('historical allowance history is unavailable even after consumption; current allowance reads remain usable',async()=>fixture(async f=>{
  await f.receipt(2,'2026-10-01T10:00:00Z');
  await f.db.query(`insert into inventory_valuation_allowances(firm_id,client_id,scope_item_id,valuation_date,allowance_amount,currency,max_reversible_amount,consumed_amount,status,reviewer)
    values($1,$2,$3,'2026-10-01',5,'EUR',5,5,'released','test-reviewer')`,[f.firmId,f.clientId,f.itemId]);
  const out=await f.read('2026-10-01');
  assert.equal(out.verdict.tied,false); assert.equal(out.verdict.engines.inventory_to_gl.status,'unavailable');
  assert.equal(out.verdict.engines.allowance_integrity.waiter.reason,'historical_allowance_history_unavailable');
  assert.equal(out.state.allowance.lots.length,0,'no current remaining balance enters historical engine');
  const current=await runInventoryReconciliationFromDb({...f.base,subledger:ok(valueInventoryOperations({operations:await f.operations()}))});
  assert.equal(current.verdict.tied,true); assert.equal(current.state.allowance.lots.length,1);
}));

test('schema absence and missing current cost facts never become tied; reader preserves caller transaction',async()=>fixture(async f=>{
  assert.equal((await f.read('2026-10-01')).verdict.tied,true,'fully evidenced empty book');
  for (const sql of ['alter table inventory_posting_journals rename column ledger_journal_id to missing_column',
    'alter table inventory_posting_attempts rename column operation_id to missing_column']) {
    await f.db.query('begin'); await f.db.query(sql);
    const missing=await f.read('2026-10-01');
    assert.equal(missing.verdict.tied,false); assert.equal(missing.state.availability.reason,'reconciliation_schema_unavailable');
    assert.equal((await f.db.query('select 1 as healthy')).rows[0].healthy,1);
    await f.db.query('rollback');
  }
  ok(await applyInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,operationType:'receipt',quantity:2,occurredAt:'2026-10-01T10:00:00Z',idempotencyKey:`${f.prefix}:unpriced`}));
  const unpriced=await f.read('2026-10-01');
  assert.equal(unpriced.verdict.tied,false); assert.equal(unpriced.state.availability.reason,'cutoff_valuation_unavailable');
}));

test('wrong firm is unavailable, another tenant stays isolated, malformed cross-tenant account/link references refuse',async()=>fixture(async f=>fixture(async other=>{
  const a=await f.receipt(2,'2026-10-01T10:00:00Z');
  const b=await other.receipt(9,'2026-10-01T10:00:00Z');
  assert.equal((await f.read('2026-10-01')).state.inventoryToGl.glInventoryGross,20);
  assert.equal((await other.read('2026-10-01')).state.inventoryToGl.glInventoryGross,90);
  const wrong=await f.read('2026-10-01',{firmId:other.firmId});
  assert.equal(wrong.verdict.tied,false); assert.equal(wrong.state.availability.reason,'reconciliation_scope_unavailable');
  const account=(await other.db.query("select id from ledger_accounts where firm_id=$1 and canonical_role='asset.inventory'",[other.firmId])).rows[0].id;
  await f.db.query('begin');
  await f.db.query('update ledger_lines set account_id=$1 where journal_id=$2',[account,a.journalId]);
  assert.equal((await f.read('2026-10-01')).state.availability.reason,'reconciliation_source_scope_invalid');
  await f.db.query('rollback');
  await f.db.query('begin');
  await f.db.query('update inventory_posting_journals set ledger_journal_id=$1 where ledger_journal_id=$2',[b.journalId,a.journalId]);
  assert.equal((await f.read('2026-10-01')).state.availability.reason,'reconciliation_source_scope_invalid');
  await f.db.query('rollback');
  assert.equal((await f.read('2026-10-01')).verdict.tied,true);
})));


test('missing required posting facts and unmatched ledger currency cannot certify a cutoff',async()=>fixture(async f=>{
  const receipt=await f.receipt(2,'2026-10-01T10:00:00Z');
  await f.db.query('begin');
  await f.db.query("update ledger_lines set currency='GBP' where journal_id=$1",[receipt.journalId]);
  const ccy=await f.read('2026-10-01');
  assert.equal(ccy.verdict.tied,false); assert.equal(ccy.state.availability.reason,'cutoff_valuation_currency_unavailable');
  await f.db.query('rollback');
  await f.db.query('begin');
  await f.db.query('delete from ledger_lines where journal_id=$1',[receipt.journalId]);
  const absent=await f.read('2026-10-01');
  assert.equal(absent.verdict.tied,false); assert.equal(absent.state.availability.reason,'reconciliation_source_scope_invalid');
  await f.db.query('rollback');
  assert.equal((await f.read('2026-10-01')).verdict.tied,true);
}));


test('database session timezone and DST fallback cannot reorder operations or change cutoff identities',async()=>fixture(async f=>{
  const original=await f.receipt(2,'2026-10-25T00:55:00Z');
  ok(await reverseInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,reversesOperationId:original.operationId,
    occurredAt:'2026-10-25T01:05:00Z',idempotencyKey:`${f.prefix}:dst-reverse`}));
  await f.db.query('begin');
  await reverseInventoryJournalWithinTransaction(f.db,{...f.base,targetJournalId:original.journalId,reversalDate:'2026-10-25',reason:'Synthetic DST reversal'});
  await f.db.query('commit');
  let identity;
  for (const timezone of ['UTC','Asia/Dubai','Europe/Madrid','America/New_York']) {
    await f.db.query("select set_config('TimeZone',$1,false)",[timezone]);
    const out=await f.read('2026-10-25');
    assert.equal(out.verdict.tied,true,JSON.stringify(out));
    assert.equal(out.state.inventoryToGl.subledgerValue,0);
    if (identity) assert.deepEqual(out.state.basis,identity);
    identity=out.state.basis;
  }
}));


test('a net-zero receipt/reversal cannot conceal missing inventory journal links',async()=>fixture(async f=>{
  const original=await f.receipt(2,'2026-10-01T10:00:00Z');
  ok(await reverseInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,reversesOperationId:original.operationId,
    occurredAt:'2026-10-01T11:00:00Z',idempotencyKey:`${f.prefix}:link-reverse`}));
  await f.db.query('begin');
  await reverseInventoryJournalWithinTransaction(f.db,{...f.base,targetJournalId:original.journalId,reversalDate:'2026-10-01',reason:'Synthetic net-zero receipt'});
  await f.db.query('commit');
  assert.equal((await f.read('2026-10-01')).verdict.tied,true);
  await f.db.query('begin');
  await f.db.query('delete from inventory_posting_journals where firm_id=$1 and client_id=$2',[f.firmId,f.clientId]);
  const out=await f.read('2026-10-01');
  assert.equal(out.verdict.tied,false); assert.equal(out.state.availability.reason,'reconciliation_source_scope_invalid');
  await f.db.query('rollback');
}));

test('GRNI compares the whole scoped GL against inventory accruals, including manual journals',async()=>fixture(async f=>{
  await f.receipt(2,'2026-10-01T10:00:00Z');
  const account=(await f.db.query("select id from ledger_accounts where firm_id=$1 and canonical_role='liability.grni'",[f.firmId])).rows[0].id;
  await f.db.query(`insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status)
    values($1,$2,$3,'manual','grni-fixture','2026-10-01','EUR','posted')`,[`${f.prefix}-manual`,f.firmId,f.clientId]);
  await f.db.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,line_no,direction,debit,credit,amount,currency)
    values($1,$2,$3,$4,$5,1,'credit',0,5,5,'EUR')`,[`${f.prefix}-manual-line`,`${f.prefix}-manual`,f.firmId,f.clientId,account]);
  const out=await f.read('2026-10-01');
  assert.equal(out.verdict.tied,false);
  assert.equal(out.state.grni.byCurrency[0].glGrni,25); assert.equal(out.state.grni.byCurrency[0].accruedReceipts,20);
  assert.equal(out.verdict.engines.grni_to_open_receipts.status,'breach');
}));


test('a posted primary stock identity missing from the cutoff stream is unavailable even when another scope still ties',async()=>fixture(async f=>{
  await f.receipt(2,'2026-10-01T10:00:00Z');
  const extra=await f.receipt(3,'2026-10-01T11:00:00Z');
  await f.db.query('begin');
  // Existing writer stamps a physical kernel ID in the primary receipt journal.
  // Changing its effective time simulates a legacy journal/stock cutoff conflict.
  await f.db.query("update inventory_operations set occurred_at='2026-10-02T00:00:00Z' where id=$1",[extra.operationId]);
  const out=await f.read('2026-10-01');
  assert.equal(out.verdict.tied,false); assert.equal(out.state.availability.reason,'cutoff_operation_basis_unavailable');
  await f.db.query('rollback');
  assert.equal((await f.read('2026-10-01')).verdict.tied,true);
}));

test('zero-cost shipment keeps historical revenue linkage unavailable instead of treating zero as evidence',async()=>fixture(async f=>{
  ok(await applyInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,operationType:'receipt',quantity:2,
    unitCostAmount:0,unitCostCurrency:'EUR',occurredAt:'2026-10-01T10:00:00Z',idempotencyKey:`${f.prefix}:zero-receipt`}));
  ok(await applyInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,operationType:'shipment',quantity:1,
    occurredAt:'2026-10-01T11:00:00Z',idempotencyKey:`${f.prefix}:zero-sale`}));
  const out=await f.read('2026-10-01');
  assert.equal(out.verdict.engines.inventory_to_gl.status,'tied');
  assert.equal(out.verdict.engines.cogs_revenue_orphans.status,'unavailable');
  assert.equal(out.verdict.engines.cogs_revenue_orphans.waiter.reason,'historical_revenue_basis_unavailable');
  assert.equal(out.verdict.tied,false);
}));

test('offsetting unposted physical movements remain unavailable even beside a complete posted reversal',async()=>fixture(async f=>{
  const missing=ok(await applyInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,
    operationType:'receipt',quantity:2,unitCostAmount:10,unitCostCurrency:'EUR',occurredAt:'2026-10-01T10:00:00Z',idempotencyKey:`${f.prefix}:missing-receipt`}));
  const missingReversal=ok(await reverseInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,
    reversesOperationId:missing.operationId,occurredAt:'2026-10-01T11:00:00Z',idempotencyKey:`${f.prefix}:missing-reversal`}));
  const assertIncomplete=async()=>{
    const out=await f.read('2026-10-01');
    assert.equal(out.state.inventoryToGl.subledgerValue,0); assert.equal(out.state.inventoryToGl.glInventoryGross,0);
    assert.equal(out.verdict.tied,false,'offsetting absent journals are not an evidenced empty book');
    assert.equal(out.verdict.engines.conservation.waiter.reason,'historical_posting_disposition_unavailable');
    assert.deepEqual(out.state.basis.postingCompleteness.unsupportedOperationIds,[String(missing.operationId),String(missingReversal.operationId)]);
  };
  await assertIncomplete();
  assert.equal((await f.db.query('select count(*) from inventory_posting_attempts where firm_id=$1',[f.firmId])).rows[0].count,'0');
  // A different legitimate receipt/reversal has its own complete lineage; its
  // two zero-net journals cannot stand in for the missing pair.
  const posted=await f.receipt(2,'2026-10-01T12:00:00Z');
  ok(await reverseInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,
    reversesOperationId:posted.operationId,occurredAt:'2026-10-01T13:00:00Z',idempotencyKey:`${f.prefix}:complete-reversal`}));
  await f.db.query('begin');
  await reverseInventoryJournalWithinTransaction(f.db,{...f.base,targetJournalId:posted.journalId,reversalDate:'2026-10-01',reason:'Synthetic completed neighboring reversal'});
  await f.db.query('commit');
  await assertIncomplete();
}));

test('per-operation posting amounts cannot offset across changed cost bases',async()=>fixture(async f=>{
  const first=await f.receipt(1,'2026-10-01T10:00:00Z',10);
  const second=await f.receipt(1,'2026-10-01T11:00:00Z',10);
  assert.equal((await f.read('2026-10-01')).verdict.tied,true);
  await f.db.query('begin');
  // Legacy changed facts keep aggregate inventory/GRNI at20; neither posted
  // journal now carries the amount of its own source operation.
  await f.db.query('update inventory_operations set unit_cost_amount=12 where id=$1',[first.operationId]);
  await f.db.query('update inventory_operations set unit_cost_amount=8 where id=$1',[second.operationId]);
  const out=await f.read('2026-10-01');
  assert.equal(out.state.inventoryToGl.glInventoryGross,20); assert.equal(out.state.inventoryToGl.subledgerValue,20);
  assert.equal(out.verdict.tied,false);
  assert.equal(out.verdict.engines.conservation.waiter.reason,'historical_posting_disposition_unavailable');
  await f.db.query('rollback');
}));

test('zero-value no-journal disposition and an evidenced empty scope still tie',async()=>fixture(async f=>{
  assert.equal((await f.read('2026-10-01')).verdict.tied,true);
  const operation=ok(await applyInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,
    operationType:'receipt',quantity:2,unitCostAmount:0,unitCostCurrency:'EUR',occurredAt:'2026-10-01T10:00:00Z',idempotencyKey:`${f.prefix}:free-receipt`}));
  const valuation=ok(valueInventoryOperations({operations:await f.operations()}));
  const effect=valuation.operationEffects.find(e=>String(e.operationId)===String(operation.operationId));
  const draft=buildInventoryJournalDraft({effect:{...effect,posting:'no_journal_required'},valuationRunId:valuation.valuationRunId});
  assert.equal(draft.applied,true);
  await f.db.query('begin');
  const disposition=await postInventoryJournalWithinTransaction(f.db,{...f.base,draft,valuationIdentity:valuation});
  await f.db.query('commit');
  assert.equal(disposition.outcome,'no_journal_required');
  const out=await f.read('2026-10-01');
  assert.equal(out.verdict.tied,true,JSON.stringify(out));
  assert.equal(out.state.basis.postingCompleteness.status,'complete');
}));


test('a posted receipt and reversal cannot conceal a later zero cost basis',async()=>fixture(async f=>{
  const original=await f.receipt(2,'2026-10-01T10:00:00Z');
  const reverse=ok(await reverseInventoryOperation({...f.base,itemId:f.itemId,locationId:f.locationId,uomId:f.uomId,
    reversesOperationId:original.operationId,occurredAt:'2026-10-01T11:00:00Z',idempotencyKey:`${f.prefix}:zero-cost-reverse`}));
  await f.db.query('begin');
  await reverseInventoryJournalWithinTransaction(f.db,{...f.base,targetJournalId:original.journalId,reversalDate:'2026-10-01',reason:'Synthetic zero-cost regression'});
  await f.db.query('commit');
  assert.equal((await f.read('2026-10-01')).verdict.tied,true);
  await f.db.query('begin');
  await f.db.query('update inventory_operations set unit_cost_amount=0 where id=$1',[original.operationId]);
  const out=await f.read('2026-10-01');
  assert.equal(out.state.inventoryToGl.subledgerValue,0);
  assert.equal(out.state.inventoryToGl.glInventoryGross,0);
  assert.equal(out.verdict.tied,false);
  assert.equal(out.verdict.engines.conservation.waiter.reason,'historical_posting_disposition_unavailable');
  assert.deepEqual(new Set(out.state.basis.postingCompleteness.unsupportedOperationIds),new Set([String(original.operationId),String(reverse.operationId)]));
  await f.db.query('rollback');
  assert.equal((await f.read('2026-10-01')).verdict.tied,true);
}));
