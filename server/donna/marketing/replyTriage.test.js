// Reply triage (M4) — coverage for the pure Keep layer: the vocabulary pins,
// the class→action refusal matrix (escalate-only classes can NEVER draft,
// whatever the verdict recommends), snooze clamping, threading headers, and
// the two provider-call contracts (strict schema; provider-RETURNED model id
// — CLAUDE.md "the model id is part of the receipt").

import assert from 'node:assert/strict';
import test from 'node:test';

import { UNSUBSCRIBE_PLACEHOLDER } from './marketingOutbound.js';
import {
  DRAFTABLE_CLASSES,
  ESCALATE_ONLY_CLASSES,
  RECOMMENDED_TRIAGE_ACTIONS,
  SEMANTIC_CLASSES,
  SNOOZE_DAYS_DEFAULT,
  SNOOZE_DAYS_MAX,
  SNOOZE_DAYS_MIN,
  TRIAGE_CONFIDENCES,
  TRIAGE_SOURCE,
  buildReplySubject,
  buildReplyThreadingHeaders,
  buildTriageInstructions,
  buildTriageSchema,
  clampSnoozeDays,
  decideTriageActions,
  validateTriageVerdict
} from './replyTriage.js';
import { buildReplyInstructions, draftInboundReply, triageInboundMessage } from './replyDrafter.js';

// ── Vocabulary pins ──────────────────────────────────────────────────────────

test('vocabularies are pinned (the 2026-07-24 rescope: no booking class anywhere)', () => {
  assert.deepEqual(
    [...SEMANTIC_CLASSES],
    [
      'positive_interest', 'question', 'objection', 'referral', 'not_now',
      'wrong_person', 'hostile_or_sensitive', 'investor_or_press', 'other'
    ]
  );
  assert.deepEqual([...RECOMMENDED_TRIAGE_ACTIONS], ['draft_reply', 'escalate_to_kari', 'record_only', 'suppress']);
  assert.deepEqual([...TRIAGE_CONFIDENCES], ['low', 'medium', 'high']);
  assert.deepEqual([...DRAFTABLE_CLASSES], ['positive_interest', 'question', 'objection', 'not_now']);
  assert.deepEqual([...ESCALATE_ONLY_CLASSES], ['hostile_or_sensitive', 'investor_or_press']);
  assert.equal(TRIAGE_SOURCE, 'reply_triage');
  // Every draftable and escalate-only class is a real class; the two sets are disjoint.
  for (const cls of [...DRAFTABLE_CLASSES, ...ESCALATE_ONLY_CLASSES]) {
    assert.ok(SEMANTIC_CLASSES.includes(cls));
  }
  assert.ok(DRAFTABLE_CLASSES.every((cls) => !ESCALATE_ONLY_CLASSES.includes(cls)));
  // No booking machinery survived the rescope.
  assert.ok(SEMANTIC_CLASSES.every((cls) => !/book|meeting|calendar/.test(cls)));
});

// ── The Keep layer: decideTriageActions ─────────────────────────────────────

const MESSAGE = { id: 'm1', from_email: 'Owner@Example.com' };

test('a draftable class with draft_reply mints a draft', () => {
  for (const cls of DRAFTABLE_CLASSES) {
    const plan = decideTriageActions({
      verdict: { semantic_class: cls, recommended_action: 'draft_reply' },
      message: MESSAGE
    });
    assert.ok(plan.some((a) => a.action === 'mint_draft'), `${cls} should draft`);
  }
});

test('escalate-only classes NEVER draft — even against a confused draft_reply verdict', () => {
  for (const cls of ESCALATE_ONLY_CLASSES) {
    const plan = decideTriageActions({
      verdict: { semantic_class: cls, recommended_action: 'draft_reply' },
      message: MESSAGE
    });
    assert.deepEqual(plan, [], `${cls} must produce no actions (structural refusal)`);
  }
});

