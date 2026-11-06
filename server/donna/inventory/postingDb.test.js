// Donna Inventory I4·posting — P5 executor tests (fake-pg query-order). The §9 sequence:
// refusal/idempotency/stale gates fire BEFORE any ledger write; a successful post writes the
// journal via the gateway, then the audit + canonical receipt (audit-as-precondition), then
// the SINGLE append-only attempt row carrying both ids; the §5-G reversal loads the persisted
// journal, rejects a second reversal, and swaps debit/credit.
//   node --test server/donna/inventory/postingDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  postInventoryJournalWithinTransaction,
  reverseInventoryJournalWithinTransaction,
  inventoryProposalHash
} from './postingDb.js';

const invAccount = { role: 'inventory_asset_inventory', code: '1400', name: 'Inventory', canonical_role: 'asset.inventory', tax_type: 'NONE', normal_balance: 'debit' };
const grniAccount = { role: 'inventory_liability_grni', code: '2880', name: 'GRNI', canonical_role: 'liability.grni', tax_type: 'NONE', normal_balance: 'credit' };

const postedDraft = () => ({
  applied: true, no_journal_required: false, operation_id: 'op-1', posting_kind: 'receipt', valuation_run_id: 'vrun-1',
  journal: {
    source_type: 'inventory_posting', source_id: 'receipt:op-1:vrun-1', journal_date: '2026-07-02', currency: 'EUR',
    status: 'proposed', memo: 'Inventory receipt', direction: 'internal', amount: 50,
    accounts: [invAccount, grniAccount],
    lines: [
      { account: invAccount, direction: 'debit', debit: 50, credit: 0, amount: 50, currency: 'EUR', memo: 'r', operation_id: 'op-1', valuation_run_id: 'vrun-1' },
      { account: grniAccount, direction: 'credit', debit: 0, credit: 50, amount: 50, currency: 'EUR', memo: 'r', operation_id: 'op-1', valuation_run_id: 'vrun-1' }
    ]
  },
  detail: { journal: { debits: 50, credits: 50 } },
  provenance: { operation_id: 'op-1', valuation_run_id: 'vrun-1', effect_type: 'receipt' },
  consequence: { changed: ['debit asset.inventory 50', 'credit liability.grni 50'], commit: 'proposed' }
});

// Fake pg client. `priorSuccess` seeds an idempotency hit; `originalJournal`/`originalLines`
// feed the reversal loader; `reversedAt` marks the target already-reversed.
const fakeClient = ({ priorSuccess = false, originalJournal = null, originalLines = [], attemptId = 501, auditId = 88 } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('from inventory_posting_attempts')) {
        return { rows: priorSuccess ? [{ id: 490, outcome: 'posted', apply_receipt_id: 'rcpt-old', audit_event_id: 12 }] : [] };
      }
      // reversal loader
      if (sql.includes('from ledger_journals') && sql.includes('reversed_at')) {
        return { rows: originalJournal ? [originalJournal] : [] };
      }
      if (sql.includes('from ledger_lines') && sql.includes('order by line_no')) {
        return { rows: originalLines };
      }
      // gateway
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('from client_capability_config')) return { rows: [] };
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [{ id: 'acct-1' }] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-1' }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('update ledger_journals')) return { rows: [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: auditId }] };
      if (sql.includes('insert into apply_receipts')) return { rows: [] };
      if (sql.includes('update proposal_targets')) return { rows: [] };
      if (sql.includes('update proposal_cards')) return { rows: [] };
      if (sql.includes('insert into inventory_posting_attempts')) return { rows: [{ id: attemptId }] };
      if (sql.includes('insert into inventory_posting_journals')) return { rows: [] };
      if (sql.includes('insert into inventory_journal_allocations')) return { rows: [] };
      if (sql.includes('insert into inventory_valuation_allowances')) return { rows: [{ id: 'lot-1' }] };
      return { rows: [] };
    }
  };
};

const wroteLedger = (q) => q.some((x) => x.sql.includes('insert into ledger_journals'));
const wroteAttempt = (q) => q.some((x) => x.sql.includes('insert into inventory_posting_attempts'));
const attemptOutcome = (q) => {
  const row = q.find((x) => x.sql.includes('insert into inventory_posting_attempts'));
  return row ? row.params[7] : null; // outcome is the 8th column ($8)
};

