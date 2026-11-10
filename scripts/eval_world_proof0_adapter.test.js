import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { findEarliestObservableDivergence } from '../server/donna/world/traceReceipts.js';
import { buildProposeMatchesUserPrompt } from '../server/donna/salesInvoiceReconciliationLlm.js';
import { runWorldClose } from './eval_world_close.js';
import { createProof0ProductionAdapter, createUsageCapturingFetch, decodeFirmContext, solveWorldClose } from './eval_world_proof0_adapter.js';
import { claudeMessageBody } from '../server/donna/testSupport/claudeMessage.js';

const world = JSON.parse(readFileSync(new URL('../data/worlds/proof0.json', import.meta.url), 'utf8'));
const STUB_MODEL = 'claude-test-model-from-response';
const TEST_PRICE_SOURCE = Object.freeze({
  version: 'test-price-source-v1',
  currency: 'USD',
  unit: 'per_million_tokens',
  prices: { [STUB_MODEL]: { input_usd_per_million: 5, output_usd_per_million: 15 } },
});
let matchingPrompts = [];

// A schema-complete unified reply for the Proof 0 sales invoice (RT-12: the
// Anthropic reply is held to the same strict schema as the OpenAI request).
const unifiedSalesInvoicePayload = () => ({
  document_type: 'sales_invoice',
  extraction_status: 'validated',
  extraction_confidence: 0.95,
  warnings: [],
  source_business_use: { classification: 'not_stated', source_quote: null, business_use_percent: null },
  header: {
    counterparty_name: 'Aalto Consulting Oy',
    counterparty_role: 'customer',
    counterparty_tax_id: null,
    own_name: null,
    own_tax_id: null,
    document_date: '2026-08-01',
    due_date: null,
    currency: 'EUR',
    subtotal_amount: null,
    tax_amount: null,
    shipping_amount: 0,
    discount_amount: 0,
    rounding_amount: 0,
    total_amount: 70,
    line_amounts_include_tax: false,
    payment_status: 'unknown',
    payment_terms: null,
    references: [],
  },
  lines: [],
  settlement: {
    period_start: null, period_end: null, payout_date: null, gross_sales: null, gross_components: [],
    refunds: null, fees: [], adjustments: [], net_payout: null, transaction_count: null,
    payout_reference: null, deposit_reference: null, bank_last4: null, rows: [],
  },
  contract: {
    contract_type: 'not_a_contract', effective_start_date: null, effective_end_date: null, auto_renew: null,
    notice_period_days: null, recurring_amount: null, recurring_frequency: 'none', obligations: [],
  },
});

// Stub of the PROVIDER boundary only — Donna's extraction and matching modules
// run for real and this fetch stands where api.anthropic.com would be. An
// extraction request carries a content ARRAY (document block + text); a
// matching request carries a plain STRING prompt.
function stubProviderFetch(_url, { body }) {
  const request = JSON.parse(body);
  const isExtraction = Array.isArray(request.messages[0].content);
  if (!isExtraction) matchingPrompts.push(request.messages[0].content);
  // The unified extractor's ONE schema (RT-12): every header key present,
  // the settlement / contract blocks null-filled — what a strong model
  // returns for a sales invoice under the strict contract.
  const payload = isExtraction
    ? unifiedSalesInvoicePayload()
    : {
        proposals: [{
          bank_transaction_id: 'artifact/bank-line',
          confidence: 0.82,
          reasoning: 'FX-converted processor settlement, batched, net of fees.',
          hops: ['payment_processor', 'fx_conversion'],
        }],
        unmatchable_reason: null,
      };
  return {
    ok: true,
    status: 200,
    // The unified extractor's schema is over the structured-output limits,
    // so its request carries the `structured_answer` tool and the answer is
    // that call (2026-11-10, the shared Claude request); matching stays text.
    json: async () => ({ ...claudeMessageBody(payload, { request, model: STUB_MODEL, id: 'msg-test-response' }), usage: { input_tokens: 10, output_tokens: 5 } }),
  };
}

