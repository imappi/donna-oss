// Slice 2 — the auto-send PRODUCER for client ask-batches. Drives the real
// drainAutoSendAskBatches through a mock pg client (same harness shape as
// askBatch.test.js / reconciliationEvalConsumer.test.js). Pins the gating split:
//   - a canary firm WITH the auto_send_client_asks toggle SENDS its live draft
//   - a shadow firm does NOT (authorized, but observe-only — tier_too_low → held)
//   - a canary firm WITHOUT the toggle does NOT (requires_human_authority → held)
//   - a SUSPENDED firm does NOT (the kill switch overrides the tier)
//   - an empty / nothing-to-ask draft is skipped (no client-visible message with no Q)
//   - a concurrent supersede/send (ASK_BATCH_NOT_DRAFT) is the idempotent no-op
//   - loops off → a clean skip; the send audit carries the autonomy receipt
//
// The gate is exercised end-to-end through the REAL loopExecutionGate /
// loopExecutionPolicy (no mock gate) so a regression in the Slice-1 unlock is caught.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  drainAutoSendAskBatches, draftAskCount, isSendableDraft, draftRetractionCount
} from './askAutoSendProducer.js';

// A draft that WOULD create a client evidence request (one ask item + one anchored
// statement request) — the sendable shape produced by the ask pipeline.
const SENDABLE_DRAFT = {
  subject: 'Quick questions to close April',
  message_markdown: '## Questions\n1. Check 3851 …',
  items: [
    { transaction_id: 'tx-check-3851', disposition: 'ask', question: 'Who was check 3851 paid to?', evidence_type: 'business_purpose' }
  ],
  statement_requests: [
    { account_reference: 'checking 1587782', request_text: 'Please send statements.', anchor_transaction_ids: ['tx-transfer-1'] }
  ],
  counts: { ask: 1, notify: 0, skip: 0, statement_requests: 1 }
};

// A draft the model decided asks nothing — all items resolved/notify, no anchored
// statement request. Sending it would create zero evidence requests → not delivered.
const EMPTY_DRAFT = {
  subject: 'Nothing outstanding',
  message_markdown: 'All clear.',
  items: [
    { transaction_id: 'tx-1', disposition: 'notify', fyi_note: 'Coded to rent.' }
  ],
  statement_requests: [],
  counts: { ask: 0, notify: 1, skip: 0, statement_requests: 0 }
};

// A draft with NO open question, only the autonomous all-clear for an item we previously
// ASKED about and have since auto-matched or auto-explained (the retraction case). Not
// sendable on its own unless RECONCILE_RETRACTION_AUTOSEND acts for the client on the
// plane (RT-11 converted the env pair) — the question chased the client, so should the
// resolution.
const RETRACTION_ONLY_DRAFT = {
  subject: 'One item handled',
  message_markdown: 'All clear.\n\n**Already handled — you can ignore these**\n- 2025-06-02 — 831.35 — LAND LEASE',
  items: [],
  statement_requests: [],
  retracted_items: [
    { request_id: 'cer-land-lease', transaction_id: 'tx-land-lease', date: '2025-06-02', description: 'LAND LEASE' }
  ],
  counts: { ask: 0, notify: 0, skip: 0, statement_requests: 0 }
};

const draftBatch = ({ id = 'ask-batch-1', firmId = 'firm-1', clientId = 'client-1', draft = SENDABLE_DRAFT } = {}) => ({
  id, firm_id: firmId, client_id: clientId, status: 'draft', payload: { draft }
});

// The retraction lane's plane row (RT-11): client-specific 'auto' for client-1.
const RETRACTION_AUTOSEND_ROWS = [
  { flag_key: 'RECONCILE_RETRACTION_AUTOSEND', stage: 'auto', source: 'default', client_id: 'client-1' }
];

