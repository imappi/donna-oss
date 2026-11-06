// Slice I — L2 playbook library v1. The pure half: deterministic per-case retrieval
// (a recall aid that gates nothing — the #497 guard note in the module header),
// bounded prompt rendering, the BOOKKEEPING_PLAYBOOK_RETRIEVAL acts/observes duals
// (BOTH dormant without a DB row — new live behaviour lands off), and the persisted
// mint-stamp → receipt-id sanitizer. The threading halves (prompt injection in
// transactionChat.js / api.js, receipt fill in feedChatProposalShadow.js) are covered
// in those modules' own tests.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOKKEEPING_PLAYBOOK_FLAG_KEY,
  BOOKKEEPING_PLAYBOOKS,
  MAX_PLAYBOOKS_PER_CASE,
  playbookRetrievalActs,
  playbookRetrievalObserves,
  selectPlaybooksForCase,
  renderPlaybooksForPrompt,
  playbookIdsFromMessagePayload
} from './bookkeepingPlaybooks.js';

const cleanEnv = {};

test('flag key is the plan §7 key', () => {
  assert.equal(BOOKKEEPING_PLAYBOOK_FLAG_KEY, 'BOOKKEEPING_PLAYBOOK_RETRIEVAL');
});

// --- library shape invariants -------------------------------------------------

test('every playbook is complete: id, title, triggers, guidance, escalation', () => {
  assert.ok(BOOKKEEPING_PLAYBOOKS.length >= 1);
  for (const playbook of BOOKKEEPING_PLAYBOOKS) {
    assert.ok(playbook.id && typeof playbook.id === 'string', 'id');
    assert.ok(playbook.title, `${playbook.id}: title`);
    assert.ok(Array.isArray(playbook.triggers) && playbook.triggers.length, `${playbook.id}: triggers`);
    assert.ok(playbook.what_it_is, `${playbook.id}: what_it_is`);
    assert.ok(playbook.do.length && playbook.do_not.length, `${playbook.id}: do/do_not`);
    // Two-terminal-states: a playbook with no owner-escalation lane would invite a
    // firm-side parking lot. Every playbook must name when to ask the OWNER.
    assert.ok(playbook.escalate_when.length, `${playbook.id}: escalate_when`);
    for (const re of playbook.triggers) {
      assert.equal(re.global, false, `${playbook.id}: /g trigger would carry lastIndex state across .test calls`);
    }
  }
});

