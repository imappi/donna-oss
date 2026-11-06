// P0: actual PostgreSQL rows, constraints, atomicity and competing connections.
// Uses DONNA_PG_TEST_URL to own a disposable fully migrated database. Audit
// history stays append-only; teardown drops only this test-owned database.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  applyInventoryOperation, applyInventoryOperationWithinTransaction,
  seedOpeningInventory, reverseInventoryOperation, rebuildInventoryProjectionFromDb,
  createPurchaseOrder, placePurchaseOrder, receivePurchaseOrderLine,
  createSalesOrder, reserveSalesOrderLine, allocateSalesOrderLine, shipSalesOrderLine,
  expireStaleReservations, openInventoryCountSession, closeInventoryCountSession,
  closeInventoryCountSessionWithinTransaction
} from './db.js';
import { valueInventoryOperations } from './valuation.js';
import { buildInventoryJournalDraft } from './posting.js';
import { postInventoryJournalWithinTransaction, reverseInventoryJournalWithinTransaction } from './postingDb.js';
const opts = {};
let testUrl, admin, databaseName;
before(async () => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: DONNA_PG_TEST_URL is required for P0 real PostgreSQL lifecycle');
  admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
  databaseName = `inventory_p0_${randomUUID().replaceAll('-', '')}`;
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
  if (admin) { try { if (databaseName) await admin.query(`drop database if exists "${databaseName}" with (force)`); } finally { await admin.end(); } }
});
const fixture = async fn => {
  const pool = new pg.Pool({ connectionString: testUrl, max: 4 });
  const ended = [];
  pool.on('connect', client => ended.push(new Promise(resolve => client.once('end', resolve))));
  const db = await pool.connect();
  const prefix = `inv-p0-${randomUUID()}`;
  const firmId = `${prefix}-firm`, clientId = `${prefix}-client`, itemId = `${prefix}-item`, locationId = `${prefix}-loc`, uomId = `${prefix}-each`;
  const base = { client: db, firmId, clientId, actorId: 'test-owner' };
  let i = 0;
  const args = (over = {}) => ({ ...base, itemId, locationId, uomId, occurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), idempotencyKey: `${prefix}:${++i}`, ...over });
  try {
    await db.query("insert into firms(id,name,slug) values($1,'Inventory P0 test',$1)", [firmId]);
    await db.query("insert into clients(id,firm_id,company_name) values($1,$2,'Inventory P0 test')", [clientId, firmId]);
    await db.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage) values($1,$2,$3,'INVENTORY_CORE','auto')", [prefix, firmId, clientId]);
    await db.query("insert into inventory_units_of_measure(id,firm_id,client_id,code,name,kind) values($1,$2,$3,'each','Each','unit')", [uomId, firmId, clientId]);
    await db.query("insert into inventory_items(id,firm_id,client_id,sku,name,base_uom_id) values($1,$2,$3,'test-sku','Test SKU',$4)", [itemId, firmId, clientId, uomId]);
    await db.query("insert into inventory_locations(id,firm_id,client_id,code,name,is_default) values($1,$2,$3,'default','Default',true)", [locationId, firmId, clientId]);
    const levels = async () => (await db.query('select * from inventory_item_levels where client_id=$1 and item_id=$2 and location_id=$3', [clientId,itemId,locationId])).rows[0];
    const operations = async () => (await db.query('select * from inventory_operations where client_id=$1 and item_id=$2 order by occurred_at,id', [clientId,itemId])).rows;
    const po = async (quantity, cost=5) => {
      const result = await createPurchaseOrder(args({ supplierId:'supplier', lines:[{ itemId, quantity, uomId, expectedUnitCostAmount:cost, expectedUnitCostCurrency:'GBP' }] }));
      assert.equal(result.applied,true, JSON.stringify(result));
      assert.equal((await placePurchaseOrder(args({purchaseOrderId:result.receipt.purchaseOrderId}))).applied,true);
      return (await db.query('select id from inventory_purchase_order_lines where purchase_order_id=$1',[result.receipt.purchaseOrderId])).rows[0].id;
    };
    const so = async quantity => {
      const result = await createSalesOrder(args({ customerRef:'buyer', lines:[{itemId,quantity,uomId}] }));
      assert.equal(result.applied,true);
      return (await db.query('select id from inventory_sales_order_lines where sales_order_id=$1',[result.receipt.salesOrderId])).rows[0].id;
    };
    await fn({db,pool,base,args,firmId,clientId,itemId,locationId,uomId,levels,operations,po,so,prefix});
  } finally {
    await db.query('rollback');
    db.release();
    await pool.end();
    // pool.end removes clients before sockets close; finish closure before the forced database drop.
    await Promise.all(ended);
  }
};
const ok = out => { assert.equal(out.applied,true,JSON.stringify(out)); return out.receipt; };
const roles = {
  'asset.inventory': { code:'1400', name:'Inventory', type:'asset', normal_balance:'debit' },
  'pnl.inventory_count_variance': {code:'5200',name:'Count variance',type:'expense',normal_balance:'debit'}
};

