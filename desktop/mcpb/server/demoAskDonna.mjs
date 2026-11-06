// Donna hosted demo — canned ask_donna answers for the Harbor Lane sample
// company (docs/design-donna-chatgpt-app-build-brief.md §3 "demo mode":
// "ask_donna serves CANNED answers for the demo question set (no model call
// for anonymous callers — cost and abuse)").
//
// CONTENT beside demoFixtures.mjs, same rules, one story: every figure, id
// and date below is one the fixtures already carry (demoAskDonna.test.js
// pins the parity), so a conversation over the demo transfers 1:1 to what
// the read tools show. The matcher is a keyword lookup over a closed
// question set plus one honest fallback — no model, no policy, no state.
//
// HONESTY RULES (non-negotiable, pinned by tests):
//   - every answer carries demo: true and a demo_notice; the hosted adapter
//     overrides the notice with its own hosted wording (as it does for the
//     read fixtures), so the DEFAULT here is the shim's DEMO_NOTICE;
//   - the answer shape mirrors the real ask_donna result (mcpAskDonna.js);
//     a proposed action carries requires_confirmation: true, is never
//     applied, and the notice says so; model_id is null — nothing answered
//     from a model;
//   - no custody slogans (the 2026-08-11 copy register);
//   - the desktop shim does NOT import this file (its demo mode is the five
//     read tools, unchanged); only the hosted adapter serves it.

import { DEMO_ENTITY_ID, DEMO_ENTITY_NAME, DEMO_NOTICE } from './demoFixtures.mjs';

const ENTITY = Object.freeze({ id: DEMO_ENTITY_ID, name: DEMO_ENTITY_NAME });

// Mirrors MCP_ASK_DONNA_CONFIRM_VIA in mcpAskDonna.js in shape; in the demo
// there is no owner and no portal thread, and the note says so. The demo
// confirm_action (below) exists so the two-call shape can be walked end to
// end; it applies nothing.
export const DEMO_ASK_DONNA_CONFIRM_VIA = Object.freeze({
  tool: 'confirm_action',
  tool_arguments: 'entity_id, message_id (this reply’s message_id), action_index (the action’s index)',
  also: 'none: this is the demo; there is no owner portal behind it',
  note: 'This is a demo proposal. In a real conversation Donna saves the proposal to the owner’s Donna thread and nothing is recorded until the owner confirms it, in the chat or in their Donna portal. Here you can call confirm_action to see the shape of that step, and nothing is recorded at all.'
});

// The demo confirm_action answer: the shape of a real confirmation with
// applied: false and the demo notice, because there is nothing to apply to.
// No model, no database, no receipt; the hosted adapter serves it beside the
// canned ask_donna answers.
export const DEMO_CONFIRM_ACTION_NOTE =
  'This is the demo, so nothing was recorded. With your own books connected, this call files your answer '
  + 'through the same tracked path as the Confirm button in your Donna portal and writes it to Donna’s audit trail, naming this chat as the door.';

export const demoConfirmActionResultFor = (args = {}) => {
  if (args.entity_id && args.entity_id !== DEMO_ENTITY_ID) return { notFound: true };
  const messageId = String(args.message_id || '').trim() || null;
  const actionIndex = Number.isInteger(args.action_index) ? args.action_index : null;
  const entry = messageId ? DEMO_ASK_DONNA_QUESTIONS.find((candidate) => messageIdFor(candidate.id) === messageId) : null;
  const action = entry && actionIndex != null ? entry.actions[actionIndex] || null : null;
  return {
    result: {
      demo: true,
      demo_notice: DEMO_NOTICE,
      entity: ENTITY,
      message_id: messageId,
      action_index: actionIndex,
      action_type: action?.type ?? null,
      surface: 'demo',
      applied: false,
      outcome: 'demo_not_applied',
      text: action
        ? `Understood, that is the demo proposal: ${action.summary}. ${DEMO_CONFIRM_ACTION_NOTE}`
        : `There is no demo proposal with that message_id and action_index; the proposals come from answering one of the two open questions through ask_donna. ${DEMO_CONFIRM_ACTION_NOTE}`,
      model_id: null
    }
  };
};

