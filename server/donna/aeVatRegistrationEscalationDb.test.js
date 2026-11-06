// AE ae_vat_registration — the registration-status drain, fake-pg-client
// idiom (aeCtRegistrationEscalationDb.test.js): the drain takes the client
// directly, so the fake answers each query by SQL fragment and logs
// everything. The real-PG acceptance fixture is
// aeVatRegistrationPgLifecycle.test.js; this file pins the branch table and
// the writer discipline without a database.
//   node --test server/donna/aeVatRegistrationEscalationDb.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drainAeVatRegistrationEscalations
} from './statutoryRegistry.js';
import { drainAeVatRegistrationEscalations as drainDirect, findAeVatActivityEvidence } from './ae/vatRegistrationEscalationDb.js';

const fakeClient = ({
  candidates = [],
  latestAsk = null,
  coded = [],
  posted = [],
  invoices = [],
  askInsertReturnsRow = true
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes("c.profile->>'jurisdiction'")) return { rows: candidates };
      if (sql.includes("evidence_type = $3") && sql.includes('from client_evidence_requests')) return { rows: latestAsk ? [latestAsk] : [] };
      if (sql.includes("'vat_control_account_coding'")) return { rows: coded };
      if (sql.includes("'vat_control_account_posting'")) return { rows: posted };
      if (sql.includes("'vat_bearing_sales_invoice'")) return { rows: invoices };
      if (sql.includes('insert into client_evidence_requests')) {
        return { rows: askInsertReturnsRow ? [{ id: params[0] }] : [] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const CODED = [{ kind: 'vat_control_account_coding', ref: 'tx-fta', on_date: '2026-04-28', amount: '1250.00', currency: 'AED', label: 'FTA VAT PAYMENT' }];

test('the firmDb re-export reaches the lane drain (outbound never imports ae/ directly)', async () => {
  const client = fakeClient({ candidates: [] });
  const summary = await drainAeVatRegistrationEscalations({ client, firmId: 'firm-9', asOf: '2026-09-01' });
  assert.deepEqual({ scanned: summary.scanned, minted: summary.minted }, { scanned: 0, minted: 0 });
  const q = client.queries[0];
  assert.deepEqual(q.params, ['firm-9']);
  assert.match(q.sql, /jurisdiction'\)\) = 'ae'/);
  assert.doesNotMatch(q.sql, /client_capability_config/);
});

test('an unknown registration with a coded FTA VAT payment mints ONE ask + audit in one txn, then delivers', async () => {
  const client = fakeClient({ candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: {} }], coded: CODED });
  const delivered = [];
  const summary = await drainDirect({ client, asOf: '2026-09-01', deliverAsksImpl: async (args) => { delivered.push(args); } });
  assert.deepEqual(
    { scanned: summary.scanned, evidence_seen: summary.evidence_seen, minted: summary.minted, delivered: summary.delivered, errors: summary.errors },
    { scanned: 1, evidence_seen: 1, minted: 1, delivered: 1, errors: 0 }
  );
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[0], 'vat-registration-status-firm-1-client-1-2026-09-01');
  assert.equal(askInsert.params[3], 'vat_registration_status');
  assert.match(askInsert.params[4], /Your books show a bank line coded to your VAT payable account on 2026-04-28 \(AED 1,250\.00\)/);
  assert.match(askInsert.params[4], /15-digit VAT TRN/);
  const payload = JSON.parse(askInsert.params[5]);
  assert.equal(payload.reason, 'status_unknown_with_activity');
  assert.equal(payload.registration_reason, 'no_record');
  assert.deepEqual(payload.vat_activity_evidence, [{ kind: 'vat_control_account_coding', ref: 'tx-fta', on_date: '2026-04-28', amount: 1250, currency: 'AED', label: 'FTA VAT PAYMENT' }]);
  const auditInsert = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.match(auditInsert.sql, /'vat_registration\.status_asked'/);
  assert.equal(JSON.parse(auditInsert.params[3]).authority_basis, 'statutory_obligation:ae_vat_registration');
  const beginIdx = client.queries.findIndex((q) => q.sql === 'begin');
  const commitIdx = client.queries.findIndex((q) => q.sql === 'commit');
  assert.ok(beginIdx < client.queries.indexOf(askInsert) && client.queries.indexOf(auditInsert) < commitIdx,
    'mint and audit sit inside one transaction');
  assert.deepEqual(delivered[0].evidenceRequestIds, ['vat-registration-status-firm-1-client-1-2026-09-01']);
});

test('an unknown registration with NO activity is still asked on the sweep (the onboarding fact), plain copy', async () => {
  const client = fakeClient({ candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: {} }] });
  const summary = await drainDirect({ client, asOf: '2026-09-01', deliverAsksImpl: async () => {} });
  assert.deepEqual({ minted: summary.minted, evidence_seen: summary.evidence_seen }, { minted: 1, evidence_seen: 0 });
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.match(askInsert.params[4], /^I do not have your VAT registration on file/);
  assert.equal(JSON.parse(askInsert.params[5]).reason, 'status_unknown');
});

