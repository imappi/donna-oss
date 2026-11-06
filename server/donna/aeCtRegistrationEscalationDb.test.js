// AE ae_corporate_tax_registration — the registry-watch drain.
//   node --test server/donna/aeCtRegistrationEscalationDb.test.js
//
// Fake-pg-client idiom (aeVatReturnDeadlineEscalationDb.test.js): the drain
// takes the client directly, so the fake answers each query by SQL fragment
// and logs everything. This drain is pure-profile underneath — no ledger or
// period reads — so the fake's surface is the jurisdiction-scoped candidate
// sweep and the two mint inserts.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drainAeCtRegistrationEscalations
} from './statutoryRegistry.js';

const fakeClient = ({
  candidates = [],
  askInsertReturnsRow = true
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes("c.profile->>'jurisdiction'")) return { rows: candidates };
      if (sql.includes('insert into client_evidence_requests')) {
        return { rows: askInsertReturnsRow ? [{ id: params[0] }] : [] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

test('an unknown registration status mints the STATUS ask + audit in one txn, then delivers', async () => {
  const client = fakeClient({
    candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: {} }]
  });
  const delivered = [];
  const summary = await drainAeCtRegistrationEscalations({
    client,
    asOf: '2026-08-31',
    deliverAsksImpl: async (args) => { delivered.push(args); }
  });
  assert.deepEqual(
    { status_minted: summary.status_minted, minted: summary.minted, delivered: summary.delivered, errors: summary.errors },
    { status_minted: 1, minted: 0, delivered: 1, errors: 0 }
  );
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[0], 'ct-registration-status-firm-1-client-1-2026');
  assert.equal(askInsert.params[3], 'ct_registration_status');
  assert.match(askInsert.params[4], /corporate tax TRN/);
  const auditInsert = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.equal(auditInsert.params[2], 'ct_registration.status_asked');
  const beginIdx = client.queries.findIndex((q) => q.sql === 'begin');
  const commitIdx = client.queries.findIndex((q) => q.sql === 'commit');
  assert.ok(beginIdx < client.queries.indexOf(askInsert) && client.queries.indexOf(auditInsert) < commitIdx,
    'mint and audit sit inside one transaction');
  assert.deepEqual(delivered[0].evidenceRequestIds, ['ct-registration-status-firm-1-client-1-2026']);
});

test('a computed deadline inside the lead window mints the DEADLINE ask with the date', async () => {
  const client = fakeClient({
    candidates: [{
      firm_id: 'firm-1', client_id: 'client-1',
      profile: { ct_registration: { status: 'not_registered' }, incorporation_date: '2026-07-15' }
    }]
  });
  const delivered = [];
  const summary = await drainAeCtRegistrationEscalations({
    client, asOf: '2026-09-20', deliverAsksImpl: async (args) => { delivered.push(args); }
  });
  assert.deepEqual(
    { due_rows: summary.due_rows, minted: summary.minted, delivered: summary.delivered },
    { due_rows: 1, minted: 1, delivered: 1 }
  );
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[0], 'ct-registration-deadline-firm-1-client-1-2026');
  assert.equal(askInsert.params[3], 'ct_registration_deadline');
  assert.match(askInsert.params[4], /due by 2026-10-15/);
  const payload = JSON.parse(askInsert.params[5]);
  assert.equal(payload.state, 'due_soon');
  assert.equal(payload.due_date, '2026-10-15');
  const auditInsert = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.equal(auditInsert.params[2], 'ct_registration.deadline_escalated');
});

test('a deadline outside the lead window stays silent', async () => {
  const client = fakeClient({
    candidates: [{
      firm_id: 'firm-1', client_id: 'client-1',
      profile: { ct_registration: { status: 'not_registered' }, incorporation_date: '2026-07-15' }
    }]
  });
  const summary = await drainAeCtRegistrationEscalations({
    client, asOf: '2026-08-31', deliverAsksImpl: async () => { throw new Error('must not deliver'); }
  });
  assert.deepEqual({ due_rows: summary.due_rows, minted: summary.minted, status_minted: summary.status_minted },
    { due_rows: 0, minted: 0, status_minted: 0 });
});

test('an uncomputable deadline mints the blocked DEADLINE ask naming the facts', async () => {
  const client = fakeClient({
    candidates: [{
      firm_id: 'firm-1', client_id: 'client-1',
      profile: { ct_registration: { status: 'not_registered' } }
    }]
  });
  const summary = await drainAeCtRegistrationEscalations({
    client, asOf: '2026-08-31', deliverAsksImpl: async () => {}
  });
  assert.deepEqual({ due_rows: summary.due_rows, minted: summary.minted }, { due_rows: 1, minted: 1 });
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.match(askInsert.params[4], /incorporation date and licence details/);
  const payload = JSON.parse(askInsert.params[5]);
  assert.equal(payload.state, 'blocked');
  assert.equal(payload.refusal_code, 'AE_CT_REGISTRATION_DEADLINE_UNRESOLVED');
});

test('a recorded registration discharges the duty — skipped, nothing minted', async () => {
  const client = fakeClient({
    candidates: [{
      firm_id: 'firm-1', client_id: 'client-1',
      profile: { ct_registration: { status: 'registered', registered_from: '2024-09-01', ct_registration_number: '104123456789012' } }
    }]
  });
  const summary = await drainAeCtRegistrationEscalations({
    client, asOf: '2026-08-31', deliverAsksImpl: async () => { throw new Error('must not deliver'); }
  });
  assert.deepEqual({ scanned: summary.scanned, skipped: summary.skipped, minted: summary.minted, status_minted: summary.status_minted },
    { scanned: 1, skipped: 1, minted: 0, status_minted: 0 });
});

test('a deregistered record mints the re-registration wording', async () => {
  const client = fakeClient({
    candidates: [{
      firm_id: 'firm-1', client_id: 'client-1',
      profile: { ct_registration: { status: 'registered', registered_from: '2024-09-01', registered_until: '2025-12-31' } }
    }]
  });
  const summary = await drainAeCtRegistrationEscalations({
    client, asOf: '2026-08-31', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.minted, 1);
  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.match(askInsert.params[4], /re-register/);
  assert.equal(JSON.parse(askInsert.params[5]).registration_reason, 'deregistered');
});

test('an existing ask dedupes on the deterministic id — skipped, never re-delivered', async () => {
  const client = fakeClient({
    candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile: {} }],
    askInsertReturnsRow: false
  });
  const summary = await drainAeCtRegistrationEscalations({
    client, asOf: '2026-08-31', deliverAsksImpl: async () => { throw new Error('must not deliver'); }
  });
  assert.deepEqual({ status_minted: summary.status_minted, skipped: summary.skipped, delivered: summary.delivered },
    { status_minted: 0, skipped: 1, delivered: 0 });
});

test('the candidate sweep is jurisdiction-scoped (no flag join) and honours a firm filter', async () => {
  const client = fakeClient({ candidates: [] });
  const summary = await drainAeCtRegistrationEscalations({ client, firmId: 'firm-9', asOf: '2026-08-31' });
  assert.deepEqual({ scanned: summary.scanned, minted: summary.minted }, { scanned: 0, minted: 0 });
  const q = client.queries[0];
  assert.deepEqual(q.params, ['firm-9']);
  assert.match(q.sql, /jurisdiction'\)\) = 'ae'/);
  assert.doesNotMatch(q.sql, /client_capability_config/);
});