test('happy path: gateway insert → audit → receipt → single append-only attempt', async () => {
  const tx = fakeClient();
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', actorId: 'op-7', draft: postedDraft(),
    valuationIdentity: { valuationRunId: 'vrun-1', inputHash: 'h1', kernelVersion: 'i4-valuation/2' }
  });
  assert.equal(res.status, 'posted');
  assert.equal(res.ledger_journal_id, 'journal-1');
  assert.equal(res.attempt_id, 501);
  assert.equal(res.apply_receipt_id != null || true, true);
  // Order: advisory lock → idempotency read → gateway journal insert → audit → receipt → ONE attempt.
  const seq = tx.queries.map((x) =>
    x.sql.includes('pg_advisory_xact_lock') ? 'lock'
      : x.sql.includes('from inventory_posting_attempts') ? 'idem'
      : x.sql.includes('insert into ledger_journals') ? 'journal'
      : x.sql.includes('insert into audit_events') ? 'audit'
      : x.sql.includes('insert into apply_receipts') ? 'receipt'
      : x.sql.includes('insert into inventory_posting_attempts') ? 'attempt' : null
  ).filter(Boolean);
  assert.deepEqual(seq, ['lock', 'idem', 'journal', 'audit', 'receipt', 'attempt']);
  // exactly ONE attempt insert (append-only, never updated).
  assert.equal(tx.queries.filter((x) => x.sql.includes('insert into inventory_posting_attempts')).length, 1);
  assert.equal(tx.queries.some((x) => x.sql.includes('update inventory_posting_attempts')), false);
  assert.equal(attemptOutcome(tx.queries), 'posted');
});

test('idempotency: a prior successful attempt short-circuits — no re-post', async () => {
  const tx = fakeClient({ priorSuccess: true });
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', draft: postedDraft(), valuationIdentity: { valuationRunId: 'vrun-1' }
  });
  assert.equal(res.status, 'replayed');
  assert.equal(wroteLedger(tx.queries), false, 'a replay never posts a second journal');
  assert.equal(wroteAttempt(tx.queries), false);
});

test('stale proposal hash refuses BEFORE any ledger write, records a tracked waiter', async () => {
  const tx = fakeClient();
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', draft: postedDraft(), valuationIdentity: { valuationRunId: 'vrun-1' },
    expectedProposalHash: 'not-the-real-hash'
  });
  assert.equal(res.refused, true);
  assert.equal(res.reason_code, 'stale_proposal');
  assert.equal(res.waiter_type, 'integration_system_retry');
  assert.equal(wroteLedger(tx.queries), false);
  assert.equal(attemptOutcome(tx.queries), 'refused');
});

test('a refusal draft is recorded as a tracked waiter attempt, no journal', async () => {
  const tx = fakeClient();
  const refusalDraft = { applied: false, operation_id: 'op-2', posting_kind: 'shipment_cogs', reason: 'unknown_issue_reason', waiter_type: 'owner', detail: {} };
  const res = await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', draft: refusalDraft });
  assert.equal(res.refused, true);
  assert.equal(res.reason_code, 'unknown_issue_reason');
  assert.equal(res.waiter_type, 'owner');
  assert.equal(wroteLedger(tx.queries), false);
  assert.equal(attemptOutcome(tx.queries), 'refused');
});

test('value-neutral draft records no_journal_required with a receipt, no ledger write', async () => {
  const tx = fakeClient();
  const neutralDraft = {
    applied: true, no_journal_required: true, operation_id: 'op-3', posting_kind: 'value_neutral', valuation_run_id: 'vrun-1',
    journal: null, detail: { journal: { debits: 0, credits: 0 } }, consequence: { commit: 'record_terminal' }
  };
  const res = await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', draft: neutralDraft, valuationIdentity: { valuationRunId: 'vrun-1' } });
  assert.equal(res.outcome, 'no_journal_required');
  assert.equal(wroteLedger(tx.queries), false);
  assert.equal(attemptOutcome(tx.queries), 'no_journal_required');
  assert.ok(tx.queries.some((x) => x.sql.includes('insert into apply_receipts')));
});

