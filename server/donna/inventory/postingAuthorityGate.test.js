// Donna Inventory I4·posting — P7 §13 executor gate wiring (fake-pg). The pure check lives in
// postingAuthority.test.js and the reader in postingAuthorityDb.test.js; THIS asserts the gate is
// wired into the P5 executor correctly: OPT-IN (an attended post never consults a grant), a denial
// records a TRACKED accountant/operator refusal and writes NO ledger journal, an authorization
// posts and attributes the covering grant on the attempt, event-class kinds always escalate, and
// the aggregate ceilings bind.
//   node --test server/donna/inventory/postingAuthorityGate.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { postInventoryJournalWithinTransaction } from './postingDb.js';

const invAccount = { role: 'inventory_asset_inventory', code: '1400', name: 'Inventory', canonical_role: 'asset.inventory', tax_type: 'NONE', normal_balance: 'debit' };
const grniAccount = { role: 'inventory_liability_grni', code: '2880', name: 'GRNI', canonical_role: 'liability.grni', tax_type: 'NONE', normal_balance: 'credit' };

const draftOf = ({ operationId = 'op-a', postingKind = 'receipt', amount = 50, currency = 'EUR' } = {}) => ({
  applied: true, no_journal_required: false, operation_id: operationId, posting_kind: postingKind, valuation_run_id: 'vrun-a',
  journal: {
    source_type: 'inventory_posting', source_id: `${postingKind}:${operationId}:vrun-a`, journal_date: '2026-07-02', currency,
    status: 'proposed', memo: 'x', direction: 'internal', amount,
    accounts: [invAccount, grniAccount],
    lines: [
      { account: invAccount, direction: 'debit', debit: amount, credit: 0, amount, currency, operation_id: operationId, valuation_run_id: 'vrun-a' },
      { account: grniAccount, direction: 'credit', debit: 0, credit: amount, amount, currency, operation_id: operationId, valuation_run_id: 'vrun-a' }
    ]
  },
  detail: { journal: { debits: amount, credits: amount } },
  consequence: { changed: [`debit asset.inventory ${amount}`], commit: 'proposed' }
});

const activeGrant = (over = {}) => ({
  id: 'grant-1', status: 'active', correction_count: 0,
  allowed_posting_kinds: ['receipt'], allowed_accounts: ['asset.inventory', 'liability.grni'],
  per_journal_ceiling: 100, daily_aggregate_ceiling: null, period_aggregate_ceiling: null,
  currency: 'EUR', confidence_floor: null, evidence_required: false, jurisdiction: null,
  valid_from: '2020-01-01', expires_at: null, review_after: null, ...over
});

// Fake pg: seeds the grant load + the per-grant posted aggregates, plus the full executor path.
const fake = ({ grants = [], dailyByGrant = [], periodByGrant = [] } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{ locked: true }] };
      // §13 gate reads (must come before the generic attempts match).
      if (sql.includes('from inventory_posting_authority_grants')) return { rows: grants };
      if (sql.includes('authority_grant_id as grant_id')) {
        return { rows: sql.includes('lj.journal_date = $3') ? dailyByGrant : periodByGrant };
      }
      // executor idempotency re-fetch
      if (sql.includes('from inventory_posting_attempts') && sql.includes('posting_basis_version')) return { rows: [] };
      // gateway + persistence fakes
      if (sql.includes('from ledger_journals lj')) return { rows: [] };
      if (sql.includes('from close_periods')) return { rows: [] };
      if (sql.includes('from client_capability_config')) return { rows: [] };
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('insert into ledger_accounts')) return { rows: [{ id: 'acct-1' }] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: 'journal-a' }] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      if (sql.includes('update ledger_journals')) return { rows: [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 77 }] };
      if (sql.includes('insert into apply_receipts')) return { rows: [] };
      if (sql.includes('update proposal_targets')) return { rows: [] };
      if (sql.includes('update proposal_cards')) return { rows: [] };
      if (sql.includes('insert into inventory_posting_attempts')) return { rows: [{ id: 555 }] };
      if (sql.includes('insert into inventory_posting_journals')) return { rows: [] };
      if (sql.includes('insert into inventory_journal_allocations')) return { rows: [] };
      return { rows: [] };
    }
  };
};

const wroteLedger = (q) => q.some((x) => x.sql.includes('insert into ledger_journals'));
const readGrants = (q) => q.some((x) => x.sql.includes('from inventory_posting_authority_grants'));
const attemptRow = (q) => q.find((x) => x.sql.includes('insert into inventory_posting_attempts'));
const attemptOutcome = (q) => { const r = attemptRow(q); return r ? r.params[7] : null; };       // $8 outcome
const attemptReason = (q) => { const r = attemptRow(q); return r ? r.params[8] : null; };        // $9 reason_code
const attemptWaiter = (q) => { const r = attemptRow(q); return r ? r.params[9] : null; };        // $10 waiter_type
const attemptGrantId = (q) => { const r = attemptRow(q); return r ? r.params[16] : null; };      // $17 authority_grant_id

const auth = (over = {}) => ({ enforce: true, context: { confidence: 0.95, evidencePresent: true }, asOf: '2026-07-12', ...over });

