// Merchant-signal pure-helper tests.
//
// Pins:
//   - the denylist (so "Card" never becomes a rollup key)
//   - the weighting (remember_merchant=3, apply_category=1)
//   - the event row shape (must be insertable into merchant_signal_events
//     without surprises)
//
// The DB writer (recordMerchantSignalInDb) is exercised by the apply
// route's manual smoke matrix — it composes a couple of pg queries
// and the integration shape is best caught in a live DB anyway.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SIGNAL_KIND_WEIGHT,
  buildMerchantSignalEventId,
  buildMerchantSignalEventRow,
  deriveMerchantKey,
  isMerchantKeyTooGeneric,
  weightForSignalKind
} from './merchantSignals.js';

// ─── Weighting ───────────────────────────────────────────────────────────

test('SIGNAL_KIND_WEIGHT: remember_merchant is the ONLY minting kind (§7.6, 2026-08-14)', () => {
  // The §7.6 flip: an ordinary apply_category correction contributes NO
  // cross-firm signal — the kind is ABSENT from the weight map, so the
  // writer refuses it fail-closed (invalid_signal_kind). Re-adding
  // apply_category here is the exact neuter the real-PG idempotency
  // test's refusal stage exists to catch.
  assert.deepEqual(Object.keys(SIGNAL_KIND_WEIGHT), ['remember_merchant']);
  assert.equal(SIGNAL_KIND_WEIGHT.remember_merchant, 3);
  assert.equal(weightForSignalKind('apply_category'), 0);
});

test('weightForSignalKind: unknown kinds return 0 (caller treats as "do not record")', () => {
  assert.equal(weightForSignalKind('ask_client'), 0);
  assert.equal(weightForSignalKind(''), 0);
  assert.equal(weightForSignalKind(null), 0);
  assert.equal(weightForSignalKind(undefined), 0);
});

// ─── Generic-key denylist ────────────────────────────────────────────────

test('isMerchantKeyTooGeneric: denylist tokens are rejected', () => {
  // Each token below normalises away under canonicalMerchantPattern's
  // stop-words but defensively guard against future drift in that
  // function. The point is: even if "card" survives normalisation
  // tomorrow, it must not become a rollup row.
  for (const denied of ['card', 'wire', 'payment', 'transfer', 'fee', 'pos', 'atm']) {
    assert.equal(isMerchantKeyTooGeneric(denied), true, `${denied} should be rejected`);
  }
});

test('isMerchantKeyTooGeneric: multi-token strings entirely of denylist words are rejected', () => {
  // Real-world description "CARD PAYMENT" normalises to "card payment".
  // Each word is a denylist hit; together they're still generic.
  assert.equal(isMerchantKeyTooGeneric('card payment'), true);
  assert.equal(isMerchantKeyTooGeneric('cash deposit'), true);
  assert.equal(isMerchantKeyTooGeneric('atm withdrawal fee'), true);
});

test('isMerchantKeyTooGeneric: real merchant tokens are NOT rejected', () => {
  assert.equal(isMerchantKeyTooGeneric('starbucks'), false);
  assert.equal(isMerchantKeyTooGeneric('uber'), false);
  assert.equal(isMerchantKeyTooGeneric('amazon web services'), false);
});

test('isMerchantKeyTooGeneric: short / empty / numeric keys are rejected', () => {
  assert.equal(isMerchantKeyTooGeneric(''), true);
  assert.equal(isMerchantKeyTooGeneric('  '), true);
  assert.equal(isMerchantKeyTooGeneric('a'), true);
  assert.equal(isMerchantKeyTooGeneric('ab'), true);  // below MIN_KEY_LENGTH
  assert.equal(isMerchantKeyTooGeneric('123456'), true);
});

test('isMerchantKeyTooGeneric: nullish and non-string inputs are treated as generic', () => {
  assert.equal(isMerchantKeyTooGeneric(null), true);
  assert.equal(isMerchantKeyTooGeneric(undefined), true);
  assert.equal(isMerchantKeyTooGeneric(42), true);
  assert.equal(isMerchantKeyTooGeneric({}), true);
});

// ─── Key derivation ──────────────────────────────────────────────────────

test('deriveMerchantKey: prefers action.merchant_pattern over transaction fields', () => {
  // The LLM is the most opinionated source — when it explicitly
  // proposes a pattern, trust it. Other fields are folded in as
  // belt-and-braces so canonicalMerchantPattern has signal even when
  // the proposed pattern is weak.
  const key = deriveMerchantKey({
    action: { merchant_pattern: 'Starbucks Pte Ltd' },
    transaction: { description: 'CARD 1234 STARBUCKS 789' }
  });
  assert.match(key, /starbucks/);
});

test('deriveMerchantKey: falls back to transaction.description when action lacks pattern', () => {
  // apply_category actions don't carry a merchant_pattern (the
  // merchant lives on the transaction). Make sure we still produce
  // a usable key.
  const key = deriveMerchantKey({
    action: { account_name: 'Meals' },
    transaction: { description: 'STARBUCKS COFFEE SG' }
  });
  assert.match(key, /starbucks/);
});

test('deriveMerchantKey: empty / nullish inputs return empty string', () => {
  assert.equal(deriveMerchantKey({}), '');
  assert.equal(deriveMerchantKey({ action: null, transaction: null }), '');
  assert.equal(deriveMerchantKey({ action: { merchant_pattern: '' }, transaction: {} }), '');
});

// ─── Event row construction ──────────────────────────────────────────────