// Mock pg client: answers the to_regclass presence probe, the draft read, and the
// per-firm metadata read (keyed off the firm id param). `firmMetadataById` maps
// firm id → the metadata jsonb the gate will see.
const makeMockClient = ({ drafts = [], firmMetadataById = {}, configRows = [] } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text.includes('to_regclass')) return { rows: [{ present: 'client_ask_batches' }] };
      if (text.includes('from client_ask_batches')) return { rows: drafts };
      if (text.includes('from client_capability_config')) return { rows: configRows };
      if (text.includes('from firms')) {
        const firmId = params?.[0];
        return { rows: [{ metadata: firmMetadataById[firmId] || {} }] };
      }
      return { rows: [] };
    }
  };
};

// A spy send fn (the producer injects this in place of __sendClientAskBatchWithClient).
const makeSendSpy = ({ throwError = null } = {}) => {
  const sent = [];
  return {
    sent,
    fn: async (args) => {
      sent.push(args);
      if (throwError) throw throwError;
      return { id: args.batchId, status: 'sent' };
    }
  };
};

// Global ceiling raised to canary (LOOPS_TIER); a firm still needs its own metadata tier.
const CANARY_ENV = { LOOPS_TIER: 'canary' };

await test('canary firm WITH auto_send toggle sends its live draft, stamped autonomous', async () => {
  const client = makeMockClient({
    drafts: [draftBatch()],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } }
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });

  assert.equal(stats.sent, 1);
  assert.equal(stats.held, 0);
  assert.equal(spy.sent.length, 1);
  assert.equal(spy.sent[0].batchId, 'ask-batch-1');
  assert.equal(spy.sent[0].actorId, 'system');
  assert.equal(spy.sent[0].autoSend, true);
  assert.equal(spy.sent[0].authorizedBy, 'firm_setting:auto_send_client_asks');
});

await test('shadow firm does NOT auto-send (authorized but observe-only)', async () => {
  const client = makeMockClient({
    drafts: [draftBatch()],
    // toggle on, but the firm sits at shadow → gate reports tier_too_low (held)
    firmMetadataById: { 'firm-1': { loops: { tier: 'shadow', auto_send_client_asks: true } } }
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });

  assert.equal(stats.sent, 0);
  assert.equal(stats.held, 1);
  assert.equal(spy.sent.length, 0);
});

await test('canary firm WITHOUT the toggle does NOT auto-send (requires human authority)', async () => {
  const client = makeMockClient({
    drafts: [draftBatch()],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary' } } } // no auto_send_client_asks
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });

  assert.equal(stats.sent, 0);
  assert.equal(stats.held, 1);
  assert.equal(spy.sent.length, 0);
});

await test('a suspended firm does NOT auto-send even with the toggle on', async () => {
  const client = makeMockClient({
    drafts: [draftBatch()],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true, suspended: true } } }
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });

  assert.equal(stats.sent, 0);
  assert.equal(stats.held, 1);
  assert.equal(spy.sent.length, 0);
});

await test('an empty / nothing-to-ask draft is skipped, never sent', async () => {
  const client = makeMockClient({
    drafts: [draftBatch({ draft: EMPTY_DRAFT })],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } }
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });

  assert.equal(stats.empty, 1);
  assert.equal(stats.sent, 0);
  assert.equal(spy.sent.length, 0);
});

await test('a concurrent supersede/send (ASK_BATCH_NOT_DRAFT) is the idempotent no-op, not a failure', async () => {
  const client = makeMockClient({
    drafts: [draftBatch()],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } }
  });
  const err = new Error('Ask batch is sent; only drafts can be sent.');
  err.code = 'ASK_BATCH_NOT_DRAFT';
  err.statusCode = 409;
  const spy = makeSendSpy({ throwError: err });
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });

  assert.equal(stats.idempotent, 1);
  assert.equal(stats.failed, 0);
  assert.equal(stats.sent, 0);
});

await test('a stale apply sends nothing and requests one coalesced fresh draft', async () => {
  const client = makeMockClient({
    drafts: [draftBatch()],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } }
  });
  const err = new Error('The draft is stale.');
  err.code = 'ASK_BATCH_STALE';
  err.statusCode = 409;
  const spy = makeSendSpy({ throwError: err });
  const redrafts = [];
  const stats = await drainAutoSendAskBatches({
    client,
    env: CANARY_ENV,
    sendFn: spy.fn,
    requestRedraftFn: async (args) => { redrafts.push(args); return { enqueued: 1 }; }
  });

  assert.equal(stats.stale, 1);
  assert.equal(stats.sent, 0);
  assert.equal(stats.failed, 0);
  assert.equal(redrafts.length, 1);
  assert.equal(redrafts[0].firmId, 'firm-1');
  assert.equal(redrafts[0].clientId, 'client-1');
});

