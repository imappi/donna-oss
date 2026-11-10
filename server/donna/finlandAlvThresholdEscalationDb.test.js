// FI-15 G-2 follow-up — the ALV-threshold exceeded-escalation drain
// (docs/design-donna-finland-g2-threshold-escalation.md).
//   node --test server/donna/finlandAlvThresholdEscalationDb.test.js
//
// Fake-pg-client idiom (finlandPrepaymentRegisterDb.test.js): the drain takes
// the client directly, so the fake answers each query by SQL fragment and logs
// everything for order/shape assertions.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drainFinlandAlvThresholdEscalations
} from './statutoryRegistry.js';

const fakeClient = ({
  candidates = [],
  snapshotFlags = {},
  turnoverRows = [],
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
      if (sql.includes('from ledger_lines')) return { rows: turnoverRows };
      if (sql.includes('insert into client_evidence_requests')) {
        return { rows: askInsertReturnsRow ? [{ id: params[0] }] : [] };
      }
      if (sql.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

const CANDIDATE = { firm_id: 'firm-1', client_id: 'client-1', jurisdiction: 'fi' };

test('exceeded: mints the deterministic per-year ask + audit in one txn, then delivers', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto' },
    turnoverRows: [{ year: '2026', turnover: '25000.00' }]
  });
  const delivered = [];
  const summary = await drainFinlandAlvThresholdEscalations({
    client,
    year: 2026,
    deliverAsksImpl: async (args) => { delivered.push(args); return { delivered: args.evidenceRequestIds }; }
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 1, minted: 1, delivered: 1, held: 0, skipped: 0, errors: 0 });

  const askInsert = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.equal(askInsert.params[0], 'alv-threshold-firm-1-client-1-2026');
  assert.equal(askInsert.params[3], 'alv_threshold_review');
  assert.match(askInsert.params[4], /OmaVero/);
  assert.match(askInsert.params[4], /Donna ei voi rekisteröidä/);
  const payload = JSON.parse(askInsert.params[5]);
  assert.equal(payload.kind, 'alv_threshold_review');
  assert.equal(payload.year, 2026);
  assert.equal(payload.driving_turnover_eur, 25000);
  assert.equal(payload.threshold_eur, 20000);
  // on conflict do nothing — an open OR resolved ask is never re-nagged.
  assert.match(askInsert.sql, /on conflict \(id\) do nothing/);

  // Audit-as-precondition: mint and audit ride the same transaction.
  const order = client.queries.map((q) => q.sql.split(/\s|\(/)[0] + (q.sql.includes('audit_events') ? ':audit' : q.sql.includes('client_evidence_requests') ? ':ask' : ''));
  const beginIdx = client.queries.findIndex((q) => q.sql === 'begin');
  const askIdx = client.queries.findIndex((q) => q.sql.includes('client_evidence_requests'));
  const auditIdx = client.queries.findIndex((q) => q.sql.includes('audit_events'));
  const commitIdx = client.queries.findIndex((q) => q.sql === 'commit');
  assert.ok(beginIdx < askIdx && askIdx < auditIdx && auditIdx < commitIdx, `txn order broken: ${order.join(',')}`);
  const auditMeta = JSON.parse(client.queries[auditIdx].params[3]);
  assert.equal(auditMeta.authority_basis, 'client_capability_config:FINLAND_ALV_THRESHOLD_WATCH');

  assert.deepEqual(delivered, [{ firmId: 'firm-1', clientId: 'client-1', evidenceRequestIds: ['alv-threshold-firm-1-client-1-2026'] }]);
});

test('existing ask (conflict no-op): no audit, no delivery, no re-nag', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto' },
    turnoverRows: [{ year: '2026', turnover: '25000.00' }],
    askInsertReturnsRow: false
  });
  const delivered = [];
  const summary = await drainFinlandAlvThresholdEscalations({
    client,
    year: 2026,
    deliverAsksImpl: async (args) => { delivered.push(args); return { delivered: args.evidenceRequestIds }; }
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 1, minted: 0, delivered: 0, held: 0, skipped: 1, errors: 0 });
  assert.equal(client.queries.some((q) => q.sql.includes('audit_events')), false, 'a no-op mint must not audit');
  assert.deepEqual(delivered, []);
});

