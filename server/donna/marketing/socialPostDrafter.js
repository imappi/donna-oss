// Social-post drafter — B1's load-bearing generation call. Trust-the-strong-
// LLM, applied to the public voice: give the strong model the charter's voice
// guardrails and the diagnose-to-sell content angles, render what it says,
// let Kari's per-post approve/reject be the cheap correction surface. The
// deterministic validator (socialPost.validateSocialPostCopy) runs at the
// mint — prompts ask for the rules, the Keep layer enforces them.
//
// Follows the marketing drafters' convention (nurtureDrafter/replyDrafter):
// openAiConfig, strict structured outputs, provider-RETURNED model id in the
// result (the receipt), honest 503 when the provider is unavailable.

import { BANDS, RECURRING_MONTHLY_PRICE, fmt } from '../../../src/lib/pricing.js';
import { llmCall } from '../llmCall.js';
import { marketingFailureMessage, marketingKeyMissingMessage, marketingStructuredRequest, resolveMarketingProvider } from './openAiConfig.js';
import { SOCIAL_CHAR_LIMIT_DEFAULT } from './socialPost.js';

export const GENERATE_POSTS_DEFAULT = 5;
export const GENERATE_POSTS_MAX = 10;

export const buildSocialPostInstructions = ({ maxChars = SOCIAL_CHAR_LIMIT_DEFAULT, siteUrl = null, topicHint = null } = {}) => [
  `You write public posts for @your_handle_here on X — Donna, an AI bookkeeper for small single-entity service businesses (US, UK, Singapore, Australia), run by a hands-on founder (Kari, Donna). The account is openly labeled as automated: Donna being an AI writing her own posts is the bit, and it is honest. A human approves and manually publishes every post — write each one well enough to publish unchanged.`,
  '',
  'Voice: dry, warm, precise, a little funny. First person singular. Zero marketing gloss, zero engagement-bait. Donna has opinions about bookkeeping and about being an AI — nothing else.',
  '',
  'Substance: the default post is a specific, TRUE, useful bookkeeping/tax observation a small-business owner can act on (the diagnose-to-sell angle: find the disorder, explain the real cost, show the fix). Examples of the register: "a payment-processor deposit is not revenue — here is what an unreconciled payout costs at tax time"; what a "clean-looking" P&L hides; why cash-basis owners get surprised in April. Aggregate, general patterns ONLY.',
  topicHint ? `\nToday's steer from the founder (optional angle, not a straitjacket): ${topicHint}` : '',
  '',
  'Hard rules (a deterministic validator refuses posts that break these):',
  `- Max ${maxChars} characters per post. Plain text, no hashtag piles (one is fine when it earns its place), no emojis-as-filler.`,
  '- NEVER @-mention anyone. No cold pings, no reply-guy behavior — mentions are a separate, human-gated lane.',
  '- NEVER a customer fact, a client story, or anything from real books — aggregate patterns only. No invented statistics; if you cite a number, it must be a general truth, not a fabricated stat.',
  `- The honest promise (2026-07-23): Donna runs the books herself — no human back office, no bookkeeper reviewing or finishing the work. Never say "human-reviewed"/"human-monitored"/"review", never guarantee outcomes, never say she replaces an accountant, never set-and-forget.`,
  `- Prices, only if genuinely relevant: one-off closes from ${fmt(Math.min(...BANDS.map((b) => b.price)))} per month-close, subscription flat ${fmt(RECURRING_MONTHLY_PRICE)}/month. Never invent other numbers.`,
  siteUrl
    ? `- A link to ${siteUrl} is allowed in at most ONE post of the batch, and only where it genuinely helps.`
    : '- Include no links (no site URL is configured for this deployment).',
  '- No politics, no named competitors, no commentary on individuals, no piggy-backing on tragedies or drama.',
  '',
  'Produce a varied batch: different angles, different lengths, at most one post about being an AI (the bit wears out fast). Each post stands alone.'
].join('\n');

const buildSocialBatchSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['posts'],
  properties: {
    posts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['body', 'angle'],
        properties: {
          body: { type: 'string', description: 'The post text, ready to publish unchanged.' },
          angle: { type: 'string', description: 'One line: the idea/evidence this post rides (renders next to the proposal so the founder sees WHY).' }
        }
      }
    }
  }
});

const drafterUnavailable = (message) => {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = 'SOCIAL_DRAFTER_UNAVAILABLE';
  return error;
};

// Draft a batch of diagnostic-content post proposals. Returns
// { posts: [{ body, angle }], model } — model is the provider-RETURNED id.
export const draftSocialPosts = async ({
  count = GENERATE_POSTS_DEFAULT,
  maxChars = SOCIAL_CHAR_LIMIT_DEFAULT,
  siteUrl = null,
  topicHint = null,
  fetchImpl = fetch,
  openAiConfig = null
} = {}) => {
  const resolved = resolveMarketingProvider({ openAiConfig });
  if (!resolved.ok) {
    throw drafterUnavailable(marketingKeyMissingMessage(resolved, 'the social drafter has no fallback copy by design.'));
  }
  const wanted = Math.min(Math.max(1, Number(count) || GENERATE_POSTS_DEFAULT), GENERATE_POSTS_MAX);

  let call;
  try {
    call = await llmCall(marketingStructuredRequest({
      resolved,
      instructions: buildSocialPostInstructions({ maxChars, siteUrl, topicHint }),
      input: JSON.stringify({ posts_wanted: wanted }),
      schemaName: 'marketing_social_posts',
      schema: buildSocialBatchSchema(),
      store: false,
      executionType: 'marketing_social_batch',
      executionId: `posts:${wanted}`,
      fetchImpl
    }));
  } catch (error) {
    const message = marketingFailureMessage(resolved.provider, error);
    if (!message) throw error;
    throw drafterUnavailable(message);
  }
  const parsed = call.result.parsed;
  const payload = { model: call.result.model };
  const config = { model: resolved.model };

  return {
    posts: (parsed.posts || []).slice(0, wanted).map((p) => ({
      body: String(p.body || '').trim(),
      angle: String(p.angle || '').trim()
    })),
    model: payload.model || config.model
  };
};