test('a non-draft recommendation on a draftable class does not draft', () => {
  const plan = decideTriageActions({
    verdict: { semantic_class: 'question', recommended_action: 'record_only' },
    message: MESSAGE
  });
  assert.ok(!plan.some((a) => a.action === 'mint_draft'));
});

test('suppress is honored through the sanctioned reason enum and ends the conversation', () => {
  const plan = decideTriageActions({
    verdict: { semantic_class: 'other', recommended_action: 'suppress' },
    message: MESSAGE
  });
  assert.deepEqual(plan, [{ action: 'suppress', email: 'owner@example.com', reason: 'unsubscribed' }]);
  // Even for a draftable class: an opt-out wins over everything else.
  const optOut = decideTriageActions({
    verdict: { semantic_class: 'question', recommended_action: 'suppress' },
    message: MESSAGE
  });
  assert.equal(optOut.length, 1);
  assert.equal(optOut[0].action, 'suppress');
});

test('not_now snoozes a matched prospect (clamped) — and only a matched one', () => {
  const plan = decideTriageActions({
    verdict: { semantic_class: 'not_now', recommended_action: 'draft_reply', suggested_snooze_days: 400 },
    message: MESSAGE,
    prospectId: 'p1'
  });
  const snooze = plan.find((a) => a.action === 'snooze');
  assert.ok(snooze, 'matched not_now snoozes');
  assert.equal(snooze.days, SNOOZE_DAYS_MAX, 'snooze clamps at the cap');
  assert.ok(plan.some((a) => a.action === 'mint_draft'), 'the ack draft still mints');

  const unmatched = decideTriageActions({
    verdict: { semantic_class: 'not_now', recommended_action: 'draft_reply', suggested_snooze_days: 30 },
    message: MESSAGE,
    prospectId: null
  });
  assert.ok(!unmatched.some((a) => a.action === 'snooze'), 'no prospect, no snooze');
});

test('an unvocabularied class produces no actions', () => {
  assert.deepEqual(
    decideTriageActions({ verdict: { semantic_class: 'meeting_booked', recommended_action: 'draft_reply' }, message: MESSAGE }),
    []
  );
});

test('clampSnoozeDays bounds and defaults', () => {
  assert.equal(clampSnoozeDays(0), SNOOZE_DAYS_MIN);
  assert.equal(clampSnoozeDays(365), SNOOZE_DAYS_MAX);
  assert.equal(clampSnoozeDays(14.6), 15);
  assert.equal(clampSnoozeDays(null), SNOOZE_DAYS_DEFAULT);
  assert.equal(clampSnoozeDays('nonsense'), SNOOZE_DAYS_DEFAULT);
});

// ── Verdict validation (writer precondition) ────────────────────────────────

test('validateTriageVerdict refuses malformed verdicts and passes clean ones', () => {
  assert.deepEqual(
    validateTriageVerdict({
      semantic_class: 'question',
      confidence: 'high',
      summary: 'They ask about pricing.',
      recommended_action: 'draft_reply'
    }),
    []
  );
  const violations = validateTriageVerdict({ semantic_class: 'nope', confidence: 'sure', summary: '', recommended_action: 'send_now' });
  assert.equal(violations.length, 4);
});

// ── Threading ───────────────────────────────────────────────────────────────

test('threading headers build from the STORED inbound fields', () => {
  assert.deepEqual(buildReplyThreadingHeaders({}), {}, 'no Message-ID, no headers');
  assert.deepEqual(buildReplyThreadingHeaders({ message_id: '<abc@ex>' }), {
    'In-Reply-To': '<abc@ex>',
    References: '<abc@ex>'
  });
  assert.deepEqual(
    buildReplyThreadingHeaders({ message_id: '<c@ex>', references_header: '<a@ex> <b@ex>' }),
    { 'In-Reply-To': '<c@ex>', References: '<a@ex> <b@ex> <c@ex>' }
  );
});