test('P0 opening → PO receipt → reserve → allocate → ship → evidenced count → reversal → valuation/journal', opts, async () => fixture(async f => {
  ok(await seedOpeningInventory(f.args({quantity:2,unitCostAmount:5,unitCostCurrency:'GBP'})));
  const poLine=await f.po(4);
  ok(await receivePurchaseOrderLine(f.args({purchaseOrderLineId:poLine,quantity:4,unitCostAmount:5,unitCostCurrency:'GBP',provisionalCost:false})));
  assert.equal(Number((await f.levels()).on_hand),6,'numeric PostgreSQL strings are added numerically');
  const salesOrderLineId=await f.so(3);
  ok(await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:3})));
  ok(await allocateSalesOrderLine(f.args({salesOrderLineId,quantity:2})));
  ok(await shipSalesOrderLine(f.args({salesOrderLineId,quantity:2})));
  const level=await f.levels();
  assert.deepEqual([level.on_hand,level.reserved,level.allocated,level.available].map(Number),[4,1,0,3]);
  const sessionId=ok(await openInventoryCountSession(f.args({scope:{itemIds:[f.itemId],locationId:f.locationId}}))).countSessionId;
  const evidence={ evidence_ids:['fixture-photo'], checksum:'sha256-fixture', cause:'confirmed_shortage', actor_id:'test-owner' };
  const countArgs=f.args({sessionId,lines:[{item_id:f.itemId,location_id:f.locationId,uom_id:f.uomId,counted_quantity:3,payload:evidence}]});
  const count=ok(await closeInventoryCountSession(countArgs));
  const correctionId=count.consequence.operations[0].operation_id;
  assert.equal(count.consequence.operations[0].quantity,-1);
  const persisted=(await f.db.query('select payload from inventory_count_lines where count_session_id=$1',[sessionId])).rows[0].payload;
  assert.deepEqual(persisted,evidence);
  let ops=await f.operations();
  assert.deepEqual(ops.find(op=>op.id===correctionId).payload.count_line_evidence,evidence);
  const receiptOp=ops.find(op=>op.operation_type==='receipt');
  assert.equal(Number(receiptOp.unit_cost_amount),5); assert.equal(receiptOp.unit_cost_currency,'GBP'); assert.equal(receiptOp.provisional_cost,false);
  const valued=valueInventoryOperations({operations:ops}); ok(valued);
  assert.equal(valued.receipt.qtyOnHand,3); assert.equal(valued.receipt.inventoryValue,15);
  const draft=buildInventoryJournalDraft({ effect:valued.receipt.operationEffects.find(e=>String(e.operationId)===String(correctionId)),roleAccounts:roles,valuationRunId:valued.receipt.valuationRunId });
  assert.equal(draft.applied,true,JSON.stringify(draft));
  await f.db.query('begin');
  const posted=await postInventoryJournalWithinTransaction(f.db,{...f.base,draft,valuationIdentity:valued.receipt});
  assert.equal(posted.status,'posted',JSON.stringify(posted));
  await f.db.query('commit');
  const journal=(await f.db.query('select j.ledger_journal_id as journal_id from inventory_posting_journals j join inventory_posting_attempts a on a.id=j.posting_attempt_id where a.operation_id=$1',[String(correctionId)])).rows[0];
  assert.ok(journal);
  assert.equal((await closeInventoryCountSession(countArgs)).receipt.replayed,true);
  const reversal=ok(await reverseInventoryOperation(f.args({reversesOperationId:correctionId,occurredAt:new Date(Date.now()+1000).toISOString()})));
  assert.equal(reversal.consequence.after.on_hand,4);
  ops=await f.operations();
  const after=valueInventoryOperations({operations:ops}); ok(after);
  assert.equal(after.receipt.qtyOnHand,4); assert.equal(after.receipt.inventoryValue,20);
  assert.equal((await rebuildInventoryProjectionFromDb(f.base))[0].on_hand,4);
  await f.db.query('begin');
  const reversedJournal=await reverseInventoryJournalWithinTransaction(f.db,{...f.base,targetJournalId:journal.journal_id,reversalDate:'2026-10-07',reason:'Test count rescinded'});
  assert.ok(reversedJournal,JSON.stringify(reversedJournal));
  await f.db.query('commit');
}));

