// Firm-scope (Inbox) feed chat — backend unit tests for UI slice 3.
// The lane is a ROUTER over the per-client grammar: same closed action
// enum, per-venture sanitization, every action carrying the client_id it
// compiles to. These tests pin:
//   - the FIRM action schema requires client_id (and the per-client
//     schema stays untouched — no client_id leaks into its required set)
//   - the firm-mode prompt carries the per-client rules PLUS the firm
//     rules (one action per venture, ids from that venture only, no
//     pipeline_states on this surface)
//   - the firm sanitizer: unknown-venture actions dropped whole,
//     cross-venture transaction_ids dropped per action, client_name
//     attached for the proposal card
//   - the firm context builder: venture cap + truncation flag + the
//     per-venture nesting of the SAME per-client context shape

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildFeedChatContext,
  buildFirmFactsAvailableByClient,
  buildFirmFeedChatContext,
  FEED_CHAT_RESPONSE_SCHEMA,
  FIRM_FEED_CHAT_RESPONSE_SCHEMA,
  FIRM_FEED_CHAT_THREAD,
  MAX_FIRM_CHAT_CLIENTS,
  generateFirmFeedChatReply,
  selectFirmApplyFacts,
  __FEED_CHAT_SYSTEM_PROMPT,
  __FIRM_FEED_CHAT_SYSTEM_PROMPT,
  __sanitizeFirmFeedChatActions
} from './feedChat.js';

const VENTURES = [
  {
    clientId: 'client-a',
    clientName: 'Honeybee Hills Apiary LLC',
    validTransactionIds: ['a-1', 'a-2'],
    knownFacts: [],
    feedRows: [
      { id: 'a-1', description: 'CHEVRON 0093', money_in: 0, money_out: 28.6 },
      { id: 'a-2', description: 'VERIZON WRLS', money_in: 0, money_out: 39.06 }
    ]
  },
  {
    clientId: 'client-b',
    clientName: 'Desert Bloom Apiaries',
    validTransactionIds: ['b-1'],
    knownFacts: [],
    feedRows: [
      { id: 'b-1', description: 'CHEVRON 4411', money_in: 0, money_out: 51.2 }
    ]
  }
];

test('firm action schema requires client_id; per-client schema stays untouched', () => {
  const firmActionSchema = FIRM_FEED_CHAT_RESPONSE_SCHEMA.properties.actions.items;
  assert.ok(firmActionSchema.required.includes('client_id'), 'firm actions must carry client_id');
  assert.ok(firmActionSchema.properties.client_id, 'client_id declared on the firm action schema');
  const clientActionSchema = FEED_CHAT_RESPONSE_SCHEMA.properties.actions.items;
  assert.ok(!clientActionSchema.required.includes('client_id'), 'per-client schema must not grow client_id');
  assert.equal(clientActionSchema.properties.client_id, undefined, 'per-client properties untouched');
});

test('firm prompt carries the per-client rules plus the firm-mode rules', () => {
  assert.ok(
    __FIRM_FEED_CHAT_SYSTEM_PROMPT.startsWith(__FEED_CHAT_SYSTEM_PROMPT),
    'firm prompt extends the per-client prompt, never forks it'
  );
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /EVERY action MUST carry `client_id`/);
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /never spans ventures/);
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /NO pipeline_states/);
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /Do not propose diagnose or retry_parse here/);
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /latest_financial_period/);
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /latest POSTED ledger journal/);
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /do not refuse or caveat a report because its feed is truncated/);
  // G0.2: the truncation rule names the window shape and hard-refuses
  // all-venture claims — not a flag the model may or may not notice.
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /\{shown, total, offset\}/);
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /NEVER claim "all ventures"/);
  assert.match(__FIRM_FEED_CHAT_SYSTEM_PROMPT, /REFUSE all-venture claims/);
});

test('sanitizer drops an action naming an unknown venture entirely', () => {
  const actions = __sanitizeFirmFeedChatActions({
    actions: [
      { type: 'apply_category', client_id: 'client-zzz', transaction_ids: ['a-1'], account_name: 'Fuel' },
      { type: 'apply_category', client_id: 'client-a', transaction_ids: ['a-1'], account_name: 'Fuel' }
    ],
    ventures: VENTURES
  });
  assert.equal(actions.length, 1, 'unknown venture dropped, known kept');
  assert.equal(actions[0].client_id, 'client-a');
});

test('sanitizer drops cross-venture transaction ids per action', () => {
  const [action] = __sanitizeFirmFeedChatActions({
    actions: [
      // b-1 is real but belongs to client-b — from client-a's action it is
      // exactly as invalid as a hallucinated id.
      { type: 'apply_category', client_id: 'client-a', transaction_ids: ['a-1', 'b-1'], account_name: 'Fuel' }
    ],
    ventures: VENTURES
  });
  assert.deepEqual(action.transaction_ids, ['a-1'], 'cross-venture id dropped');
  assert.equal(action.dropped_transaction_ids, 1, 'the drop is visible on the card');
});