await test('loops off → a clean skip (no reads, no sends)', async () => {
  const client = makeMockClient({ drafts: [draftBatch()] });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: {}, sendFn: spy.fn });

  assert.equal(stats.skipped, true);
  assert.equal(stats.reason, 'loops_off');
  assert.equal(spy.sent.length, 0);
  assert.equal(client.calls.length, 0, 'no DB work when the master is off');
});

await test('the gate is resolved once per firm across a multi-batch drain', async () => {
  const client = makeMockClient({
    drafts: [
      draftBatch({ id: 'b1', firmId: 'firm-1', clientId: 'c1' }),
      draftBatch({ id: 'b2', firmId: 'firm-1', clientId: 'c2' })
    ],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } }
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });

  assert.equal(stats.sent, 2);
  const firmReads = client.calls.filter((c) => c.sql.toLowerCase().includes('from firms'));
  assert.equal(firmReads.length, 1, 'the firm metadata is read once and cached for the tick');
});

await test('draftAskCount / isSendableDraft read straight off the persisted draft', () => {
  assert.equal(draftAskCount({ draft: SENDABLE_DRAFT }), 2);
  assert.equal(isSendableDraft({ draft: SENDABLE_DRAFT }), true);
  assert.equal(draftAskCount({ draft: EMPTY_DRAFT }), 0);
  assert.equal(isSendableDraft({ draft: EMPTY_DRAFT }), false);
  assert.equal(isSendableDraft({}), false);
  assert.equal(isSendableDraft(null), false);
  // an ask item missing its transaction_id can't anchor a request → not counted
  assert.equal(draftAskCount({ draft: { items: [{ disposition: 'ask' }] } }), 0);
});

await test('draftRetractionCount reads retracted_items off the persisted draft', () => {
  assert.equal(draftRetractionCount({ draft: RETRACTION_ONLY_DRAFT }), 1);
  assert.equal(draftRetractionCount({ draft: EMPTY_DRAFT }), 0);
  assert.equal(draftRetractionCount({}), 0);
  assert.equal(draftRetractionCount(null), 0);
  // a retraction-only draft is NOT sendable by the ask-count rule (no open question) —
  // it only becomes sendable through the flag-gated branch in the drain loop.
  assert.equal(isSendableDraft({ draft: RETRACTION_ONLY_DRAFT }), false);
});

await test('retraction-only draft: SENT when the plane flag acts and the firm is authorized', async () => {
  const client = makeMockClient({
    drafts: [draftBatch({ draft: RETRACTION_ONLY_DRAFT })],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } },
    configRows: RETRACTION_AUTOSEND_ROWS
  });
  const spy = makeSendSpy();
  // No env var can enable this any more (the pair is gone); the row is the only on.
  const stats = await drainAutoSendAskBatches({
    client, env: { ...CANARY_ENV, RECONCILE_RETRACTION_AUTOSEND_ENABLED: 'true' }, sendFn: spy.fn
  });

  assert.equal(stats.sent, 1);
  assert.equal(stats.empty, 0);
  assert.equal(spy.sent.length, 1);
  assert.equal(spy.sent[0].autoSend, true);
});

await test('retraction-only draft: SKIPPED when the flag is off (default), even if authorized', async () => {
  const client = makeMockClient({
    drafts: [draftBatch({ draft: RETRACTION_ONLY_DRAFT })],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } }
  });
  const spy = makeSendSpy();
  // No RECONCILE_RETRACTION_AUTOSEND row for the client (envFallback false — born on the
  // plane) → the retraction stays non-sendable, whatever the env says.
  const stats = await drainAutoSendAskBatches({
    client, env: { ...CANARY_ENV, RECONCILE_RETRACTION_AUTOSEND_ENABLED: 'true' }, sendFn: spy.fn
  });

  assert.equal(stats.empty, 1);
  assert.equal(stats.sent, 0);
  assert.equal(spy.sent.length, 0);
});

