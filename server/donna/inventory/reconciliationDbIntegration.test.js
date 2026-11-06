// Donna Inventory I4·posting — P6 reconciliation real-Postgres integration suite (design §19).
// The fake-pg gatherer test proves the SQL SHAPE; this proves the reconciliation reads against a
// REAL database — canonical_role summation (migration 035), the inventory_posting_journals join
// (migration 080), and the allowance-register read — so the §16 ties hold against actual rows,
// not a mock. The whole suite SKIPS unless DATABASE_URL is set (the unit harness is mock-pg
// only), so it is a no-op in `npm test` and runs in a DB-provisioned CI before canary.
//   DATABASE_URL=postgres://… node --test server/donna/inventory/reconciliationDbIntegration.test.js
//
// Everything runs inside ONE transaction ROLLED BACK at the end — a throwaway firm+client, no
// trace left. If the P6-relevant tables (ledger + 080) are not migrated, the suite skips with a
// diagnostic. This suite is READ-ONLY against the reconciliation code path: it seeds ledger rows
// directly (the P5 executor has its own suite), then asserts the gatherer reads + ties them.

import assert from 'node:assert/strict';
import test from 'node:test';

import { gatherInventoryReconciliationState } from './reconciliationDb.js';

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const opts = { skip: HAVE_DB ? false : 'DATABASE_URL not set — real-Postgres suite skipped (mock-pg harness covers gatherer SQL shape)' };

const withRolledBackFixture = async (fn) => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const firmId = 'itest-firm-inv-p6';
  const clientId = 'itest-client-inv-p6';
  try {
    await client.query('begin');
    const present = await client.query("select to_regclass('public.inventory_posting_journals') as a, to_regclass('public.ledger_lines') as b, to_regclass('public.inventory_valuation_allowances') as c");
    if (!present.rows[0]?.a || !present.rows[0]?.b || !present.rows[0]?.c) { await client.query('rollback'); return { skipped: 'P6 tables not migrated' }; }
    await client.query(`insert into firms (id, name, slug) values ($1, 'ITest Firm', $2) on conflict (id) do nothing`, [firmId, `itest-inv-p6-${firmId}`]);
    await client.query(`insert into clients (id, firm_id, company_name) values ($1, $2, 'ITest Client') on conflict (id) do nothing`, [clientId, firmId]);
    return await fn({ client, firmId, clientId });
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end();
  }
};

