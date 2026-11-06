// AE ae_vat_return — the deadline-escalation drain.
//   node --test server/donna/aeVatReturnDeadlineEscalationDb.test.js
//
// Fake-pg-client idiom (aeVatThresholdEscalationDb.test.js): the drain takes
// the client directly, so the fake answers each query by SQL fragment and
// logs everything. The drain's preparation attempt runs the REAL route
// (dynamic import), so the fake also answers the route's period and ledger
// reads — distinguishable by fragment: the drain's period query filters
// status = 'open', the route's does not; the route's ledger read joins
// ledger_journals.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drainAeVatReturnDeadlineEscalations
} from './statutoryRegistry.js';

const PERIOD_ROW = { id: 'p1', period_key: 'Apr-Jun 2026', start_date: '2026-04-01', end_date: '2026-06-30', due_date: '2026-07-28', status: 'open' };
const REGISTERED_PROFILE = {
  vat_registration: { status: 'registered', registered_from: '2020-01-01', vat_registration_number: '100 1234 5678 9012' },
  ae_establishment: { emirate: 'DXB' }
};

const fakeClient = ({
  candidates = [],
  periods = [],
  ledgerLines = [],
  askInsertReturnsRow = true
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes("c.profile->>'jurisdiction'")) return { rows: candidates };
      if (sql.includes('from ae_vat_periods') && sql.includes("status = 'open'")) return { rows: periods };
      if (sql.includes('from ae_vat_periods')) return { rows: periods };
      if (sql.includes('from ledger_lines')) return { rows: ledgerLines };
      if (sql.includes('insert into client_evidence_requests')) {
        return { rows: askInsertReturnsRow ? [{ id: params[0] }] : [] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const CANDIDATE = { firm_id: 'firm-1', client_id: 'client-1', profile: REGISTERED_PROFILE };

test('a due period on a clean nil book mints the prepared ask + audit in one txn, then delivers', async () => {
  const client = fakeClient({ candidates: [CANDIDATE], periods: [PERIOD_ROW] });
  const delivered = [];
  const summary = await drainAeVatReturnDeadlineEscalations({
    client,
    asOf: '2026-07-20',
    deliverAsksImpl: async (args) => { delivered.push(args); }
  });
  assert.deepEqual(
    { due_periods: summary.due_periods, minted: summary.minted, delivered: summary.delivered, errors: summary.errors },
    { due_periods: 1, minted: 1, delivered: 1, errors: 0 }
  );
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[0], 'vat-return-deadline-firm-1-client-1-p1');
  assert.equal(askInsert.params[3], 'vat_return_deadline');
  assert.match(askInsert.params[4], /due 2026-07-28/);
  assert.match(askInsert.params[4], /net VAT payable of AED 0\.00/, 'a nil book prepares as figures, not a blocker');
  const auditInsert = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.equal(auditInsert.params[2], 'vat_return.deadline_escalated');
  const beginIdx = client.queries.findIndex((q) => q.sql === 'begin');
  const commitIdx = client.queries.findIndex((q) => q.sql === 'commit');
  assert.ok(beginIdx < client.queries.indexOf(askInsert) && client.queries.indexOf(auditInsert) < commitIdx,
    'mint and audit sit inside one transaction');
  assert.deepEqual(delivered[0].evidenceRequestIds, ['vat-return-deadline-firm-1-client-1-p1']);
});

test('a preparation refusal becomes the ask content — the blocker is named, still minted', async () => {
  const client = fakeClient({
    candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: { vat_registration: REGISTERED_PROFILE.vat_registration } }],
    periods: [PERIOD_ROW],
    ledgerLines: [
      { journal_id: 'j1', line_no: 1, debit: 0, credit: 1000, tax_type: 'AE_VAT_SR_5_OUTPUT', account_type: 'revenue', currency:'AED', journal_date:'2026-04-01',
        tax_point:{document_id:'doc-j1',evidence_digest:'fixture-digest',actor_id:'fixture-member',authority_basis:'transaction_review_correction',date_of_supply:'2026-04-01',reporting_date:'2026-04-01'} },
      { journal_id: 'j1', line_no: 2, debit: 0, credit: 50, tax_type: 'NONE', account_type: 'liability', role: 'vat_output' }
    ]
  });
  const summary = await drainAeVatReturnDeadlineEscalations({
    client, asOf: '2026-07-20', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.minted, 1);
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.match(askInsert.params[4], /cannot finish preparing it yet/);
  assert.match(JSON.parse(askInsert.params[5]).refusal_code, /AE_VAT_EMIRATE_NOT_ESTABLISHED/);
});

test('a registered client with NO open periods gets the period-intake ask instead', async () => {
  const client = fakeClient({ candidates: [CANDIDATE], periods: [] });
  const delivered = [];
  const summary = await drainAeVatReturnDeadlineEscalations({
    client, asOf: '2026-07-20', deliverAsksImpl: async (args) => { delivered.push(args); }
  });
  assert.deepEqual(
    { intake_minted: summary.intake_minted, minted: summary.minted, delivered: summary.delivered },
    { intake_minted: 1, minted: 0, delivered: 1 }
  );
  assert.deepEqual(delivered[0].evidenceRequestIds, ['vat-return-period-intake-firm-1-client-1-2026']);
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[3], 'vat_return_period_intake');
});

