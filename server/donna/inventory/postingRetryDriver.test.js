// Donna Inventory I4·posting — P7 §12 retry re-post: the ACTION driver (fake-pg). Asserts the
// driver drives ONLY due `retry` dispositions, re-invokes the P5 executor with the rebuilt draft
// (routing every ledger write through the ONE post path), classifies met/unmet/unhandled correctly,
// forwards dryRun, and leaves escalate/open_incident/wait/human_owned untouched.
//   node --test server/donna/inventory/postingRetryDriver.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  driveInventoryWaiterRetriesWithinTransaction
} from './postingRetryDriver.js';
import { DEFAULT_RETRY_BACKOFF_MS } from './postingWaiters.js';

const T0 = '2026-07-12T00:00:00.000Z';
// A clock past backoff[0] after T0 → a retry with retry_count 1 anchored at T0 is DUE.
const DUE_NOW = new Date(Date.parse(T0) + DEFAULT_RETRY_BACKOFF_MS[1] + 1000);

const invAccount = { role: 'inventory_asset_inventory', code: '1400', name: 'Inventory', canonical_role: 'asset.inventory', tax_type: 'NONE', normal_balance: 'debit' };
const grniAccount = { role: 'inventory_liability_grni', code: '2880', name: 'GRNI', canonical_role: 'liability.grni', tax_type: 'NONE', normal_balance: 'credit' };

// A success draft — the condition is NOW MET, the executor posts.
const metDraft = (operationId, postingKind) => ({
  applied: true, no_journal_required: false, operation_id: operationId, posting_kind: postingKind, valuation_run_id: 'vrun-r',
  journal: {
    source_type: 'inventory_posting', source_id: `${postingKind}:${operationId}:vrun-r`, journal_date: '2026-07-02', currency: 'EUR',
    status: 'proposed', memo: 'retry re-post', direction: 'internal', amount: 40,
    accounts: [invAccount, grniAccount],
    lines: [
      { account: invAccount, direction: 'debit', debit: 40, credit: 0, amount: 40, currency: 'EUR', memo: 'r', operation_id: operationId, valuation_run_id: 'vrun-r' },
      { account: grniAccount, direction: 'credit', debit: 0, credit: 40, amount: 40, currency: 'EUR', memo: 'r', operation_id: operationId, valuation_run_id: 'vrun-r' }
    ]
  },
  detail: { journal: { debits: 40, credits: 40 } },
  consequence: { changed: ['debit asset.inventory 40', 'credit liability.grni 40'], commit: 'proposed' }
});

// A refusal draft — the condition is STILL UNMET; the executor records a fresh tracked attempt
// (waiter_type integration_system_retry), advancing exhaustion. No ledger write.
const unmetDraft = (operationId, postingKind) => ({
  applied: false, operation_id: operationId, posting_kind: postingKind, valuation_run_id: 'vrun-r',
  reason: 'missing_close_fx_rate', waiter_type: 'integration_system_retry',
  detail: { next_action: 'await_fx_fact' }
});

// Fake pg: seeds the drain reads (heads + integration-retry counts) and the full executor path
// (idempotency re-fetch, gateway insert, audit, receipt, attempt insert, refusal insert). Records
// every query.
const fake = ({ heads = [], retryCounts = [], priorSuccess = false } = {}) => {
  const queries = [];
  let attemptSeq = 700;
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
      if (sql.includes('from inventory_posting_heads')) return { rows: heads };
      if (sql.includes('from inventory_posting_attempts') && sql.includes('group by operation_id')) return { rows: retryCounts };
      if (sql.includes('from inventory_posting_attempts') && sql.includes('posting_basis_version')) {
        return { rows: priorSuccess ? [{ id: 690, outcome: 'posted', apply_receipt_id: 'rcpt-old', audit_event_id: 12, proposal_hash: 'h' }] : [] };
      }
      // gateway + persistence fakes (mirror postingDb.test.js)
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('from client_capability_config')) return { rows: [] };
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [{ id: 'acct-1' }] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-r' }] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('update ledger_journals')) return { rows: [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 88 }] };
      if (sql.includes('insert into apply_receipts')) return { rows: [] };
      if (sql.includes('update proposal_targets')) return { rows: [] };
      if (sql.includes('update proposal_cards')) return { rows: [] };
      if (sql.includes('insert into inventory_posting_attempts')) return { rows: [{ id: attemptSeq++ }] };
      if (sql.includes('insert into inventory_posting_journals')) return { rows: [] };
      if (sql.includes('insert into inventory_journal_allocations')) return { rows: [] };
      return { rows: [] };
    }
  };
};

const wroteLedger = (q) => q.some((x) => x.sql.includes('insert into ledger_journals'));
const attemptOutcomes = (q) => q.filter((x) => x.sql.includes('insert into inventory_posting_attempts')).map((x) => x.params[7]);

// One due integration-retry head (retry_count 1, anchored at T0 → due under DUE_NOW).
const dueRetryHead = (operationId = 'op1', postingKind = 'grni_retranslation') =>
  ({ heads: [{ attempt_id: 31, operation_id: operationId, posting_kind: postingKind, outcome: 'refused', waiter_type: 'integration_system_retry', reason_code: 'missing_close_fx_rate', next_action: 'await_fx_fact', created_at: T0 }], retryCounts: [{ operation_id: operationId, posting_kind: postingKind, retry_count: 1 }] });

