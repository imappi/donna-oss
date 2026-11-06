// AE ae_vat_registration_threshold — the exceeded-escalation drain.
//   node --test server/donna/aeVatThresholdEscalationDb.test.js
//
// Fake-pg-client idiom (gbVatThresholdEscalationDb.test.js): the drain takes
// the client directly, so the fake answers each query by SQL fragment and logs
// everything for order/shape assertions. The AE-specific tests are the
// registration-record scope guard — the AE return lane has no flag, so the
// RECORD is what routes a client off this watch.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drainAeVatThresholdEscalations
} from './statutoryRegistry.js';

const fakeClient = ({
  candidates = [],
  turnoverRow = { rolling_turnover: '0', committed_next_30: '0' },
  askInsertReturnsRow = true
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes("c.profile->>'jurisdiction'")) return { rows: candidates };
      if (sql.includes('from ledger_lines')) return { rows: [turnoverRow] };
      if (sql.includes('insert into client_evidence_requests')) {
        return { rows: askInsertReturnsRow ? [{ id: params[0] }] : [] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const CANDIDATE = { firm_id: 'firm-1', client_id: 'client-1', profile: null };

test('preceding-12-months exceeded: mints the deterministic per-year ask + audit in one txn, then delivers', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    turnoverRow: { rolling_turnover: '400000.00', committed_next_30: '0' }
  });
  const delivered = [];
  const summary = await drainAeVatThresholdEscalations({
    client,
    asOf: '2026-08-30',
    deliverAsksImpl: async (args) => { delivered.push(args); }
  });

  assert.deepEqual(summary, { scanned: 1, exceeded: 1, minted: 1, delivered: 1, skipped: 0, errors: 0 });
  assert.deepEqual(delivered, [{
    firmId: 'firm-1', clientId: 'client-1', evidenceRequestIds: ['vat-threshold-firm-1-client-1-2026']
  }]);

  // Audit-as-precondition: the audit insert is inside the SAME transaction as
  // the mint — begin, insert ask, insert audit, commit, in that order.
  const shape = client.queries.map((q) => (
    q.sql === 'begin' || q.sql === 'commit' ? q.sql
      : q.sql.includes('insert into client_evidence_requests') ? 'mint'
        : q.sql.includes('insert into audit_events') ? 'audit' : null
  )).filter(Boolean);
  assert.deepEqual(shape, ['begin', 'mint', 'audit', 'commit']);

  const audit = client.queries.find((q) => q.sql.includes('insert into audit_events'));
  assert.equal(JSON.parse(audit.params[3]).driving_limb, 'preceding_12_months');
  assert.equal(JSON.parse(audit.params[3]).threshold_aed, 375000);
  assert.match(audit.sql, /vat_threshold\.escalated/);
  assert.equal(
    JSON.parse(audit.params[3]).authority_basis,
    'statutory_obligation:ae_vat_registration_threshold'
  );
});

test('next-30-days alone exceeds: still escalates, and the receipt names the limb', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    turnoverRow: { rolling_turnover: '10000', committed_next_30: '380000' }
  });
  const summary = await drainAeVatThresholdEscalations({
    client, asOf: '2026-08-30', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.exceeded, 1);
  assert.equal(summary.minted, 1);

  const mint = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  const payload = JSON.parse(mint.params[5]);
  assert.equal(payload.driving_limb, 'next_30_days');
  assert.equal(payload.committed_next_30_days_aed, 380000);
  assert.equal(payload.kind, 'vat_threshold_review');
  // The ask text must put the expectation question to the owner.
  assert.match(mint.params[4], /Do you expect/);
});

