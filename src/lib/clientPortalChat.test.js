// Client-portal chat — FE pure-helper tests.
//
// Pins the owner-facing rendering contract:
//   - three roles map to two speakers + a quiet notice;
//   - a system FAILURE row renders friendly copy, never the raw
//     failure payload — but is not silently dropped;
//   - empty/malformed rows are filtered without throwing;
//   - error copy is plain words keyed off the status the server sends
//     (402 billing backstop, auth, generic).

import assert from 'node:assert/strict';

import {
  portalChatActionCards,
  portalChatDisplayMessages,
  portalChatErrorCopy,
  portalChatOwnerIntentCandidateCards,
  portalEvidenceTopicCards
} from './clientPortalChat.js';

let passed = 0;
let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err?.stack || err?.message || err}`);
  }
};

console.log('clientPortalChat (FE helpers):');

await test('maps user/assistant rows to you/donna speakers in order', () => {
  const out = portalChatDisplayMessages([
    { id: 'm1', role: 'user', content: 'Is my Shopify invoice paid?', created_at: '2026-07-06T10:00:00Z' },
    { id: 'm2', role: 'assistant', content: 'Yes — it settled on 2 July.', created_at: '2026-07-06T10:00:05Z' }
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((m) => m.speaker), ['you', 'donna']);
  assert.equal(out[0].text, 'Is my Shopify invoice paid?');
  assert.equal(out[1].at, '2026-07-06T10:00:05Z');
});

await test('system failure row renders friendly notice, not the raw payload', () => {
  const out = portalChatDisplayMessages([
    {
      id: 's1',
      role: 'system',
      content: 'Chat unavailable: anthropic_529 (model=claude-opus-4-8, stop_reason=unknown).',
      payload: { failure_code: 'anthropic_529' }
    }
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].speaker, 'notice');
  assert.ok(!out[0].text.includes('anthropic'), 'raw failure code must not leak to the owner');
  assert.ok(out[0].text.length > 0);
});

await test('non-failure system rows render their content as a notice', () => {
  const out = portalChatDisplayMessages([
    { id: 's2', role: 'system', content: 'Donna is reviewing June.', payload: {} }
  ]);
  assert.equal(out[0].speaker, 'notice');
  assert.equal(out[0].text, 'Donna is reviewing June.');
});

await test('drops malformed, id-less, and empty rows without throwing', () => {
  const out = portalChatDisplayMessages([
    null,
    {},
    { id: 'x', role: 'user', content: '   ' },
    { id: 'y', role: 'unknown_role', content: 'hi' },
    'not-an-object'
  ]);
  assert.deepEqual(out, []);
  assert.deepEqual(portalChatDisplayMessages(undefined), []);
});

await test('action cards: only assistant answer_evidence_request actions render, with the right states', () => {
  const message = {
    id: 'm9',
    role: 'assistant',
    payload: {
      actions: [
        { type: 'answer_evidence_request', evidence_request_id: 'ask-1', reply_text: 'income tax' },
        { type: 'answer_evidence_request', evidence_request_id: 'ask-2', reply_text: 'old answer', status: 'superseded' },
        { type: 'answer_evidence_request', evidence_request_id: 'ask-3', reply_text: 'done one', status: 'applied' },
        { type: 'apply_category', account_name: 'Fuel' }
      ]
    }
  };
  const cards = portalChatActionCards(message);
  assert.equal(cards.length, 3, 'foreign action types never render as cards');
  assert.deepEqual(cards.map((c) => c.confirmable), [true, false, false]);
  assert.deepEqual(cards.map((c) => c.status), ['proposed', 'superseded', 'applied']);
  assert.equal(cards[0].actionIndex, 0);
  assert.equal(cards[0].messageId, 'm9');
  assert.equal(cards[0].replyText, 'income tax');
  // user/system messages and empty payloads yield no cards
  assert.deepEqual(portalChatActionCards({ id: 'u', role: 'user', payload: { actions: [{ type: 'answer_evidence_request' }] } }), []);
  assert.deepEqual(portalChatActionCards(null), []);
});



await test('evidence topic cards render open persisted topics only', () => {
  const cards = portalEvidenceTopicCards([
    {
      evidence_request_id: 'ask-1',
      status: 'open',
      channel: 'whatsapp',
      current_need: 'Need the Acme receipt',
      last_owner_message_at: '2026-07-14T00:00:00Z',
      last_assessment: { outcome: 'clarification_requested', still_missing: ['receipt'], reason: 'owner asked' },
      recent_turns: [{ reply_excerpt: 'Which receipt do you mean?' }]
    },
    { evidence_request_id: 'ask-2', status: 'answered', current_need: 'Done' },
    { status: 'open', current_need: 'missing id' }
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].evidenceRequestId, 'ask-1');
  assert.equal(cards[0].outcomeLabel, 'clarification requested');
  assert.equal(cards[0].lastReplyExcerpt, 'Which receipt do you mean?');
});

await test('owner intent candidate cards render only proposed read-only summaries', () => {
  const cards = portalChatOwnerIntentCandidateCards([
    {
      proposal_id: 'owner_intent_1',
      status: 'proposed',
      intent_kind: 'memory',
      summary: 'Remember Alex birthday is 4 May.',
      parse_confidence: 'high',
      source_message_id: 'msg-1',
      compile_id: 'ic-1',
      memory_candidate: { id: 'memcand-1', status: 'suggested', target_contract: 'memory', candidate_type: 'fact' },
      preflight: {
        status: 'blocked',
        blockers: [{ code: 'apply_executor_not_enabled' }],
        consequence_diff: { status: 'computed', required_before_apply: true },
        authority: { status: 'owner_confirmation_required', materialized_grant_id: null },
        execution_gate: {
          status: 'blocked',
          enabled: false,
          writer_invoked: false,
          apply_receipt_required: true,
          apply_receipt_persisted: false,
          authority_materialized: false,
          reasons: [{ code: 'apply_executor_not_enabled' }]
        },
        apply_plan: { selected_mutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb' } }
      },
      warnings: ['staged only'],
      unmet_capability_needs: [{ capability: 'memory.remember.v1' }],
      review_mode: 'client_confirmation',
      check_status: 'requires_review'
    },
    { proposal_id: 'owner_intent_2', status: 'applied', summary: 'Already handled' },
    { proposal_id: 'owner_intent_3', status: 'proposed', summary: '   ' },
    null
  ]);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], {
    proposalId: 'owner_intent_1',
    status: 'proposed',
    intentKind: 'memory',
    summary: 'Remember Alex birthday is 4 May.',
    parseConfidence: 'high',
    sourceMessageId: 'msg-1',
    compileId: 'ic-1',
    memoryCandidate: { id: 'memcand-1', status: 'suggested', target_contract: 'memory', candidate_type: 'fact' },
    preflight: {
      status: 'blocked',
      blockers: [{ code: 'apply_executor_not_enabled' }],
      consequence_diff: { status: 'computed', required_before_apply: true },
      authority: { status: 'owner_confirmation_required', materialized_grant_id: null },
      execution_gate: {
        status: 'blocked',
        enabled: false,
        writer_invoked: false,
        apply_receipt_required: true,
        apply_receipt_persisted: false,
        authority_materialized: false,
        reasons: [{ code: 'apply_executor_not_enabled' }]
      },
      apply_plan: { selected_mutation: { verb: 'ask_client', writer: 'createClientEvidenceRequestInDb' } }
    },
    warnings: ['staged only'],
    unmetCapabilityNeeds: [{ capability: 'memory.remember.v1' }],
    reviewMode: 'client_confirmation',
    checkStatus: 'requires_review'
  });
  assert.deepEqual(portalChatOwnerIntentCandidateCards(undefined), []);
});

await test('error copy keys off status: 402 billing, 401/403 auth, default generic', () => {
  assert.match(portalChatErrorCopy({ status: 402 }), /plan|billing/i);
  assert.match(portalChatErrorCopy({ status: 401 }), /sign in/i);
  assert.match(portalChatErrorCopy({ status: 403 }), /sign in/i);
  assert.match(portalChatErrorCopy({ status: 500 }), /try again/i);
  assert.match(portalChatErrorCopy(null), /try again/i);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