// ── F7 — the 7-day FYI send floor (design 2026-07-06 §2) ──────────────────────

import {
  oldestUndeliveredFyiAgeDays, askFyiSendFloorDays, FYI_SEND_FLOOR_FLAG_KEY
} from './askAutoSendProducer.js';

// A pure-FYI draft: no ask items, but the batch payload carries the material
// auto-FYI receipt ids (the Q1 staging shape — five holds auto-reconciled,
// owner_notified still false).
const FYI_ONLY_DRAFT = {
  subject: 'Already matched & posted',
  message_markdown: 'We matched and posted 5 items…',
  items: [],
  statement_requests: [],
  counts: { ask: 0, notify: 0, skip: 0, statement_requests: 0 }
};

const fyiBatch = ({ matchIds = ['m-1', 'm-2'] } = {}) => ({
  id: 'ask-batch-fyi', firm_id: 'firm-1', client_id: 'client-1', status: 'draft',
  payload: { draft: FYI_ONLY_DRAFT, posted_fyi_match_ids: matchIds }
});

// Floor-aware mock: adds handlers for the config plane + the oldest-FYI read.
const makeFloorMockClient = ({ drafts = [], firmMetadataById = {}, configRows = [], oldest = null } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text.includes('to_regclass')) return { rows: [{ present: 'client_ask_batches' }] };
      if (text.includes('from client_ask_batches')) return { rows: drafts };
      if (text.includes('from client_capability_config')) return { rows: configRows };
      if (text.includes('min(updated_at)')) return { rows: [{ oldest }] };
      if (text.includes('from firms')) {
        const firmId = params?.[0];
        return { rows: [{ metadata: firmMetadataById[firmId] || {} }] };
      }
      return { rows: [] };
    }
  };
};

const FLOOR_CONFIG_ROW = { flag_key: FYI_SEND_FLOOR_FLAG_KEY, stage: 'canary', source: 'manual', client_id: 'client-1' };
const AUTHORIZED_FIRM = { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } };

await test('floor knob defaults to 7 days and reads the env override', () => {
  assert.equal(askFyiSendFloorDays({}), 7);
  assert.equal(askFyiSendFloorDays({ ASK_FYI_SEND_FLOOR_DAYS: '3' }), 3);
  assert.equal(askFyiSendFloorDays({ ASK_FYI_SEND_FLOOR_DAYS: 'junk' }), 7);
});

await test('oldestUndeliveredFyiAgeDays reads the persisted receipt stamps (null without ids)', async () => {
  const client = makeFloorMockClient({ oldest: new Date(Date.now() - 8 * 86400000).toISOString() });
  const age = await oldestUndeliveredFyiAgeDays({
    client, firmId: 'firm-1', payload: { posted_fyi_match_ids: ['m-1'] }
  });
  assert.ok(age > 7.9 && age < 8.1, `≈8 days (got ${age})`);
  assert.equal(await oldestUndeliveredFyiAgeDays({ client, firmId: 'firm-1', payload: {} }), null);
});

await test('a pure-FYI draft older than the floor SENDS when the flag acts (F7 closed)', async () => {
  const client = makeFloorMockClient({
    drafts: [fyiBatch()],
    firmMetadataById: AUTHORIZED_FIRM,
    configRows: [FLOOR_CONFIG_ROW],
    oldest: new Date(Date.now() - 8 * 86400000).toISOString()
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });
  assert.equal(stats.sent, 1);
  assert.equal(stats.fyi_floor, 1);
  assert.equal(stats.empty, 0);
  assert.equal(spy.sent[0].batchId, 'ask-batch-fyi');
});

await test('a pure-FYI draft YOUNGER than the floor stays undelivered (waits its 7 days)', async () => {
  const client = makeFloorMockClient({
    drafts: [fyiBatch()],
    firmMetadataById: AUTHORIZED_FIRM,
    configRows: [FLOOR_CONFIG_ROW],
    oldest: new Date(Date.now() - 2 * 86400000).toISOString()
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });
  assert.equal(stats.sent, 0);
  assert.equal(stats.empty, 1);
  assert.equal(stats.fyi_floor, 0);
  assert.equal(spy.sent.length, 0);
});