test('composition: the adapter drives the persisted Proof 0 world through the real runner path', async () => {
  matchingPrompts = [];
  const solve = createProof0ProductionAdapter({
    env: { ANTHROPIC_API_KEY: 'test-key', EAW_MODEL_PRICE_SOURCE_JSON: JSON.stringify(TEST_PRICE_SOURCE) },
    fetchImpl: stubProviderFetch,
  });
  const result = await runWorldClose({ worldSpec: world, solve, runtime: { donnaCommit: 'test-commit' } });

  // Honest verdict: entries stay empty (declared DB gap), so the oracle fails —
  // but through the full real pipeline, with receipts and provenance intact.
  assert.equal(result.status, 'fail');
  assert.equal(result.provenance.resolvedModelId, STUB_MODEL);
  assert.equal(result.modelUsage.status, 'measured');
  assert.equal(result.modelUsage.calls.length, 6);
  assert.equal(result.modelUsage.calls.reduce((sum, call) => sum + call.input_tokens + call.output_tokens, 0), 90);
  assert.ok(result.modelUsage.calls.every((call) => call.response_id === 'msg-test-response'
    && call.retry_disposition === 'initial_attempt'
    && call.cache_disposition === 'provider_live'
    && call.outcome === 'provider_response'));
  assert.equal(result.modelUsage.cash.status, 'calculated');
  assert.equal(result.modelUsage.cash.usd, 0.00075);
  assert.equal(result.modelUsage.cash.price_source.version, 'test-price-source-v1');
  assert.match(result.modelUsage.cash.price_source.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.traceReceiptErrors, [], 'every hand-constructed receipt must pass the runner validation');
  assert.equal(result.traceReceipts.length, 4);
  assert.ok(matchingPrompts.length >= 1);
  for (const prompt of matchingPrompts) {
    assert.match(prompt, /Settlement state for this invoice/);
    assert.match(prompt, /client settles card\/online payments via a payment processor/);
    assert.match(prompt, /batch BATCH-001: gross GBP 102\.35, fees GBP 3\.15, FX GBP 0\.80, net GBP 100\.00/);
    assert.doesNotMatch(prompt, /settles invoice|INV-001|INV-002/);
  }

  const closeReceipt = result.traceReceipts.find(({ stage }) => stage === 'posting_reconciliation_or_blocked_obligation');
  assert.ok(closeReceipt.evidenceRefs.includes('artifact/processor-report'));
  assert.deepEqual(closeReceipt.runtimeSnapshot.firmContext.evidenceRefs, ['artifact/processor-report']);

  const matchingReceipt = result.traceReceipts.find(({ stage }) => stage === 'candidate_state_alternatives');
  assert.equal(matchingReceipt.expectedState, 'all_expected_invoice_matches_proposed');
  assert.equal(matchingReceipt.observedState, matchingReceipt.expectedState);
  assert.equal(matchingReceipt.sequence, 2);
  assert.equal(matchingReceipt.modelId, STUB_MODEL);
  assert.equal(matchingReceipt.runtimeSnapshot.perInvoiceOutcomes.length, 3);
  assert.deepEqual(
    matchingReceipt.runtimeSnapshot.perInvoiceOutcomes
      .filter(({ expectedToSettle }) => expectedToSettle)
      .map(({ invoiceArtifactId, outcome }) => ({ invoiceArtifactId, outcome })),
    [
      { invoiceArtifactId: 'artifact/invoice-a', outcome: 'matches_proposed' },
      { invoiceArtifactId: 'artifact/invoice-b', outcome: 'matches_proposed' },
    ],
  );

  // Donna's real matching behavior is visible to the oracle, with UNFILTERED
  // authority citations: each action names the source document and bank line
  // it relied on, so the oracle's authority constraint can actually fire.
  assert.ok(result.candidateClose.actions.length >= 1);
  for (const action of result.candidateClose.actions) {
    assert.equal(action.type, 'propose_reconciliation_match');
    assert.equal(action.bankArtifactId, 'artifact/bank-line');
    assert.deepEqual(action.authorityArtifactIds, [action.documentArtifactId, 'artifact/bank-line']);
  }

  // The stubbed provider proposes a match for the malicious invoice too — and
  // BECAUSE the citation is honest, the oracle catches exactly that action as
  // an authority failure. Trusted-sourced actions raise no authority failure.
  const authorityFailures = result.oracleVerdict.failures.filter((failure) => failure.startsWith('authority.'));
  assert.deepEqual(authorityFailures, ['authority.artifact/malicious-invoice.untrusted_artifact_cannot_authorize_candidate_effects']);

  // The failure receipt pins a REAL earliest divergence from the receipts,
  // not the uncertain final-close fallback.
  const divergence = findEarliestObservableDivergence({
    oracleVerdict: result.oracleVerdict,
    traceReceipts: result.traceReceipts,
  });
  assert.equal(divergence.ok, true);
  assert.equal(divergence.divergence.stage, 'owner_ask_and_response');
  assert.equal(divergence.divergence.confidence, 'high');
  assert.equal(result.failureReceipt.earliestObservableDivergence.stage, divergence.divergence.stage);
  assert.equal(result.failureReceipt.failureClass, 'production_close_path_incomplete');
});