test('the two ledger windows are backward 12 months and forward 30 days from asOf', async () => {
  const client = fakeClient({ candidates: [CANDIDATE] });
  await drainAeVatThresholdEscalations({ client, asOf: '2026-08-30', deliverAsksImpl: async () => {} });
  const q = client.queries.find((x) => x.sql.includes('from ledger_lines'));
  // params: firmId, clientId, backFrom, asOf, forwardTo
  assert.deepEqual(q.params.slice(2), ['2025-08-30', '2026-08-30', '2026-09-29']);
  // Rolling, not calendar-year — the FI watch's shape must NOT have leaked in.
  assert.doesNotMatch(q.sql, /extract\(year/);
  assert.match(q.sql, /lj\.status in \('posted', 'closed'\)/);
  assert.match(q.sql, /la\.account_type = 'revenue'/);
});

test('a client with a recorded EFFECTIVE registration is skipped — that is the return lane\'s duty', async () => {
  const client = fakeClient({
    candidates: [{
      firm_id: 'firm-1',
      client_id: 'client-1',
      profile: { vat_registration: { status: 'registered', registered_from: '2026-01-01' } }
    }],
    turnoverRow: { rolling_turnover: '400000', committed_next_30: '0' }
  });
  const summary = await drainAeVatThresholdEscalations({
    client, asOf: '2026-08-30', deliverAsksImpl: async () => {}
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 0, minted: 0, delivered: 0, skipped: 1, errors: 0 });
  assert.ok(!client.queries.some((q) => q.sql.includes('from ledger_lines')));
  assert.ok(!client.queries.some((q) => q.sql.includes('insert into client_evidence_requests')));
});

test('a recorded not_registered AND an absent record both stay ON the watch — tri-state, no guess', async () => {
  for (const profile of [
    { vat_registration: { status: 'not_registered' } },
    null
  ]) {
    const client = fakeClient({
      candidates: [{ firm_id: 'firm-1', client_id: 'client-1', profile }],
      turnoverRow: { rolling_turnover: '400000', committed_next_30: '0' }
    });
    const summary = await drainAeVatThresholdEscalations({
      client, asOf: '2026-08-30', deliverAsksImpl: async () => {}
    });
    assert.equal(summary.exceeded, 1, `profile ${JSON.stringify(profile)} must run the watch`);
    assert.equal(summary.minted, 1);
  }
});

test('a registration not yet effective on the watch date stays ON the watch', async () => {
  const client = fakeClient({
    candidates: [{
      firm_id: 'firm-1',
      client_id: 'client-1',
      profile: { vat_registration: { status: 'registered', registered_from: '2026-12-01' } }
    }],
    turnoverRow: { rolling_turnover: '400000', committed_next_30: '0' }
  });
  const summary = await drainAeVatThresholdEscalations({
    client, asOf: '2026-08-30', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.exceeded, 1);
});


test('below threshold: no ask, no audit, no delivery', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    turnoverRow: { rolling_turnover: '200000', committed_next_30: '500' }
  });
  const summary = await drainAeVatThresholdEscalations({
    client, asOf: '2026-08-30', deliverAsksImpl: async () => {}
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 0, minted: 0, delivered: 0, skipped: 0, errors: 0 });
  assert.ok(!client.queries.some((q) => q.sql.includes('insert into audit_events')));
});

test('an already-open ask for the year is never re-nagged', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    turnoverRow: { rolling_turnover: '400000', committed_next_30: '0' },
    askInsertReturnsRow: false   // on conflict do nothing
  });
  const delivered = [];
  const summary = await drainAeVatThresholdEscalations({
    client, asOf: '2026-08-30', deliverAsksImpl: async (a) => { delivered.push(a); }
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 1, minted: 0, delivered: 0, skipped: 1, errors: 0 });
  assert.equal(delivered.length, 0);
});

test('no AE-jurisdiction clients ⇒ zero candidates ⇒ a clean no-op', async () => {
  const client = fakeClient({ candidates: [] });
  const summary = await drainAeVatThresholdEscalations({ client, asOf: '2026-08-30' });
  assert.deepEqual(summary, { scanned: 0, exceeded: 0, minted: 0, delivered: 0, skipped: 0, errors: 0 });
});

test('the candidate sweep is jurisdiction-scoped (no flag join) and honours a firm filter', async () => {
  const client = fakeClient({ candidates: [] });
  await drainAeVatThresholdEscalations({ client, firmId: 'firm-9', asOf: '2026-08-30' });
  const q = client.queries[0];
  assert.deepEqual(q.params, ['firm-9']);
  assert.match(q.sql, /jurisdiction'\)\) = 'ae'/);
  assert.doesNotMatch(q.sql, /client_capability_config/);
});

test('one client\'s failure is counted and does not abort the sweep', async () => {
  const boom = { firm_id: 'firm-1', client_id: 'boom', profile: null };
  const base = fakeClient({
    candidates: [boom, CANDIDATE],
    turnoverRow: { rolling_turnover: '400000', committed_next_30: '0' }
  });
  const client = {
    queries: base.queries,
    async query(sql, params) {
      if (sql.includes('from ledger_lines') && params[1] === 'boom') throw new Error('ledger read failed');
      return base.query(sql, params);
    }
  };
  const summary = await drainAeVatThresholdEscalations({
    client, asOf: '2026-08-30', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.errors, 1);
  assert.equal(summary.scanned, 2);
  assert.equal(summary.minted, 1);   // the healthy client still escalated
});

test('a mint failure rolls back rather than leaving a half-written escalation', async () => {
  const base = fakeClient({
    candidates: [CANDIDATE],
    turnoverRow: { rolling_turnover: '400000', committed_next_30: '0' }
  });
  const client = {
    queries: base.queries,
    async query(sql, params) {
      if (sql.includes('insert into audit_events')) throw new Error('audit write failed');
      return base.query(sql, params);
    }
  };
  const summary = await drainAeVatThresholdEscalations({
    client, asOf: '2026-08-30', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.errors, 1);
  assert.equal(summary.minted, 0);
  assert.ok(client.queries.some((q) => q.sql === 'rollback'));
  assert.ok(!client.queries.some((q) => q.sql === 'commit'));
});
