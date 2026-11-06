// Donna Inventory I4·posting — P5 ledger-posting gateway tests (fake-pg query-order, same
// style as finlandSupplierBillPostDb.test.js). Every refusal gate (balance, then the two
// locked-period 409s) fires BEFORE any ledger write; the happy path routes through the ONE
// shared __writeLedgerJournalRows insert (INV-1).
//   node --test server/donna/ledgerPostingGateway.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { writeValidatedJournalWithinTransaction } from './ledgerPostingGateway.js';

const invAccount = { role: 'inventory_asset_inventory', code: '1400', name: 'Inventory', canonical_role: 'asset.inventory', tax_type: 'NONE', normal_balance: 'debit' };
const grniAccount = { role: 'inventory_liability_grni', code: '2880', name: 'GRNI', canonical_role: 'liability.grni', tax_type: 'NONE', normal_balance: 'credit' };

const balancedJournal = () => ({
  source_type: 'inventory_posting', source_id: 'receipt:op-1:vrun-1', journal_date: '2026-07-02', currency: 'EUR',
  status: 'proposed', memo: 'Inventory receipt', direction: 'internal', amount: 50,
  accounts: [invAccount, grniAccount],
  lines: [
    { account: invAccount, direction: 'debit', debit: 50, credit: 0, amount: 50, currency: 'EUR', memo: 'r' },
    { account: grniAccount, direction: 'credit', debit: 0, credit: 50, amount: 50, currency: 'EUR', memo: 'r' }
  ]
});

// Pattern-matching fake client; `queries` records every SQL for gate-ordering assertions.
const fakeClient = ({ existingLocked = false, dateLocked = false } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('from ledger_journals lj')) return { rows: existingLocked ? [{ id: 'j-old', close_period_id: 'cp-1' }] : [] };
      if (sql.includes('from close_periods')) return { rows: dateLocked ? [{ id: 'cp-2', period_start: '2026-07-01', period_end: '2026-07-31' }] : [] };
      if (sql.includes('from client_capability_config')) return { rows: [] };
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [{ id: 'acct-1' }] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-1' }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('for update')) return { rows: [] };
      return { rows: [] };
    }
  };
};

const wrote = (queries) => queries.some((q) => q.sql.includes('insert into ledger_journals'));

test('balance gate fires BEFORE any query (unbalanced draft never touches the DB)', async () => {
  const tx = fakeClient();
  const j = balancedJournal();
  j.lines[1].credit = 40; // now 50 != 40
  await assert.rejects(
    () => writeValidatedJournalWithinTransaction(tx, j, { firmId: 'f1', clientId: 'c1' }),
    (e) => e.code === 'LEDGER_CORRECTION_UNBALANCED'
  );
  assert.equal(tx.queries.length, 0, 'balance is a pure gate — no query before it');
});

test('locked existing journal refuses (LEDGER_LOCKED_PERIOD_IMMUTABLE) before any write', async () => {
  const tx = fakeClient({ existingLocked: true });
  await assert.rejects(
    () => writeValidatedJournalWithinTransaction(tx, balancedJournal(), { firmId: 'f1', clientId: 'c1' }),
    (e) => e.code === 'LEDGER_LOCKED_PERIOD_IMMUTABLE' && e.statusCode === 409
  );
  assert.equal(wrote(tx.queries), false, 'no ledger_journals insert when the existing journal is locked');
});

test('journal_date inside a locked period refuses (LEDGER_ADJUSTMENT_DATE_LOCKED) before any write', async () => {
  const tx = fakeClient({ dateLocked: true });
  await assert.rejects(
    () => writeValidatedJournalWithinTransaction(tx, balancedJournal(), { firmId: 'f1', clientId: 'c1' }),
    (e) => e.code === 'LEDGER_ADJUSTMENT_DATE_LOCKED' && e.statusCode === 409
  );
  assert.equal(wrote(tx.queries), false, 'no ledger_journals insert when the date is locked');
});

test('happy path routes through the shared __writeLedgerJournalRows insert', async () => {
  const tx = fakeClient();
  const res = await writeValidatedJournalWithinTransaction(tx, balancedJournal(), { firmId: 'f1', clientId: 'c1', actorId: 'op-7' });
  assert.equal(res.ledger_journal_id, 'journal-1');
  assert.equal(res.ledger_status, 'posted');
  // The gate order: existing-journal check → date check → account upsert → journal insert.
  const kinds = tx.queries.map((q) =>
    q.sql.includes('from ledger_journals lj') ? 'existing'
      : q.sql.includes('from close_periods') ? 'date'
      : q.sql.includes('insert into ledger_journals') ? 'journal' : null
  ).filter(Boolean);
  assert.deepEqual(kinds.slice(0, 3), ['existing', 'date', 'journal']);
});

test('opt-in audit hook emits an audit event in the same txn and returns its id', async () => {
  const queries = [];
  const tx = {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [{ id: 'acct-1' }] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-9' }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 77 }] };
      return { rows: [] };
    }
  };
  const res = await writeValidatedJournalWithinTransaction(tx, balancedJournal(), {
    firmId: 'f1', clientId: 'c1', audit: { action: 'inventory.generic_ledger', metadata: { k: 1 } }
  });
  assert.equal(res.audit_event_id, '77');
  assert.ok(queries.some((q) => q.sql.includes('insert into audit_events')));
});
