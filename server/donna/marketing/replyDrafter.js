// Reply drafter — M4's two load-bearing provider calls: (1) triage one
// persisted inbound message into a semantic verdict, (2) draft the response
// email for draftable verdicts. Both follow the marketing drafters'
// convention (nurtureDrafter/dossierDrafter): strong model by default via
// openAiConfig, strict structured outputs, provider-RETURNED model id in the
// result (CLAUDE.md: the model id is part of the receipt), honest 503 when
// the provider is unavailable — no fallback copy, no fallback verdict.
//
// The deterministic layers live elsewhere by design: replyTriage.js decides
// what a verdict is ALLOWED to cause; validateDraftCopy refuses rail-violating
// copy at the mint; the draft rests 'proposed' under per-send approval.

import { BANDS, RECURRING_MONTHLY_PRICE, fmt } from '../../../src/lib/pricing.js';
import { UNSUBSCRIBE_PLACEHOLDER } from './marketingOutbound.js';
import { llmCall } from '../llmCall.js';
import { marketingFailureMessage, marketingKeyMissingMessage, marketingStructuredRequest, resolveMarketingProvider } from './openAiConfig.js';
import {
  buildReplySubject,
  buildTriageInput,
  buildTriageInstructions,
  buildTriageSchema
} from './replyTriage.js';

const providerUnavailable = (code, message) => {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = code;
  return error;
};

// One structured call on the resolved provider (Anthropic first since
// 2026-11-10; OpenAI only without an Anthropic key), through the shared
// envelope. The 503 code stays REPLY_TRIAGE_UNAVAILABLE for both calls, as
// before; its message now names the typed provider cause.
const callResponsesApi = async ({ resolved, fetchImpl, instructions, input, schemaName, schema, executionType, executionId }) => {
  let call;
  try {
    call = await llmCall(marketingStructuredRequest({
      resolved,
      instructions,
      input: JSON.stringify(input),
      schemaName,
      schema,
      store: false,
      executionType,
      executionId,
      fetchImpl
    }));
  } catch (error) {
    const message = marketingFailureMessage(resolved.provider, error);
    if (!message) throw error;
    throw providerUnavailable('REPLY_TRIAGE_UNAVAILABLE', message);
  }
  return { parsed: call.result.parsed, model: call.result.model || resolved.model };
};

// Triage one inbound message. Returns { verdict, model }.
export const triageInboundMessage = async ({ message, lead = null, prospect = null, fetchImpl = fetch, openAiConfig = null } = {}) => {
  const resolved = resolveMarketingProvider({ openAiConfig });
  if (!resolved.ok) {
    throw providerUnavailable(
      'REPLY_TRIAGE_UNAVAILABLE',
      marketingKeyMissingMessage(resolved, 'reply triage (no deterministic fallback)')
    );
  }
  const { parsed, model } = await callResponsesApi({
    resolved,
    fetchImpl,
    instructions: buildTriageInstructions(),
    input: buildTriageInput({ message, lead, prospect }),
    schemaName: 'marketing_reply_triage',
    schema: buildTriageSchema(),
    executionType: 'marketing_inbound_message',
    executionId: message?.id
  });
  return { verdict: parsed, model };
};

// ── The response draft ──────────────────────────────────────────────────────

