import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  GATE2B_PREDECLARED_K,
  buildGate2bC1RunReceipt,
  buildGate2bLiveBudget,
  evaluateGate2bOwnerCheckpoints,
  evaluateGate2bQuiescence,
  evaluateGate2bStability,
  validateGate2bWorld,
} from './gate2bConvergenceProof.js';
import { buildExpectedClose, readProof0PolicyPack } from './oracleSuite.js';
import { renderWorldArtifacts } from './worldRenderer.js';
import { selectGate2aRenderedArtifact } from './gate2aRawByteProof.js';
import { createDecisionReceipt } from './traceReceipts.js';

const DIGEST = 'a'.repeat(64);
const na = () => ({ status: 'not_applicable' });
const unknown = (reason) => ({ status: 'unknown', reason });
const liveDecisionReceipt = (overrides = {}) => createDecisionReceipt({
  decisionId: 'decision/gate2b-card-purpose',
  worldId: 'gate2b/world',
  capabilityId: 'code_owner_answered_card_charge',
  stage: 'authority_decision',
  selectedAction: 'post_travel_expense',
  authorityBasis: 'owner_business_purpose_answer',
  sourceTrust: 'owner_response',
  reversibility: 'reversible_accounting_entry',
  externalConsequence: 'isolated_ledger',
  nextState: 'auto_reconciled',
  modelId: 'response-model-id',
  expectedState: 'auto_reconciled',
  observedState: 'auto_reconciled',
  confidence: 'high',
  sequence: 1,
  model_source: 'provider_response',
  model_artifact: {
    provider: 'provider-a',
    base_model_id: 'response-model-id',
    base_model_digest: unknown('provider does not publish an artifact digest'),
    adapter_id: na(), adapter_digest: na(),
    quantization: unknown('provider does not disclose serving quantization'),
    runtime: 'provider-managed',
    runtime_version: unknown('provider does not disclose runtime version'),
    vision_projector_digest: na(),
    tool_protocol_version: 'tools.v1',
    prompt_snapshot_id: 'prompt/gate2b/v1',
    retrieval_snapshot_id: na(),
    routing_snapshot_id: 'routing/gate2b/v1',
    hardware_profile: unknown('provider-managed hardware is undisclosed'),
    execution_mode: 'frontier',
    model_id_source: 'provider_response',
    network_egress: true,
    fallback_occurred: false,
  },
  ...overrides,
});
const spendReceipt = () => ({
  status: 'counted',
  solveCalls: 1,
  calls: [{
    provider: 'provider-a', response_id: 'response-a', model_id: 'model-a',
    input_tokens: 100, output_tokens: 20, wall_time_ms: 250,
    request_digest: DIGEST, http_status: 200, retry_index: 0,
    retry_disposition: 'not_retried', cache_disposition: 'miss', outcome: 'success',
    input_token_preflight: {
      input_tokens: 100, http_status: 200, request_digest: DIGEST,
      endpoint_path: '/v1/test/input_tokens', cost: 'free_provider_token_count',
    },
  }],
  cash: { usd: 0.001, price_source: { id: 'provider-a-pricing-2026-08-30' } },
  configurationDigest: DIGEST,
  artifactDigests: [DIGEST],
});

test('Gate 2B extends the causal month while preserving the first Gate 2A PDF byte-for-byte', async () => {
  const [gate2a, gate2b] = await Promise.all([
    fs.readFile('data/worlds/gate2a-raw-byte-month.json', 'utf8').then(JSON.parse),
    fs.readFile('data/worlds/gate2b-birth-to-quiescence-month.json', 'utf8').then(JSON.parse),
  ]);
  assert.deepEqual(validateGate2bWorld(gate2b), { ok: true, errors: [] });
  const [firstA, firstB] = await Promise.all([
    renderWorldArtifacts(gate2a).then((rendered) => selectGate2aRenderedArtifact({ world: gate2a, rendered })),
    renderWorldArtifacts(gate2b).then((rendered) => selectGate2aRenderedArtifact({ world: gate2b, rendered })),
  ]);
  assert.equal(firstB.raw_sha256, firstA.raw_sha256);
  assert.equal(firstB.byte_length, firstA.byte_length);
  const expected = buildExpectedClose(gate2b, await readProof0PolicyPack());
  assert.equal(expected.ok, true);
  assert.equal(expected.requiredOwnerFacts[0].requiredFactKind, 'business_purpose');
  assert.ok(expected.expectedEntries.some((entry) => entry.accountRole === 'travel_expense' && entry.amount === 24));
});

