// Dossier drafter — unit coverage: instructions carry the rails, the schema
// matches what prospectLab.validateDossier expects, tier gates the message,
// the provider-returned model id is the receipt, and message rail violations
// are refused by the validator (writer-level, via validateDossier).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDossierInput,
  buildDossierInstructions,
  draftProspectDossier
} from './dossierDrafter.js';
import { UNSUBSCRIBE_PLACEHOLDER } from './marketingOutbound.js';
import { validateDossier } from './prospectLab.js';

const PROSPECT = {
  id: 'p1',
  company_name: 'Acme Design Ltd',
  company_number: '12345678',
  jurisdiction: 'UK',
  website: 'https://acme.example',
  source: 'manual_upload',
  source_note: 'hiring a part-time bookkeeper on Indeed',
  campaigns: ['micro_agencies'],
  tier: 'green',
  contact_email: null
};

const VALID_DOSSIER = {
  identity: { company_name: 'Acme Design Ltd', company_number: '12345678', company_type: 'ltd', website: 'https://acme.example', industry: 'design agency' },
  disorder_signal: {
    summary: 'Job post for a part-time bookkeeper, live this week',
    citation: 'https://indeed.example/job/123 (observed 2026-07-06)',
    observed_at: '2026-07-06'
  },
  fit: { service_business: 'yes', volume_under_1000: 'unknown', single_entity: 'yes', country_in_icp: 'yes' },
  fit_evidence: 'Website shows a 6-person design agency; volume unknown (headcount is a weak proxy).',
  jurisdiction_check: { basis: 'UK PECR corporate subscriber: verified ltd at Companies House.', notes: '' },
  contact: { email: 'hello@acme.example', published_where: 'https://acme.example/contact', role_relevance: 'General studio inbox published for business enquiries.' },
  why_now: 'They are paying to solve bookkeeping right now — the job post is the budget.',
  main_risk: 'The hire may already be half-decided.',
  negative_evidence: ['Cannot verify transaction volume from public sources.'],
  rubric: { pain_evidence: 3, fit_confidence: 2, contact_legitimacy: 3, delivery_complexity: 2, payment_compliance_risk: 1, message_quality: 2, expected_value: 2 },
  confidence: 'medium',
  recommended_action: 'approve',
  message: {
    subject: 'Your bookkeeper job post — a different option',
    body: `Saw your post for a part-time bookkeeper.\n\nDonna runs the books herself and shows you what she did.\n\nNo more emails? ${UNSUBSCRIBE_PLACEHOLDER}`
  }
};

const okResponse = (payload) => ({
  ok: true,
  json: async () => payload
});

test('instructions carry the lab rails; message rules only for message-capable tiers', () => {
  const green = buildDossierInstructions({ includeMessage: true });
  assert.match(green, /NO SIGNAL, NO DOSSIER/);
  assert.match(green, /NEVER GUESS A GATE/);
  assert.match(green, /ARGUE AGAINST YOURSELF/);
  assert.match(green, /PECR/);
  assert.match(green, new RegExp(UNSUBSCRIBE_PLACEHOLDER.replace(/[{}]/g, '\\$&')));
  assert.match(green, /\$99/);
  assert.match(green, /NEVER say "human-reviewed"/);
  assert.doesNotMatch(green, /human monitors every close/i);

  const red = buildDossierInstructions({ includeMessage: false });
  assert.match(red, /Do NOT draft an outreach message/);
  assert.doesNotMatch(red, /unsubscribe_url/);
});

test('the drafted schema output validates clean against the lab validator', () => {
  assert.deepEqual(validateDossier(VALID_DOSSIER), []);
});

test('a rail-violating message is refused by the validator', () => {
  const badPromise = validateDossier({
    ...VALID_DOSSIER,
    message: { subject: 'Human-reviewed books', body: `x ${UNSUBSCRIBE_PLACEHOLDER}` }
  });
  assert.ok(badPromise.some((v) => /message: .*human-reviewed/i.test(v)));

  const noUnsub = validateDossier({
    ...VALID_DOSSIER,
    message: { subject: 'Hello', body: 'no opt-out line' }
  });
  assert.ok(noUnsub.some((v) => /message: missing .*unsubscribe/i.test(v)));

  const inventedPrice = validateDossier({
    ...VALID_DOSSIER,
    message: { subject: 'Hello', body: `Only $37! ${UNSUBSCRIBE_PLACEHOLDER}` }
  });
  assert.ok(inventedPrice.some((v) => /message: price \$37/.test(v)));

  // Absent message stays valid — red-tier dossiers carry none.
  assert.deepEqual(validateDossier({ ...VALID_DOSSIER, message: null }), []);
});

test('draftProspectDossier returns the provider-returned model id and requests web_search', async () => {
  let requestBody = null;
  const result = await draftProspectDossier({
    prospect: PROSPECT,
    openAiConfig: { apiKey: 'test-key', model: 'gpt-5.4' },
    fetchImpl: async (url, options) => {
      requestBody = JSON.parse(options.body);
      return okResponse({ model: 'gpt-5.4-2026-05-01', output_text: JSON.stringify(VALID_DOSSIER) });
    }
  });
  assert.equal(result.model, 'gpt-5.4-2026-05-01');
  assert.equal(result.dossier.why_now, VALID_DOSSIER.why_now);
  assert.deepEqual(requestBody.tools, [{ type: 'web_search' }]);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.strict, true);
  assert.ok(requestBody.text.format.schema.required.includes('negative_evidence'));
  assert.ok(requestBody.text.format.schema.required.includes('message'));
});

test('red tier: schema omits message and any returned message is dropped', async () => {
  let requestBody = null;
  const result = await draftProspectDossier({
    prospect: { ...PROSPECT, tier: 'red' },
    openAiConfig: { apiKey: 'test-key', model: 'gpt-5.4' },
    fetchImpl: async (url, options) => {
      requestBody = JSON.parse(options.body);
      return okResponse({
        model: 'gpt-5.4-2026-05-01',
        output_text: JSON.stringify({ ...VALID_DOSSIER, message: VALID_DOSSIER.message })
      });
    }
  });
  assert.ok(!requestBody.text.format.schema.required.includes('message'));
  assert.equal(result.dossier.message, null);
});

test('the input packet separates signal hypothesis from campaigns (campaign ≠ source)', () => {
  const input = buildDossierInput(PROSPECT);
  assert.equal(input.signal_hypothesis, 'hiring a part-time bookkeeper on Indeed');
  assert.deepEqual(input.campaigns, ['micro_agencies']);
  assert.equal(input.source, 'manual_upload');
  assert.equal(input.tier_capabilities.can_generate_message, true);
});

test('missing API key fails honestly with 503 (no fallback dossier by design)', async () => {
  await assert.rejects(
    draftProspectDossier({ prospect: PROSPECT, openAiConfig: { apiKey: '', model: 'gpt-5.4' } }),
    (error) => error.statusCode === 503 && error.code === 'DOSSIER_DRAFTER_UNAVAILABLE'
  );
});

test('provider errors surface, never a silently un-researched dossier', async () => {
  await assert.rejects(
    draftProspectDossier({
      prospect: PROSPECT,
      openAiConfig: { apiKey: 'k', model: 'gpt-5.4' },
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'web_search not supported' } }) })
    }),
    /web_search not supported/
  );
});