export const buildReplyInstructions = ({ signupUrl = null } = {}) => [
  'You draft Donna\'s reply to an email she received. Donna is a done-for-you AI bookkeeping service for small single-entity service businesses (US, UK, Singapore, Australia), run by a hands-on founder (Kari, Donna). Donna is 100% self-service: the reader signs up on the site — there are no sales calls to book and no demos to schedule.',
  '',
  'You are given the inbound email, its triage verdict (class + summary), and what we know about the sender. Write the reply Donna would send. A human approves every send — write it well enough to send unchanged.',
  '',
  'Voice: founder-personal, plain, brief (under 150 words of body), zero marketing gloss. Answer what they actually asked. It is fine — good, even — that Donna is openly an AI writing her own mail.',
  '',
  'Per-class guidance:',
  '- positive_interest: thank them, say concretely what happens after signup (connect the bank, upload what exists, Donna takes it from there), and point them at signing up. No pressure, no urgency theater.',
  '- question: answer it plainly and truthfully from the facts below. If the answer depends on something about THEIR business you cannot know, say so and ask that one thing.',
  '- objection: acknowledge it honestly — never argue it away. If the objection is right for their situation, say Donna may not be the fit.',
  '- not_now: a two-sentence warm ack. They said later; respect it, tell them we will check back around when they suggested, no pitch.',
  '',
  'Hard rules (a validator refuses drafts that break these):',
  `- Never say "human-reviewed", "human-monitored", or "review". The honest promise (re-amended 2026-07-23): Donna runs the books herself — no human back office, no bookkeeper reviewing or finishing the work. She acts within the owner's rules, shows what she did, answers questions from a curated base of high-trust accounting and tax sources, and asks only when a fact about their business is something only they can know.`,
  '- Never guarantee outcomes; never say Donna replaces an accountant; never say set-and-forget.',
  `- Prices, only if relevant: one-off/catch-up closes from ${fmt(Math.min(...BANDS.map((b) => b.price)))} per month-close by volume; ongoing subscription flat ${fmt(RECURRING_MONTHLY_PRICE)}/month. Never invent other numbers.`,
  signupUrl
    ? `- The only link you may include besides the unsubscribe placeholder is the signup page: ${signupUrl}. Include it only where it genuinely helps.`
    : '- Include no links other than the unsubscribe placeholder (no signup URL is configured for this deployment).',
  `- The body MUST end with a short opt-out line containing the literal placeholder ${UNSUBSCRIBE_PLACEHOLDER} (e.g. "No more emails? ${UNSUBSCRIBE_PLACEHOLDER}").`,
  '- Subject: reply to their subject (a single leading "Re:" is correct here). Do not invent a new subject unless theirs is empty.',
  '- Plain text only. Never fabricate facts about Donna, the sender, or their business; never quote their email back at length.'
].join('\n');

const buildReplyDraftSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string', description: 'Reply subject, normally "Re: <their subject>".' },
    body: {
      type: 'string',
      description: `Plain-text reply body ending with an opt-out line containing ${UNSUBSCRIBE_PLACEHOLDER}.`
    }
  }
});

export const buildReplyInput = ({ message = {}, verdict = {}, lead = null, prospect = null } = {}) => ({
  inbound_email: {
    from: message.from_email || null,
    subject: message.subject || null,
    text_body: String(message.text_body || '').slice(0, 6000) || null
  },
  triage_verdict: {
    semantic_class: verdict.semantic_class || null,
    summary: verdict.summary || null
  },
  sender_context: {
    known_waitlist_lead: lead ? { email: lead.email, disqualify_reason: lead.reason || null } : null,
    known_prospect: prospect
      ? { company_name: prospect.company_name, jurisdiction: prospect.jurisdiction, status: prospect.status }
      : null
  },
  expected_subject: buildReplySubject(message.subject)
});

// Draft the response for a draftable verdict. Returns { subject, body, model }.
export const draftInboundReply = async ({
  message,
  verdict,
  lead = null,
  prospect = null,
  signupUrl = null,
  fetchImpl = fetch,
  openAiConfig = null
} = {}) => {
  const resolved = resolveMarketingProvider({ openAiConfig });
  if (!resolved.ok) {
    throw providerUnavailable(
      'REPLY_DRAFTER_UNAVAILABLE',
      marketingKeyMissingMessage(resolved, 'reply drafter')
    );
  }
  const { parsed, model } = await callResponsesApi({
    resolved,
    fetchImpl,
    instructions: buildReplyInstructions({ signupUrl }),
    input: buildReplyInput({ message, verdict, lead, prospect }),
    schemaName: 'marketing_reply_draft',
    schema: buildReplyDraftSchema(),
    executionType: 'marketing_inbound_reply_draft',
    executionId: message?.id
  });
  return {
    subject: String(parsed.subject || '').trim() || buildReplySubject(message?.subject),
    body: String(parsed.body || '').trim(),
    model
  };
};