test('sanitizer attaches client_name for the proposal card', () => {
  const actions = __sanitizeFirmFeedChatActions({
    actions: [
      { type: 'apply_category', client_id: 'client-b', transaction_ids: ['b-1'], account_name: 'Fuel' }
    ],
    ventures: VENTURES
  });
  assert.equal(actions[0].client_name, 'Desert Bloom Apiaries');
});

test('firm context builder caps ventures and carries the truncation WINDOW (G0.2)', () => {
  const many = Array.from({ length: MAX_FIRM_CHAT_CLIENTS + 3 }, (_, i) => ({
    clientId: `client-${i}`,
    clientName: `Venture ${i}`,
    context: buildFeedChatContext({ feedRows: [], accountOptions: [] })
  }));
  // Derived fallback (no route window): the builder states what it knows —
  // shown + a local total — never a bare boolean.
  const context = buildFirmFeedChatContext({ ventures: many });
  assert.equal(context.ventures.length, MAX_FIRM_CHAT_CLIENTS);
  assert.deepEqual(context.ventures_truncated, {
    shown: MAX_FIRM_CHAT_CLIENTS,
    total: MAX_FIRM_CHAT_CLIENTS + 3,
    offset: 0
  });
  assert.equal(context.mode, 'firm_inbox');
  // Route-provided window wins: the real firm total + the batch offset.
  const windowed = buildFirmFeedChatContext({
    ventures: many.slice(0, 4),
    venturesWindow: { shown: 4, total: 20, offset: 8 }
  });
  assert.deepEqual(windowed.ventures_truncated, { shown: 4, total: 20, offset: 8 });
  // A window that IS the whole firm reads as untruncated.
  const whole = buildFirmFeedChatContext({
    ventures: many.slice(0, 4),
    venturesWindow: { shown: 4, total: 4, offset: 0 }
  });
  assert.equal(whole.ventures_truncated, null);
  // Small firm, no window: null — an 8-or-fewer firm is unchanged.
  const small = buildFirmFeedChatContext({ ventures: many.slice(0, 2) });
  assert.equal(small.ventures_truncated, null);
  // Legacy boolean fallback: truncated-but-total-unknown records null total
  // rather than fabricating a number.
  const legacy = buildFirmFeedChatContext({ ventures: many.slice(0, 2), truncated: true });
  assert.deepEqual(legacy.ventures_truncated, { shown: 2, total: null, offset: 0 });
});

test('firm context carries the deterministic latest posted-ledger period per venture', () => {
  const context = buildFirmFeedChatContext({
    ventures: [{
      ...VENTURES[0],
      latestFinancialPeriod: '2025-08',
      context: buildFeedChatContext({ feedRows: VENTURES[0].feedRows, accountOptions: [] })
    }]
  });
  assert.equal(context.ventures[0].latest_financial_period, '2025-08');
});

test('firm context nests the per-client context shape per venture', () => {
  const ventureContext = buildFeedChatContext({
    clientProfile: { name: 'Honeybee Hills Apiary LLC', jurisdiction: 'US' },
    feedRows: [{ id: 'a-1', description: 'CHEVRON', money_in: 0, money_out: 28.6 }],
    accountOptions: ['Fuel']
  });
  const context = buildFirmFeedChatContext({
    ventures: [{ clientId: 'client-a', clientName: 'Honeybee Hills Apiary LLC', context: ventureContext }]
  });
  const [venture] = context.ventures;
  assert.equal(venture.client_id, 'client-a');
  assert.equal(venture.client_name, 'Honeybee Hills Apiary LLC');
  // The SAME keys the per-client lane's prompt vocabulary describes.
  assert.ok(Array.isArray(venture.feed_rows), 'feed_rows nested');
  assert.ok(Array.isArray(venture.account_options), 'account_options nested');
  assert.ok(venture.client, 'client block nested');
});

test('mint stamp is per-venture bundles — never a cross-venture union (G0.1)', () => {
  const byClient = buildFirmFactsAvailableByClient([
    { ...VENTURES[0], knownFacts: [{ id: 'fact-a1' }, { id: 'fact-a2' }, { id: 'fact-a1' }] },
    { ...VENTURES[1], knownFacts: [{ id: 'fact-b1' }] },
    { clientId: 'client-c', clientName: 'No Facts LLC', knownFacts: [], feedRows: [], validTransactionIds: [] }
  ]);
  assert.deepEqual(byClient, {
    'client-a': ['fact-a1', 'fact-a2'],
    'client-b': ['fact-b1']
  }, 'per-venture ids, deduped; a factless venture gets NO entry');
  assert.ok(!Object.values(byClient).some((ids) => ids.includes('fact-a1') && ids.includes('fact-b1')),
    'no bundle unions another venture\'s facts');
  assert.deepEqual(buildFirmFactsAvailableByClient([]), {});
  assert.deepEqual(buildFirmFactsAvailableByClient(null), {});
});