test('a period outside the lead window stays silent', async () => {
  const client = fakeClient({ candidates: [CANDIDATE], periods: [PERIOD_ROW] });
  const summary = await drainAeVatReturnDeadlineEscalations({
    client, asOf: '2026-05-01', deliverAsksImpl: async () => { throw new Error('must not deliver'); }
  });
  assert.deepEqual({ due_periods: summary.due_periods, minted: summary.minted }, { due_periods: 0, minted: 0 });
});

test('an existing ask dedupes on the deterministic id — skipped, never re-delivered', async () => {
  const client = fakeClient({ candidates: [CANDIDATE], periods: [PERIOD_ROW], askInsertReturnsRow: false });
  const summary = await drainAeVatReturnDeadlineEscalations({
    client, asOf: '2026-07-20', deliverAsksImpl: async () => { throw new Error('must not deliver'); }
  });
  assert.deepEqual({ minted: summary.minted, skipped: summary.skipped, delivered: summary.delivered },
    { minted: 0, skipped: 1, delivered: 0 });
});

test('a not-registered or unknown client is skipped — the threshold watch owns that side', async () => {
  const unknown = { firm_id: 'firm-1', client_id: 'client-1', profile: null };
  const notRegistered = { firm_id: 'firm-1', client_id: 'client-2', profile: { vat_registration: { status: 'not_registered' } } };
  const client = fakeClient({ candidates: [unknown, notRegistered], periods: [PERIOD_ROW] });
  const summary = await drainAeVatReturnDeadlineEscalations({
    client, asOf: '2026-07-20', deliverAsksImpl: async () => { throw new Error('must not deliver'); }
  });
  assert.deepEqual({ scanned: summary.scanned, skipped: summary.skipped, minted: summary.minted },
    { scanned: 2, skipped: 2, minted: 0 });
});

test('the candidate sweep is jurisdiction-scoped (no flag join) and honours a firm filter', async () => {
  const client = fakeClient({ candidates: [] });
  const summary = await drainAeVatReturnDeadlineEscalations({ client, firmId: 'firm-9', asOf: '2026-07-20' });
  assert.deepEqual({ scanned: summary.scanned, minted: summary.minted }, { scanned: 0, minted: 0 });
  const q = client.queries[0];
  assert.deepEqual(q.params, ['firm-9']);
  assert.match(q.sql, /jurisdiction'\)\) = 'ae'/);
  assert.doesNotMatch(q.sql, /client_capability_config/);
});
