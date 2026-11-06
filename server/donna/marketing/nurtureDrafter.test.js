// Nurture drafter — coverage for the prompt contract (the rails ride in the
// instructions) and the call shape (strict schema; the provider-RETURNED model
// id is what gets stamped on the draft — CLAUDE.md "the model id is part of
// the receipt").

import assert from 'node:assert/strict';
import test from 'node:test';

import { UNSUBSCRIBE_PLACEHOLDER } from './marketingOutbound.js';
import { buildNurtureInstructions, buildNurtureInput, draftNurtureEmail } from './nurtureDrafter.js';

test('instructions carry the rails: honest promise, no guarantees, unsubscribe, pricing.js numbers', () => {
  const instructions = buildNurtureInstructions();
  assert.match(instructions, /runs the books herself/i);
  // The retired 2026-07-13 promise must not reappear in the prompt.
  assert.doesNotMatch(instructions, /human monitors every close/i);
  assert.match(instructions, /Never guarantee/i);
  assert.ok(instructions.includes(UNSUBSCRIBE_PLACEHOLDER));
  assert.match(instructions, /\$99\/month/);
  assert.match(instructions, /\$50/);
  assert.match(instructions, /no "Re:"\/"Fwd:"/);
});

test('segment guidance keeps the gate kind, never looser', () => {
  // The inventory segment reflects the P0E gate revision (Kari, 2026-07-05):
  // commerce is invited back under the SCOPED promise — payout/bank
  // reconciliation, never unscoped inventory/COGS accounting.
  const inventory = buildNurtureInput({ email: 'a@b-co.example', reason: 'inventory' });
  assert.equal(inventory.segment, 'inventory');
  assert.ok(inventory.segment_guidance.some((line) => /GATE HAS SINCE CHANGED/.test(line)));
  assert.ok(inventory.segment_guidance.some((line) => /Do NOT promise unscoped inventory accounting/i.test(line)));
  const restaurant = buildNurtureInput({ email: 'a@b-co.example', reason: 'restaurant' });
  assert.ok(restaurant.segment_guidance.some((line) => /Do NOT suggest workarounds/i.test(line)));
  // Unknown reasons fall back to the 'other' guidance rather than throwing.
  const unknown = buildNurtureInput({ email: 'a@b-co.example', reason: 'mystery' });
  assert.ok(unknown.segment_guidance.length > 0);
});

test('draftNurtureEmail sends a strict json_schema request and returns the provider model id', async () => {
  let captured = null;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        model: 'gpt-5.4-2026-06-01',
        output_text: JSON.stringify({ subject: 'A note', body: `Hello. ${UNSUBSCRIBE_PLACEHOLDER}` })
      })
    };
  };
  const result = await draftNurtureEmail({
    lead: { email: 'lead@example.com', reason: 'volume' },
    fetchImpl,
    openAiConfig: { apiKey: 'k', model: 'gpt-5.4' }
  });
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.body.model, 'gpt-5.4');
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.text.format.strict, true);
  assert.deepEqual(Object.keys(captured.body.text.format.schema.properties), ['subject', 'body']);
  // The RETURNED id (dated snapshot) is the receipt, not the requested alias.
  assert.equal(result.model, 'gpt-5.4-2026-06-01');
  assert.equal(result.subject, 'A note');
});

test('draftNurtureEmail fails honestly with no API key (no fallback copy by design)', async () => {
  await assert.rejects(
    () => draftNurtureEmail({ lead: { email: 'a@b-co.example' }, openAiConfig: { apiKey: '', model: 'x' } }),
    /no fallback/
  );
});