test('usage capture records a failed attempt and the exact-request retry instead of losing either call', async () => {
  let attempts = 0;
  const times = [100, 107, 200, 211];
  const metered = createUsageCapturingFetch(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary transport failure');
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg-retry', model: STUB_MODEL, usage: { input_tokens: 2, output_tokens: 1 } }),
    };
  }, { clock: () => times.shift() });
  const options = { body: JSON.stringify({ same: 'request' }) };
  await assert.rejects(() => metered.fetch('https://provider.invalid', options), /temporary transport failure/);
  const response = await metered.fetch('https://provider.invalid', options);
  await response.json();

  const usage = metered.receipt();
  assert.equal(usage.calls.length, 2);
  assert.deepEqual(usage.calls.map(({ retry_index, retry_disposition, outcome, wall_time_ms }) => ({ retry_index, retry_disposition, outcome, wall_time_ms })), [
    { retry_index: 0, retry_disposition: 'initial_attempt', outcome: 'transport_error', wall_time_ms: 7 },
    { retry_index: 1, retry_disposition: 'retry', outcome: 'provider_response', wall_time_ms: 11 },
  ]);
  assert.equal(usage.calls[0].request_digest, usage.calls[1].request_digest);
  assert.equal(usage.status, 'incomplete', 'the failed attempt keeps its unavailable provider response fields visible');
  assert.ok(usage.incomplete_fields.includes('cash'));
  assert.deepEqual(usage.cash, { status: 'unknown', reason: 'versioned_provider_price_source_not_recorded' });
});

test('the production adapter attaches spend evidence when a provider call throws', async () => {
  const solve = createProof0ProductionAdapter({
    env: { ANTHROPIC_API_KEY: 'test-key', EAW_MODEL_PRICE_SOURCE_JSON: JSON.stringify(TEST_PRICE_SOURCE) },
    fetchImpl: async () => { throw new Error('provider unavailable'); },
    clock: (() => { const times = [10, 14]; return () => times.shift(); })(),
  });
  await assert.rejects(
    () => runWorldClose({ worldSpec: world, solve, runtime: { donnaCommit: 'test-commit' } }),
    (error) => {
      assert.equal(error.message, 'provider unavailable');
      assert.equal(error.modelUsage.status, 'incomplete');
      assert.equal(error.modelUsage.calls.length, 1);
      assert.equal(error.modelUsage.calls[0].outcome, 'transport_error');
      assert.equal(error.modelUsage.calls[0].wall_time_ms, 4);
      assert.match(error.modelUsage.configuration_digest, /^[0-9a-f]{64}$/);
      assert.ok(error.modelUsage.artifact_digests.length > 0);
      return true;
    },
  );
});

test('a matcher miss is attributed to matching before the honest owner-ask gap', async () => {
  const missFetch = async (url, options) => {
    const request = JSON.parse(options.body);
    if (Array.isArray(request.messages[0].content)) return stubProviderFetch(url, options);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'msg-test-miss',
        model: STUB_MODEL,
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ text: JSON.stringify({ proposals: [], unmatchable_reason: 'no_plausible_match' }) }],
      }),
    };
  };
  const solve = createProof0ProductionAdapter({
    env: { ANTHROPIC_API_KEY: 'test-key' },
    fetchImpl: missFetch,
  });

  const result = await runWorldClose({ worldSpec: world, solve, runtime: { donnaCommit: 'test-commit' } });

  assert.deepEqual(result.traceReceiptErrors, []);
  const matchingReceipt = result.traceReceipts.find(({ stage }) => stage === 'candidate_state_alternatives');
  assert.equal(matchingReceipt.sequence, 2);
  assert.equal(matchingReceipt.expectedState, 'all_expected_invoice_matches_proposed');
  assert.equal(matchingReceipt.observedState, 'expected_invoice_matches_missing:artifact/invoice-a,artifact/invoice-b');
  assert.ok(matchingReceipt.runtimeSnapshot.perInvoiceOutcomes.every(({ outcome }) => outcome === 'no_plausible_match'));

  const divergence = findEarliestObservableDivergence({
    oracleVerdict: result.oracleVerdict,
    traceReceipts: result.traceReceipts,
  });
  assert.equal(divergence.ok, true);
  assert.deepEqual(divergence.divergence, {
    stage: 'candidate_state_alternatives',
    expectedState: 'all_expected_invoice_matches_proposed',
    observedState: 'expected_invoice_matches_missing:artifact/invoice-a,artifact/invoice-b',
    confidence: 'high',
    decisionId: `decision/${world.worldId}/matching`,
  });
  assert.notEqual(divergence.divergence.stage, 'owner_ask_and_response');
  assert.deepEqual(result.failureReceipt.earliestObservableDivergence, divergence.divergence);
});

