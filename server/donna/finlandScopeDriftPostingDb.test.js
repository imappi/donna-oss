// G-7P — scope-drift detection BEFORE POSTING: the seam hook in
// __writeLedgerJournalRows (D-G7P-2/3) and the daily delivery sweep for the
// posting-time asks (D-G7P-3), against a pattern-matching fake pg client.
// node --test server/donna/finlandScopeDriftPostingDb.test.js
// Design: docs/design-donna-finland-g7-posting-detection.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  __writeLedgerJournalRows
} from './firmDb.js';
import {
  deliverPendingFinlandScopeDriftAsks
} from './statutoryRegistry.js';
import { REVERSE_CHARGE_TAX_CODES } from './finland/scopeDrift.js';

const journalFixture = ({ expenseAccount = { role: 'counterparty', code: '4000', name: 'Ostot' } } = {}) => ({
  source_type: 'transaction',
  source_id: 'tx-1',
  journal_date: '2026-07-11',
  currency: 'EUR',
  memo: 'test journal',
  accounts: [expenseAccount, { role: 'bank', code: '1910', name: 'Pankkitili' }],
  lines: [
    { direction: 'debit', debit: 100, credit: 0, amount: 100, currency: 'EUR', account: expenseAccount },
    { direction: 'credit', debit: 0, credit: 100, amount: 100, currency: 'EUR', account: { role: 'bank', code: '1910', name: 'Pankkitili' } }
  ]
});