// The question set. `patterns` are tested against the lower-cased message;
// the first entry whose pattern matches answers. Order matters: the more
// specific entries (an owner ANSWERING the Amazon ask) sit above the general
// ones (asking ABOUT the Amazon charge). Answers are in Donna's register
// (docs/donna-voice-and-tone.md: lead with the answer, say it once, no em
// dashes, no exclamation marks) and quote only fixture facts.
export const DEMO_ASK_DONNA_QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'amazon-answer',
    example: 'The Amazon purchase on 18 July was a milk frother for the shop.',
    patterns: [/amazon.*\b(was|were|is)\b.*\b(for|a|an|the)\b/i, /\b(frother|grinder|jug|for the shop|for the caf)/i, /184\.?2?0?.*\b(was|for)\b/i],
    text:
      'Got it. I have that as a shop purchase, a milk frother for £184.20 on 18 July, in your own words. '
      + 'Nothing is recorded yet: confirm it here or in your Donna portal and I file the answer and close that question.',
    actions: Object.freeze([
      Object.freeze({
        index: 0,
        type: 'answer_evidence_request',
        evidence_request_id: 'demo-ask-0009',
        summary: 'Answer Donna’s open question demo-ask-0009 with: “A milk frother for the shop.”',
        requires_confirmation: true
      })
    ])
  }),
  Object.freeze({
    id: 'hartley-answer',
    example: 'The £950 to J Hartley was the deposit for the new espresso machine.',
    patterns: [/hartley.*\b(was|were|is)\b.*\b(for|a|an|the)\b/i, /\b(deposit|espresso machine|refund|loan)\b.*hartley/i, /950.*\b(was|for)\b/i],
    text:
      'Understood. I have the £950 transfer to J Hartley on 24 July as a deposit for the new espresso machine, in your own words. '
      + 'Nothing is recorded yet: confirm it here or in your Donna portal and I file the answer and close that question.',
    actions: Object.freeze([
      Object.freeze({
        index: 0,
        type: 'answer_evidence_request',
        evidence_request_id: 'demo-ask-0010',
        summary: 'Answer Donna’s open question demo-ask-0010 with: “A deposit for the new espresso machine.”',
        requires_confirmation: true
      })
    ])
  }),
  Object.freeze({
    id: 'blocking',
    example: 'What is blocking the July close?',
    patterns: [/block/i, /what.*(need|waiting|outstanding|left|remaining)/i, /still need/i, /what.*do you need/i, /close.*(done|ready|finished)/i, /is july (done|closed)/i],
    text:
      'Not yet. I cleared 126 items myself and three more post with the close; four items block it. '
      + 'Two are yours: what the £184.20 Amazon Marketplace purchase on 18 July was, and what the £950 transfer to J Hartley on 24 July was for. '
      + 'Two I am holding on my side: the Stripe payout on 28 July is £26.10 short of the invoices it should settle, so I want the July fee report before matching it, and Fairfield Roasters invoice FR-2214 looks like a duplicate of FR-2209, already paid on 12 July, so I have held it rather than pay it twice. '
      + 'Answer the two questions here or in your Donna portal and the close moves.',
    actions: Object.freeze([])
  }),
  Object.freeze({
    id: 'amazon',
    example: 'Why are you asking about the Amazon charge?',
    patterns: [/amazon/i, /184/i, /receipt/i],
    text:
      'There is no receipt on file for the £184.20 Amazon Marketplace charge on 18 July, so I cannot code it with confidence. '
      + 'A one-line answer is enough: tell me what it was and I file it once you confirm.',
    actions: Object.freeze([])
  }),
  Object.freeze({
    id: 'hartley',
    example: 'What is the J Hartley transfer about?',
    patterns: [/hartley/i, /950/i, /transfer/i],
    text:
      'The £950 bank transfer to J Hartley on 24 July has no invoice or note attached, and only you know what it was for. '
      + 'I asked on 31 July. Tell me here and I file it once you confirm.',
    actions: Object.freeze([])
  }),
  Object.freeze({
    id: 'stripe',
    example: 'Why is the Stripe payout held?',
    patterns: [/stripe/i, /payout/i, /26\.1/i],
    text:
      'The Stripe payout of £1,912.44 on 28 July is £26.10 short of the invoices it should settle. '
      + 'That looks like a fee line, and I would rather see the July fee report than guess, so the payout is held until it arrives. Nothing needed from you unless you have the report handy.',
    actions: Object.freeze([])
  }),
  Object.freeze({
    id: 'fairfield',
    example: 'Did you pay Fairfield Roasters twice?',
    patterns: [/fairfield/i, /duplicate/i, /twice/i, /fr-22/i, /roaster/i],
    text:
      'No. Fairfield Roasters invoice FR-2214 for £412.50 looks like a duplicate of FR-2209, which was matched and paid on 12 July. '
      + 'I have held FR-2214 so it is not paid twice. If it is a genuine second invoice, tell me and I will treat it as one.',
    actions: Object.freeze([])
  }),
  Object.freeze({
    id: 'overnight',
    example: 'What did you do overnight?',
    patterns: [/overnight/i, /what did you do/i, /recent/i, /yesterday/i, /last night/i, /activity/i],
    text:
      'This morning I auto-cleared two more bank lines, read the Fairfield Roasters invoice that arrived on 30 July and held it as a likely duplicate, and sent you the question about the J Hartley transfer. '
      + 'On 28 July I saved a merchant rule from one of your earlier answers, so that vendor codes itself from now on.',
    actions: Object.freeze([])
  }),
  Object.freeze({
    id: 'subscriptions',
    example: 'What is posting with the close?',
    patterns: [/posting with/i, /confirmable/i, /notion/i, /tfl|transport for london/i, /british gas/i, /subscription/i],
    text:
      'Three lines post with the close, none needing you: Notion, £12 on 15 July, the monthly software subscription on its standing rule; Transport for London, £46.80 on 21 July, staff travel consistent with prior months; and British Gas, £89 on 26 July, the utilities direct debit matching the July bill.',
    actions: Object.freeze([])
  })
]);