test('a due retry whose condition is NOW MET re-posts through the executor', async () => {
  const tx = fake(dueRetryHead());
  const res = await driveInventoryWaiterRetriesWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', actorId: 'retry-cron', now: DUE_NOW,
    rebuild: ({ item }) => ({ draft: metDraft(item.operation_id, item.posting_kind), valuationIdentity: { valuationRunId: 'vrun-r' }, relationship: 'delta_adjustment' })
  });
  assert.equal(res.due_retries, 1);
  assert.equal(res.summary.reposted, 1);
  assert.equal(res.results[0].disposition, 'reposted');
  assert.equal(res.results[0].ledger_journal_id, 'journal-r');
  assert.ok(wroteLedger(tx.queries), 'the re-post wrote a ledger journal');
  assert.deepEqual(attemptOutcomes(tx.queries), ['posted']);
});

test('a due retry whose condition is STILL UNMET records a fresh tracked attempt (no ledger write), advancing exhaustion', async () => {
  const tx = fake(dueRetryHead());
  const res = await driveInventoryWaiterRetriesWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', actorId: 'retry-cron', now: DUE_NOW,
    rebuild: ({ item }) => ({ draft: unmetDraft(item.operation_id, item.posting_kind) })
  });
  assert.equal(res.summary.still_waiting, 1);
  assert.equal(res.summary.reposted, 0);
  assert.equal(res.results[0].disposition, 'still_waiting');
  assert.equal(res.results[0].waiter_type, 'integration_system_retry');
  assert.equal(res.results[0].reason_code, 'missing_close_fx_rate');
  assert.ok(!wroteLedger(tx.queries), 'a still-unmet retry writes NO ledger journal');
  // A fresh integration_system_retry attempt IS recorded (advances the retry count toward slice A).
  assert.deepEqual(attemptOutcomes(tx.queries), ['refused']);
});

test('a retry with no resolver is surfaced as unhandled, never silently posted', async () => {
  const tx = fake(dueRetryHead());
  const res = await driveInventoryWaiterRetriesWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', now: DUE_NOW, rebuild: () => null
  });
  assert.equal(res.summary.unhandled, 1);
  assert.equal(res.results[0].disposition, 'unhandled');
  assert.ok(!wroteLedger(tx.queries));
  assert.deepEqual(attemptOutcomes(tx.queries), [], 'no attempt written when unhandled');
});

test('a NOT-due retry (wait) is not driven — the driver only actions due retries', async () => {
  // retry_count 1 anchored at T0, but the clock is only 1s past T0 → next attempt not yet due → wait.
  const tx = fake(dueRetryHead());
  let rebuildCalls = 0;
  const res = await driveInventoryWaiterRetriesWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', now: new Date(Date.parse(T0) + 1000),
    rebuild: () => { rebuildCalls += 1; return null; }
  });
  assert.equal(res.due_retries, 0);
  assert.equal(rebuildCalls, 0, 'rebuild is never called for a not-due retry');
  assert.equal(res.plan_summary.wait, 1);
});

test('escalate / open_incident / human_owned dispositions are echoed but never actioned by this driver', async () => {
  const tx = fake({
    heads: [
      { operation_id: 'opE', posting_kind: 'receipt', outcome: 'refused', waiter_type: 'integration_system_retry', created_at: T0 }, // exhausted → escalate
      { operation_id: 'opI', posting_kind: 'write_down', outcome: 'refused', waiter_type: 'engineering_incident', created_at: T0 },   // open_incident
      { operation_id: 'opH', posting_kind: 'shipment_cogs', outcome: 'refused', waiter_type: 'owner', created_at: T0 }                // human_owned
    ],
    retryCounts: [{ operation_id: 'opE', posting_kind: 'receipt', retry_count: 99 }]
  });
  let rebuildCalls = 0;
  const res = await driveInventoryWaiterRetriesWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', now: DUE_NOW, rebuild: () => { rebuildCalls += 1; return null; }
  });
  assert.equal(res.due_retries, 0, 'none of these are `retry`');
  assert.equal(rebuildCalls, 0);
  assert.equal(res.plan_summary.escalate, 1);
  assert.equal(res.plan_summary.open_incident, 1);
  assert.equal(res.plan_summary.human_owned, 1);
  assert.ok(!wroteLedger(tx.queries), 'the retry driver posts nothing for non-retry dispositions');
});

test('dryRun forwards to the executor — a due retry previews, writes nothing', async () => {
  const tx = fake(dueRetryHead());
  const res = await driveInventoryWaiterRetriesWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', now: DUE_NOW, dryRun: true,
    rebuild: ({ item }) => ({ draft: metDraft(item.operation_id, item.posting_kind), valuationIdentity: { valuationRunId: 'vrun-r' } })
  });
  assert.equal(res.status, 'dry_run');
  assert.ok(!wroteLedger(tx.queries), 'dryRun writes no ledger journal');
  assert.deepEqual(attemptOutcomes(tx.queries), [], 'dryRun writes no attempt row');
});

test('required args are enforced (no silent no-op)', async () => {
  await assert.rejects(driveInventoryWaiterRetriesWithinTransaction(fake(), { firmId: 'f1', clientId: 'c1' }), /rebuild/);
  await assert.rejects(driveInventoryWaiterRetriesWithinTransaction(fake(), { firmId: 'f1', rebuild: () => null }), /clientId/);
  await assert.rejects(driveInventoryWaiterRetriesWithinTransaction(null, { firmId: 'f1', clientId: 'c1', rebuild: () => null }), /transaction client/);
});

test('degrades to empty (nothing due) pre-migration — the drain read returns nothing', async () => {
  const throwing = { async query(sql) { if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }; const e = new Error('missing'); e.code = '42P01'; throw e; } };
  const res = await driveInventoryWaiterRetriesWithinTransaction(throwing, { firmId: 'f1', clientId: 'c1', now: DUE_NOW, rebuild: () => null });
  assert.equal(res.due_retries, 0);
  assert.deepEqual(res.summary, { reposted: 0, still_waiting: 0, no_journal: 0, blocked: 0, already_applied: 0, unhandled: 0 });
});