const fakeClient = ({ flags = {}, askInsertReturns = true, entityType = null } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update') {
        assert.deepEqual(params,['firm-1','client-1']);
        return {rows:[]};
      }
      // FI-13 13.3A — the entity read the drift path takes only after a trigger
      // fires; a trigger-free post never reaches it (the byte-identical fast path).
      // Canonical lineage observes the same unmarked client and empty initial chart.
      if (sql.includes('as birth_created_at') && sql.includes('from clients')) return { rows: [{ id: params[1], firm_id: params[0], birth_created_at: null, jurisdiction: 'FI', entity_type: entityType, profile: null }] };
      if (sql.includes('from audit_events where firm_id=$1 and resource_id=$2')) return { rows: [] };
      if (sql === 'select id,code,name,account_type,normal_balance,canonical_role,status,currency,payload\n    from ledger_accounts where firm_id=$1 and client_id=$2 order by id') return { rows: [] };
      if (sql.includes('entity_type') && sql.includes('from clients')) {
        return { rows: [{ jurisdiction: 'FI', entity_type: entityType, profile: null }] };
      }
      if (sql.includes('from client_capability_config')) {
        return { rows: Object.entries(flags).map(([flag_key, stage]) => ({ flag_key, stage, source: 'test', client_id: 'client-1' })) };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('insert into audit_events')) return { rows: [{ id: 1 }] };
      if (sql.includes('insert into client_evidence_requests')) {
        return askInsertReturns ? { rows: [{ id: params[0] }] } : { rows: [] };
      }
      if (sql.includes('insert into ledger_accounts')) return { rows: [] };
      if (sql.includes('insert into ledger_journals')) return { rows: [{ id: params[0] }] };
      if (sql.includes('delete from ledger_lines')) return { rows: [] };
      if (sql.includes('insert into ledger_lines')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const write = ({ client, journal }) => __writeLedgerJournalRows({
  client, firmId: 'firm-1', clientId: 'client-1', journal, payload: { source: 'test' }
});

const auditActions = (client) => client.queries
  .filter((q) => q.sql.includes('insert into audit_events'))
  .map((q) => (q.sql.match(/'(ledger\.scope_drift_detected|scope_drift\.escalated)'/) || [])[1])
  .filter(Boolean);

const journalPayloadParam = (client) => {
  const q = client.queries.find((x) => x.sql.includes('insert into ledger_journals'));
  return JSON.parse(q.params[8]);
};

test('a trigger-free journal keeps the scope-drift fast path: no drift-gate read before the insert, no stamp, no ask', async () => {
  const client = fakeClient({ flags: { FINLAND_SCOPE_DRIFT_POSTING_GATE: 'auto' } });
  await write({ client, journal: journalFixture() });
  // The only snapshot read is the tosite allocator's, and it happens AFTER the
  // journal insert — the drift block never touched the connection.
  const journalInsertIx = client.queries.findIndex((q) => q.sql.includes('insert into ledger_journals'));
  const firstSnapshotIx = client.queries.findIndex((q) =>
    q.sql.includes('from client_capability_config')
      && q.params?.[2] !== 'ENTITY_READINESS_ADMISSION');
  assert.ok(journalInsertIx >= 0);
  assert.ok(firstSnapshotIx > journalInsertIx, 'no scope-drift config read precedes the insert on a healthy journal');
  assert.deepEqual(auditActions(client), []);
  assert.equal(client.queries.some((q) => q.sql.includes('client_evidence_requests')), false);
  assert.equal(journalPayloadParam(client).scope_drift, undefined);
});

test('a fired trigger with the gate DARK posts unstamped (one gate read, zero writes)', async () => {
  const client = fakeClient({ flags: {} });
  await write({
    client,
    journal: journalFixture({ expenseAccount: { role: 'counterparty', code: '5000', name: 'Palkat' } })
  });
  assert.deepEqual(auditActions(client), []);
  assert.equal(client.queries.some((q) => q.sql.includes('client_evidence_requests')), false);
  assert.equal(journalPayloadParam(client).scope_drift, undefined);
});

test('country admission reads persisted identity even for a trigger-free journal', async () => {
  const client = fakeClient({ flags: { FINLAND_SCOPE_DRIFT_POSTING_GATE: 'auto' } });
  await write({ client, journal: journalFixture() });
  assert.equal(
    client.queries.some((q) => q.sql.includes('entity_type') && q.sql.includes('from clients')),
    true,
    'country context must be resolved before choosing any admission policy'
  );
});

test('gate acting on an fi-oy: the personnel signal posts as payroll_activity (review), not first_employee', async () => {
  const client = fakeClient({ flags: { FINLAND_SCOPE_DRIFT_POSTING_GATE: 'canary' }, entityType: 'fi-oy' });
  await write({
    client,
    journal: journalFixture({ expenseAccount: { role: 'counterparty', code: '5000', name: 'Palkat' } })
  });
  assert.deepEqual(auditActions(client), ['ledger.scope_drift_detected', 'scope_drift.escalated']);
  const stamped = journalPayloadParam(client);
  assert.equal(stamped.scope_drift.verdict, 'supported_with_review');
  assert.deepEqual(stamped.scope_drift.triggers.map((t) => t.id), ['payroll_activity']);
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[0], 'scope-drift-firm-1-client-1-payroll_activity');
});

test('gate acting: in-txn receipt + stamped payload + ONE deterministic owner ask per trigger', async () => {
  const client = fakeClient({ flags: { FINLAND_SCOPE_DRIFT_POSTING_GATE: 'canary' } });
  const reverseChargeAccount = { role: 'counterparty', code: '4000', name: 'Alihankinta', tax_type: REVERSE_CHARGE_TAX_CODES[1] };
  await write({ client, journal: journalFixture({ expenseAccount: reverseChargeAccount }) });

  assert.deepEqual(auditActions(client), ['ledger.scope_drift_detected', 'scope_drift.escalated']);

  const stamped = journalPayloadParam(client);
  assert.equal(stamped.source, 'test'); // the caller's payload survives
  assert.equal(stamped.scope_drift.verdict, 'filing_blocked');
  assert.deepEqual(stamped.scope_drift.triggers.map((t) => t.id), ['construction_reverse_charge']);

  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[0], 'scope-drift-firm-1-client-1-construction_reverse_charge');
  assert.ok(askInsert.sql.includes('on conflict (id) do nothing'));
  assert.equal(askInsert.params[3], 'scope_drift_review');
  assert.match(askInsert.params[4], /käännetyn verovelvollisuuden/);
  const requestPayload = JSON.parse(askInsert.params[5]);
  assert.equal(requestPayload.trigger_id, 'construction_reverse_charge');
  assert.equal(requestPayload.severity, 'filing_blocked');

  // The receipt precedes the stamped insert — no stamped journal without it.
  const receiptIx = client.queries.findIndex((q) => q.sql.includes('ledger.scope_drift_detected'));
  const insertIx = client.queries.findIndex((q) => q.sql.includes('insert into ledger_journals'));
  assert.ok(receiptIx >= 0 && receiptIx < insertIx);
});

