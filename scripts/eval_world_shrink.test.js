import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createDecisionReceipt } from '../server/donna/world/traceReceipts.js';
import { createProof0WorldSpec } from '../server/donna/world/worldSchema.js';
import { NO_FAILURE_RECEIPT, loadSolveWorldClose, parseArgs, runWorldShrink } from './eval_world_shrink.js';

function world() {
  return createProof0WorldSpec({
    worldId: 'proof0/shrink-driver', seed: 'fixed', effectiveDate: '2026-08-05',
    entities: [{ id: 'entity/client', activeFrom: '2026-01-01' }],
    events: [{ id: 'event/settlement', type: 'processor_settlement', legalEntityId: 'entity/client', occurredAt: '2026-08-05', causalParents: [], monetaryEffects: { grossReceipts: 102, fees: 2, settled: 100 } }],
    observations: [{ id: 'observation/noise', eventId: 'event/settlement', observedAt: '2026-08-05' }], hiddenFacts: [], artifacts: [],
  });
}

function responseArtifact(modelId) {
  const notApplicable = { status: 'not_applicable' };
  return {
    provider: 'test-provider', base_model_id: modelId, base_model_digest: notApplicable,
    adapter_id: notApplicable, adapter_digest: notApplicable, quantization: notApplicable,
    runtime: 'provider-api', runtime_version: 'test-v1', vision_projector_digest: notApplicable,
    tool_protocol_version: notApplicable, prompt_snapshot_id: 'prompt/test', retrieval_snapshot_id: notApplicable,
    routing_snapshot_id: notApplicable, hardware_profile: notApplicable, execution_mode: 'frontier',
    model_id_source: 'provider_response', network_egress: true, fallback_occurred: false,
  };
}

function solver({ passing = false, usage = null, modelId = 'provider/response-model', responseProven = false } = {}) {
  return async ({ worldId, capability }) => ({
    resolvedModelId: modelId, usage,
    candidateClose: passing ? {
      candidateId: 'candidate/pass',
      entries: [['sales_revenue', 102], ['processor_fees_expense', 2], ['bank_cash', 100]].map(([accountRole, amount]) => ({ eventId: 'event/settlement', accountRole, amount, authorityArtifactIds: [] })),
      ownerFacts: [], actions: [],
    } : { candidateId: 'candidate/fail', entries: [], ownerFacts: [], actions: [] },
    traceReceipts: [createDecisionReceipt({
      decisionId: 'decision/close', worldId, capabilityId: capability.capabilityId, stage: 'final_close_and_external_state',
      selectedAction: 'close', authorityBasis: 'declared_mandate', sourceTrust: 'verified_evidence', reversibility: 'reversible',
      externalConsequence: 'books_only', nextState: passing ? 'resolved' : 'blocked', modelId,
      ...(responseProven ? { model_source: 'provider_response', model_artifact: responseArtifact(modelId) } : {}),
      expectedState: 'admissible_close', observedState: passing ? 'admissible_close' : 'missing_entries', sequence: 1,
    })],
    failureClass: 'whole_close_oracle_failure', consequence: { accounting: 'missing_entries' },
  });
}

test('requires a finite evaluation bound and the production adapter module', () => {
  assert.throws(() => parseArgs(['--solver-module=x.js']), /--max-evaluations is required/);
  assert.throws(() => parseArgs(['--solver-module=x.js', '--max-evaluations=1']), /at least 2/);
  assert.throws(() => parseArgs(['--solver-module=x.js', '--max-evaluations=2.5']), /safe integer/);
  assert.throws(() => parseArgs(['--max-evaluations=2']), /--solver-module is required/);
  assert.deepEqual(parseArgs(['--filter=proof0', '--solver-module=x.js', '--max-evaluations=2', '--output=out.json', '--print']), {
    filter: 'proof0', solverModule: 'x.js', maxEvaluations: 2, output: 'out.json', print: true,
  });
});

test('a passing candidate returns the no-failure sentinel through the real runner without quarantine', async () => {
  let calls = 0;
  const result = await runWorldShrink({
    worldSpec: world(), maxEvaluations: 3,
    solveWorldClose: async (input) => { calls += 1; return solver({ passing: calls > 1 })(input); },
  });
  assert.equal(result.status, 'shrunk');
  assert.equal(result.shrink.quarantine.length, 0);
  assert.deepEqual(NO_FAILURE_RECEIPT, { outcome: 'no_failure' });
  assert.equal(result.spend.solveCalls, 3);
  assert.equal(result.spend.solveCalls <= 3, true);
});