const STD_ROW_INPUTS = {
  firmId: 'firm-1',
  clientId: 'client-9',
  transactionId: 'tx-42',
  chatMessageId: 'txchat-tx-42-assistant-abc',
  actionIndex: 0,
  action: {
    type: 'remember_merchant',
    merchant_pattern: 'Starbucks',
    account_name: 'Meals and entertainment',
    account_code: '5500',
    tax_treatment: 'No GST',
    contact_name: 'Starbucks'
  },
  transaction: { description: 'STARBUCKS COFFEE SG' },
  merchantKey: 'starbucks',
  jurisdiction: 'SG',
  signalKind: 'remember_merchant'
};

test('buildMerchantSignalEventRow: returns a full row for a valid input', () => {
  const row = buildMerchantSignalEventRow(STD_ROW_INPUTS);
  assert.ok(row);
  assert.match(row.id, /^msig-[a-f0-9]{24}$/);
  assert.equal(row.firm_id, 'firm-1');
  assert.equal(row.client_id, 'client-9');
  assert.equal(row.merchant_key, 'starbucks');
  assert.equal(row.account_name, 'Meals and entertainment');
  assert.equal(row.account_code, '5500');
  assert.equal(row.jurisdiction, 'SG');
  assert.equal(row.signal_kind, 'remember_merchant');
  assert.equal(row.weight, 3);
});

test('buildMerchantSignalEventRow: remember_merchant weighs 3; the retired apply_category kind builds no row', () => {
  const remember = buildMerchantSignalEventRow(STD_ROW_INPUTS);
  assert.equal(remember.weight, 3);
  // §7.6 (2026-08-14): apply_category is no longer a signal kind — the
  // row builder returns null exactly like any other unknown kind.
  assert.equal(buildMerchantSignalEventRow({ ...STD_ROW_INPUTS, signalKind: 'apply_category' }), null);
});

test('buildMerchantSignalEventRow: returns null when account_name is missing', () => {
  // No account to attribute the signal to → no useful row.
  const row = buildMerchantSignalEventRow({
    ...STD_ROW_INPUTS,
    action: { ...STD_ROW_INPUTS.action, account_name: '' }
  });
  assert.equal(row, null);
});

test('buildMerchantSignalEventRow: returns null when firm_id / client_id / merchantKey missing', () => {
  assert.equal(buildMerchantSignalEventRow({ ...STD_ROW_INPUTS, firmId: '' }), null);
  assert.equal(buildMerchantSignalEventRow({ ...STD_ROW_INPUTS, clientId: '' }), null);
  assert.equal(buildMerchantSignalEventRow({ ...STD_ROW_INPUTS, merchantKey: '' }), null);
});

test('buildMerchantSignalEventRow: returns null on unknown signal_kind', () => {
  assert.equal(buildMerchantSignalEventRow({ ...STD_ROW_INPUTS, signalKind: 'ask_client' }), null);
});

test('buildMerchantSignalEventRow: jurisdiction defaults to empty string', () => {
  // Postgres primary key includes jurisdiction; the rollup table
  // defaults it to '' on insert. The row builder must match that
  // contract so cross-jurisdiction merchants don't get pooled by
  // accident.
  const row = buildMerchantSignalEventRow({ ...STD_ROW_INPUTS, jurisdiction: undefined });
  assert.equal(row.jurisdiction, '');
});

test('buildMerchantSignalEventRow: raw_merchant is truncated to 240 chars', () => {
  const longDescription = 'X'.repeat(1000);
  const row = buildMerchantSignalEventRow({
    ...STD_ROW_INPUTS,
    transaction: { description: longDescription },
    action: { ...STD_ROW_INPUTS.action, merchant_pattern: '' }
  });
  assert.ok(row.raw_merchant.length <= 240);
});

// G−1(d) (build-spec PR-4): the id is DETERMINISTIC over the apply's
// provenance tuple — the reversal of the old "fresh random per call"
// pin, on purpose. A replayed apply must rebuild the SAME id so the
// event insert's `on conflict (id) do nothing` dedupes it; any change
// to the tuple is a new event.
test('buildMerchantSignalEventRow: id is deterministic over the provenance tuple', () => {
  const a = buildMerchantSignalEventRow(STD_ROW_INPUTS);
  const b = buildMerchantSignalEventRow(STD_ROW_INPUTS);
  assert.equal(a.id, b.id, 'same apply replayed → same id');
  assert.equal(
    a.id,
    buildMerchantSignalEventId({
      firmId: STD_ROW_INPUTS.firmId,
      clientId: STD_ROW_INPUTS.clientId,
      transactionId: STD_ROW_INPUTS.transactionId,
      chatMessageId: STD_ROW_INPUTS.chatMessageId,
      actionIndex: STD_ROW_INPUTS.actionIndex,
      signalKind: STD_ROW_INPUTS.signalKind
    }),
    'row id comes from the exported id builder'
  );
});

test('buildMerchantSignalEventId: every tuple field separates events', () => {
  const base = {
    firmId: 'firm-1',
    clientId: 'client-9',
    transactionId: 'tx-1',
    chatMessageId: 'msg-1',
    actionIndex: 0,
    signalKind: 'apply_category'
  };
  const id = buildMerchantSignalEventId(base);
  assert.match(id, /^msig-[a-f0-9]{24}$/);
  for (const [field, value] of [
    ['firmId', 'firm-2'],
    ['clientId', 'client-8'],
    ['transactionId', 'tx-2'],
    ['chatMessageId', 'msg-2'],
    ['actionIndex', 1],
    ['signalKind', 'remember_merchant']
  ]) {
    assert.notEqual(
      buildMerchantSignalEventId({ ...base, [field]: value }),
      id,
      `${field} must separate events`
    );
  }
});