test('P0 partial receipts preserve inbound, zero-cost facts, and complete backorder fills',opts,async()=>fixture(async f=>{
  const salesOrderLineId=await f.so(4);
  ok(await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:4})));
  assert.equal((await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:1}))).reason,'over_reservation');
  const purchaseOrderLineId=await f.po(4,0);
  const first=f.args({purchaseOrderLineId,quantity:1});
  ok(await receivePurchaseOrderLine(first));
  let level=await f.levels();
  assert.deepEqual([level.on_hand,level.reserved,level.backordered,level.inbound].map(Number),[1,1,3,3]);
  assert.equal((await receivePurchaseOrderLine(first)).receipt.replayed,true);
  ok(await receivePurchaseOrderLine(f.args({purchaseOrderLineId,quantity:3})));
  level=await f.levels();
  assert.deepEqual([level.on_hand,level.reserved,level.backordered,level.inbound].map(Number),[4,4,0,0]);
  const back=(await f.db.query('select quantity,state from inventory_backorders where client_id=$1',[f.clientId])).rows[0];
  assert.equal(Number(back.quantity),0); assert.equal(back.state,'filled');
  for(const op of await f.operations()){assert.equal(Number(op.unit_cost_amount),0);assert.equal(op.unit_cost_currency,'GBP');assert.equal(op.provisional_cost,true);}
  assert.equal(valueInventoryOperations({operations:await f.operations()}).receipt.inventoryValue,0);
}));

test('P0 reversal validates tenant/target/order, is exactly once, and reverses quarantine',opts,async()=>fixture(async f=>{
  const opening=ok(await seedOpeningInventory(f.args({quantity:5,unitCostAmount:2,unitCostCurrency:'GBP'})));
  const q=ok(await applyInventoryOperation(f.args({operationType:'quarantine',quantity:2})));
  assert.equal((await reverseInventoryOperation(f.args({reversesOperationId:opening.operationId}))).reason,'stale_reversal');
  const revArgs=f.args({reversesOperationId:q.operationId,payload:{effect:{on_hand:900}}});
  ok(await reverseInventoryOperation(revArgs));
  assert.equal(Number((await f.levels()).quarantined),0);
  assert.equal(Number((await f.levels()).on_hand),5);
  assert.equal(valueInventoryOperations({operations:await f.operations()}).receipt.snapshots.at(-1).quarantinedQty,0);
  assert.equal((await reverseInventoryOperation(revArgs)).receipt.replayed,true);
  assert.equal((await reverseInventoryOperation(f.args({reversesOperationId:q.operationId}))).reason,'invalid_reversal');
  assert.equal((await reverseInventoryOperation(f.args({reversesOperationId:'999999999'}))).reason,'invalid_reversal');
}));

test('P0 wrong-tenant item/location and non-base UOM refuse before any write',opts,async()=>fixture(async f=>{
  assert.equal((await seedOpeningInventory(f.args({itemId:'not-this-client',quantity:1}))).reason,'unknown_item');
  assert.equal((await seedOpeningInventory(f.args({locationId:'not-this-client',quantity:1}))).reason,'unknown_location');
  assert.equal((await seedOpeningInventory(f.args({uomId:'carton',quantity:1}))).reason,'undefined_uom_conversion');
  const sessionId=ok(await openInventoryCountSession(f.args({scope:{all:true}}))).countSessionId;
  assert.equal((await closeInventoryCountSession(f.args({sessionId,lines:[{item_id:f.itemId,location_id:f.locationId,uom_id:'carton',counted_quantity:1}]}))).reason,'undefined_uom_conversion');
  assert.equal((await f.operations()).length,0);
}));

