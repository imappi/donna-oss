import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTelegramAskDigestText,
  TELEGRAM_ASK_DIGEST_TEMPLATE,
  TELEGRAM_ASK_DIGEST_MAX_ITEMS,
  renderTelegramTemplate
} from './telegram.js';

const item = (n, over = {}) => ({
  question: `What was this charge ${n} for, and was it a business expense?`,
  askRef: `LC0000${n}`,
  period: 'July 2026',
  ...over
});

test('a batch renders as ONE numbered message, not one message per ask', () => {
  const text = buildTelegramAskDigestText({ items: [item(1), item(2), item(3)] });
  assert.match(text, /^Donna needs 3 things for July 2026:/);
  assert.match(text, /\n1\. What was this charge 1 for/);
  assert.match(text, /\n2\. What was this charge 2 for/);
  assert.match(text, /\n3\. What was this charge 3 for/);
});

test('every item keeps its own Ref so an owner can answer exactly one', () => {
  const text = buildTelegramAskDigestText({ items: [item(1), item(2)] });
  assert.match(text, /Ref: LC00001/);
  assert.match(text, /Ref: LC00002/);
  assert.match(text, /mention its Ref/);
});

test('the assistant name is the client-configured one, not a hardcoded Donna', () => {
  const text = buildTelegramAskDigestText({ assistantName: 'Aino', items: [item(1), item(2)] });
  assert.match(text, /^Aino needs 2 things/);
});

test('a shared period is stated once in the header, never repeated per line', () => {
  const text = buildTelegramAskDigestText({ items: [item(1), item(2)] });
  assert.match(text, /for July 2026:/);
  assert.equal(text.match(/July 2026/g).length, 1, 'the period appears exactly once');
});

test('mixed periods drop the header period and annotate each line instead', () => {
  const text = buildTelegramAskDigestText({
    items: [item(1), item(2, { period: 'June 2026' })]
  });
  assert.match(text, /^Donna needs 2 things from you:/);
  assert.match(text, /1\. \[July 2026\] /);
  assert.match(text, /2\. \[June 2026\] /);
});

// The portal link is the whole point of the second half of the ask: some owners
// would rather clear a list on a laptop than answer questions in a chat.
test('the portal link is offered as the alternative surface when one is resolved', () => {
  const text = buildTelegramAskDigestText({
    items: [item(1), item(2)],
    portalUrl: 'https://app.example.com/portal/acme/asks'
  });
  assert.match(text, /answer them all in your portal/);
  assert.match(text, /https:\/\/app\.example\.com\/portal\/acme\/asks/);
});

test('no portal URL means no link line and no dead link', () => {
  const text = buildTelegramAskDigestText({ items: [item(1), item(2)] });
  assert.ok(!text.includes('http'), 'never a dead or invented link');
  assert.ok(!/portal/i.test(text.split('\n').slice(-1)[0]), 'no dangling portal sentence');
});

test('the item count is capped and the remainder is named, never silently dropped', () => {
  const many = Array.from({ length: TELEGRAM_ASK_DIGEST_MAX_ITEMS + 4 }, (_, i) => item(i + 1));
  const text = buildTelegramAskDigestText({ items: many });
  const numbered = text.match(/^\d+\. /gm) || [];
  assert.equal(numbered.length, TELEGRAM_ASK_DIGEST_MAX_ITEMS);
  assert.match(text, new RegExp(`needs ${many.length} things`), 'the header states the TRUE total');
  assert.match(text, /4 more questions are waiting in your portal/);
});

test('a single leftover is pluralised correctly', () => {
  const many = Array.from({ length: TELEGRAM_ASK_DIGEST_MAX_ITEMS + 1 }, (_, i) => item(i + 1));
  const text = buildTelegramAskDigestText({ items: many });
  assert.match(text, /1 more question is waiting/);
});

test('the digest stays inside Telegram message limits', () => {
  const many = Array.from({ length: 40 }, (_, i) => item(i + 1, {
    question: 'x'.repeat(120)
  }));
  const text = buildTelegramAskDigestText({ items: many });
  assert.ok(text.length < 4096, `digest was ${text.length} chars`);
});

test('a pathologically long single question yields an empty digest so the caller can fall back', () => {
  const text = buildTelegramAskDigestText({
    items: [item(1, { question: 'y'.repeat(9000) }), item(2, { question: 'z'.repeat(9000) })],
    maxChars: 100
  });
  assert.equal(text, '');
});

test('empty or blank input yields an empty digest rather than a header with nothing under it', () => {
  assert.equal(buildTelegramAskDigestText({ items: [] }), '');
  assert.equal(buildTelegramAskDigestText({ items: [{ question: '   ' }] }), '');
  assert.equal(buildTelegramAskDigestText({}), '');
});

// Voice rule (clientPortalChat.js system prompt, held for static copy too per
// Kari 2026-07-21): never an em or en dash; comma, colon, or a new sentence.
test('the digest copy carries no em or en dash', () => {
  const text = buildTelegramAskDigestText({
    items: [item(1), item(2, { period: 'June 2026' })],
    portalUrl: 'https://app.example.com/p/x'
  });
  assert.ok(!text.includes('—'), 'no em dash');
  assert.ok(!text.includes('–'), 'no en dash');
});

test('the digest template renders through the channel renderer as free-form text', () => {
  const text = buildTelegramAskDigestText({ items: [item(1), item(2)] });
  const rendered = renderTelegramTemplate({
    templateName: TELEGRAM_ASK_DIGEST_TEMPLATE,
    bodyParameters: [text]
  });
  assert.equal(rendered, text, 'the composed digest rides the channel verbatim');
});

test('the single-ask template is untouched by the digest work', () => {
  const rendered = renderTelegramTemplate({
    templateName: 'donna_evidence_ask_v1',
    bodyParameters: ['June 2026', 'What was the Delta charge for?', 'LC1234']
  });
  assert.match(rendered, /^Donna needs one thing for June 2026: What was the Delta charge for\?/);
  assert.match(rendered, /Ref: LC1234$/);
});
