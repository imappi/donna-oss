// The ask drafter is told which language the business owner reads, from the
// ONE resolver (ownerLanguage.js, re-exported by db/channels.js). Pins the
// real request path: draftClientAskMessage → the provider request body, with a
// captured fetch (no live model call). Synthetic fixtures only.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAskDraftInput, buildAskMessageSchema, draftClientAskMessage } from './askPipeline.js';
import { preferredOwnerTemplateLanguage as channelsResolver } from './db/channels.js';
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';

const CODING_ITEM = {
  id: 'txn-synthetic-1',
  date: '2026-03-20',
  description: 'KORTTIOSTO ESIMERKKIKAUPPA',
  money_out: 19.9,
  ai_suggestion: { ask_client_question: 'What was this purchase for?' }
};

const captureDraftRequest = async (clientProfile) => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const draft = {
      subject: 'S', message_markdown: 'M', summary: 'internal',
      items: [{ transaction_ref: 'transaction_1', disposition: 'ask', question: 'Q?', evidence_type: 'business_purpose', skip_reason: '', fyi_note: '', local_document_refs: [] }],
      statement_requests: [], document_asks: []
    };
    const payload = { id: 'resp_synthetic', model: 'synthetic-model', output_text: JSON.stringify(draft) };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await draftClientAskMessage({
    clientProfile,
    codingItems: [CODING_ITEM],
    fetchImpl,
    openAiConfig: { apiKey: 'sk-test-dummy', model: 'synthetic-model' }
  });
  assert.equal(bodies.length, 1, 'exactly one provider call');
  return { body: bodies[0], input: JSON.parse(bodies[0].input), result };
};

test('db/channels.js re-exports the same resolver the drafter uses', () => {
  assert.equal(channelsResolver, preferredOwnerTemplateLanguage);
});

test('a Finnish client: the drafting request carries language fi and the language instruction', async () => {
  const { body, input, result } = await captureDraftRequest({ companyName: 'Esimerkki Oy', jurisdiction: 'FI' });
  assert.equal(input.client.language, 'fi');
  assert.match(body.instructions, /client\.language/);
  assert.match(body.instructions, /every question/);
  assert.match(body.instructions, /Keep amounts, currencies, dates, counterparty and company names, filenames, account numbers, IBANs, and document identifiers exactly as they appear/);
  assert.equal(result.language, 'fi', 'the drafting receipt names the language');
  assert.deepEqual(body.text.format.schema, buildAskMessageSchema(), 'the output contract is unchanged');
});

test('a non-Finnish client: the same prompt with language en, otherwise the same request', async () => {
  const fi = await captureDraftRequest({ companyName: 'Example Ltd', jurisdiction: 'FI' });
  const en = await captureDraftRequest({ companyName: 'Example Ltd', jurisdiction: 'GB' });
  assert.equal(en.input.client.language, 'en');
  assert.equal(en.result.language, 'en');
  assert.equal(en.body.instructions, fi.body.instructions, 'one prompt; the language is a parameter, not a second copy');
  const { language: _l1, jurisdiction: _j1, ...enClient } = en.input.client;
  const { language: _l2, jurisdiction: _j2, ...fiClient } = fi.input.client;
  assert.deepEqual(enClient, fiClient);
  assert.deepEqual(en.input.coding_items, fi.input.coding_items);
  assert.deepEqual(en.body.text, fi.body.text);
});

test('an explicit profile language beats the jurisdiction default in the drafting input', () => {
  const input = buildAskDraftInput({ clientProfile: { companyName: 'Esimerkki Oy', jurisdiction: 'FI', locale: 'en-GB' } });
  assert.equal(input.client.language, 'en');
  assert.equal(input.client.jurisdiction, 'FI');
  assert.equal(buildAskDraftInput({ clientProfile: { jurisdiction: 'GB', language: 'fi' } }).client.language, 'fi');
});

// The drafter is told the client's country by the same rule the resolver uses
// (one helper, ownerLanguage.js ownerClientCountry): the jurisdiction column is
// authoritative, the profile value is read only when the column is empty, and
// no country when the two disagree. Before, the profile won (`profile || column`).
test('the drafting input names the client country by the resolver\'s rule, never the profile over the column', () => {
  const country = (profileJurisdiction, column) => buildAskDraftInput({
    clientProfile: { companyName: 'Esimerkki Oy', jurisdiction: profileJurisdiction, persisted_identity: { jurisdiction: column } }
  }).client;
  // Disagreement: the column and the profile name different countries.
  assert.equal(country('GB', 'FI').jurisdiction, '');
  assert.equal(country('GB', 'FI').language, preferredOwnerTemplateLanguage({ jurisdiction: 'GB' }, { jurisdiction: 'FI' }));
  // Column only, profile only, both agreeing: the stored value as before.
  assert.equal(country('', 'FI').jurisdiction, 'FI');
  assert.equal(country('FI', null).jurisdiction, 'FI');
  assert.equal(country('FI', 'FI').jurisdiction, 'FI');
  assert.equal(country('uk', 'GB').jurisdiction, 'GB', 'uk and GB are one country; the column is the value shown');
  // No persisted identity at all (a caller with the profile only): unchanged.
  assert.equal(buildAskDraftInput({ clientProfile: { jurisdiction: 'FI' } }).client.jurisdiction, 'FI');
});