const lane = () => ({
  lane: 'document_extraction',
  provider: 'provider-a',
  model_id: 'model-a',
  max_calls_per_run: 2,
  max_input_tokens_per_call: 1_000,
  max_output_tokens_per_call: 500,
  price_source: {
    id: 'provider-a-pricing-2026-08-30',
    observed_at: '2026-08-30T08:00:00.000Z',
    input_usd_per_million: 2,
    output_usd_per_million: 8,
  },
});

test('Gate 2B live budget refuses the first call until the exact measured cap is approved', () => {
  const waiting = buildGate2bLiveBudget({ worldId: 'gate2b/world', lanes: [lane()] });
  assert.equal(waiting.status, 'AWAITING_APPROVAL');
  assert.equal(waiting.first_live_call_allowed, false);
  assert.deepEqual(waiting.totals, { calls: 6, input_tokens: 6_000, output_tokens: 3_000, cash_usd: 0.036 });

  const approved = buildGate2bLiveBudget({
    worldId: 'gate2b/world',
    lanes: [lane()],
    approved: {
      authority_id: 'kari', basis: 'approved measured Gate 2B hard cap',
      approved_at: '2026-08-30T09:00:00.000Z', world_id: 'gate2b/world',
      k: GATE2B_PREDECLARED_K, max_cash_usd: 0.04, max_calls: 6,
    },
  });
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.first_live_call_allowed, true);
});

const quietInventory = () => ({
  projector: 'reconcileConvergenceState',
  source_items: [{ id: 'source/bank-line-1' }],
  documents: [{ id: 'doc-1', status: 'completed' }],
  jobs: [{ id: 'job-1', status: 'completed' }],
  reconciliation_candidates: [],
  coding_candidates: [],
  draft_send_work: [],
  asks: [],
  transactions: [{ id: 'tx-1', state: 'auto_applied', journal_ids: ['journal-1'] }],
  obligations: [{ id: 'obligation-1', source_item_id: 'source/bank-line-1', state: 'auto_reconciled' }],
});

test('Gate 2B quiescence requires a complete unchanged epoch and journal coverage', () => {
  const inventory = quietInventory();
  const pass = evaluateGate2bQuiescence({ before_epoch: inventory, after_epoch: structuredClone(inventory) });
  assert.equal(pass.status, 'PASS');
  assert.equal(pass.unchanged_after_complete_epoch, true);

  const broken = structuredClone(inventory);
  broken.transactions[0].journal_ids = [];
  broken.asks.push({ id: 'ask-1', status: 'replied' });
  broken.obligations[0] = { id: 'obligation-1', source_item_id: 'source/bank-line-1', state: 'hanging' };
  const fail = evaluateGate2bQuiescence({ before_epoch: broken, after_epoch: structuredClone(broken) });
  assert.equal(fail.status, 'FAIL');
  assert.deepEqual(fail.blockers.map(({ class: name }) => name), [
    'replied_asks_awaiting_processing',
    'accepted_transactions_without_journal',
    'canonical_hanging_obligations',
  ]);
});

test('Gate 2B owner proof pins lawful T2, replied-as-hanging, and actual resumption', () => {
  const receipt = evaluateGate2bOwnerCheckpoints({
    declared_hidden_facts: [{ id: 'hidden/purpose', kind: 'business_purpose' }],
    answer: { ask_id: 'ask-purpose', hidden_fact_id: 'hidden/purpose', fact_class: 'business_purpose', obligation_id: 'obligation/card-line' },
    pre_answer: {
      asks: [{ id: 'ask-purpose', status: 'open', fact_class: 'business_purpose' }],
      obligations: [{ id: 'obligation/card-line', state: 'on_owner', ask_id: 'ask-purpose', responsible_actor: 'owner' }],
    },
    replied: {
      asks: [{ id: 'ask-purpose', status: 'replied', fact_class: 'business_purpose' }],
      obligations: [{ id: 'obligation/card-line', state: 'hanging', reason: 'owner_answered_processing' }],
    },
    post_resume: {
      asks: [{ id: 'ask-purpose', status: 'resolved', fact_class: 'business_purpose' }],
      obligations: [{ id: 'obligation/card-line', state: 'auto_reconciled' }],
    },
  });
  assert.equal(receipt.status, 'PASS');

  const falseTerminal = evaluateGate2bOwnerCheckpoints({
    declared_hidden_facts: [{ id: 'hidden/purpose', kind: 'business_purpose' }],
    answer: { ask_id: 'ask-purpose', hidden_fact_id: 'hidden/purpose', fact_class: 'business_purpose', obligation_id: 'obligation/card-line' },
    pre_answer: { asks: [{ id: 'ask-purpose', status: 'open', fact_class: 'business_purpose' }], obligations: [{ id: 'obligation/card-line', state: 'on_owner', ask_id: 'ask-purpose', responsible_actor: 'owner' }] },
    replied: { asks: [{ id: 'ask-purpose', status: 'replied' }], obligations: [{ id: 'obligation/card-line', state: 'on_owner', ask_id: 'ask-purpose' }] },
    post_resume: { asks: [{ id: 'ask-purpose', status: 'replied' }], obligations: [{ id: 'obligation/card-line', state: 'on_owner', ask_id: 'ask-purpose' }] },
  });
  assert.equal(falseTerminal.status, 'FAIL');
  assert.match(falseTerminal.failures.join('\n'), /hanging|closed/);
});