// The honest fallback: the demo answers its question set and nothing else.
// No model is called for an anonymous caller, so an out-of-set question gets
// the set, not an invention.
export const DEMO_ASK_DONNA_FALLBACK = Object.freeze({
  id: 'fallback',
  text:
    'In this demo I can only answer about Harbor Lane Coffee’s July close: what is blocking it, the Amazon and J Hartley questions, the Stripe payout, the Fairfield Roasters invoice, what posts with the close, and what I did overnight. '
    + 'Ask one of those, or answer one of my two open questions and I will show you the proposal I would file. '
    + 'With your own books connected, you can ask me anything about them.',
  actions: Object.freeze([])
});

const messageIdFor = (entryId) => `demo-msg-${entryId}`;

// Lookup only. Returns:
//   { result }          — the demo answer (demo/demo_notice on every answer)
//   { notFound: true }  — entity_id given but not the demo entity
export const demoAskDonnaResultFor = (args = {}) => {
  if (args.entity_id && args.entity_id !== DEMO_ENTITY_ID) return { notFound: true };
  const message = String(args.message || '').trim();
  const entry = message
    ? DEMO_ASK_DONNA_QUESTIONS.find((candidate) => candidate.patterns.some((pattern) => pattern.test(message)))
    : null;
  const answer = entry || DEMO_ASK_DONNA_FALLBACK;
  return {
    result: {
      demo: true,
      demo_notice: DEMO_NOTICE,
      entity: ENTITY,
      user_message_id: `demo-msg-user-${answer.id}`,
      message_id: messageIdFor(answer.id),
      surface: 'demo',
      applied: false,
      confirm_via: DEMO_ASK_DONNA_CONFIRM_VIA,
      text: answer.text,
      actions: answer.actions.map((action) => ({ ...action })),
      // No model answered: canned text, by design (brief §3 demo mode).
      model_id: null,
      matched_question: answer.id
    }
  };
};