await test('flag off (no plane row): the floor never trips — pure-FYI drafts rest as before', async () => {
  const client = makeFloorMockClient({
    drafts: [fyiBatch()],
    firmMetadataById: AUTHORIZED_FIRM,
    configRows: [],
    oldest: new Date(Date.now() - 30 * 86400000).toISOString()
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });
  assert.equal(stats.sent, 0);
  assert.equal(stats.empty, 1);
  assert.ok(!client.calls.some((c) => c.sql.toLowerCase().includes('min(updated_at)')), 'the age read never ran');
});

await test('the floor makes the draft sendable but authority still gates delivery (no toggle → held)', async () => {
  const client = makeFloorMockClient({
    drafts: [fyiBatch()],
    firmMetadataById: { 'firm-1': { loops: { tier: 'canary' } } }, // no auto_send toggle
    configRows: [FLOOR_CONFIG_ROW],
    oldest: new Date(Date.now() - 8 * 86400000).toISOString()
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });
  assert.equal(stats.fyi_floor, 1, 'the floor tripped');
  assert.equal(stats.held, 1, 'but the send authority still held it');
  assert.equal(spy.sent.length, 0);
});

// ── The settle gate (B1 + B2, the 2026-07-29 receipt-upload burst) ──────────

const {
  shouldHoldForSettle: __shouldHold,
  countSettlingOwnerUploads: __countSettling,
  askSendSettleMinutes: __settleMinutes,
  ASK_SEND_SETTLE_FLAG_KEY: __SETTLE_FLAG
} = await import('./askAutoSendProducer.js');

// A mock that also answers the config-snapshot read and the settling-uploads
// count, so the gate can be exercised end to end.
const makeSettleClient = ({
  drafts = [], firmMetadataById = {}, settleStage = null, inFlight = 0, countThrows = false
} = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).trim().toLowerCase();
      if (text.includes('to_regclass')) return { rows: [{ present: 'client_ask_batches' }] };
      if (text.includes('from client_ask_batches')) return { rows: drafts };
      if (text.includes('from firms')) {
        return { rows: [{ metadata: firmMetadataById[params?.[0]] || {} }] };
      }
      if (text.includes('from client_capability_config')) {
        return { rows: settleStage ? [{ flag_key: __SETTLE_FLAG, stage: settleStage, source: 'test', client_id: params?.[1] }] : [] };
      }
      if (text.includes('from documents')) {
        if (countThrows) throw new Error('documents read exploded');
        return { rows: [{ in_flight: inFlight }] };
      }
      return { rows: [] };
    }
  };
};

const SETTLE_META = { 'firm-1': { loops: { tier: 'canary', auto_send_client_asks: true } } };

// ---- the pure policy ----

await test('settle policy: an in-flight upload holds the batch when the flag acts', () => {
  assert.equal(__shouldHold({ inFlight: 1, flagActs: true }), true);
  assert.equal(__shouldHold({ inFlight: 3, flagActs: true }), true);
});

await test('settle policy: nothing in flight sends as before', () => {
  assert.equal(__shouldHold({ inFlight: 0, flagActs: true }), false);
});

await test('settle policy: flag off is byte-identical to today, whatever is in flight', () => {
  assert.equal(__shouldHold({ inFlight: 9, flagActs: false }), false);
  assert.equal(__shouldHold({}), false);
});

// Holding on uncertainty is how an owner stops hearing from Donna entirely.
await test('settle policy: an unreadable count fails OPEN, never silences the owner', () => {
  assert.equal(__shouldHold({ inFlight: 0, flagActs: true, readFailed: true }), false);
  assert.equal(__shouldHold({ inFlight: 5, flagActs: true, readFailed: true }), false);
});