const waitBlocked=async(db,pid)=>{
  for(let i=0;i<100;i++){
    if((await db.query('select cardinality(pg_blocking_pids($1)) as n',[pid])).rows[0].n>0)return;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.fail('competing writer never took the shared inventory lock');
};

test('P0 competing receipts serialize even when no projection row exists',opts,async()=>fixture(async f=>{
  const other=await f.pool.connect();
  try{
    await f.db.query('begin');
    ok(await applyInventoryOperationWithinTransaction(f.args({operationType:'receipt',quantity:2})));
    const pid=(await other.query('select pg_backend_pid() as id')).rows[0].id;
    const pending=applyInventoryOperation(f.args({client:other,operationType:'receipt',quantity:4}));
    await waitBlocked(f.db,pid);
    await f.db.query('commit');
    ok(await pending);
    assert.equal(Number((await f.levels()).on_hand),6);
  }finally{other.release();}
}));

test('P0 count holds movement lock through commit; later receipt cannot be lost',opts,async()=>fixture(async f=>{
  ok(await seedOpeningInventory(f.args({quantity:5})));
  const sessionId=ok(await openInventoryCountSession(f.args({scope:{all:true}}))).countSessionId;
  const other=await f.pool.connect();
  try{
    await f.db.query('begin');
    ok(await closeInventoryCountSessionWithinTransaction(f.args({sessionId,lines:[{item_id:f.itemId,location_id:f.locationId,uom_id:f.uomId,counted_quantity:3}]})));
    const pid=(await other.query('select pg_backend_pid() as id')).rows[0].id;
    const pending=applyInventoryOperation(f.args({client:other,operationType:'receipt',quantity:2}));
    await waitBlocked(f.db,pid); await f.db.query('commit'); ok(await pending);
    assert.equal(Number((await f.levels()).on_hand),5);
    assert.equal((await rebuildInventoryProjectionFromDb(f.base))[0].on_hand,5);
  }finally{other.release();}
}));

test('P0 failed count transaction rolls back evidence, operation, session and audit together',opts,async()=>fixture(async f=>{
  ok(await seedOpeningInventory(f.args({quantity:5})));
  const sessionId=ok(await openInventoryCountSession(f.args({scope:{all:true}}))).countSessionId;
  const before=(await f.db.query('select count(*)::int as n from audit_events where client_id=$1',[f.clientId])).rows[0].n;
  await f.db.query('begin');
  ok(await closeInventoryCountSessionWithinTransaction(f.args({sessionId,lines:[{item_id:f.itemId,location_id:f.locationId,uom_id:f.uomId,counted_quantity:3,payload:{evidence_id:'test-photo'}}]})));
  await assert.rejects(f.db.query('select 1/0'));
  await f.db.query('rollback');
  assert.equal(Number((await f.levels()).on_hand),5);
  assert.equal((await f.operations()).length,1);
  assert.equal((await f.db.query('select state from inventory_count_sessions where id=$1',[sessionId])).rows[0].state,'open');
  assert.equal((await f.db.query('select count(*)::int as n from inventory_count_lines where count_session_id=$1',[sessionId])).rows[0].n,0);
  assert.equal((await f.db.query('select count(*)::int as n from audit_events where client_id=$1',[f.clientId])).rows[0].n,before);
}));

test('P0 full reservation expiration releases line counter for a fresh reservation',opts,async()=>fixture(async f=>{
  ok(await seedOpeningInventory(f.args({quantity:5})));
  const salesOrderLineId=await f.so(3);
  ok(await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:3,expiresAt:'2026-01-01T00:00:00Z'})));
  ok(await expireStaleReservations(f.args({now:'2026-02-01T00:00:00Z'})));
  assert.equal(Number((await f.levels()).reserved),0);
  ok(await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:3})));
  assert.equal(Number((await f.levels()).reserved),3);
}));

test('P0 duplicate concurrent receipts mint exactly one operation and original receipt',opts,async()=>fixture(async f=>{
  const other=await f.pool.connect();
  try {
    const args=f.args({operationType:'receipt',quantity:2});
    const results=await Promise.all([applyInventoryOperation(args),applyInventoryOperation({...args,client:other})]);
    results.forEach(ok);
    assert.equal(results.filter(r=>r.receipt.replayed).length,1);
    assert.equal((await f.operations()).length,1);
    assert.equal(Number((await f.levels()).on_hand),2);
  } finally {other.release();}
}));

