// Twin-aging → owner-ask lane (design 2026-07-06 §1). Mock-pg harness
// (substring handlers, the askAutoDraftConsumer.test.js shape). Pins:
//   gather — rows group per bank line (one owner question per line, its
//     candidates = the line's aged suggested twin matches); the SQL carries
//     the twin gate (twin reasons ?|, material reasons excluded, the
//     twin_aging asked-once marker, the open-ask spam guard);
//   sweep — twin flag off ⇒ no twin work, while ungated material confirmations
//     still recover through the same coalesced ask_draft.requested lane;
//     twin shadow ⇒ the would-mint is receipted; canary+ ⇒ one request; an
//     already-pending request is not duplicated; a below-canary firm never
//     parks a row.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blockingOpenAskExistsSql,
  gatherAgedTwinAskGroups,
  gatherHeldMaterialAskGroups,
  heldMatchGroupReceipts,
  isSupersedableAskRow,
  suggestedMatchHasSettleLane,
  sweepTwinAgingAskDraftRequests,
  twinAskGroupReceipts,
  twinAgingAskDays,
  TWIN_AGING_ASK_FLAG_KEY
} from './reconciliationTwinAging.js';

const makeMockClient = (handlers = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      for (const h of handlers) {
        if (text.includes(h.match)) {
          if (h.throw) throw h.throw;
          const rows = typeof h.rows === 'function' ? h.rows() : (h.rows || []);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const hasCall = (client, needle) => client.calls.some((c) => c.sql.toLowerCase().includes(needle));

const CANARY_ENV = { LOOPS_TIER: 'canary' };

const TWIN_ROW = (overrides = {}) => ({
  match_id: 'match-a',
  bank_transaction_id: 'tx-exxon-1',
  matched_object_type: 'receipt',
  matched_object_id: 'doc-exxon-a',
  match_amount: 51.38,
  match_confidence: 0.65,
  matcher_reasoning: 'Indistinguishable from tx-exxon-2 (same amount, currency, and counterparty).',
  authorization_reasons: ['ambiguous_candidates'],
  verdict_stamped_at: '2026-07-01T10:00:00Z',
  transaction_date: '2026-05-04',
  description: 'EXXONMOBIL 97531',
  money_in: 0,
  money_out: 51.38,
  currency: 'USD',
  doc_type: 'receipt',
  doc_filename: 'exxon-may-3.pdf',
  doc_counterparty: 'ExxonMobil',
  doc_amount: 51.38,
  doc_currency: 'USD',
  doc_date: '2026-05-03',
  ...overrides
});

// The gather query is keyed on its twin_aging marker guard.
const cannedTwins = (rows) => ({ match: "payload->'twin_aging'->>'asked_at'", rows });
// Config-plane snapshot rows (base query only; the cohort query falls through).
const cannedConfig = (rows) => ({ match: 'from client_capability_config', rows });
const configRowAt = (stage) => [{ flag_key: TWIN_AGING_ASK_FLAG_KEY, stage, source: 'manual', client_id: 'client-1' }];
const cannedHeldSweep = (rows) => ({ match: "payload->'material_hold'->>'asked_at'", rows });
const HELD_SWEEP_ROW = {
  match_id: 'match-amex',
  bank_transaction_id: 'tx-amex-1',
  matched_object_type: 'bank_statement',
  matched_object_id: 'doc-amex',
  match_amount: 2087.97,
  match_confidence: 0.92,
  matcher_reasoning: 'Exact amount and date; owner authority required.',
  authorization_reasons: ['above_materiality_ceiling'],
  verdict_stamped_at: '2026-08-28T10:00:00Z',
  transaction_date: '2026-06-17',
  description: 'AMEX EPAYMENT 37861257',
  money_in: 0,
  money_out: 2087.97,
  currency: 'USD',
  doc_type: 'bank_statement',
  doc_filename: 'amex-june.pdf',
  doc_counterparty: 'American Express',
  doc_amount: 2087.97,
  doc_currency: 'USD',
  doc_date: '2026-06-17'
};

await test('gather groups aged twin matches per bank line with both candidates', async () => {
  const client = makeMockClient([
    cannedTwins([
      TWIN_ROW(),
      TWIN_ROW({
        match_id: 'match-b', matched_object_id: 'doc-exxon-b',
        doc_filename: 'exxon-may-5.pdf', doc_date: '2026-05-05',
        verdict_stamped_at: '2026-06-30T10:00:00Z'
      }),
      TWIN_ROW({
        match_id: 'match-c', bank_transaction_id: 'tx-fee-9',
        description: 'MONTHLY SERVICE FEE', matched_object_id: 'doc-fee',
        money_out: 25, match_amount: 25, doc_amount: 25
      })
    ])
  ]);
  const now = new Date('2026-07-07T10:00:00Z').getTime();
  const { groups, considered, truncated } = await gatherAgedTwinAskGroups(client, {
    firmId: 'firm-1', clientId: 'client-1', now
  });
  assert.equal(considered, 3);
  assert.equal(truncated, false);
  assert.equal(groups.length, 2);
  const exxon = groups.find((g) => g.transaction_id === 'tx-exxon-1');
  assert.deepEqual(exxon.match_ids, ['match-a', 'match-b']);
  assert.equal(exxon.candidates.length, 2);
  assert.equal(exxon.candidates[0].filename, 'exxon-may-3.pdf');
  assert.equal(exxon.candidates[1].matcher_reasoning.includes('Indistinguishable'), true);
  // The group's age is its OLDEST verdict (match-b, 2026-06-30 → 7 days).
  assert.equal(exxon.aged_days, 7);
  // The receipts shape the send chokepoint reads.
  const receipts = twinAskGroupReceipts(groups);
  assert.deepEqual(receipts[0].candidate_document_ids, ['doc-exxon-a', 'doc-exxon-b']);
  assert.equal(receipts[0].transaction_id, 'tx-exxon-1');
  // The SQL carries the gate params: 3-day default window, twin + material reason arrays.
  const gatherCall = client.calls.find((c) => c.sql.includes('twin_aging'));
  assert.equal(gatherCall.params[2], '3');
  assert.deepEqual(gatherCall.params[4], ['ambiguous_candidates', 'insufficient_separation']);
  assert.deepEqual(gatherCall.params[5], ['above_materiality_ceiling', 'materiality_ceiling_unset']);
});

await test('the aging window is a tuning knob (env), default 3 days', () => {
  assert.equal(twinAgingAskDays({}), 3);
  assert.equal(twinAgingAskDays({ RECONCILIATION_TWIN_AGING_ASK_DAYS: '5' }), 5);
  assert.equal(twinAgingAskDays({ RECONCILIATION_TWIN_AGING_ASK_DAYS: 'nope' }), 3);
});

await test('sweep: twin flag off is quiet when no ungated material confirmation is owed', async () => {
  const client = makeMockClient([cannedConfig([])]);
  const out = await sweepTwinAgingAskDraftRequests({
    client, firmId: 'firm-1', clientId: 'client-1', env: CANARY_ENV
  });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'flag_off');
  assert.ok(!hasCall(client, 'twin_aging'), 'the gated twin gather never ran');
  assert.ok(hasCall(client, 'material_hold'), 'the ungated recovery lane was checked');
  assert.ok(!hasCall(client, 'insert into loop_event_outbox'), 'nothing enqueued');
});

await test('sweep: a material-held confirmation replaces an exhausted/cancelled draft request even with the twin flag off', async () => {
  const client = makeMockClient([
    cannedConfig([]),
    cannedHeldSweep([HELD_SWEEP_ROW]),
    { match: 'to_regclass', rows: [{ present: 'x' }] },
    { match: 'select metadata from firms', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
    { match: "event_type = 'ask_draft.requested'", rows: [] },
    { match: 'insert into loop_event_outbox', rows: [{ id: 'ob-recovery' }] }
  ]);
  const out = await sweepTwinAgingAskDraftRequests({
    client, firmId: 'firm-1', clientId: 'client-1', env: CANARY_ENV
  });

  assert.equal(out.skipped, false);
  assert.equal(out.groups, 0);
  assert.equal(out.held_groups, 1);
  assert.equal(out.enqueued, 1);
  const coalesce = client.calls.find((call) => call.sql.includes("event_type = 'ask_draft.requested'"));
  assert.match(coalesce.sql, /status in \('pending', 'dispatching', 'failed'\)/,
    'cancelled/dead-lettered requests do not suppress recovery');
  const enqueue = client.calls.find((call) => call.sql.includes('insert into loop_event_outbox'));
  const payload = JSON.parse(enqueue.params[6]);
  assert.equal(payload.source, 'suggested_match_ask_sweep');
  assert.equal(payload.identity_contract, 'call_local_handles_v1');
  assert.equal(payload.held_match_groups, 1);
});

await test('sweep at shadow: the would-mint is receipted, nothing enqueued', async () => {
  const client = makeMockClient([
    cannedConfig(configRowAt('shadow')),
    cannedTwins([TWIN_ROW()])
  ]);
  const out = await sweepTwinAgingAskDraftRequests({
    client, firmId: 'firm-1', clientId: 'client-1', env: CANARY_ENV
  });
  assert.equal(out.shadow, true);
  assert.equal(out.groups, 1);
  assert.equal(out.enqueued, 0);
  assert.ok(hasCall(client, 'twin_aging_would_ask'), 'shadow receipt written');
  assert.ok(!hasCall(client, 'insert into loop_event_outbox'), 'nothing enqueued at shadow');
});

await test('sweep at canary: enqueues ONE coalesced ask_draft.requested row', async () => {
  const client = makeMockClient([
    cannedConfig(configRowAt('canary')),
    cannedTwins([TWIN_ROW()]),
    { match: 'to_regclass', rows: [{ present: 'x' }] },
    { match: 'select metadata from firms', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
    { match: 'insert into loop_event_outbox', rows: [{ id: 'ob-1' }] }
  ]);
  const out = await sweepTwinAgingAskDraftRequests({
    client, firmId: 'firm-1', clientId: 'client-1', env: CANARY_ENV
  });
  assert.equal(out.groups, 1);
  assert.equal(out.enqueued, 1);
  const enqueue = client.calls.find((c) => c.sql.includes('insert into loop_event_outbox'));
  assert.ok(enqueue.params.includes('ask_draft.requested'), 'the EXISTING draft-request event');
});

await test('sweep at canary: an already-pending draft request is not duplicated', async () => {
  const client = makeMockClient([
    cannedConfig(configRowAt('canary')),
    cannedTwins([TWIN_ROW()]),
    { match: 'to_regclass', rows: [{ present: 'x' }] },
    { match: 'select metadata from firms', rows: [{ metadata: { loops: { tier: 'canary' } } }] },
    { match: "event_type = 'ask_draft.requested'", rows: [{ '?column?': 1 }] }
  ]);
  const out = await sweepTwinAgingAskDraftRequests({
    client, firmId: 'firm-1', clientId: 'client-1', env: CANARY_ENV
  });
  assert.equal(out.enqueued, 0);
  assert.equal(out.reason, 'already_pending');
  assert.ok(!hasCall(client, 'insert into loop_event_outbox'), 'no duplicate row');
});

await test('sweep: a below-canary firm never parks a request (gate blocks the enqueue)', async () => {
  const client = makeMockClient([
    cannedConfig(configRowAt('canary')),
    cannedTwins([TWIN_ROW()]),
    { match: 'to_regclass', rows: [{ present: 'x' }] },
    { match: 'select metadata from firms', rows: [{ metadata: { loops: { tier: 'shadow' } } }] }
  ]);
  const out = await sweepTwinAgingAskDraftRequests({
    client, firmId: 'firm-1', clientId: 'client-1', env: CANARY_ENV
  });
  assert.equal(out.enqueued, 0);
  assert.ok(out.reason, 'a named block reason');
  assert.ok(!hasCall(client, 'insert into loop_event_outbox'), 'nothing enqueued');
});

await test('sweep with no aged twins: quiet no-op (no shadow receipt, no enqueue)', async () => {
  const client = makeMockClient([
    cannedConfig(configRowAt('canary')),
    cannedTwins([])
  ]);
  const out = await sweepTwinAgingAskDraftRequests({
    client, firmId: 'firm-1', clientId: 'client-1', env: CANARY_ENV
  });
  assert.equal(out.groups, 0);
  assert.equal(out.enqueued, 0);
  assert.ok(!hasCall(client, 'twin_aging_would_ask'));
});

// ── The material-hold → owner-confirm lane (2026-08-25, the land-lease rule) ──
// A suggested match held ONLY by authority converts to an owner CONFIRM ask,
// immediately and unconditionally — no aging window, no plane gate. The
// gather's SQL carries the reason arrays inverted vs the twin lane (material
// reasons required, ambiguity reasons excluded) and keys its asked-once guard
// on the material_hold marker.

const HELD_ROW = (overrides = {}) => ({
  match_id: 'match-lease',
  bank_transaction_id: 'tx-lease-1',
  matched_object_type: 'supplier_bill',
  matched_object_id: 'doc-lease',
  match_amount: 831.35,
  match_confidence: 0.92,
  matcher_reasoning: 'Exact amount 831.35 USD on the bill date.',
  authorization_reasons: ['above_materiality_ceiling'],
  verdict_stamped_at: '2026-08-25T20:22:19Z',
  transaction_date: '2025-06-01',
  description: 'LAND LEASE PMT · 801743248367',
  money_in: 0,
  money_out: 831.35,
  currency: 'USD',
  doc_type: 'supplier_bill',
  doc_filename: '25-06-02_Land_Lease_831.35.pdf',
  doc_counterparty: 'Sonoran Land Holdings',
  doc_amount: 831.35,
  doc_currency: 'USD',
  doc_date: '2025-06-02',
  ...overrides
});

const cannedHeld = (rows) => ({ match: "payload->'material_hold'->>'asked_at'", rows });

await test('held-material gather: immediate (no aging window), reasons inverted vs twins', async () => {
  const client = makeMockClient([cannedHeld([HELD_ROW()])]);
  const now = new Date('2026-08-25T20:30:00Z').getTime();
  const { groups, considered, truncated } = await gatherHeldMaterialAskGroups(client, {
    firmId: 'firm-1', clientId: 'client-1', now
  });
  assert.equal(considered, 1);
  assert.equal(truncated, false);
  assert.equal(groups.length, 1);
  const lease = groups[0];
  assert.equal(lease.transaction_id, 'tx-lease-1');
  assert.deepEqual(lease.hold_reasons, ['above_materiality_ceiling']);
  assert.equal(lease.candidates.length, 1);
  assert.equal(lease.candidates[0].counterparty, 'Sonoran Land Holdings');
  assert.equal(lease.candidates[0].confidence, 0.92);
  // The SQL: material reasons REQUIRED, ambiguity reasons EXCLUDED, and no
  // aging-window parameter — the hold never self-resolves, so it asks now.
  const gatherCall = client.calls.find((c) => c.sql.includes('material_hold'));
  assert.deepEqual(gatherCall.params[3], ['above_materiality_ceiling', 'materiality_ceiling_unset']);
  assert.deepEqual(gatherCall.params[4], ['ambiguous_candidates', 'insufficient_separation']);
  assert.ok(!gatherCall.sql.includes('days'), 'no aging window in the held-match SQL');
  // The receipts shape the send chokepoint reads.
  const receipts = heldMatchGroupReceipts(groups);
  assert.deepEqual(receipts[0].match_ids, ['match-lease']);
  assert.deepEqual(receipts[0].candidate_document_ids, ['doc-lease']);
  assert.deepEqual(receipts[0].hold_reasons, ['above_materiality_ceiling']);
});

// ── RT-21c: a row match is a settlement of THAT row ─────────────────────────
await test('held-material gather: a koontilasku row match is asked about as its row — the candidate amount is the row net, the row is named', async () => {
  const client = makeMockClient([cannedHeld([HELD_ROW({
    match_id: 'match-nets-vko7', bank_transaction_id: 'tx-nets-7', matched_object_type: 'payout_statement', matched_object_id: 'doc-nets',
    match_amount: 2462.61, description: 'NETS FINLAND OY', money_in: 2462.61, money_out: 0, currency: 'EUR',
    doc_type: 'payout_statement', doc_filename: '14 Nets kuukausiraportti 02-2025.pdf', doc_counterparty: 'Nets',
    doc_amount: 2462.61, doc_currency: 'EUR', doc_date: '2025-02-28',
    matched_line_id: 'doc-nets-ln-3', matched_line_no: 3, matched_line_description: 'VKO7 2025 (10.2.–16.2.)'
  })])]);
  const { groups } = await gatherHeldMaterialAskGroups(client, { firmId: 'firm-1', clientId: 'client-1' });
  assert.equal(groups.length, 1);
  const candidate = groups[0].candidates[0];
  assert.equal(candidate.amount, 2462.61, 'the row net, never the statement total');
  assert.equal(candidate.matched_line_id, 'doc-nets-ln-3');
  assert.equal(candidate.matched_line_no, 3);
  assert.equal(candidate.matched_line_description, 'VKO7 2025 (10.2.–16.2.)');
  const gatherCall = client.calls.find((c) => c.sql.includes('material_hold'));
  assert.ok(gatherCall.sql.includes('left join document_lines dl on dl.id = m.matched_line_id'), 'the gather reads the matched row');
  assert.ok(gatherCall.sql.includes('coalesce(dl.amount, d.total_amount) as doc_amount'));
  // A document-level match carries no row fields at all.
  const plain = makeMockClient([cannedHeld([HELD_ROW()])]);
  const plainGroups = (await gatherHeldMaterialAskGroups(plain, { firmId: 'firm-1', clientId: 'client-1' })).groups;
  assert.equal('matched_line_id' in plainGroups[0].candidates[0], false);
});

// ── RT-21a: the lane predicate is the JS twin of the two gathers' admission ──
// (2026-09-08, the Kultalanka Nets four.) A 'suggested' match "has a lane"
// only when HELD_MATERIAL_SQL or AGED_TWIN_SQL will actually admit it. The
// koontilasku shape — four weekly settlements each tagged `partial_payment`
// against one monthly statement, reasons `below_floor` +
// `insufficient_separation` + `above_materiality_ceiling` — is admitted by
// neither (the material gather excludes twin reasons, the twin gather excludes
// material reasons), so it must read LANELESS, and the coding sweep's rule 3.5
// asks the owner instead of standing down on doc_match_pending.
await test('suggestedMatchHasSettleLane mirrors the gathers: material-and-twin together is laneless', () => {
  // The Nets shape: no gather admits it.
  assert.equal(suggestedMatchHasSettleLane(['below_floor', 'insufficient_separation', 'above_materiality_ceiling']), false);
  assert.equal(suggestedMatchHasSettleLane(['ambiguous_candidates', 'materiality_ceiling_unset']), false);
  // A pure material hold: the held-material gather admits it (with or without
  // below_floor — the SQL never reads below_floor, only material vs twin).
  assert.equal(suggestedMatchHasSettleLane(['above_materiality_ceiling']), true);
  assert.equal(suggestedMatchHasSettleLane(['below_floor', 'above_materiality_ceiling']), true);
  // A pure ambiguity: the aged-twin gather admits it.
  assert.equal(suggestedMatchHasSettleLane(['insufficient_separation']), true);
  assert.equal(suggestedMatchHasSettleLane(['below_floor', 'ambiguous_candidates']), true);
  // No lane-shaped reason at all (the Desert Rose Union Coop shape).
  assert.equal(suggestedMatchHasSettleLane(['below_floor']), false);
  assert.equal(suggestedMatchHasSettleLane([]), false);
  assert.equal(suggestedMatchHasSettleLane(null), false);
});

// ── The stale-ask supersede law (2026-09-01, the February burst race) ────────
// A sweep-minted generic evidence ask must not lock a line out of the confirm/
// twin lanes forever: both gathers' spam guards carry the supersedable
// carve-out, and the JS predicate the drafter-input filter uses must agree
// with the SQL byte-for-byte in meaning.

await test('isSupersedableAskRow: only the sweep-minted generic owner ask, never a reply or a purpose question', () => {
  const base = {
    status: 'open', created_by: 'coding_auto_post',
    evidence_type: 'supporting_document', audience: 'client'
  };
  assert.equal(isSupersedableAskRow(base), true);
  assert.equal(isSupersedableAskRow({ ...base, status: 'draft' }), true);
  // A reply belongs to the reply-recode lane, always.
  assert.equal(isSupersedableAskRow({ ...base, status: 'replied' }), false);
  assert.equal(isSupersedableAskRow({ ...base, status: 'resolved' }), false);
  // A purpose/fact question is never superseded by evidence arriving (the
  // Netflix RCM case: an amount-matched receipt proves existence, not purpose).
  assert.equal(isSupersedableAskRow({ ...base, evidence_type: 'business_purpose' }), false);
  assert.equal(isSupersedableAskRow({ ...base, evidence_type: 'owner_fact' }), false);
  // A model-drafted batch ask is not the sweep's template — untouched.
  assert.equal(isSupersedableAskRow({ ...base, created_by: 'system' }), false);
  // A colleague/agent ask never gets replaced with an owner confirm.
  assert.equal(isSupersedableAskRow({ ...base, audience: 'seat' }), false);
  // A row without an audience column (pre-122) reads as an owner ask.
  assert.equal(isSupersedableAskRow({ status: 'open', created_by: 'coding_auto_post', evidence_type: 'supporting_document' }), true);
});

await test('both gather SQLs carry the supersedable carve-out; replied always blocks', async () => {
  const sql = blockingOpenAskExistsSql({ firmColumn: 'x.firm_id', transactionColumn: 'x.tx_id' });
  assert.match(sql, /cer\.status in \('draft', 'open', 'replied'\)/, 'the blocking population is unchanged');
  assert.match(sql, /and not \(/, 'with a carve-out');
  assert.match(sql, /cer\.created_by = 'coding_auto_post'/);
  assert.match(sql, /cer\.evidence_type = 'supporting_document'/);
  assert.match(sql, /cer\.status in \('draft', 'open'\)/, 'a replied row is never supersedable');
  assert.match(sql, /coalesce\(cer\.audience, 'client'\) = 'client'/);

  const twinClient = makeMockClient([cannedTwins([])]);
  await gatherAgedTwinAskGroups(twinClient, { firmId: 'firm-1', clientId: 'client-1' });
  const twinSql = twinClient.calls.find((c) => c.sql.includes('twin_aging')).sql;
  assert.match(twinSql, /cer\.created_by = 'coding_auto_post'/, 'twin gather admits supersedable-ask lines');

  const heldClient = makeMockClient([cannedHeld([])]);
  await gatherHeldMaterialAskGroups(heldClient, { firmId: 'firm-1', clientId: 'client-1' });
  const heldSql = heldClient.calls.find((c) => c.sql.includes('material_hold')).sql;
  assert.match(heldSql, /cer\.created_by = 'coding_auto_post'/, 'held gather admits supersedable-ask lines');
});

await test('held-material gather: missing tables degrade to empty, never break the draft', async () => {
  const client = makeMockClient([{ match: "payload->'material_hold'->>'asked_at'", throw: Object.assign(new Error('no table'), { code: '42P01' }) }]);
  const out = await gatherHeldMaterialAskGroups(client, { firmId: 'firm-1', clientId: 'client-1' });
  assert.deepEqual(out, { groups: [], considered: 0, truncated: false });
});

// ── The held/twin one-day date shift (round-4 review, 2026-09-01 §B) ─────────
// pg hands a DATE column back as a Date at LOCAL midnight. The lane's old
// `new Date(v).toISOString()` read that as the PREVIOUS UTC day on any
// positive-offset host, so every held/twin confirm on the appliance (UTC+2/+4)
// dated a 1 Jan rent line "31 Dec" and its bill the same — bank line AND
// document. Both gathers now go through dates.js `toIsoDay`; this pins the
// calendar day on a positive-offset host with a pg-shaped Date input.
await test('gather: a pg local-midnight DATE keeps its calendar day on a UTC+2 host (no 31 Dec for a 1 Jan line)', async () => {
  const priorTz = process.env.TZ;
  try {
    process.env.TZ = 'Europe/Helsinki';
    // Exactly what node-postgres returns for `date '2026-01-01'`: local midnight.
    const txDate = new Date(2026, 0, 1);
    const billDate = new Date(2026, 0, 1);
    assert.equal(txDate.toISOString().slice(0, 10), '2025-12-31', 'the harness reproduces the shift the old code had');
    const held = makeMockClient([cannedHeld([HELD_ROW({
      transaction_date: txDate, doc_date: billDate,
      description: 'AL WASL PROPERTIES LLC', money_out: 8500, match_amount: 8500, doc_amount: 8500
    })])]);
    const heldGroups = await gatherHeldMaterialAskGroups(held, {
      firmId: 'firm-1', clientId: 'client-1', now: new Date('2026-01-03T10:00:00Z').getTime()
    });
    assert.equal(heldGroups.groups[0].date, '2026-01-01');
    assert.equal(heldGroups.groups[0].candidates[0].date, '2026-01-01');

    const twins = makeMockClient([cannedTwins([TWIN_ROW({ transaction_date: txDate, doc_date: billDate })])]);
    const twinGroups = await gatherAgedTwinAskGroups(twins, {
      firmId: 'firm-1', clientId: 'client-1', now: new Date('2026-01-10T10:00:00Z').getTime()
    });
    assert.equal(twinGroups.groups[0].date, '2026-01-01');
    assert.equal(twinGroups.groups[0].candidates[0].date, '2026-01-01');
    // ISO strings (the shape tests and JSONB feed) still pass through unchanged.
    const strings = makeMockClient([cannedHeld([HELD_ROW()])]);
    const stringGroups = await gatherHeldMaterialAskGroups(strings, { firmId: 'firm-1', clientId: 'client-1' });
    assert.equal(stringGroups.groups[0].date, HELD_ROW().transaction_date);
  } finally {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  }
});