test('wraps solver spend inside the driver and preserves nondeterministic quarantine', async () => {
  let calls = 0;
  const result = await runWorldShrink({
    worldSpec: world(), maxEvaluations: 3,
    solveWorldClose: async (input) => { calls += 1; return solver({ passing: calls === 3, usage: { inputTokens: 7, outputTokens: 3 } })(input); },
  });
  assert.equal(result.status, 'quarantined');
  assert.equal(result.shrink.quarantine[0].reason, 'predicate_nondeterministic');
  assert.equal(result.spend.solveCalls, 3);
  assert.equal(result.spend.providerUsage.length, 3);
});

test('charges the initial reproduction against the declared total solve bound', async () => {
  const result = await runWorldShrink({ worldSpec: world(), maxEvaluations: 2, solveWorldClose: solver() });
  assert.equal(result.status, 'shrink_refused');
  assert.equal(result.spend.solveCalls, 1);
  assert.equal(result.spend.solveCalls <= 2, true);
});

test('an adapter refusal during initial reproduction fails closed with a spend receipt', async () => {
  const result = await runWorldShrink({
    worldSpec: world(),
    maxEvaluations: 3,
    solveWorldClose: async () => { throw new Error('paid adapter refused the reproduction'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'runner_refused');
  assert.deepEqual(result.initialRun, {
    status: 'adapter_error',
    errors: ['paid adapter refused the reproduction'],
    worldId: 'proof0/shrink-driver',
  });
  assert.equal(result.spend.solveCalls, 1);
  assert.equal(result.spend.providerUsage.length, 1);
  assert.equal(result.spend.providerUsage[0].status, 'incomplete');
  assert.ok(result.spend.providerUsage[0].incomplete_fields.includes('adapter.usage'));
  assert.match(result.spend.providerUsage[0].configuration_digest, /^[0-9a-f]{64}$/);
  assert.equal(result.shrink, null, 'an unreproduced failure must never reach the shrinker');
  assert.deepEqual(result.evaluationErrors, []);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('reports errored evaluations separately from candidates that do not preserve the failure', async () => {
  let calls = 0;
  const result = await runWorldShrink({
    worldSpec: world(), maxEvaluations: 3,
    solveWorldClose: async (input) => {
      calls += 1;
      if (calls === 1) return solver()(input);
      const errored = await solver({ passing: true })(input);
      return { ...errored, traceReceipts: [{}] };
    },
  });
  assert.equal(result.status, 'runner_refused');
  assert.equal(result.ok, false);
  assert.equal(result.shrink.quarantine.length, 0, 'the shrinker keeps treating an unknown signature as non-preservation');
  assert.equal(result.evaluationErrors.length, 2);
  assert.deepEqual(result.evaluationErrors.map(({ outcome, status }) => ({ outcome, status })), [
    { outcome: 'evaluation_error', status: 'model_identity_changed' },
    { outcome: 'evaluation_error', status: 'model_identity_changed' },
  ]);
});

test('refuses a scorer model that changes across shrink evaluations', async () => {
  let calls = 0;
  const result = await runWorldShrink({
    worldSpec: world(), maxEvaluations: 3,
    solveWorldClose: async (input) => {
      calls += 1;
      return solver({ modelId: calls === 1 ? 'provider/model-a' : 'provider/model-b' })(input);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'runner_refused');
  assert.ok(result.evaluationErrors.every(({ status }) => status === 'model_identity_changed'));
  assert.equal(result.provenance.scorerIdentity.resolvedModelId, 'provider/model-a');
});

test('does not drop provider-response scorer provenance from the shrink receipt', async () => {
  const result = await runWorldShrink({
    worldSpec: world(), maxEvaluations: 2, solveWorldClose: solver({ responseProven: true }),
  });
  assert.equal(result.provenance.scorerIdentity.classification, 'response_proven');
  assert.equal(result.provenance.scorerIdentity.modelSource, 'provider_response');
  assert.deepEqual(result.provenance.scorerIdentity, result.initialRun.provenance.scorerIdentity);
});

test('composition: persisted Proof 0 world runs through the loaded production adapter within the total bound', async () => {
  const proof0 = JSON.parse(readFileSync(new URL('../data/worlds/proof0.json', import.meta.url), 'utf8'));
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async (_url, { body }) => {
    const request = JSON.parse(body);
    const extraction = Array.isArray(request.messages[0].content);
    // The unified extractor's ONE strict schema (RT-12): every header key,
    // the settlement / contract blocks null-filled.
    const payload = extraction ? {
      document_type: 'sales_invoice', extraction_status: 'validated', extraction_confidence: 0.95,
      warnings: [], lines: [],
      source_business_use: { classification: 'not_stated', source_quote: null, business_use_percent: null },
      header: {
        counterparty_name: 'Aalto Consulting Oy', counterparty_role: 'customer', counterparty_tax_id: null, own_name: null, own_tax_id: null,
        document_date: '2026-08-01', due_date: null, currency: 'EUR', subtotal_amount: null, tax_amount: null,
        shipping_amount: 0, discount_amount: 0, rounding_amount: 0, total_amount: 70, line_amounts_include_tax: false,
        payment_status: 'unknown', payment_terms: null, references: [],
      },
      settlement: {
        period_start: null, period_end: null, payout_date: null, gross_sales: null, gross_components: [], refunds: null, fees: [],
        adjustments: [], net_payout: null, transaction_count: null, payout_reference: null, deposit_reference: null, bank_last4: null, rows: [],
      },
      contract: {
        contract_type: 'not_a_contract', effective_start_date: null, effective_end_date: null, auto_renew: null,
        notice_period_days: null, recurring_amount: null, recurring_frequency: 'none', obligations: [],
      },
    } : { proposals: [], unmatchable_reason: 'no_plausible_match' };
    return { ok: true, status: 200, json: async () => ({ model: 'provider-response-test-model', content: [{ text: JSON.stringify(payload) }] }) };
  };
  try {
    const solveWorldClose = await loadSolveWorldClose('scripts/eval_world_proof0_adapter.js');
    const result = await runWorldShrink({ worldSpec: proof0, solveWorldClose, maxEvaluations: 3, runtime: { donnaCommit: 'test-commit' } });
    assert.equal(result.initialRun.status, 'fail');
    assert.equal(result.initialRun.provenance.resolvedModelId, 'provider-response-test-model');
    assert.match(result.provenance.solverModule.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.provenance.solverModule, result.initialRun.provenance.solverModule);
    assert.equal(result.provenance.scorerIdentity.classification, 'legacy_unproven');
    assert.equal(result.provenance.scorerIdentity.modelSource, null);
    assert.equal(result.spend.solveCalls <= 3, true);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});

test('refuses malformed direct calls before spending', async () => {
  let calls = 0;
  await assert.rejects(() => runWorldShrink({ worldSpec: world(), solveWorldClose: async () => { calls += 1; }, maxEvaluations: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/);
  assert.equal(calls, 0);
});

test('refuses malformed world dates and boundary amounts before spending', async (t) => {
  const cases = [
    ['malformed event date', (candidate) => { candidate.events[0].occurredAt = '2026-8-05'; }],
    ['positive-infinite amount', (candidate) => { candidate.events[0].monetaryEffects.grossReceipts = Number.POSITIVE_INFINITY; }],
    ['negative-infinite amount', (candidate) => { candidate.events[0].monetaryEffects.fees = Number.NEGATIVE_INFINITY; }],
    ['not-a-number amount', (candidate) => { candidate.events[0].monetaryEffects.settled = Number.NaN; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const candidate = world();
      mutate(candidate);
      let calls = 0;
      const result = await runWorldShrink({
        worldSpec: candidate,
        maxEvaluations: 2,
        solveWorldClose: async () => { calls += 1; return solver()(candidate); },
      });
      assert.equal(result.status, 'runner_refused');
      assert.equal(result.initialRun.status, 'invalid_world');
      assert.equal(result.spend.solveCalls, 0);
      assert.equal(calls, 0);
      assert.equal(result.shrink, null);
    });
  }
});