test('P0 cross-client ids cannot write stock or reveal another client receipt/reversal',opts,async()=>fixture(async f=>fixture(async other=>{
  const originalArgs=f.args({quantity:3,unitCostAmount:5,unitCostCurrency:'GBP'});
  const opening=ok(await seedOpeningInventory(originalArgs));
  assert.equal((await seedOpeningInventory(other.args({itemId:f.itemId,quantity:1}))).reason,'unknown_item');
  assert.equal((await seedOpeningInventory(other.args({locationId:f.locationId,quantity:1}))).reason,'unknown_location');
  assert.equal((await reverseInventoryOperation(other.args({reversesOperationId:opening.operationId}))).reason,'invalid_reversal');
  await assert.rejects(seedOpeningInventory(other.args({quantity:1,idempotencyKey:originalArgs.idempotencyKey})),e=>e.code==='23505');
  assert.equal((await other.operations()).length,0,'conflicting receipt rolls back the whole write');
  assert.equal(Number((await f.levels()).on_hand),3);
})));

test('P0 matching count persists evidence/receipt but no movement; duplicate lines refuse atomically',opts,async()=>fixture(async f=>{
  ok(await seedOpeningInventory(f.args({quantity:3})));
  const sessionId=ok(await openInventoryCountSession(f.args({scope:{all:true}}))).countSessionId;
  const line={item_id:f.itemId,location_id:f.locationId,uom_id:f.uomId,counted_quantity:3,payload:{photo:'photo-match'}};
  assert.equal((await closeInventoryCountSession(f.args({sessionId,lines:[line,line]}))).reason,'invalid_command');
  const counted=ok(await closeInventoryCountSession(f.args({sessionId,lines:[line]})));
  assert.deepEqual(counted.consequence.operations,[]);
  assert.deepEqual(counted.lines[0].payload,line.payload);
  assert.equal((await f.operations()).length,1);
}));

test('P0 short close retires only that PO line inbound and blocks further receipt',opts,async()=>fixture(async f=>{
  const purchaseOrderLineId=await f.po(5);
  const received=ok(await receivePurchaseOrderLine(f.args({purchaseOrderLineId,quantity:2,closeShort:true})));
  assert.deepEqual(received.consequence.anomalies,['short_receipt']);
  assert.equal(Number((await f.levels()).inbound),0);
  assert.equal(Number((await f.levels()).on_hand),2);
  assert.equal((await receivePurchaseOrderLine(f.args({purchaseOrderLineId,quantity:1}))).reason,'invalid_state_transition');
}));


test('P0 reservation keeps unshipped order state truthful and preserves actual later progress',opts,async()=>fixture(async f=>{
  ok(await seedOpeningInventory(f.args({quantity:10,unitCostAmount:5,unitCostCurrency:'GBP'})));
  const salesOrderLineId=await f.so(4);
  const order=async()=>(await f.db.query(`select so.state,sol.quantity_shipped from inventory_sales_orders so
    join inventory_sales_order_lines sol on sol.sales_order_id=so.id where sol.id=$1`,[salesOrderLineId])).rows[0];
  ok(await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:2})));
  assert.equal((await order()).state,'reserved');assert.equal(Number((await order()).quantity_shipped),0);
  assert.deepEqual((await f.operations()).map(op=>op.operation_type),['opening_balance']);
  ok(await allocateSalesOrderLine(f.args({salesOrderLineId,quantity:1})));
  ok(await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:1})));
  assert.equal((await order()).state,'allocated');assert.equal(Number((await order()).quantity_shipped),0);
  ok(await shipSalesOrderLine(f.args({salesOrderLineId,quantity:1})));
  ok(await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:1})));
  assert.equal((await order()).state,'partially_shipped');assert.equal(Number((await order()).quantity_shipped),1);
}));

test('P0 an entirely unfilled reservation reports backordered, never shipped',opts,async()=>fixture(async f=>{
  const salesOrderLineId=await f.so(3);
  ok(await reserveSalesOrderLine(f.args({salesOrderLineId,quantity:3})));
  const row=(await f.db.query(`select so.state,sol.quantity_shipped from inventory_sales_orders so
    join inventory_sales_order_lines sol on sol.sales_order_id=so.id where sol.id=$1`,[salesOrderLineId])).rows[0];
  assert.equal(row.state,'backordered');assert.equal(Number(row.quantity_shipped),0);
  assert.equal((await f.operations()).length,0);
}));