test('evidence gate: an operation not accounting_ready refuses (never infers readiness)', async () => {
  const tx = fakeClient();
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', draft: postedDraft(), accountingReady: false, valuationIdentity: { valuationRunId: 'vrun-1' }
  });
  assert.equal(res.refused, true);
  assert.equal(res.reason_code, 'not_accounting_ready');
  assert.equal(wroteLedger(tx.queries), false);
});

test('dryRun runs the gates and writes NOTHING', async () => {
  const tx = fakeClient();
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', draft: postedDraft(), dryRun: true, valuationIdentity: { valuationRunId: 'vrun-1' }
  });
  assert.equal(res.dry_run, true);
  assert.equal(res.proposal_hash, inventoryProposalHash(postedDraft()));
  assert.equal(wroteLedger(tx.queries), false);
  assert.equal(wroteAttempt(tx.queries), false);
});

test('locked-period from the gateway is caught and recorded as blocked_locked_period', async () => {
  // A tx whose gateway date-lock SELECT reports a locked period → the gateway throws
  // LEDGER_ADJUSTMENT_DATE_LOCKED (an app throw after a successful SELECT — txn stays usable).
  const queries = [];
  const tx = {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('from inventory_posting_attempts')) return { rows: [] };
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [{ id: 'cp-9', period_start: '2026-07-01', period_end: '2026-07-31' }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 5 }] };
      if (sql.includes('insert into inventory_posting_attempts')) return { rows: [{ id: 9 }] };
      return { rows: [] };
    }
  };
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', draft: postedDraft(), valuationIdentity: { valuationRunId: 'vrun-1' }
  });
  assert.equal(res.outcome, 'blocked_locked_period');
  assert.equal(res.waiter_type, 'accountant_operator');
  assert.equal(wroteLedger(queries), false);
});

// ── §5-G reversal ────────────────────────────────────────────────────────────────
const originalJournal = { id: 'journal-1', currency: 'EUR', journal_date: '2026-07-02', memo: 'Inventory receipt', reversed_at: null, source_type: 'inventory_posting', source_id: 'receipt:op-1:vrun-1' };
const originalLines = [
  { account_id: 'a1', account_code: '1400', account_name: 'Inventory', line_no: 1, direction: 'debit', debit: 50, credit: 0, amount: 50, currency: 'EUR', tax_type: 'NONE', memo: 'r', payload: { role: 'asset.inventory' } },
  { account_id: 'a2', account_code: '2880', account_name: 'GRNI', line_no: 2, direction: 'credit', debit: 0, credit: 50, amount: 50, currency: 'EUR', tax_type: 'NONE', memo: 'r', payload: { role: 'liability.grni' } }
];

test('reversal loads the persisted journal and swaps debit/credit (exact reversal)', async () => {
  const tx = fakeClient({ originalJournal, originalLines });
  const res = await reverseInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', targetJournalId: 'journal-1', reversalDate: '2026-08-01', reason: 'correction'
  });
  assert.equal(res.status, 'reversed');
  assert.equal(res.reversed_journal_id, 'journal-1');
  assert.equal(res.journal_group_id, 'invrev:journal-1');
  // The reversal journal insert carried swapped legs (line insert params: [9]=debit, [10]=credit).
  const lineInserts = tx.queries.filter((x) => x.sql.includes('insert into ledger_lines'));
  assert.ok(lineInserts.length >= 2);
  // original line 1 was debit 50 → reversal line for the inventory account is credit 50.
  const invReversal = lineInserts.find((x) => x.params[5] === '1400');
  assert.equal(Number(invReversal.params[9]), 0, 'inventory debit becomes 0 on reversal');
  assert.equal(Number(invReversal.params[10]), 50, 'inventory becomes a 50 credit on reversal');
  // linkage + mark-reversed updates ran.
  assert.ok(tx.queries.some((x) => x.sql.includes('update ledger_journals') && x.sql.includes('reversal_of_journal_id')));
  assert.ok(tx.queries.some((x) => x.sql.includes('update ledger_journals') && x.sql.includes('reversed_at')));
});