test('reply subjects carry a single Re: with no pile-up', () => {
  assert.equal(buildReplySubject('Your books'), 'Re: Your books');
  assert.equal(buildReplySubject('Re: RE: re: Your books'), 'Re: Your books');
  assert.equal(buildReplySubject(''), 'Re: your note to Donna');
});

// ── Prompt contracts ────────────────────────────────────────────────────────

test('triage instructions carry the class vocabulary, escalation rule, and safe-direction opt-out', () => {
  const instructions = buildTriageInstructions();
  for (const cls of SEMANTIC_CLASSES) assert.ok(instructions.includes(cls), `instructions name ${cls}`);
  assert.match(instructions, /ALWAYS use this for hostile_or_sensitive and investor_or_press/);
  assert.match(instructions, /stopping is always the safe direction/i);
  assert.match(instructions, /never a sales call/i);
  const schema = buildTriageSchema();
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.semantic_class.enum, [...SEMANTIC_CLASSES]);
});

test('reply instructions carry the rails: honest promise, unsubscribe, no invented prices, no booking', () => {
  const instructions = buildReplyInstructions({ signupUrl: 'https://donna.example' });
  assert.match(instructions, /runs the books herself/i);
  assert.match(instructions, /Never guarantee/i);
  assert.ok(instructions.includes(UNSUBSCRIBE_PLACEHOLDER));
  assert.match(instructions, /\$99\/month/);
  assert.ok(instructions.includes('https://donna.example'));
  assert.doesNotMatch(instructions, /book a call|schedule a (call|meeting)|calendly/i);
  const noUrl = buildReplyInstructions({});
  assert.match(noUrl, /no signup URL is configured/i);
});

// ── Provider-call contracts ─────────────────────────────────────────────────

const okFetch = (payload) => async (url, options) => ({
  ok: true,
  json: async () => payload,
  _captured: { url, body: JSON.parse(options.body) }
});

test('triageInboundMessage sends a strict json_schema request and returns the provider model id', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        model: 'gpt-5.4-2026-06-01',
        output_text: JSON.stringify({
          semantic_class: 'question',
          confidence: 'high',
          summary: 'Asks about pricing.',
          recommended_action: 'draft_reply',
          suggested_snooze_days: null,
          referred_contact: null
        })
      })
    };
  };
  const { verdict, model } = await triageInboundMessage({
    message: { from_email: 'a@b-co.example', subject: 'Price?', text_body: 'What does it cost?' },
    fetchImpl,
    openAiConfig: { apiKey: 'k', model: 'gpt-5.4' }
  });
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(model, 'gpt-5.4-2026-06-01', 'the RETURNED id is the receipt');
  assert.equal(verdict.semantic_class, 'question');
});

test('draftInboundReply returns the provider model id and falls back to a threaded subject', async () => {
  const result = await draftInboundReply({
    message: { from_email: 'a@b-co.example', subject: 'Price?' },
    verdict: { semantic_class: 'question', summary: 'Pricing.' },
    fetchImpl: okFetch({
      model: 'gpt-5.4-2026-06-01',
      output_text: JSON.stringify({ subject: '', body: `Answer. ${UNSUBSCRIBE_PLACEHOLDER}` })
    }),
    openAiConfig: { apiKey: 'k', model: 'gpt-5.4' }
  });
  assert.equal(result.model, 'gpt-5.4-2026-06-01');
  assert.equal(result.subject, 'Re: Price?');
});

test('both provider calls fail honestly with no API key (no fallback by design)', async () => {
  await assert.rejects(() => triageInboundMessage({ message: {}, openAiConfig: { apiKey: '', model: 'x' } }), /no deterministic fallback/);
  await assert.rejects(() => draftInboundReply({ message: {}, verdict: {}, openAiConfig: { apiKey: '', model: 'x' } }), /no fallback copy/);
});
