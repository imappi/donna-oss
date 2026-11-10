// GB gb_vat_registration_threshold — the exceeded-escalation drain.
//   node --test server/donna/gbVatThresholdEscalationDb.test.js
//
// Fake-pg-client idiom (finlandAlvThresholdEscalationDb.test.js): the drain
// takes the client directly, so the fake answers each query by SQL fragment and
// logs everything for order/shape assertions.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drainGbVatThresholdEscalations
} from './statutoryRegistry.js';

const fakeClient = ({
  candidates = [],
  snapshotFlags = {},
  turnoverRow = { rolling_turnover: '0', committed_next_30: '0' },
  askInsertReturnsRow = true
} = {}) => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes('select distinct c.firm_id')) return { rows: candidates };
      if (sql.includes('select jurisdiction, profile from clients')) return { rows: candidates.filter(row => row.firm_id === params[0] && row.client_id === params[1]) };
      if (sql.includes('from client_capability_config')) {
        return {
          rows: Object.entries(snapshotFlags).map(([flag_key, stage]) => (
            { flag_key, stage, source: 'test', client_id: params?.[1] ?? 'client-1' }
          ))
        };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('from ledger_lines')) return { rows: [turnoverRow] };
      if (sql.includes('insert into client_evidence_requests')) {
        return { rows: askInsertReturnsRow ? [{ id: params[0] }] : [] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const CANDIDATE = { firm_id: 'firm-1', client_id: 'client-1', jurisdiction: 'gb' };
const ON = { GB_VAT_THRESHOLD_WATCH: 'auto' };

test('backward look exceeded: mints the deterministic per-year ask + audit in one txn, then delivers', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: ON,
    turnoverRow: { rolling_turnover: '95000.00', committed_next_30: '0' }
  });
  const delivered = [];
  const summary = await drainGbVatThresholdEscalations({
    client,
    asOf: '2026-07-27',
    deliverAsksImpl: async (args) => { delivered.push(args); return { delivered: args.evidenceRequestIds }; }
  });

  assert.deepEqual(summary, { scanned: 1, exceeded: 1, minted: 1, delivered: 1, held: 0, skipped: 0, errors: 0 });
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
  assert.equal(audit.params[3] && JSON.parse(audit.params[3]).driving_limb, 'backward_look');
  assert.match(audit.sql, /vat_threshold\.escalated/);
  assert.equal(
    JSON.parse(audit.params[3]).authority_basis,
    'client_capability_config:GB_VAT_THRESHOLD_WATCH'
  );
});

test('forward look alone exceeds: still escalates, and the receipt names the limb', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: ON,
    turnoverRow: { rolling_turnover: '5000', committed_next_30: '120000' }
  });
  const summary = await drainGbVatThresholdEscalations({
    client, asOf: '2026-07-27', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.exceeded, 1);
  assert.equal(summary.minted, 1);

  const mint = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  const payload = JSON.parse(mint.params[5]);
  assert.equal(payload.driving_limb, 'forward_look');
  assert.equal(payload.committed_next_30_days_gbp, 120000);
  assert.equal(payload.kind, 'vat_threshold_review');
  // The ask text must put the expectation question to the owner.
  assert.match(mint.params[4], /Do you expect/);
});

test('the two ledger windows are backward 12 months and forward 30 days from asOf', async () => {
  const client = fakeClient({ candidates: [CANDIDATE], snapshotFlags: ON });
  await drainGbVatThresholdEscalations({ client, asOf: '2026-07-27', deliverAsksImpl: async () => {} });
  const q = client.queries.find((x) => x.sql.includes('from ledger_lines'));
  // params: firmId, clientId, backFrom, asOf, forwardTo
  assert.deepEqual(q.params.slice(2), ['2025-07-27', '2026-07-27', '2026-08-26']);
  // Rolling, not calendar-year — the FI watch's shape must NOT have leaked in.
  assert.doesNotMatch(q.sql, /extract\(year/);
  assert.match(q.sql, /lj\.status in \('posted', 'closed'\)/);
  assert.match(q.sql, /la\.account_type = 'revenue'/);
});

test('a VAT-registered client (HMRC_MTD_VAT acting) is skipped — that is the return lane\'s duty', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: { GB_VAT_THRESHOLD_WATCH: 'auto', HMRC_MTD_VAT: 'auto' },
    turnoverRow: { rolling_turnover: '95000', committed_next_30: '0' }
  });
  const summary = await drainGbVatThresholdEscalations({
    client, asOf: '2026-07-27', deliverAsksImpl: async () => {}
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 1, errors: 0 });
  assert.ok(!client.queries.some((q) => q.sql.includes('insert into client_evidence_requests')));
});