test('a repeat firing never re-nags: the ask conflict swallows the mint and the escalated receipt is skipped', async () => {
  const client = fakeClient({ flags: { FINLAND_SCOPE_DRIFT_POSTING_GATE: 'auto' }, askInsertReturns: false });
  await write({
    client,
    journal: journalFixture({ expenseAccount: { role: 'counterparty', code: '5000', name: 'Palkat' } })
  });
  // Detection receipt + stamp still happen (this JOURNAL is new evidence);
  // only the owner-ask side is deduped.
  assert.deepEqual(auditActions(client), ['ledger.scope_drift_detected']);
  assert.equal(journalPayloadParam(client).scope_drift.verdict, 'migration_required');
});

// ----- the delivery sweep (D-G7P-3's after-commit half) ----------------------------

const sweepClient = ({ pending = [] } = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'select id from ledger_accounts where firm_id=$1 and client_id=$2 order by id for update') {
        assert.deepEqual(params,['firm-1','client-1']);
        return {rows:[]};
      }
      if (sql.includes('from client_evidence_requests r')) return { rows: pending };
      if (sql.includes('update client_evidence_requests')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

test('delivery sweep: skipped (unbound/flag-off) retries tomorrow; held by the send gate retries tomorrow; only the deliverer stamps', async () => {
  const client = sweepClient({
    pending: [
      { id: 'scope-drift-f-c1-first_employee', firm_id: 'f', client_id: 'c1' },
      { id: 'scope-drift-f-c2-cash_activity', firm_id: 'f', client_id: 'c2' },
      { id: 'scope-drift-f-c3-cash_activity', firm_id: 'f', client_id: 'c3' }
    ]
  });
  const delivered = [];
  const summary = await deliverPendingFinlandScopeDriftAsks({
    client,
    deliverAsksImpl: async ({ clientId, evidenceRequestIds }) => {
      delivered.push({ clientId, evidenceRequestIds });
      if (clientId === 'c1') return { whatsapp: { skipped: true, reason: 'unbound' }, delivered: [] };
      if (clientId === 'c3') return { refused: 'INTERNAL_PILOT_SEND_DISABLED' };
      return { whatsapp: { sent: 1, delivered: evidenceRequestIds }, delivered: evidenceRequestIds };
    }
  });
  assert.deepEqual(summary, { pending: 3, attempted: 1, held: 1, skipped: 1, errors: 0 });
  assert.equal(delivered.length, 3);
  // The sweep never writes a sent stamp itself: the deliverer that delivered did.
  const updates = client.queries.filter((q) => q.sql.includes('update client_evidence_requests'));
  assert.equal(updates.length, 0);
});

test('delivery sweep: a throwing send is counted, never fatal; empty backlog is a quiet no-op', async () => {
  const failing = sweepClient({ pending: [{ id: 'a1', firm_id: 'f', client_id: 'c' }] });
  const summary = await deliverPendingFinlandScopeDriftAsks({
    client: failing,
    deliverAsksImpl: async () => { throw new Error('meta down'); }
  });
  assert.deepEqual(summary, { pending: 1, attempted: 0, held: 0, skipped: 0, errors: 1 });

  const idle = sweepClient({ pending: [] });
  const quiet = await deliverPendingFinlandScopeDriftAsks({ client: idle, deliverAsksImpl: async () => ({ sent: 1 }) });
  assert.deepEqual(quiet, { pending: 0, attempted: 0, held: 0, skipped: 0, errors: 0 });
});