test('an open ask dedupes per client — no evidence read is wasted on a mint that cannot happen', async () => {
  const client = fakeClient({
    candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: {} }],
    latestAsk: { id: 'vat-registration-status-firm-1-client-1-2026-08-30', status: 'open' },
    coded: CODED
  });
  const summary = await drainDirect({ client, asOf: '2026-09-01', deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
  assert.deepEqual({ minted: summary.minted, skipped: summary.skipped, skip_reasons: summary.skip_reasons }, { minted: 0, skipped: 1, skip_reasons: { ask_open: 1 } });
});

test('a recorded registration discharges — skipped without an evidence read; the return lane owns the next ask', async () => {
  const client = fakeClient({
    candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: { vat_registration: { status: 'registered', registered_from: '2026-01-01', vat_registration_number: '100123456789012' } } }],
    coded: CODED
  });
  const summary = await drainDirect({ client, asOf: '2026-09-01', deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
  assert.deepEqual({ minted: summary.minted, skip_reasons: summary.skip_reasons, evidence_seen: summary.evidence_seen }, { minted: 0, skip_reasons: { registered: 1 }, evidence_seen: 0 });
  assert.ok(!client.queries.some((q) => q.sql.includes("'vat_control_account_coding'")), 'no evidence read for a registrant');
});

test('a "not registered" answer: silent for 90 days, re-asked after with the contradiction named', async () => {
  const notRegistered = { firm_id: 'firm-1', client_id: 'client-1', profile: { vat_registration: { status: 'not_registered' } } };
  const answered = { id: 'vat-registration-status-firm-1-client-1-2026-06-01', status: 'resolved', resolved_at: '2026-06-03T09:00:00Z' };
  const inside = fakeClient({ candidates: [notRegistered], latestAsk: answered, coded: CODED });
  const insideSummary = await drainDirect({ client: inside, asOf: '2026-08-31', deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
  assert.deepEqual({ minted: insideSummary.minted, skip_reasons: insideSummary.skip_reasons }, { minted: 0, skip_reasons: { answered_recently: 1 } });

  const after = fakeClient({ candidates: [notRegistered], latestAsk: answered, coded: CODED });
  const afterSummary = await drainDirect({ client: after, asOf: '2026-09-01', deliverAsksImpl: async () => {} });
  assert.equal(afterSummary.minted, 1);
  const askInsert = after.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[0], 'vat-registration-status-firm-1-client-1-2026-09-01');
  assert.match(askInsert.params[4], /You told me on 2026-06-03 that you are not VAT registered, but your books now show/);
  const payload = JSON.parse(askInsert.params[5]);
  assert.equal(payload.reason, 'not_registered_but_vat_activity');
  assert.equal(payload.previous_ask_id, answered.id);

  const quiet = fakeClient({ candidates: [notRegistered], latestAsk: answered });
  const quietSummary = await drainDirect({ client: quiet, asOf: '2027-01-01', deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
  assert.deepEqual({ minted: quietSummary.minted, skip_reasons: quietSummary.skip_reasons }, { minted: 0, skip_reasons: { not_registered_no_activity: 1 } });
});

test('the same-day id dedupes on conflict — skipped, never re-delivered', async () => {
  const client = fakeClient({ candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: {} }], askInsertReturnsRow: false });
  const summary = await drainDirect({ client, asOf: '2026-09-01', deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
  assert.deepEqual({ minted: summary.minted, skip_reasons: summary.skip_reasons, delivered: summary.delivered }, { minted: 0, skip_reasons: { ask_id_exists: 1 }, delivered: 0 });
});

test('an audit-insert failure aborts the mint — rollback, counted as an error, nothing delivered', async () => {
  const base = fakeClient({ candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: {} }] });
  const client = {
    queries: base.queries,
    async query(sql, params) {
      if (sql.includes('insert into audit_events')) { base.queries.push({ sql, params }); throw new Error('audit unavailable'); }
      return base.query(sql, params);
    }
  };
  const summary = await drainDirect({ client, asOf: '2026-09-01', deliverAsksImpl: async () => { throw new Error('must not deliver'); } });
  assert.deepEqual({ minted: summary.minted, errors: summary.errors, delivered: summary.delivered }, { minted: 0, errors: 1, delivered: 0 });
  assert.equal(base.queries[base.queries.length - 1].sql, 'rollback');
});

test('the evidence read resolves by chart ROLE across coding, posting and invoices — never by description keyword', async () => {
  const client = fakeClient({ coded: CODED, posted: [{ kind: 'vat_control_account_posting' }], invoices: [{ kind: 'vat_bearing_sales_invoice' }] });
  const evidence = await findAeVatActivityEvidence({ client, firmId: 'firm-1', clientId: 'client-1' });
  assert.deepEqual(evidence.map((e) => e.kind), ['vat_control_account_coding', 'vat_control_account_posting', 'vat_bearing_sales_invoice']);
  for (const q of client.queries) {
    assert.doesNotMatch(q.sql, /ilike|FTA|EMARATAX/i, 'no keyword heuristics');
  }
  const coded = client.queries.find((q) => q.sql.includes("'vat_control_account_coding'"));
  assert.equal(coded.params[2], 'liability.sales_tax_payable');
  assert.match(coded.sql, /la\.canonical_role = \$3/);
  assert.match(coded.sql, /ai_suggestion/, 'the coder\'s persisted proposal counts as a verdict');
});