test('the per-client snapshot is authoritative: a candidate whose flag does not act is skipped', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: {},
    turnoverRow: { rolling_turnover: '95000', committed_next_30: '0' }
  });
  const summary = await drainGbVatThresholdEscalations({
    client, asOf: '2026-07-27', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.minted, 0);
});

test('below threshold: no ask, no audit, no delivery', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: ON,
    turnoverRow: { rolling_turnover: '1000', committed_next_30: '500' }
  });
  const summary = await drainGbVatThresholdEscalations({
    client, asOf: '2026-07-27', deliverAsksImpl: async () => {}
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 0, errors: 0 });
  assert.ok(!client.queries.some((q) => q.sql.includes('insert into audit_events')));
});

test('an already-open ask for the year is never re-nagged', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: ON,
    turnoverRow: { rolling_turnover: '95000', committed_next_30: '0' },
    askInsertReturnsRow: false   // on conflict do nothing
  });
  const delivered = [];
  const summary = await drainGbVatThresholdEscalations({
    client, asOf: '2026-07-27', deliverAsksImpl: async (a) => { delivered.push(a); }
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 1, minted: 0, delivered: 0, held: 0, skipped: 1, errors: 0 });
  assert.equal(delivered.length, 0);
});

test('flag off everywhere ⇒ zero candidates ⇒ a clean no-op', async () => {
  const client = fakeClient({ candidates: [], snapshotFlags: {} });
  const summary = await drainGbVatThresholdEscalations({ client, asOf: '2026-07-27' });
  assert.deepEqual(summary, { scanned: 0, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 0, errors: 0 });
});

test('the candidate sweep is bounded by the flag key and honours a firm filter', async () => {
  const client = fakeClient({ candidates: [], snapshotFlags: {} });
  await drainGbVatThresholdEscalations({ client, firmId: 'firm-9', asOf: '2026-07-27' });
  const q = client.queries[0];
  assert.deepEqual(q.params, ['GB_VAT_THRESHOLD_WATCH', 'firm-9']);
  assert.match(q.sql, /stage in \('canary', 'auto'\)/);
});

test('one client\'s failure is counted and does not abort the sweep', async () => {
  const boom = { ...CANDIDATE, client_id: 'boom' };
  const base = fakeClient({
    candidates: [boom, CANDIDATE],
    snapshotFlags: ON,
    turnoverRow: { rolling_turnover: '95000', committed_next_30: '0' }
  });
  const client = {
    queries: base.queries,
    async query(sql, params) {
      if (sql.includes('from ledger_lines') && params[1] === 'boom') throw new Error('ledger read failed');
      return base.query(sql, params);
    }
  };
  const summary = await drainGbVatThresholdEscalations({
    client, asOf: '2026-07-27', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.errors, 1);
  assert.equal(summary.scanned, 2);
  assert.equal(summary.minted, 1);   // the healthy client still escalated
});

test('a mint failure rolls back rather than leaving a half-written escalation', async () => {
  const base = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: ON,
    turnoverRow: { rolling_turnover: '95000', committed_next_30: '0' }
  });
  const client = {
    queries: base.queries,
    async query(sql, params) {
      if (sql.includes('insert into audit_events')) throw new Error('audit write failed');
      return base.query(sql, params);
    }
  };
  const summary = await drainGbVatThresholdEscalations({
    client, asOf: '2026-07-27', deliverAsksImpl: async () => {}
  });
  assert.equal(summary.errors, 1);
  assert.equal(summary.minted, 0);
  assert.ok(client.queries.some((q) => q.sql === 'rollback'));
  assert.ok(!client.queries.some((q) => q.sql === 'commit'));
});

test('the mint writes no sent stamp; a question the send gate held counts as held, never as delivered', async () => {
  const client = fakeClient({ candidates: [CANDIDATE], snapshotFlags: ON, turnoverRow: { rolling_turnover: '95000.00', committed_next_30: '0' } });
  const summary = await drainGbVatThresholdEscalations({
    client, asOf: '2026-07-27', deliverAsksImpl: async () => ({ refused: 'INTERNAL_PILOT_SEND_DISABLED' })
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 1, minted: 1, delivered: 0, held: 1, skipped: 0, errors: 0 });
  const mint = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.doesNotMatch(mint.sql, /first_sent_at|last_sent_at/, 'only a deliverer stamps a send');
  assert.match(mint.sql, /, 0, 'system'\)/, 'minted with send_count 0');
});