test('not exceeded: nothing minted, nothing delivered', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto' },
    turnoverRows: [{ year: '2026', turnover: '12000.00' }]
  });
  const summary = await drainFinlandAlvThresholdEscalations({ client, year: 2026, deliverAsksImpl: async () => {} });
  assert.deepEqual(summary, { scanned: 1, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 0, errors: 0 });
  assert.equal(client.queries.some((q) => q.sql.includes('client_evidence_requests')), false);
});

test('scope guard: FINLAND_ALV_CODING acting skips the client (the return engine owns it)', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto', FINLAND_ALV_CODING: 'auto' },
    turnoverRows: [{ year: '2026', turnover: '25000.00' }]
  });
  const summary = await drainFinlandAlvThresholdEscalations({ client, year: 2026, deliverAsksImpl: async () => {} });
  assert.deepEqual(summary, { scanned: 1, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 1, errors: 0 });
});

test('authoritative re-gate: an enumerated candidate whose snapshot does not act is skipped', async () => {
  // e.g. a force-disable or a conservative cohort override — the enumeration
  // only bounds the sweep, the snapshot decides.
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: {},
    turnoverRows: [{ year: '2026', turnover: '25000.00' }]
  });
  const summary = await drainFinlandAlvThresholdEscalations({ client, year: 2026, deliverAsksImpl: async () => {} });
  assert.deepEqual(summary, { scanned: 1, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 1, errors: 0 });
});

test('no candidates (flag dark everywhere): a strict no-op', async () => {
  const client = fakeClient({ candidates: [] });
  const summary = await drainFinlandAlvThresholdEscalations({ client, year: 2026, deliverAsksImpl: async () => {} });
  assert.deepEqual(summary, { scanned: 0, exceeded: 0, minted: 0, delivered: 0, held: 0, skipped: 0, errors: 0 });
  assert.equal(client.queries.length, 1, 'only the candidate enumeration runs');
});

test('a per-client failure is counted and does not stop the sweep', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE, { ...CANDIDATE, client_id: 'client-2' }],
    snapshotFlags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto' },
    turnoverRows: [{ year: '2026', turnover: '25000.00' }]
  });
  let first = true;
  const summary = await drainFinlandAlvThresholdEscalations({
    client,
    year: 2026,
    deliverAsksImpl: async () => {
      if (first) { first = false; throw new Error('WHATSAPP_DOWN'); }
      return { delivered: ['alv-threshold-firm-1-client-2-2026'] };
    }
  });
  assert.equal(summary.scanned, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.delivered, 1);
});
test('the mint writes no sent stamp; a question the send gate held counts as held, never as delivered', async () => {
  const client = fakeClient({
    candidates: [CANDIDATE],
    snapshotFlags: { FINLAND_ALV_THRESHOLD_WATCH: 'auto' },
    turnoverRows: [{ year: '2026', turnover: '25000.00' }]
  });
  const summary = await drainFinlandAlvThresholdEscalations({
    client,
    year: 2026,
    deliverAsksImpl: async () => ({ refused: 'INTERNAL_PILOT_SEND_DISABLED' })
  });
  assert.deepEqual(summary, { scanned: 1, exceeded: 1, minted: 1, delivered: 0, held: 1, skipped: 0, errors: 0 });
  const mint = client.queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  assert.doesNotMatch(mint.sql, /first_sent_at|last_sent_at/, 'only a deliverer stamps a send');
  assert.match(mint.sql, /, 0, 'system'\)/, 'minted with send_count 0');
});