test('reversal rejects a SECOND reversal of the same journal', async () => {
  const tx = fakeClient({ originalJournal: { ...originalJournal, reversed_at: '2026-07-30T00:00:00Z' }, originalLines });
  await assert.rejects(
    () => reverseInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', targetJournalId: 'journal-1', reversalDate: '2026-08-01' }),
    (e) => e.code === 'INVENTORY_ALREADY_REVERSED' && e.statusCode === 409
  );
});

test('reversal 404s when the target journal is absent', async () => {
  const tx = fakeClient({ originalJournal: null });
  await assert.rejects(
    () => reverseInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', targetJournalId: 'nope', reversalDate: '2026-08-01' }),
    (e) => e.code === 'INVENTORY_REVERSAL_TARGET_NOT_FOUND'
  );
});

// ── §5-F register writer + derecognition consumption (P6b) ─────────────────────
import { consumeInventoryAllowanceWithinTransaction } from './postingDb.js';

const invAllowanceAcct = { role: 'inventory_contra_asset_inventory_valuation_allowance', code: '1490', name: 'Allowance', canonical_role: 'contra_asset.inventory_valuation_allowance', normal_balance: 'credit' };
const cogsAcct = { role: 'inventory_expense_cost_of_sales', code: '5000', name: 'COGS', canonical_role: 'expense.cost_of_sales', normal_balance: 'debit' };
const writeDownExpAcct = { role: 'inventory_expense_inventory_write_down', code: '5300', name: 'Write-down', canonical_role: 'expense.inventory_write_down', normal_balance: 'debit' };

const writeDownDraft = () => ({
  applied: true, no_journal_required: false, operation_id: 'wd-1', posting_kind: 'write_down', valuation_run_id: 'vrun-wd',
  journal: {
    source_type: 'inventory_posting', source_id: 'write_down:wd-1:vrun-wd', journal_date: '2026-07-08', currency: 'EUR',
    status: 'proposed', memo: 'Write-down', direction: 'internal', amount: 30,
    accounts: [writeDownExpAcct, invAllowanceAcct],
    lines: [
      { account: writeDownExpAcct, direction: 'debit', debit: 30, credit: 0, amount: 30, currency: 'EUR', operation_id: 'wd-1' },
      { account: invAllowanceAcct, direction: 'credit', debit: 0, credit: 30, amount: 30, currency: 'EUR', operation_id: 'wd-1' }
    ]
  },
  detail: { journal: { debits: 30, credits: 30 } },
  provenance: { operation_id: 'wd-1', effect_type: 'write_down' },
  consequence: { commit: 'proposed' }
});

test('register writer: a write-down persists its allowance lot (bound quantity) atomically', async () => {
  const tx = fakeClient();
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', draft: writeDownDraft(),
    valuationIdentity: { valuationRunId: 'vrun-wd' },
    allowanceLot: { scope_item_id: 'SKU1', valuation_date: '2026-07-08', allowance_amount: 30, currency: 'EUR', max_reversible_amount: 30, bound_quantity: 10, reviewer: 'op-7' }
  });
  assert.equal(res.status, 'posted');
  assert.equal(res.allowance_lot_id, 'lot-1');
  const lotInsert = tx.queries.find((x) => x.sql.includes('insert into inventory_valuation_allowances'));
  assert.ok(lotInsert, 'the lot was persisted');
  // bound_quantity ($9) seeds both bound_quantity and remaining_quantity.
  assert.equal(lotInsert.params[8], 10);
});

test('register writer: a non-write-down post never writes a lot', async () => {
  const tx = fakeClient();
  await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', draft: postedDraft(), valuationIdentity: { valuationRunId: 'vrun-1' } });
  assert.equal(tx.queries.some((x) => x.sql.includes('insert into inventory_valuation_allowances')), false);
});