const consequence = (runToken, amount = 24) => ({
  version: 'eaw.gate2b.c1-run.v1',
  status: 'PASS',
  run_token: runToken,
  accounting_entries: [{ canonical_identity: 'entry/card-line', event_id: 'event/card-line', obligation_id: 'obligation/card-line', account_role: 'travel_expense', amount, currency: 'GBP' }],
  terminal_inventory: [{ canonical_identity: 'terminal/card-line', source_item_id: 'source/card-line', state: 'auto_reconciled', responsible_actor: null, fact_class: null }],
  ask_inventory: [{ canonical_identity: 'ask/business-purpose', obligation_id: 'obligation/card-line', fact_class: 'business_purpose', audience: 'client', terminal_status: 'resolved', wording: `wording-${runToken}` }],
});

test('Gate 2B K schedule ignores wording and generated ids but blocks consequence variance', () => {
  const stable = evaluateGate2bStability({ runs: [consequence('run-a'), consequence('run-b'), consequence('run-c')] });
  assert.equal(stable.status, 'PASS');
  assert.equal(stable.consequence_variants, 1);

  const variance = evaluateGate2bStability({ runs: [consequence('run-a'), consequence('run-b'), consequence('run-c', 25)] });
  assert.equal(variance.status, 'VARIANCE');
  assert.equal(variance.consequence_variants, 2);

  const failedRun = consequence('run-c');
  failedRun.status = 'FAIL';
  const failed = evaluateGate2bStability({ runs: [consequence('run-a'), consequence('run-b'), failedRun] });
  assert.equal(failed.status, 'FAIL', 'a valid failed run must not be laundered as missing infrastructure');
});

test('one C1 run refuses configured-only model identity or incomplete spend', () => {
  const base = {
    world: { worldId: 'gate2b/world' }, run_token: 'run-a',
    model_receipts: [liveDecisionReceipt()],
    spend: spendReceipt(),
    quiescence: { status: 'PASS' }, owner_checkpoints: { status: 'PASS' },
    oracle: { ok: true, failures: [] }, isolation: { status: 'PASS', external_destinations: 'isolated' },
    accounting_entries: consequence('x').accounting_entries,
    terminal_inventory: consequence('x').terminal_inventory,
    ask_inventory: consequence('x').ask_inventory,
    artifact_digests: [DIGEST], configuration_digest: DIGEST,
    complete_epoch_receipt: {
      reconciliation: {}, coding: {}, draft: {}, send: {}, inbox: {}, outbox: {}, resumed_coding: {},
    },
  };
  assert.equal(buildGate2bC1RunReceipt(base).status, 'PASS');
  assert.equal(buildGate2bC1RunReceipt({
    ...base,
    model_receipts: [liveDecisionReceipt({
      model_source: 'configured_fallback',
      model_artifact: {
        ...liveDecisionReceipt().model_artifact,
        model_id_source: 'configured_fallback',
        fallback_occurred: true,
      },
    })],
  }).status, 'INCOMPLETE');
  assert.equal(buildGate2bC1RunReceipt({ ...base, configuration_digest: 'b'.repeat(64) }).status, 'INCOMPLETE');
  assert.equal(buildGate2bC1RunReceipt({ ...base, artifact_digests: ['b'.repeat(64)] }).status, 'INCOMPLETE');
  assert.equal(buildGate2bC1RunReceipt({ ...base, spend: { status: 'counted', solveCalls: 1, calls: [] } }).status, 'INCOMPLETE');
  const withoutEpoch = { ...base };
  delete withoutEpoch.complete_epoch_receipt;
  assert.equal(buildGate2bC1RunReceipt(withoutEpoch).status, 'INCOMPLETE');
});
