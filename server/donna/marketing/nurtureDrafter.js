// Nurture drafter — the load-bearing generation call for waitlist nurture
// emails (slice 1 of docs/design-donna-sales-marketing.md).
//
// Trust-the-strong-LLM, applied to marketing: give the strong model the lead's
// context, the firm's real positioning, and a schema; render what it says;
// Kari's per-draft approve/reject is the cheap correction surface. No template
// engine, no hand-written fallback copy — if the provider is unavailable we
// fail honestly and Kari retries.
//
// The deterministic claim checklist (marketingOutbound.validateDraftCopy) runs
// AFTER generation, at the mint: prompts ask for the rules, the validator
// enforces them. A draft that violates the checklist is refused, never minted.

import { BANDS, RECURRING_MONTHLY_PRICE, fmt } from '../../../src/lib/pricing.js';
import { UNSUBSCRIBE_PLACEHOLDER } from './marketingOutbound.js';
// Strong-model default + OPENAI_MODEL override + .env fallback — shared with
// the dossier drafter (openAiConfig.js) so the convention lives in one place.
import { getOpenAiConfig, outputTextFromResponse } from './openAiConfig.js';

// Segment-specific guidance: the waitlist stores WHY the gate said no, so the
// nurture is honest about fit — kinder gate, never looser. The gates are an
// escalation-rate control; nothing here invites a disqualified segment in.
const SEGMENT_GUIDANCE = Object.freeze({
  inventory: [
    'They said they sell physical products, and at the time the gate said not-yet. THE GATE HAS SINCE CHANGED (2026-07-05): Donna now takes on commerce businesses with a clearly scoped promise.',
    'Be straight about the update: Donna reconciles payouts, fees, refunds, and bank evidence and closes the month; full inventory/COGS accounting (stock valuation, landed cost) is NOT part of the promise — anything beyond scope is flagged for a human.',
    'Invite them to sign up under that scoped framing if it fits, or to reply if their situation is mostly services. Do NOT promise unscoped inventory accounting or future inventory support.'
  ],
  restaurant: [
    'They run a restaurant, café, or retail — POS floats, tips, and cash handling are outside what Donna does well today.',
    'Be warm and brief: they are on the list, we will write when that changes. No timeline promises.',
    'Do NOT suggest workarounds to make a restaurant fit.'
  ],
  volume: [
    'Their business runs more than 1,000 transactions a month — above what Donna takes on today.',
    'Acknowledge that this usually means a real finance workload and their time is expensive.',
    'They stay on the list for when higher volumes open. No timeline promises, no exceptions offered.'
  ],
  other: [
    'They picked "something else" at the gate, so we know least about them.',
    'Invite a one-line reply describing the business — a human reads every reply — so we can say honestly whether Donna fits.'
  ]
});

export const buildNurtureInstructions = () => [
  'You write short nurture emails for Donna, a done-for-you AI bookkeeping service for small service businesses (US, UK, Singapore, Australia), run by a hands-on founder.',
  'The reader joined the waitlist after our signup gate told them Donna is not a fit for them YET. This email is a considerate follow-up, not a pitch to get around the gate.',
  '',
  'Voice: founder-personal, plain, brief (under 150 words of body), zero marketing gloss. One idea per email. It should read like a real person wrote it, because a real person approves every send.',
  '',
  'Hard rules (a validator refuses drafts that break these):',
  `- Never say "human-reviewed", "human-monitored", or "review". The honest promise (re-amended 2026-07-23): Donna runs the books herself — no human back office, no bookkeeper reviewing or finishing the work. She acts within the owner's rules, shows what she did, answers questions from a curated base of high-trust accounting and tax sources, and asks only when a fact about their business is something only they can know.`,
  '- Never guarantee outcomes; never say Donna replaces an accountant; never say set-and-forget.',
  `- Prices, only if relevant: one-off closes from ${fmt(Math.min(...BANDS.map((b) => b.price)))} per close by volume, ongoing subscription flat ${fmt(RECURRING_MONTHLY_PRICE)}/month. Never invent other numbers.`,
  `- The body MUST end with a short unsubscribe line containing the literal placeholder ${UNSUBSCRIBE_PLACEHOLDER} (e.g. "No more emails? ${UNSUBSCRIBE_PLACEHOLDER}").`,
  '- Subject: specific and honest, no "Re:"/"Fwd:", no clickbait.',
  '- Plain text only. No HTML, no images, no links other than the unsubscribe placeholder.'
].join('\n');

const buildDraftSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string', description: 'Email subject line.' },
    body: {
      type: 'string',
      description: `Plain-text email body, ending with an unsubscribe line containing ${UNSUBSCRIBE_PLACEHOLDER}.`
    }
  }
});

export const buildNurtureInput = (lead = {}) => ({
  segment: lead.reason || lead.segment || 'other',
  lead: {
    email: lead.email,
    joined_waitlist_at: lead.created_at || null,
    disqualify_reason: lead.reason || 'other'
  },
  segment_guidance: SEGMENT_GUIDANCE[lead.reason] || SEGMENT_GUIDANCE.other
});

const drafterUnavailable = (message) => {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = 'NURTURE_DRAFTER_UNAVAILABLE';
  return error;
};

// Draft one nurture email for a lead. Returns { subject, body, model } where
// `model` is the provider-RETURNED id (CLAUDE.md "the model id is part of the
// receipt") — that is what gets stamped on the marketing_draft row.
export const draftNurtureEmail = async ({ lead, fetchImpl = fetch, openAiConfig = null } = {}) => {
  const config = openAiConfig || getOpenAiConfig();
  if (!config.apiKey) {
    throw drafterUnavailable('OpenAI API key is not configured; the nurture drafter has no fallback copy by design.');
  }

  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      instructions: buildNurtureInstructions(),
      input: JSON.stringify(buildNurtureInput(lead)),
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'marketing_nurture_draft',
          strict: true,
          schema: buildDraftSchema()
        }
      }
    })
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw drafterUnavailable(errorBody?.error?.message || `OpenAI draft request failed with ${response.status}.`);
  }

  const payload = await response.json();
  let parsed = null;
  try {
    parsed = JSON.parse(outputTextFromResponse(payload));
  } catch {
    throw drafterUnavailable('OpenAI returned an unreadable nurture draft.');
  }

  return {
    subject: String(parsed.subject || '').trim(),
    body: String(parsed.body || '').trim(),
    model: payload.model || config.model
  };
};
