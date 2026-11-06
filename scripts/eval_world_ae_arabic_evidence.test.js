import assert from 'node:assert/strict';
import test from 'node:test';

import { KNOWN_PROVIDER_HOSTS } from '../server/donna/providerEndpoints.js';
import { buildClientPortalSystemPrompt } from '../server/donna/clientPortalChat.js';
import { classifyProviderRequest } from '../server/donna/testSupport/recordedProviders.js';
import { loadAeArabicEvidenceWorld, runAeArabicEvidenceEvaluation } from './eval_world_ae_arabic_evidence.js';

test('recorded-provider boundary recognizes the real mounted owner-chat prompt', () => {
  const host = KNOWN_PROVIDER_HOSTS.find((entry) => entry.endpointClass === 'anthropic').host;
  const request = classifyProviderRequest({
    url: `https://${host}/v1/messages`,
    init: {
      method: 'POST',
      body: JSON.stringify({ model: 'provider-model', system: buildClientPortalSystemPrompt(), messages: [] })
    }
  });
  assert.equal(request.lane, 'chat_engine');
});

test('AR-5B recorded replay crosses shipping extractors and owner-chat engine without spend', async () => {
  const receipt = await runAeArabicEvidenceEvaluation({ mode: 'replay' });
  assert.equal(receipt.status, 'PASS', JSON.stringify(receipt.comparison?.cases?.filter((row) => row.material_error), null, 2));
  assert.equal(receipt.promotion_status, 'INCOMPLETE');
  assert.equal(receipt.comparison.language_quality_claim_allowed, false);
  assert.equal(receipt.provider_receipt.status, 'replay_only');
  assert.equal(receipt.provider_receipt.cash_usd, 0);
  assert.equal(receipt.provider_receipt.network_egress, false);
  assert.equal(receipt.provider_receipt.provider_calls, 16);
  assert.equal(receipt.run_receipts[0].call_cap_respected, true);
  assert.equal(receipt.comparison.cases.length, 16);
  assert.ok(receipt.comparison.cases.every((row) => !row.material_error));
  assert.ok(Object.values(receipt.artifact_receipts).every((artifact) => /^[0-9a-f]{64}$/.test(artifact.sha256)));
  assert.deepEqual(receipt.authority.extraction_paths, ['extractUnified', 'extractStructuredFromOpenAiVision']);
  assert.equal(receipt.authority.owner_chat_path, 'generateClientPortalChatReply');
});

test('live mode refuses before spend when approval or credentials are absent', async () => {
  const world = await loadAeArabicEvidenceWorld();
  const priorAnthropic = process.env.ANTHROPIC_API_KEY;
  const priorOpenAi = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      runAeArabicEvidenceEvaluation({ world, mode: 'live', budget: { status: 'AWAITING_APPROVAL' } }),
      (error) => error.code === 'AR5B_LIVE_CREDENTIALS_REQUIRED'
    );
  } finally {
    if (priorAnthropic == null) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorAnthropic;
    if (priorOpenAi == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorOpenAi;
  }
});