// Seed a ledger account with a canonical role, then a journal + its two lines, and link the
// journal to an inventory posting attempt. Returns the journal id.
const seedInventoryJournal = async ({ client, firmId, clientId, kind, operationId, currency, legs }) => {
  const journalId = `j-${kind}-${operationId}`;
  await client.query(
    `insert into ledger_journals (id, firm_id, client_id, source_type, source_id, journal_date, currency, status)
     values ($1,$2,$3,'inventory_posting',$4,'2026-07-01',$5,'posted')`,
    [journalId, firmId, clientId, `${kind}:${operationId}`, currency]
  );
  let lineNo = 0;
  for (const leg of legs) {
    const acctId = `a-${leg.role}`;
    await client.query(
      `insert into ledger_accounts (id, firm_id, client_id, name, canonical_role, normal_balance, status)
       values ($1,$2,$3,$4,$5,$6,'active') on conflict (id) do nothing`,
      [acctId, firmId, clientId, leg.role, leg.role, leg.direction === 'debit' ? 'debit' : 'credit']
    );
    await client.query(
      `insert into ledger_lines (id, journal_id, firm_id, client_id, account_id, line_no, direction, debit, credit, amount, currency, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [`l-${journalId}-${lineNo}`, journalId, firmId, clientId, acctId, lineNo,
       leg.direction, leg.direction === 'debit' ? leg.amount : 0, leg.direction === 'credit' ? leg.amount : 0,
       leg.amount, currency, JSON.stringify({ role: `inventory_${leg.role.replace(/\./g, '_')}` })]
    );
    lineNo += 1;
  }
  const attempt = await client.query(
    `insert into inventory_posting_attempts (firm_id, client_id, operation_id, posting_kind, valuation_run_id, outcome, actor_id)
     values ($1,$2,$3,$4,'vrun-itest','posted','itest') returning id`,
    [firmId, clientId, operationId, kind]
  );
  await client.query(
    `insert into inventory_posting_journals (firm_id, client_id, posting_attempt_id, ledger_journal_id, relationship)
     values ($1,$2,$3,$4,'primary')`,
    [firmId, clientId, attempt.rows[0].id, journalId]
  );
  return journalId;
};

test('reconciliation reads sum GL by canonical role and tie the subledger (real Postgres)', opts, async () => {
  const out = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    // A receipt (DR inventory 100 / CR grni 100) and a sale (CR inventory 60 / DR cogs 60).
    await seedInventoryJournal({ client, firmId, clientId, kind: 'receipt', operationId: 'op-r', currency: 'EUR', legs: [
      { role: 'asset.inventory', direction: 'debit', amount: 100 },
      { role: 'liability.grni', direction: 'credit', amount: 100 }
    ] });
    await seedInventoryJournal({ client, firmId, clientId, kind: 'shipment_cogs', operationId: 'op-s', currency: 'EUR', legs: [
      { role: 'expense.cost_of_sales', direction: 'debit', amount: 60 },
      { role: 'asset.inventory', direction: 'credit', amount: 60 }
    ] });

    const subledger = { applied: true, receipt: {
      inventoryValue: 40, functionalCurrency: 'EUR', conservation: { delta: 0 },
      operationEffects: [
        { amountToInventory: 100, amountToCogsOrVariance: 0, amountToGrni: 100 },
        { amountToInventory: -60, amountToCogsOrVariance: 60, amountToGrni: 0 }
      ]
    } };
    const state = await gatherInventoryReconciliationState({ client, firmId, clientId, subledger });
    return state;
  });
  if (out?.skipped) { console.log(`SKIP: ${out.skipped}`); return; }

  // GL gross inventory = 100 − 60 = 40, ties the subledger 40.
  assert.equal(out.inventoryToGl.glInventoryGross, 40);
  assert.equal(out.inventoryToGl.subledgerValue, 40);
  // GRNI (credit-normal) reads as +100 accrued, 0 matched → open 100.
  const eur = out.grni.byCurrency.find((r) => r.currency === 'EUR');
  assert.equal(eur.glGrni, 100);
  assert.equal(eur.accruedReceipts, 100);
  // Conservation buckets from the ledger tie the kernel: inventory 40, cogs 60.
  assert.equal(out.conservation.ledgerBuckets.inventory, 40);
  assert.equal(out.conservation.ledgerBuckets.cogs, 60);
});

test('reconciliation reads the allowance register and its GL contra balance (real Postgres)', opts, async () => {
  const out = await withRolledBackFixture(async ({ client, firmId, clientId }) => {
    // A write-down journal: DR expense.inventory_write_down 100 / CR contra_asset.allowance 100.
    await seedInventoryJournal({ client, firmId, clientId, kind: 'write_down', operationId: 'op-wd', currency: 'EUR', legs: [
      { role: 'expense.inventory_write_down', direction: 'debit', amount: 100 },
      { role: 'contra_asset.inventory_valuation_allowance', direction: 'credit', amount: 100 }
    ] });
    // The allowance lot (register).
    await client.query(
      `insert into inventory_valuation_allowances (firm_id, client_id, scope_item_id, valuation_date, allowance_amount, currency, max_reversible_amount, consumed_amount, status, reviewer)
       values ($1,$2,'SKU-WD','2026-07-01',100,'EUR',100,0,'active','itest-reviewer')`,
      [firmId, clientId]
    );
    return await gatherInventoryReconciliationState({ client, firmId, clientId, subledger: { applied: true, receipt: { inventoryValue: 0, functionalCurrency: 'EUR', conservation: { delta: 0 }, operationEffects: [] } }, onHandByScope: { 'item:SKU-WD': { qty: 5, value: 400 } } });
  });
  if (out?.skipped) { console.log(`SKIP: ${out.skipped}`); return; }

  assert.equal(out.allowance.glAllowance, 100);            // GL contra flipped to a positive magnitude
  assert.equal(out.allowance.lots.length, 1);
  assert.equal(out.inventoryToGl.registerAllowance, 100);  // register outstanding
});


test('current reads exclude draft/voided journals and retain closed journal balances (real Postgres)', opts, async () => {
  const out = await withRolledBackFixture(async ({client,firmId,clientId}) => {
    const closed = await seedInventoryJournal({client,firmId,clientId,kind:'receipt',operationId:'op-closed',currency:'EUR',legs:[
      {role:'asset.inventory',direction:'debit',amount:20},{role:'liability.grni',direction:'credit',amount:20}
    ]});
    await client.query("update ledger_journals set status='closed' where id=$1",[closed]);
    for (const status of ['draft','voided']) {
      const id=await seedInventoryJournal({client,firmId,clientId,kind:'receipt',operationId:`op-${status}`,currency:'EUR',legs:[
        {role:'asset.inventory',direction:'debit',amount:100},{role:'liability.grni',direction:'credit',amount:100}
      ]});
      await client.query('update ledger_journals set status=$1 where id=$2',[status,id]);
    }
    return gatherInventoryReconciliationState({client,firmId,clientId,subledger:{inventoryValue:20,operationEffects:[{amountToInventory:20,amountToGrni:20,amountToCogsOrVariance:0}]}});
  });
  assert.ok(!out?.skipped, 'INCOMPLETE: required reconciliation tables not migrated');
  assert.equal(out.inventoryToGl.glInventoryGross,20);
  assert.equal(out.conservation.ledgerBuckets.inventory,20);
  assert.equal(out.grni.byCurrency[0].glGrni,20);
});
