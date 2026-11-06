// RT-15b (audit F-11): "today" in the statutory watch drains is the HOST-local
// day. The four drains in firmDb.js (GB VAT threshold, AE VAT threshold, AE
// VAT return deadline, AE CT registration) stamped
// `new Date().toISOString().slice(0, 10)` — the UTC day — so on the appliance
// (Dubai, UTC+4) every night between 00:00 and 04:00 local the watch ran for
// "yesterday". At the year boundary that is not a cosmetic shift: the
// deterministic per-year ask id carries the year, so a client whose threshold
// verdict flipped on Jan 1 got its ask minted under the OLD year's id, and the
// audit/ask payload said `as_of` New Year's Eve.
//
// Fails on the old tree (ask id …-2025, as_of 2025-12-31); passes once the
// drains stamp toLocalIsoDay. The window edges stay UTC-stepped from that
// local day (toUtcIsoDay), pinned here too.
//
//   TZ=Asia/Dubai node --test server/donna/firmDbHostLocalDay.test.js

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  drainAeVatThresholdEscalations,
  drainGbVatThresholdEscalations
} from './statutoryRegistry.js';

// 2025-12-31T21:00Z is 2026-01-01 01:00 in Dubai: the owner's wall clock says
// New Year's Day; the UTC day still says New Year's Eve.
const DUBAI_NEW_YEAR_01_00 = Date.UTC(2025, 11, 31, 21, 0, 0);

const withDubaiClock = async (fn) => {
  const priorTz = process.env.TZ;
  process.env.TZ = 'Asia/Dubai';
  mock.timers.enable({ apis: ['Date'], now: DUBAI_NEW_YEAR_01_00 });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  }
};

const mintedAsk = (queries) => {
  const mint = queries.find((q) => q.sql.includes('insert into client_evidence_requests'));
  return { id: mint.params[0], payload: JSON.parse(mint.params[5]) };
};

const watchWindow = (queries) => queries.find((q) => q.sql.includes('from ledger_lines')).params.slice(2);

// Fake-pg-client idiom (gbVatThresholdEscalationDb.test.js).
const gbFakeClient = () => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes('select distinct c.firm_id')) return { rows: [{ firm_id: 'firm-1', client_id: 'client-1', jurisdiction: 'GB', profile: { jurisdiction: 'gb' } }] };
      if (sql.includes('select jurisdiction, profile from clients')) return { rows: [{ jurisdiction: 'GB', profile: { jurisdiction: 'gb' } }] };
      if (sql.includes('from client_capability_config')) {
        return { rows: [{ flag_key: 'GB_VAT_THRESHOLD_WATCH', stage: 'auto', source: 'test', client_id: 'client-1' }] };
      }
      if (sql.includes('from cohort_capability_config')) return { rows: [] };
      if (sql.includes('from ledger_lines')) return { rows: [{ rolling_turnover: '95000.00', committed_next_30: '0' }] };
      if (sql.includes('insert into client_evidence_requests')) return { rows: [{ id: params[0] }] };
      if (sql.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

// Fake-pg-client idiom (aeVatThresholdEscalationDb.test.js).
const aeFakeClient = () => {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') return { rows: [] };
      if (sql.includes("c.profile->>'jurisdiction'")) return { rows: [{ firm_id: 'firm-1', client_id: 'client-1', profile: null }] };
      if (sql.includes('from ledger_lines')) return { rows: [{ rolling_turnover: '400000.00', committed_next_30: '0' }] };
      if (sql.includes('insert into client_evidence_requests')) return { rows: [{ id: params[0] }] };
      if (sql.includes('insert into audit_events')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
};

test('GB threshold drain at 01:00 Dubai on Jan 1: the ask is minted for the NEW year, as_of the local day', async () => {
  await withDubaiClock(async () => {
    const client = gbFakeClient();
    const delivered = [];
    const summary = await drainGbVatThresholdEscalations({ client, deliverAsksImpl: async (args) => { delivered.push(args); } });
    assert.equal(summary.minted, 1);
    assert.deepEqual(delivered[0].evidenceRequestIds, ['vat-threshold-firm-1-client-1-2026']);
    const ask = mintedAsk(client.queries);
    assert.equal(ask.id, 'vat-threshold-firm-1-client-1-2026');
    assert.equal(ask.payload.as_of, '2026-01-01');
    assert.equal(ask.payload.year, 2026);
    // (asOf − 12 months, asOf] and (asOf, asOf + 30 days], stepped in UTC from
    // the local day — never from the UTC day.
    assert.deepEqual(watchWindow(client.queries), ['2025-01-01', '2026-01-01', '2026-01-31']);
  });
});

test('AE threshold drain at 01:00 Dubai on Jan 1: the ask is minted for the NEW year, as_of the local day', async () => {
  await withDubaiClock(async () => {
    const client = aeFakeClient();
    const delivered = [];
    const summary = await drainAeVatThresholdEscalations({ client, deliverAsksImpl: async (args) => { delivered.push(args); } });
    assert.equal(summary.minted, 1);
    assert.deepEqual(delivered[0].evidenceRequestIds, ['vat-threshold-firm-1-client-1-2026']);
    const ask = mintedAsk(client.queries);
    assert.equal(ask.id, 'vat-threshold-firm-1-client-1-2026');
    assert.equal(ask.payload.as_of, '2026-01-01');
    assert.equal(ask.payload.year, 2026);
    assert.deepEqual(watchWindow(client.queries), ['2025-01-01', '2026-01-01', '2026-01-31']);
  });
});