await test('the staleness ceiling defaults to 20 minutes and is env-tunable', () => {
  assert.equal(__settleMinutes({}), 20);
  assert.equal(__settleMinutes({ ASK_SEND_SETTLE_MINUTES: '45' }), 45);
  assert.equal(__settleMinutes({ ASK_SEND_SETTLE_MINUTES: 'nonsense' }), 20);
  assert.equal(__settleMinutes({ ASK_SEND_SETTLE_MINUTES: '-5' }), 20, 'a negative ceiling would disable the bound');
});

// ---- the DB read ----

await test('the settling count only counts NON-terminal, owner-initiated, in-window uploads', async () => {
  const client = makeSettleClient({ inFlight: 2 });
  const { count, readFailed } = await __countSettling({ client, firmId: 'firm-1', clientId: 'client-1', settleMinutes: 20 });
  assert.equal(count, 2);
  assert.equal(readFailed, false);
  const sql = client.calls.find((c) => c.sql.includes('from documents')).sql;
  // The staleness bound is what stops a stuck parse silencing a client forever.
  assert.match(sql, /parse_status in \('pending', 'processing'\)/);
  assert.match(sql, /created_at > now\(\) - \(\$3::int \* interval '1 minute'\)/);
  assert.match(sql, /owner_initiated/);
});

await test('a failed settling read reports readFailed rather than a false zero', async () => {
  const client = makeSettleClient({ countThrows: true });
  const { count, readFailed } = await __countSettling({ client, firmId: 'firm-1', clientId: 'client-1', settleMinutes: 20 });
  assert.equal(count, 0);
  assert.equal(readFailed, true, 'the caller must be able to tell "none" from "could not tell"');
});

// ---- end to end through the drain ----

await test('a client with a receipt still being read has its batch HELD, not dropped', async () => {
  const client = makeSettleClient({
    drafts: [draftBatch()], firmMetadataById: SETTLE_META,
    settleStage: 'canary', inFlight: 1
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });
  assert.equal(stats.settling, 1);
  assert.equal(stats.sent, 0);
  assert.equal(spy.sent.length, 0, 'the burst never lands while the upload is in flight');
});

await test('once the upload settles, the very same draft sends on the next tick', async () => {
  const client = makeSettleClient({
    drafts: [draftBatch()], firmMetadataById: SETTLE_META,
    settleStage: 'canary', inFlight: 0
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });
  assert.equal(stats.settling, 0);
  assert.equal(stats.sent, 1, 'a hold defers, it never drops');
  assert.equal(spy.sent[0].batchId, 'ask-batch-1');
});

await test('an unstaged client is byte-identical to before the settle gate existed', async () => {
  const client = makeSettleClient({
    drafts: [draftBatch()], firmMetadataById: SETTLE_META,
    settleStage: null, inFlight: 5
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });
  assert.equal(stats.settling, 0);
  assert.equal(stats.sent, 1);
  const touchedDocuments = client.calls.some((c) => c.sql.includes('from documents'));
  assert.equal(touchedDocuments, false, 'a flag-off client costs no extra query');
});

await test('a documents-read failure sends rather than stranding the owner', async () => {
  const client = makeSettleClient({
    drafts: [draftBatch()], firmMetadataById: SETTLE_META,
    settleStage: 'canary', countThrows: true
  });
  const spy = makeSendSpy();
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: spy.fn });
  assert.equal(stats.settling, 0);
  assert.equal(stats.sent, 1);
});

await test('the settle gate runs BEFORE the authority gate, so a held batch costs no firm read', async () => {
  const client = makeSettleClient({
    drafts: [draftBatch()], firmMetadataById: SETTLE_META,
    settleStage: 'canary', inFlight: 1
  });
  await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: makeSendSpy().fn });
  assert.equal(client.calls.some((c) => c.sql.includes('from firms')), false);
});

await test('an empty draft is still skipped as empty, never counted as settling', async () => {
  const client = makeSettleClient({
    drafts: [draftBatch({ draft: EMPTY_DRAFT })], firmMetadataById: SETTLE_META,
    settleStage: 'canary', inFlight: 1
  });
  const stats = await drainAutoSendAskBatches({ client, env: CANARY_ENV, sendFn: makeSendSpy().fn });
  assert.equal(stats.empty, 1);
  assert.equal(stats.settling, 0);
});