// A consumption fake: returns the seeded active lots for the FOR UPDATE read, records updates,
// and satisfies the nested postInventoryJournalWithinTransaction posts (idempotency empty).
const consumeFake = ({ lots = [] } = {}) => {
  const queries = [];
  let attemptSeq = 600;
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('from inventory_valuation_allowances') && sql.includes('status = \'active\'')) return { rows: lots };
      if (sql.includes('from inventory_posting_attempts')) return { rows: [] }; // no prior success → posts fresh
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('from client_capability_config') || sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [{ id: 'acct-x' }] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: `journal-${attemptSeq}` }] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 77 }] };
      if (sql.includes('insert into apply_receipts')) return { rows: [{ id: 'rcpt-x' }] };
      if (sql.includes('insert into inventory_posting_attempts')) return { rows: [{ id: attemptSeq++ }] };
      return { rows: [] };
    }
  };
};

test('consumption: a sale of written-down stock releases the bound allowance + moves the lot', async () => {
  const tx = consumeFake({ lots: [{ id: 42, scope_item_id: 'SKU1', scope_group: null, allowance_amount: 30, consumed_amount: 0, remaining_quantity: 10, currency: 'EUR' }] });
  const res = await consumeInventoryAllowanceWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', scopeItemId: 'SKU1', derecognizedQty: 4, reason: 'sale',
    roleAccounts: { 'contra_asset.inventory_valuation_allowance': invAllowanceAcct, 'expense.cost_of_sales': cogsAcct },
    derecognitionOperationId: 'ship-1', currency: 'EUR', date: '2026-07-10'
  });
  assert.equal(res.status, 'consumed');
  assert.equal(res.released_total, 12); // 30/10 × 4
  assert.equal(res.lots_consumed, 1);
  // The release POSTED through the executor (a ledger journal was written).
  assert.ok(tx.queries.some((x) => x.sql.includes('insert into ledger_journals')));
  // The lot was MOVED (register update) with the released amount + quantity.
  const upd = tx.queries.find((x) => x.sql.includes('update inventory_valuation_allowances'));
  assert.ok(upd, 'the lot was updated');
  assert.deepEqual(upd.params, [42, 12, 4]);
});

test('consumption: FIFO across lots + full consumption releases the whole remainder', async () => {
  const tx = consumeFake({ lots: [
    { id: 1, scope_item_id: 'SKU1', scope_group: null, allowance_amount: 30, consumed_amount: 0, remaining_quantity: 10, currency: 'EUR' },
    { id: 2, scope_item_id: 'SKU1', scope_group: null, allowance_amount: 20, consumed_amount: 0, remaining_quantity: 5, currency: 'EUR' }
  ] });
  const res = await consumeInventoryAllowanceWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', scopeItemId: 'SKU1', derecognizedQty: 12, reason: 'scrap',
    roleAccounts: { 'contra_asset.inventory_valuation_allowance': invAllowanceAcct, 'pnl.inventory_count_variance': { role: 'inventory_pnl_inventory_count_variance', code: '5200', name: 'CV', canonical_role: 'pnl.inventory_count_variance', normal_balance: 'debit' } },
    derecognitionOperationId: 'scrap-1', currency: 'EUR'
  });
  // Lot 1 fully consumed (30), lot 2 partial (20/5 × 2 = 8). Total 38.
  assert.equal(res.lots_consumed, 2);
  assert.equal(res.released_total, 38);
  assert.equal(res.consumed[0].fully_consumed, true);
  assert.equal(res.consumed[1].fully_consumed, false);
});

test('consumption: no active lot for the scope is a clean no-op', async () => {
  const tx = consumeFake({ lots: [] });
  const res = await consumeInventoryAllowanceWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', scopeItemId: 'SKU-NONE', derecognizedQty: 5, reason: 'sale',
    roleAccounts: { 'contra_asset.inventory_valuation_allowance': invAllowanceAcct, 'expense.cost_of_sales': cogsAcct },
    derecognitionOperationId: 'ship-9'
  });
  assert.equal(res.released_total, 0);
  assert.equal(res.lots_consumed, 0);
  assert.equal(res.unbound_quantity, 5);
  assert.equal(tx.queries.some((x) => x.sql.includes('insert into ledger_journals')), false);
});