test('apply facts selection: own bundle only; legacy union carries the marker (G0.1)', () => {
  const payload = {
    facts_available_by_client: { 'client-a': ['fact-a1'], 'client-b': ['fact-b1'] }
  };
  // A venture-B action gets B's bundle — a venture-A fact can never ride
  // into B's receipt.
  assert.deepEqual(
    selectFirmApplyFacts({ payload, clientId: 'client-b' }),
    { factsAvailable: ['fact-b1'], legacyUnionReceipt: false }
  );
  // A venture with no entry gets an HONEST empty bundle, never a
  // fallback to the union or another venture's facts.
  assert.deepEqual(
    selectFirmApplyFacts({ payload, clientId: 'client-zzz' }),
    { factsAvailable: [], legacyUnionReceipt: false }
  );
  // The by-client stamp wins even when a legacy union coexists.
  assert.deepEqual(
    selectFirmApplyFacts({
      payload: { ...payload, facts_available: ['fact-a1', 'fact-b1'] },
      clientId: 'client-b'
    }),
    { factsAvailable: ['fact-b1'], legacyUnionReceipt: false }
  );
  // Legacy pre-bundle message: the union still applies (replay keeps
  // working) but the receipt is marked.
  assert.deepEqual(
    selectFirmApplyFacts({
      payload: { facts_available: ['fact-a1', 'fact-b1'] },
      clientId: 'client-b'
    }),
    { factsAvailable: ['fact-a1', 'fact-b1'], legacyUnionReceipt: true }
  );
  // No stamp at all (pre-slice / factless prompt) → null, unmarked.
  assert.deepEqual(
    selectFirmApplyFacts({ payload: {}, clientId: 'client-b' }),
    { factsAvailable: null, legacyUnionReceipt: false }
  );
  assert.deepEqual(
    selectFirmApplyFacts({ payload: null, clientId: 'client-b' }),
    { factsAvailable: null, legacyUnionReceipt: false }
  );
});

test('the firm thread sentinel is dunder-shaped and stable', () => {
  assert.equal(FIRM_FEED_CHAT_THREAD, '__firm_feed__');
});

// ── G0.3 (build-spec PR-7): sanitizer drops surface as an anomaly summary ──
// The route writes a firm_chat.action_anomaly audit row from this summary;
// these tests pin its arithmetic at the seam. Whole-action drops at the firm
// layer are exactly the unknown-venture path (the per-client sanitizer maps
// 1:1); per-action id drops ride dropped_transaction_ids.

const okAnthropicResponse = (input) => ({
  ok: true,
  json: async () => ({
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'submit_structured_reply', input }]
  })
});

test('firm reply summarizes unknown-venture and cross-venture drops (G0.3)', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  const reply = await generateFirmFeedChatReply({
    context: buildFirmFeedChatContext({ ventures: VENTURES.map((venture) => ({ ...venture, context: buildFeedChatContext({ clientProfile: { jurisdiction: 'us' }, feedRows: venture.feedRows }) })) }),
    userMessage: 'code the chevron charges',
    ventures: VENTURES,
    __callAnthropic: async () => okAnthropicResponse({
      text: 'Coding fuel across ventures.',
      actions: [
        // Hallucinated venture: dropped whole.
        { type: 'apply_category', client_id: 'client-zzz', transaction_ids: ['a-1'], account_name: 'Fuel' },
        // Real venture, but b-1 belongs to client-b: the id is dropped.
        { type: 'apply_category', client_id: 'client-a', transaction_ids: ['a-1', 'b-1'], account_name: 'Fuel' }
      ]
    })
  });
  assert.equal(reply.kind, 'ok');
  assert.equal(reply.actions.length, 1, 'unknown-venture action dropped, real one kept');
  assert.deepEqual(reply.action_anomalies, {
    dropped_unknown_venture_actions: 1,
    dropped_transaction_ids: 1
  });
});

test('a clean firm reply reports zero anomalies (G0.3)', async () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key';
  const reply = await generateFirmFeedChatReply({
    context: buildFirmFeedChatContext({ ventures: VENTURES.map((venture) => ({ ...venture, context: buildFeedChatContext({ clientProfile: { jurisdiction: 'us' }, feedRows: venture.feedRows }) })) }),
    userMessage: 'code the chevron charge for the apiary',
    ventures: VENTURES,
    __callAnthropic: async () => okAnthropicResponse({
      text: 'Coding it.',
      actions: [
        { type: 'apply_category', client_id: 'client-a', transaction_ids: ['a-1'], account_name: 'Fuel' }
      ]
    })
  });
  assert.equal(reply.kind, 'ok');
  assert.equal(reply.actions.length, 1);
  assert.deepEqual(reply.action_anomalies, {
    dropped_unknown_venture_actions: 0,
    dropped_transaction_ids: 0
  });
});