test('playbook ids are unique (they are the receipt vocabulary)', () => {
  const ids = BOOKKEEPING_PLAYBOOKS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

// --- selection ------------------------------------------------------------------

test('selectPlaybooksForCase: stripe payout descriptors match on any text field', () => {
  const hit = (fields) => selectPlaybooksForCase(fields).map((p) => p.id);
  assert.deepEqual(hit({ description: 'STRIPE PAYOUT' }), ['stripe_payout_reconciliation']);
  assert.deepEqual(hit({ raw_description: 'ORIG CO NAME=STRIPE ST-K3M2N4' }), ['stripe_payout_reconciliation']);
  assert.deepEqual(hit({ counterparty: 'Stripe Payments UK Ltd' }), ['stripe_payout_reconciliation']);
  assert.deepEqual(hit({ description: 'transfer', raw_description: 'stripe transfer 2026-06-30' }), ['stripe_payout_reconciliation']);
});

test('selectPlaybooksForCase: square/shopify payout descriptors match (Honeybee statement fixtures)', () => {
  const hit = (fields) => selectPlaybooksForCase(fields).map((p) => p.id);
  assert.deepEqual(hit({ description: 'SHOPIFY INC ACH 889512' }), ['processor_payout_reconciliation']);
  assert.deepEqual(hit({ raw_description: 'SQUARE INC 99623697367' }), ['processor_payout_reconciliation']);
  assert.deepEqual(hit({ counterparty: 'Shopify Payments (USA) Inc' }), ['processor_payout_reconciliation']);
  assert.deepEqual(hit({ description: 'SQUAREUP DEPOSIT 2026-06-16' }), ['processor_payout_reconciliation']);
});

test('selectPlaybooksForCase: credit-card payment descriptors match (Honeybee statement fixtures)', () => {
  const hit = (fields) => selectPlaybooksForCase(fields).map((p) => p.id);
  assert.deepEqual(hit({ description: 'AMEX EPAYMENT ACH 37861257' }), ['credit_card_payment_settlement']);
  assert.deepEqual(hit({ raw_description: 'CHASE EPAY 000482217' }), ['credit_card_payment_settlement']);
  assert.deepEqual(hit({ description: 'CAPITAL ONE AUTOPAY PYMT' }), ['credit_card_payment_settlement']);
  assert.deepEqual(hit({ description: 'ACH DEBIT CRCARDPMT 8842' }), ['credit_card_payment_settlement']);
});

test('selectPlaybooksForCase: inter-account transfer descriptors match (Honeybee statement fixtures)', () => {
  const hit = (fields) => selectPlaybooksForCase(fields).map((p) => p.id);
  assert.deepEqual(hit({ description: 'ONLINE TRANSFER TO CHECKING 1587782' }), ['interaccount_transfer']);
  assert.deepEqual(hit({ description: 'ONLINE TRANSFER FROM SAVINGS 6301512' }), ['interaccount_transfer']);
  assert.deepEqual(hit({ raw_description: 'INTERNAL TRANSFER REF 99213' }), ['interaccount_transfer']);
  assert.deepEqual(hit({ description: 'XFER TO SAV 0091' }), ['interaccount_transfer']);
});

test('selectPlaybooksForCase: issuer/transfer words alone do not trigger (payments to third parties stay unguided)', () => {
  // A wire/transfer TO a third party is a payment, not an internal movement —
  // and a card brand word inside an ordinary merchant name is not an issuer
  // settlement. Both must stay [] so no misleading guidance rides the prompt.
  assert.deepEqual(selectPlaybooksForCase({ description: 'WIRE TRANSFER TO ACME SUPPLIES LLC' }), []);
  assert.deepEqual(selectPlaybooksForCase({ description: 'PAYPAL TRANSFER 88213' }), []);
  assert.deepEqual(selectPlaybooksForCase({ description: 'AMEX GBT TRAVEL BOOKING 5521' }), []);
  assert.deepEqual(selectPlaybooksForCase({ description: 'DISCOVER CARD CAFE 0428' }), []);
});

test('selectPlaybooksForCase: word-bounded — no substring false positives, no signal → []', () => {
  assert.deepEqual(selectPlaybooksForCase({ description: 'STRIPED SHIRT CO INVOICE' }), []);
  assert.deepEqual(selectPlaybooksForCase({ description: 'PINSTRIPES CATERING' }), []);
  assert.deepEqual(selectPlaybooksForCase({ description: 'AWS EMEA monthly' }), []);
  // Bare "square" is an ordinary merchant word — only the INC/UP-qualified
  // processor forms may trigger.
  assert.deepEqual(selectPlaybooksForCase({ description: 'TOWN SQUARE MARKET POS' }), []);
  assert.deepEqual(selectPlaybooksForCase({ description: 'SQUARE ONE CAFE 0428' }), []);
  assert.deepEqual(selectPlaybooksForCase({ counterparty: 'Madison Square Garden' }), []);
  assert.deepEqual(selectPlaybooksForCase({}), []);
  assert.deepEqual(selectPlaybooksForCase(), []);
  assert.deepEqual(selectPlaybooksForCase({ description: null, raw_description: undefined, counterparty: 42 }), []);
});

test('selectPlaybooksForCase: result is capped at MAX_PLAYBOOKS_PER_CASE', () => {
  const matched = selectPlaybooksForCase({ description: 'stripe payout' });
  assert.ok(matched.length <= MAX_PLAYBOOKS_PER_CASE);
});

// --- rendering ------------------------------------------------------------------

test('renderPlaybooksForPrompt: compact bounded shape, no trigger plumbing leaks', () => {
  const rendered = renderPlaybooksForPrompt(selectPlaybooksForCase({ description: 'stripe payout' }));
  assert.equal(rendered.length, 1);
  const [pb] = rendered;
  assert.equal(pb.id, 'stripe_payout_reconciliation');
  assert.ok(pb.title && pb.what_it_is && pb.tax_note);
  assert.ok(pb.do.length && pb.do_not.length && pb.escalate_when.length);
  assert.equal('triggers' in pb, false);
  for (const item of [...pb.do, ...pb.do_not, ...pb.escalate_when]) {
    assert.ok(item.length <= 300);
  }
});

test('renderPlaybooksForPrompt: empty/garbage in → [] out; junk entries dropped', () => {
  assert.deepEqual(renderPlaybooksForPrompt([]), []);
  assert.deepEqual(renderPlaybooksForPrompt(null), []);
  assert.deepEqual(renderPlaybooksForPrompt('nope'), []);
  assert.deepEqual(renderPlaybooksForPrompt([{ title: 'no id' }]), []);
});

// --- config gate duals ------------------------------------------------------------

test('gate: no DB row → fully dormant (BOTH duals false — new live behaviour lands off)', () => {
  assert.equal(playbookRetrievalActs({ snapshot: {}, env: cleanEnv }), false);
  assert.equal(playbookRetrievalObserves({ snapshot: {}, env: cleanEnv }), false);
  assert.equal(playbookRetrievalActs({ snapshot: null, env: cleanEnv }), false);
  assert.equal(playbookRetrievalObserves({ snapshot: null, env: cleanEnv }), false);
});

test('gate: shadow observes but does not act; canary/auto do both; off/dry_run neither', () => {
  const at = (stage) => ({ snapshot: { [BOOKKEEPING_PLAYBOOK_FLAG_KEY]: { stage } }, env: cleanEnv });
  for (const stage of ['off', 'dry_run']) {
    assert.equal(playbookRetrievalObserves(at(stage)), false, stage);
    assert.equal(playbookRetrievalActs(at(stage)), false, stage);
  }
  assert.equal(playbookRetrievalObserves(at('shadow')), true);
  assert.equal(playbookRetrievalActs(at('shadow')), false);
  for (const stage of ['canary', 'auto']) {
    assert.equal(playbookRetrievalObserves(at(stage)), true, stage);
    assert.equal(playbookRetrievalActs(at(stage)), true, stage);
  }
});

test('gate: CLIENT_CONFIG_FORCE_DISABLE kills it fleet-wide', () => {
  const env = { CLIENT_CONFIG_FORCE_DISABLE: BOOKKEEPING_PLAYBOOK_FLAG_KEY };
  const snapshot = { [BOOKKEEPING_PLAYBOOK_FLAG_KEY]: { stage: 'auto' } };
  assert.equal(playbookRetrievalActs({ snapshot, env }), false);
  assert.equal(playbookRetrievalObserves({ snapshot, env }), false);
});

// --- persisted stamp → receipt ids -------------------------------------------------

test('playbookIdsFromMessagePayload: no stamp → null (nothing injected ≠ injected-none)', () => {
  assert.equal(playbookIdsFromMessagePayload(null), null);
  assert.equal(playbookIdsFromMessagePayload({}), null);
  assert.equal(playbookIdsFromMessagePayload({ actions: [] }), null);
  assert.equal(playbookIdsFromMessagePayload({ playbooks_injected: 'stripe' }), null);
});

test('playbookIdsFromMessagePayload: sanitized — strings only, trimmed, deduped', () => {
  assert.deepEqual(
    playbookIdsFromMessagePayload({
      playbooks_injected: ['stripe_payout_reconciliation', ' stripe_payout_reconciliation ', '', 7, null, 'other_pb']
    }),
    ['stripe_payout_reconciliation', 'other_pb']
  );
  assert.deepEqual(playbookIdsFromMessagePayload({ playbooks_injected: [] }), []);
});