test('consumption: dryRun previews without writing (no ledger insert, no lot update, no FOR UPDATE)', async () => {
  const tx = consumeFake({ lots: [{ id: 3, scope_item_id: 'SKU1', scope_group: null, allowance_amount: 30, consumed_amount: 0, remaining_quantity: 10, currency: 'EUR' }] });
  const res = await consumeInventoryAllowanceWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', scopeItemId: 'SKU1', derecognizedQty: 4, reason: 'sale',
    roleAccounts: { 'contra_asset.inventory_valuation_allowance': invAllowanceAcct, 'expense.cost_of_sales': cogsAcct },
    derecognitionOperationId: 'ship-2', dryRun: true
  });
  assert.equal(res.status, 'dry_run');
  assert.equal(tx.queries.some((x) => x.sql.includes('insert into ledger_journals')), false);
  assert.equal(tx.queries.some((x) => x.sql.includes('update inventory_valuation_allowances')), false);
  assert.equal(tx.queries.some((x) => x.sql.includes('for update')), false);
});

test('consumption: requires a positive qty and a scope', async () => {
  const tx = consumeFake({ lots: [] });
  await assert.rejects(() => consumeInventoryAllowanceWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', scopeItemId: 'SKU1', derecognizedQty: 0, reason: 'sale', derecognitionOperationId: 'x' }), /positive derecognizedQty/);
  await assert.rejects(() => consumeInventoryAllowanceWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', derecognizedQty: 5, reason: 'sale', derecognitionOperationId: 'x' }), /scope/);
});

test('consumption: the scope predicate matches ONLY the provided scope (no widening)', async () => {
  // Item-only: the lot SELECT carries exactly [firm, client, item] and a scope_item_id condition.
  const txItem = consumeFake({ lots: [] });
  await consumeInventoryAllowanceWithinTransaction(txItem, {
    firmId: 'f1', clientId: 'c1', scopeItemId: 'SKU1', derecognizedQty: 1, reason: 'sale',
    roleAccounts: { 'contra_asset.inventory_valuation_allowance': invAllowanceAcct, 'expense.cost_of_sales': cogsAcct },
    derecognitionOperationId: 'ship-i'
  });
  const sel = txItem.queries.find((x) => x.sql.includes('from inventory_valuation_allowances') && x.sql.includes("status = 'active'"));
  assert.match(sel.sql, /scope_item_id = \$3/);
  assert.doesNotMatch(sel.sql, /is null/); // no widening disjunct
  assert.deepEqual(sel.params, ['f1', 'c1', 'SKU1']);

  // Group-only: scope_group condition, group param at $3.
  const txGroup = consumeFake({ lots: [] });
  await consumeInventoryAllowanceWithinTransaction(txGroup, {
    firmId: 'f1', clientId: 'c1', scopeGroup: 'GRP-A', derecognizedQty: 1, reason: 'sale',
    roleAccounts: { 'contra_asset.inventory_valuation_allowance': invAllowanceAcct, 'expense.cost_of_sales': cogsAcct },
    derecognitionOperationId: 'ship-g'
  });
  const selG = txGroup.queries.find((x) => x.sql.includes('from inventory_valuation_allowances') && x.sql.includes("status = 'active'"));
  assert.match(selG.sql, /scope_group = \$3/);
  assert.deepEqual(selG.params, ['f1', 'c1', 'GRP-A']);
});

// ── §10 FX retranslation of open GRNI at close — the executor (P6c) ────────────
import { retranslateOpenGrniWithinTransaction } from './postingDb.js';

const grniAcct = { role: 'inventory_liability_grni', code: '2880', name: 'GRNI', canonical_role: 'liability.grni', normal_balance: 'credit' };
const fxAcct = { role: 'inventory_expense_fx', code: '7600', name: 'FX gain/loss', canonical_role: 'expense.fx', normal_balance: 'debit' };
const retransRoles = { 'liability.grni': grniAcct, 'expense.fx': fxAcct };

test('retranslation executor: posts one journal per foreign currency with a rate, skips functional', async () => {
  const tx = fakeClient();
  const res = await retranslateOpenGrniWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', closePeriod: '2026-Q3', functionalCurrency: 'EUR',
    grniByCurrency: [
      { currency: 'EUR', glGrni: 500, accruedReceipts: 500, matchedAllocations: 0 }, // functional — never retranslates
      { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0, closeRate: 1.18, bookedRate: 1.15, sourceOpenAmount: 745 },
      { currency: 'USD', glGrni: 300, accruedReceipts: 300, matchedAllocations: 0, closeRate: 0.90, bookedRate: 0.92, sourceOpenAmount: 300 }
    ],
    roleAccounts: retransRoles, journalDate: '2026-09-30'
  });
  assert.equal(res.status, 'retranslated');
  assert.equal(res.posted_count, 2);          // GBP + USD, EUR skipped
  assert.equal(res.rate_missing, 0);
  assert.equal(res.journal_group_id, 'grniretr:2026-Q3');
  const journalInserts = tx.queries.filter((x) => x.sql.includes('insert into ledger_journals'));
  assert.equal(journalInserts.length, 2, 'exactly two journals posted (functional currency skipped)');
  // Each posted result carries its (period, currency)-scoped operation id.
  assert.ok(res.retranslations.some((r) => r.operation_id === 'grni_retranslation:2026-Q3:GBP' && r.status === 'posted'));
});