test('ATTENDED post (no authorization) never consults a grant — the gate is opt-in', async () => {
  const tx = fake({ grants: [] });
  const res = await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', actorId: 'op', draft: draftOf() });
  assert.equal(res.status, 'posted');
  assert.ok(!readGrants(tx.queries), 'no authority-grant query issued for an attended post');
  assert.ok(wroteLedger(tx.queries));
});

test('AUTHORIZED unattended post: a covering grant lets it post, and attributes the grant on the attempt', async () => {
  const tx = fake({ grants: [activeGrant()] });
  const res = await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', actorId: 'loop', draft: draftOf(), authorization: auth() });
  assert.equal(res.status, 'posted');
  assert.ok(readGrants(tx.queries), 'the gate consulted the grant');
  assert.ok(wroteLedger(tx.queries));
  assert.equal(attemptOutcome(tx.queries), 'posted');
  assert.equal(attemptGrantId(tx.queries), 'grant-1', 'the posted attempt is attributed to the covering grant');
});

test('DENIED — no active grant: a tracked accountant/operator refusal, no ledger write', async () => {
  const tx = fake({ grants: [] });
  const res = await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', actorId: 'loop', draft: draftOf(), authorization: auth() });
  assert.equal(res.refused, true);
  assert.equal(res.reason_code, 'authority_no_grant');
  assert.equal(res.waiter_type, 'accountant_operator');
  assert.ok(!wroteLedger(tx.queries), 'a denied post writes NO ledger journal');
  assert.equal(attemptOutcome(tx.queries), 'refused');
  assert.equal(attemptWaiter(tx.queries), 'accountant_operator');
});

test('DENIED — over the per-journal ceiling: refusal names the breach, no write', async () => {
  const tx = fake({ grants: [activeGrant({ per_journal_ceiling: 40 })] }); // draft amount 50 > 40
  const res = await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', actorId: 'loop', draft: draftOf({ amount: 50 }), authorization: auth() });
  assert.equal(res.reason_code, 'authority_per_journal_ceiling');
  assert.ok(!wroteLedger(tx.queries));
  assert.equal(attemptReason(tx.queries), 'authority_per_journal_ceiling');
  assert.equal(attemptGrantId(tx.queries), 'grant-1', 'the breached grant is recorded on the refusal');
});

test('DENIED — the DAILY aggregate ceiling binds cumulative posting (already-posted + this proposal)', async () => {
  // ceiling 100, already 80 posted today under grant-1, this post 50 → 130 > 100.
  const tx = fake({ grants: [activeGrant({ daily_aggregate_ceiling: 100 })], dailyByGrant: [{ grant_id: 'grant-1', total: 80 }] });
  const res = await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', actorId: 'loop', draft: draftOf({ amount: 50 }), authorization: auth() });
  assert.equal(res.reason_code, 'authority_daily_aggregate_ceiling');
  assert.ok(!wroteLedger(tx.queries));
});

test('DENIED — an event-class kind (write_down) ALWAYS escalates, even with a covering grant', async () => {
  const tx = fake({ grants: [activeGrant({ allowed_posting_kinds: ['write_down', 'receipt'] })] });
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', actorId: 'loop', draft: draftOf({ postingKind: 'write_down' }), authorization: auth()
  });
  assert.equal(res.reason_code, 'authority_event_class_always_escalates');
  assert.ok(!wroteLedger(tx.queries));
});

test('DENIED — first-use account escalates by anomaly regardless of ceilings', async () => {
  const tx = fake({ grants: [activeGrant()] });
  const res = await postInventoryJournalWithinTransaction(tx, {
    firmId: 'f1', clientId: 'c1', actorId: 'loop', draft: draftOf(), authorization: auth({ context: { confidence: 0.99, firstUseAccount: true } })
  });
  assert.equal(res.reason_code, 'authority_event_class_always_escalates');
  assert.ok(!wroteLedger(tx.queries));
});

test('dryRun with enforcement: authorized → preview + grant id, no write; denied → refusal preview, no write', async () => {
  const okTx = fake({ grants: [activeGrant()] });
  const ok = await postInventoryJournalWithinTransaction(okTx, { firmId: 'f1', clientId: 'c1', actorId: 'loop', draft: draftOf(), authorization: auth(), dryRun: true });
  assert.equal(ok.status, 'dry_run');
  assert.equal(ok.authority_grant_id, 'grant-1');
  assert.ok(!wroteLedger(okTx.queries));

  const noTx = fake({ grants: [] });
  const denied = await postInventoryJournalWithinTransaction(noTx, { firmId: 'f1', clientId: 'c1', actorId: 'loop', draft: draftOf(), authorization: auth(), dryRun: true });
  assert.equal(denied.status, 'dry_run');
  assert.equal(denied.refused, true);
  assert.equal(denied.reason_code, 'authority_no_grant');
  assert.ok(!wroteLedger(noTx.queries));
});

test('authorization present but enforce:false is NOT enforced (staging shape)', async () => {
  const tx = fake({ grants: [] });
  const res = await postInventoryJournalWithinTransaction(tx, { firmId: 'f1', clientId: 'c1', actorId: 'op', draft: draftOf(), authorization: { enforce: false, context: {} } });
  assert.equal(res.status, 'posted');
  assert.ok(!readGrants(tx.queries), 'enforce:false does not consult a grant');
  assert.ok(wroteLedger(tx.queries));
});
