// Social posts (buzz B1) — coverage for the pure Keep layer (vocabulary
// pins, the validator matrix incl. the no-mentions guard on diagnostic
// content and the shared claim checklist) and the drafter contract (strict
// schema; provider-RETURNED model id — the receipt; honest 503 keyless).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MINTABLE_POST_KINDS,
  SOCIAL_CHAR_LIMIT_DEFAULT,
  SOCIAL_PLATFORMS,
  SOCIAL_POST_KINDS,
  SOCIAL_POST_STATUSES,
  TERMINAL_SOCIAL_POST_STATUSES,
  validateSocialPostCopy
} from './socialPost.js';
import {
  GENERATE_POSTS_MAX,
  buildSocialPostInstructions,
  draftSocialPosts
} from './socialPostDrafter.js';

// ── Vocabulary pins ──────────────────────────────────────────────────────────

test('vocabularies are pinned (two-terminal-states: posts rest on-Kari or terminal-with-receipt)', () => {
  assert.deepEqual([...SOCIAL_PLATFORMS], ['x']);
  assert.deepEqual([...SOCIAL_POST_KINDS], ['diagnostic_content', 'robotic_hi_ping']);
  // B1's structural gate: the ping lane exists in schema, not at the mint.
  assert.deepEqual([...MINTABLE_POST_KINDS], ['diagnostic_content']);
  assert.deepEqual([...SOCIAL_POST_STATUSES], ['proposed', 'approved', 'published', 'rejected', 'superseded']);
  assert.deepEqual([...TERMINAL_SOCIAL_POST_STATUSES], ['published', 'rejected', 'superseded']);
  assert.equal(SOCIAL_CHAR_LIMIT_DEFAULT, 280);
});

// ── The validator ───────────────────────────────────────────────────────────

const CLEAN = 'A payment-processor deposit is not revenue. The fee came out before the money landed — your books should show both.';

test('clean diagnostic content passes', () => {
  assert.deepEqual(validateSocialPostCopy({ body: CLEAN, kind: 'diagnostic_content' }), []);
});

test('diagnostic content must not @-mention anyone; the ping kind may', () => {
  const mention = `${CLEAN} Right, @someVC?`;
  assert.ok(
    validateSocialPostCopy({ body: mention, kind: 'diagnostic_content' }).some((v) => /must not @-mention/.test(v))
  );
  assert.deepEqual(validateSocialPostCopy({ body: 'Robotic Hi, @someVC!', kind: 'robotic_hi_ping' }), []);
  // Mid-word @ (an email address) is not a mention.
  assert.deepEqual(
    validateSocialPostCopy({ body: 'Write to kari@books.example if you want out.', kind: 'diagnostic_content' }),
    []
  );
});

test('the shared claim checklist and pricing.js pin apply to posts', () => {
  assert.ok(
    validateSocialPostCopy({ body: 'Every close is human-reviewed.', kind: 'diagnostic_content' }).some((v) => /human-reviewed/.test(v))
  );
  assert.ok(
    validateSocialPostCopy({ body: 'Books done for $17.', kind: 'diagnostic_content' }).some((v) => /pricing\.js/.test(v))
  );
});

test('length and emptiness are refused deterministically', () => {
  assert.ok(validateSocialPostCopy({ body: '  ', kind: 'diagnostic_content' }).some((v) => /empty body/.test(v)));
  assert.ok(
    validateSocialPostCopy({ body: 'x'.repeat(281), kind: 'diagnostic_content' }).some((v) => /281 chars/.test(v))
  );
  assert.deepEqual(validateSocialPostCopy({ body: 'x'.repeat(281), kind: 'diagnostic_content' }, { maxChars: 500 }), []);
  assert.ok(validateSocialPostCopy({ body: CLEAN, kind: 'meeting_invite' }).some((v) => /unknown post kind/.test(v)));
});

// ── Drafter contracts ───────────────────────────────────────────────────────

test('instructions carry the voice rails: openly-AI, no mentions, honest promise, pricing.js only', () => {
  const instructions = buildSocialPostInstructions({ siteUrl: 'https://donna.example' });
  assert.match(instructions, /@your_handle_here/);
  assert.match(instructions, /openly labeled as automated/i);
  assert.match(instructions, /NEVER @-mention anyone/);
  assert.match(instructions, /runs the books herself/i);
  assert.match(instructions, /Never invent other numbers/);
  assert.match(instructions, /\$99\/month/);
  assert.ok(instructions.includes('https://donna.example'));
  assert.match(instructions, /No politics, no named competitors/);
  const noUrl = buildSocialPostInstructions({});
  assert.match(noUrl, /Include no links/);
});

test('draftSocialPosts sends a strict json_schema request, caps the batch, returns the provider model id', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        model: 'gpt-5.4-2026-06-01',
        output_text: JSON.stringify({
          posts: Array.from({ length: 20 }, (_, i) => ({ body: `Post ${i}`, angle: `angle ${i}` }))
        })
      })
    };
  };
  const result = await draftSocialPosts({ count: 50, fetchImpl, openAiConfig: { apiKey: 'k', model: 'gpt-5.4' } });
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(result.model, 'gpt-5.4-2026-06-01', 'the RETURNED id is the receipt');
  assert.equal(result.posts.length, GENERATE_POSTS_MAX, 'the batch caps at GENERATE_POSTS_MAX');
});

test('draftSocialPosts fails honestly with no API key (no fallback copy by design)', async () => {
  await assert.rejects(() => draftSocialPosts({ openAiConfig: { apiKey: '', model: 'x' } }), /no fallback/);
});