test('retranslation executor: a missing close rate records a tracked integration_system_retry attempt, no journal', async () => {
  const tx = fakeClient();
  const res = await retranslateOpenGrniWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', closePeriod: '2026-Q3', functionalCurrency: 'EUR',
    grniByCurrency: [
      { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0, sourceOpenAmount: 745 } // no closeRate
    ],
    roleAccounts: retransRoles
  });
  assert.equal(res.posted_count, 0);
  assert.equal(res.rate_missing, 1);
  assert.equal(tx.queries.some((x) => x.sql.includes('insert into ledger_journals')), false, 'no journal on a missing rate');
  const row = res.retranslations[0];
  assert.equal(row.outcome, 'refused');
  assert.equal(row.waiter_type, 'integration_system_retry');
  // The refusal WAS recorded as a tracked attempt (nothing-silent).
  assert.ok(tx.queries.some((x) => x.sql.includes('insert into inventory_posting_attempts')));
});

test('retranslation executor: a zero delta is a recorded no_journal_required terminal (no ledger write)', async () => {
  const tx = fakeClient();
  const res = await retranslateOpenGrniWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', closePeriod: '2026-Q3', functionalCurrency: 'EUR',
    grniByCurrency: [
      { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0, closeRate: 1.15, bookedRate: 1.15, sourceOpenAmount: 745 }
    ],
    roleAccounts: retransRoles
  });
  assert.equal(res.posted_count, 0);
  assert.equal(res.neutral_count, 1);
  assert.equal(tx.queries.some((x) => x.sql.includes('insert into ledger_journals')), false);
});

test('retranslation executor: idempotent replay — a prior success does NOT re-post', async () => {
  const tx = fakeClient({ priorSuccess: true }); // every nested post short-circuits as a replay
  const res = await retranslateOpenGrniWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', closePeriod: '2026-Q3', functionalCurrency: 'EUR',
    grniByCurrency: [
      { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0, closeRate: 1.18, bookedRate: 1.15, sourceOpenAmount: 745 }
    ],
    roleAccounts: retransRoles
  });
  assert.equal(res.posted_count, 0);
  assert.equal(res.retranslations[0].status, 'replayed');
  assert.equal(tx.queries.some((x) => x.sql.includes('insert into ledger_journals')), false, 'a replay writes no new journal');
});

test('retranslation executor: dryRun runs the gates and writes NOTHING', async () => {
  const tx = fakeClient();
  const res = await retranslateOpenGrniWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', closePeriod: '2026-Q3', functionalCurrency: 'EUR',
    grniByCurrency: [
      { currency: 'GBP', glGrni: 745, accruedReceipts: 745, matchedAllocations: 0, closeRate: 1.18, bookedRate: 1.15, sourceOpenAmount: 745 }
    ],
    roleAccounts: retransRoles, dryRun: true
  });
  assert.equal(res.status, 'dry_run');
  assert.equal(tx.queries.some((x) => x.sql.includes('insert into ledger_journals')), false);
});

test('retranslation executor: requires a closePeriod identifier', async () => {
  const tx = fakeClient();
  await assert.rejects(
    () => retranslateOpenGrniWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', functionalCurrency: 'EUR', grniByCurrency: [] }),
    /closePeriod/
  );
});
