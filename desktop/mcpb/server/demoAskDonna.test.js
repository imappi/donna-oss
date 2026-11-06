// Donna hosted demo — canned ask_donna answers — pins.
//
// Load-bearing properties:
//   - HONESTY: every answer carries demo:true + a demo notice; model_id is
//     null (no model answered); a proposed action carries
//     requires_confirmation:true and the confirm note says nothing is
//     recorded; no custody slogans; no em dashes / exclamation marks in
//     Donna's voice.
//   - ONE STORY: every id, amount and date an answer quotes is one the read
//     fixtures already carry (demoFixtures.mjs) — the conversation transfers
//     1:1 to what the read tools show.
//   - CONTENT, NOT LOGIC: demoAskDonnaResultFor is a keyword lookup — wrong
//     entity ⇒ notFound; an out-of-set question ⇒ the honest fallback, never
//     an invention; the desktop shim does not import this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { DEMO_ENTITY_ID, DEMO_FIXTURES, DEMO_NOTICE } from './demoFixtures.mjs';
import {
  DEMO_ASK_DONNA_CONFIRM_VIA,
  DEMO_ASK_DONNA_FALLBACK,
  DEMO_ASK_DONNA_QUESTIONS,
  demoAskDonnaResultFor
} from './demoAskDonna.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// The real ask_donna result keys (mcpAskDonna.js runAskDonna) — update BOTH
// sides deliberately if the shape ever changes.
const RESULT_KEYS = ['entity', 'user_message_id', 'message_id', 'surface', 'applied', 'confirm_via', 'text', 'actions', 'model_id'];
const ACTION_KEYS = ['index', 'type', 'summary', 'requires_confirmation'];

const CUSTODY_SLOGAN = /never leaves?|stays? on (this|your) (machine|office)|100% private/i;

test('every canned answer is labeled demo, answered by no model, and shaped like the real tool result', () => {
  for (const entry of [...DEMO_ASK_DONNA_QUESTIONS, DEMO_ASK_DONNA_FALLBACK]) {
    const message = entry.example || 'something outside the set';
    const demo = demoAskDonnaResultFor({ entity_id: DEMO_ENTITY_ID, message });
    assert.ok(demo?.result, `${entry.id} answers`);
    const result = demo.result;
    assert.equal(result.demo, true, `${entry.id} carries demo:true`);
    assert.equal(result.demo_notice, DEMO_NOTICE, `${entry.id} carries the notice`);
    assert.equal(result.model_id, null, `${entry.id}: no model answered`);
    assert.equal(result.applied, false);
    assert.equal(result.matched_question, entry.id, `${entry.id} is what its own example matches`);
    for (const key of RESULT_KEYS) assert.ok(key in result, `${entry.id} result carries '${key}' like the real tool`);
    assert.equal(result.entity.id, DEMO_ENTITY_ID);
    assert.match(result.message_id, /^demo-msg-/);
    for (const action of result.actions) {
      for (const key of ACTION_KEYS) assert.ok(key in action, `${entry.id} action carries '${key}'`);
      assert.equal(action.requires_confirmation, true);
      assert.equal(action.type, 'answer_evidence_request', 'the demo proposes only the owner answer verb');
    }
  }
});

test('the confirm note says plainly that nothing is recorded in the demo; no custody slogans anywhere', () => {
  assert.match(DEMO_ASK_DONNA_CONFIRM_VIA.note, /nothing is recorded/i);
  assert.match(DEMO_ASK_DONNA_CONFIRM_VIA.note, /demo/i);
  const source = readFileSync(resolvePath(here, 'demoAskDonna.mjs'), 'utf8');
  assert.doesNotMatch(source, CUSTODY_SLOGAN);
  for (const entry of [...DEMO_ASK_DONNA_QUESTIONS, DEMO_ASK_DONNA_FALLBACK]) {
    assert.doesNotMatch(entry.text, CUSTODY_SLOGAN, entry.id);
    assert.doesNotMatch(entry.text, /[—–]/, `${entry.id}: Donna never uses an em or en dash`);
    assert.doesNotMatch(entry.text, /!/, `${entry.id}: no exclamation marks`);
    assert.doesNotMatch(entry.text, /human (review|back office)|bookkeeper (review|check)/i, `${entry.id}: no implied human reviewer`);
  }
});

test('one story: every ask id, amount and counterparty an answer quotes is in the read fixtures', () => {
  const fixtureText = JSON.stringify(DEMO_FIXTURES);
  const askIds = DEMO_FIXTURES.document_status.entities[0].requests.map((r) => r.id);
  for (const entry of DEMO_ASK_DONNA_QUESTIONS) {
    for (const action of entry.actions) {
      assert.ok(askIds.includes(action.evidence_request_id), `${entry.id} proposes an ask id the fixtures carry`);
    }
    // Every "£<amount>" the answer quotes must be a fixture amount (with or
    // without the thousands separator).
    for (const match of entry.text.matchAll(/£([\d,]+(?:\.\d+)?)/g)) {
      const amount = Number(match[1].replace(/,/g, ''));
      const seen = fixtureText.includes(String(amount)) || fixtureText.includes(String(-amount)) || fixtureText.includes(amount.toFixed(1));
      assert.ok(seen, `${entry.id} quotes £${match[1]}, which the fixtures do not carry`);
    }
  }
  // The blocking answer names all four blockers' counterparties.
  const blocking = DEMO_ASK_DONNA_QUESTIONS.find((q) => q.id === 'blocking');
  for (const blocker of DEMO_FIXTURES.close_status.blockers) {
    assert.ok(blocking.text.includes(blocker.counterparty), `blocking answer names ${blocker.counterparty}`);
  }
  assert.ok(blocking.text.includes(String(DEMO_FIXTURES.close_status.totals.auto_cleared)));
});