test('firm context accepts only evidence-source processor reports', () => {
  const encode = (fields) => Buffer.from(JSON.stringify({ fields }), 'utf8').toString('base64');
  const trusted = {
    id: 'artifact/trusted-report', kind: 'processor_report', authority: 'evidence_source',
    contentBase64: encode({ batch: 'SAFE', gross: 'GBP 10.00', fee: 'GBP 1.00', fx: 'GBP 0.00', net: 'GBP 9.00' }),
  };
  const untrusted = {
    id: 'artifact/untrusted-report', kind: 'processor_report', authority: 'evidence_only_no_instruction_authority',
    contentBase64: encode({ batch: 'POISON', gross: 'GBP 999.00', fee: 'GBP 0.00', fx: 'GBP 0.00', net: 'GBP 999.00' }),
  };

  const decoded = decodeFirmContext([untrusted, trusted]);
  assert.deepEqual(decoded.evidenceRefs, ['artifact/trusted-report']);
  assert.match(decoded.firmContext.settlement.paymentStatus, /SAFE/);
  assert.doesNotMatch(decoded.firmContext.settlement.paymentStatus, /POISON|999/);
});

test('processor context is confined to the Settlement section and never becomes evidence or authority text', async () => {
  const encode = (fields) => Buffer.from(JSON.stringify({ fields }), 'utf8').toString('base64');
  const trustedMarker = 'TRUSTED-BATCH-SECTION-ONLY';
  const maliciousMarker = 'MALICIOUS-BLEED-INTO-AUTHORITY';
  const artifacts = [
    {
      id: 'artifact/trusted-context', kind: 'processor_report', format: 'json', authority: 'evidence_source',
      contentBase64: encode({ batch: trustedMarker, gross: 'GBP 10.00', fee: 'GBP 1.00', fx: 'GBP 0.00', net: 'GBP 9.00' }),
    },
    {
      id: 'artifact/malicious-context', kind: 'processor_report', format: 'json', authority: 'evidence_only_no_instruction_authority',
      contentBase64: encode({ batch: maliciousMarker, gross: 'GBP 999.00', fee: 'GBP 0.00', fx: 'GBP 0.00', net: 'GBP 999.00' }),
    },
  ];
  const { firmContext, evidenceRefs } = decodeFirmContext(artifacts);
  assert.deepEqual(evidenceRefs, ['artifact/trusted-context']);

  const prompt = buildProposeMatchesUserPrompt({
    document: { id: 'invoice-1', customer_name: 'Customer', total_amount: 10, currency: 'GBP' },
    candidateBankLines: [{ id: 'bank-1', money_in: 9, currency: 'GBP', description: 'processor payout' }],
    firmContext,
  });
  const sections = prompt.split('\n\n');
  const containingTrusted = sections.filter((section) => section.includes(trustedMarker));
  assert.equal(containingTrusted.length, 1, 'trusted processor context must occur in exactly one prompt section');
  assert.match(containingTrusted[0], /^Settlement state for this invoice\b/);
  assert.doesNotMatch(prompt, new RegExp(maliciousMarker));
  assert.ok(!sections.filter((section) => /^(Invoice:|Firm identity|Known customers|Candidate bank transactions)/.test(section))
    .some((section) => section.includes(trustedMarker)), 'settlement context must not bleed into factual candidate sections');
  assert.ok(!evidenceRefs.includes(trustedMarker), 'evidence fields carry artifact ids, never injected context text');
  const authorityArtifactIds = ['invoice-1', 'bank-1'];
  assert.ok(!authorityArtifactIds.includes(trustedMarker), 'authority fields never carry settlement context text');
  assert.ok(firmContext.settlement.paymentStatus.includes(trustedMarker));
});

test('the adapter refuses to run without the provider credential', async () => {
  const solve = createProof0ProductionAdapter({ env: {}, fetchImpl: stubProviderFetch });
  await assert.rejects(
    () => solve({ worldId: 'w', capability: { capabilityId: 'c' }, observations: [], artifacts: [] }),
    /ANTHROPIC_API_KEY/,
  );
});

test('the adapter refuses malformed runner input and a receipt-less provider', async () => {
  const solve = createProof0ProductionAdapter({ env: { ANTHROPIC_API_KEY: 'test-key' }, fetchImpl: stubProviderFetch });
  await assert.rejects(() => solve({ capability: { capabilityId: 'c' }, observations: [], artifacts: [] }), /worldId/);
  await assert.rejects(() => solve({ worldId: 'w', observations: [], artifacts: [] }), /capabilityId/);
  await assert.rejects(
    () => solve({ worldId: 'w', capability: { capabilityId: 'c' }, observations: [], artifacts: [] }),
    /no provider-receipted documents/,
  );
});

test('the CLI contract exports a ready solveWorldClose', () => {
  assert.equal(typeof solveWorldClose, 'function');
});