test('lookup only: wrong entity ⇒ notFound; out-of-set ⇒ the honest fallback naming the set; owner answers match before questions', () => {
  assert.deepEqual(demoAskDonnaResultFor({ entity_id: 'someone-real', message: 'what is blocking?' }), { notFound: true });
  const out = demoAskDonnaResultFor({ entity_id: DEMO_ENTITY_ID, message: 'What is my VAT position this quarter?' }).result;
  assert.equal(out.matched_question, 'fallback');
  assert.match(out.text, /only answer about Harbor Lane/i);
  assert.deepEqual(out.actions, []);
  const empty = demoAskDonnaResultFor({ entity_id: DEMO_ENTITY_ID, message: '' }).result;
  assert.equal(empty.matched_question, 'fallback');
  // An owner ANSWERING the Amazon ask gets the proposal; asking ABOUT it does not.
  const answer = demoAskDonnaResultFor({ entity_id: DEMO_ENTITY_ID, message: 'The Amazon purchase on 18 July was a milk frother for the shop.' }).result;
  assert.equal(answer.matched_question, 'amazon-answer');
  assert.equal(answer.actions.length, 1);
  assert.equal(answer.actions[0].evidence_request_id, 'demo-ask-0009');
  const about = demoAskDonnaResultFor({ entity_id: DEMO_ENTITY_ID, message: 'Why are you asking about the Amazon charge?' }).result;
  assert.equal(about.matched_question, 'amazon');
  assert.deepEqual(about.actions, []);
  // Results are fresh objects — a caller mutating one cannot change the set.
  answer.actions[0].requires_confirmation = false;
  assert.equal(demoAskDonnaResultFor({ entity_id: DEMO_ENTITY_ID, message: 'The Amazon purchase on 18 July was a milk frother for the shop.' }).result.actions[0].requires_confirmation, true);
});

test('the desktop shim does not serve the hosted ask_donna demo (desktop behaviour unchanged)', () => {
  const shim = readFileSync(resolvePath(here, 'shimCore.mjs'), 'utf8');
  assert.doesNotMatch(shim, /demoAskDonna/);
  const fixtures = readFileSync(resolvePath(here, 'demoFixtures.mjs'), 'utf8');
  assert.doesNotMatch(fixtures, /ask_donna|demoAskDonna/);
});

test('demo confirm_action: applies nothing, no model, labeled; finds the demo proposal by the ask_donna message_id + index; wrong entity ⇒ notFound; unknown proposal ⇒ honest applied:false', async () => {
  const { demoConfirmActionResultFor, DEMO_CONFIRM_ACTION_NOTE } = await import('./demoAskDonna.mjs');
  const proposed = demoAskDonnaResultFor({ entity_id: DEMO_ENTITY_ID, message: 'The £950 to J Hartley was the deposit for the new espresso machine.' }).result;
  assert.equal(proposed.matched_question, 'hartley-answer');
  const confirmed = demoConfirmActionResultFor({ entity_id: DEMO_ENTITY_ID, message_id: proposed.message_id, action_index: proposed.actions[0].index }).result;
  assert.equal(confirmed.demo, true);
  assert.equal(confirmed.demo_notice, DEMO_NOTICE);
  assert.equal(confirmed.applied, false);
  assert.equal(confirmed.outcome, 'demo_not_applied');
  assert.equal(confirmed.action_type, 'answer_evidence_request');
  assert.equal(confirmed.message_id, proposed.message_id);
  assert.equal(confirmed.action_index, 0);
  assert.equal(confirmed.model_id, null);
  assert.match(confirmed.text, /demo-ask-0010/);
  assert.match(confirmed.text, /nothing was recorded/);
  assert.match(DEMO_CONFIRM_ACTION_NOTE, /same tracked path as the Confirm button/);
  assert.match(DEMO_CONFIRM_ACTION_NOTE, /audit trail/);
  // (The shim's DEMO_NOTICE is pre-existing copy; the demo confirm's own text
  // and note follow the register: no custody slogans, no dashes.)
  assert.doesNotMatch(`${confirmed.text} ${DEMO_CONFIRM_ACTION_NOTE}`, /never leave|your office|custody|[—–]/i);
  assert.deepEqual(demoConfirmActionResultFor({ entity_id: 'someone-else', message_id: proposed.message_id, action_index: 0 }), { notFound: true });
  const unknown = demoConfirmActionResultFor({ entity_id: DEMO_ENTITY_ID, message_id: 'demo-msg-blocking', action_index: 0 }).result;
  assert.equal(unknown.applied, false);
  assert.equal(unknown.action_type, null, 'the blocking answer carries no proposal');
  assert.match(unknown.text, /no demo proposal/i);
  // The canned answers now name both doors.
  for (const id of ['amazon-answer', 'hartley-answer']) {
    const entry = DEMO_ASK_DONNA_QUESTIONS.find((q) => q.id === id);
    assert.match(entry.text, /confirm it here or in your Donna portal/);
  }
});
