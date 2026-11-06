// Q7 (the model lab) — reconciliation_reasoning reverse-shadow wiring.
//
// Pins: the comparator's proposal-set semantics (ids only, free text never
// recorded); fail-closed hook construction; and the reverse replay's exact
// parity — the strong default receives the SAME system prompt + user
// prompt the seated rung decided on, and the receipt lands in
// model_challenger_runs under this lane with response-sourced model ids.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECONCILIATION_REASONING_LANE,
  REASONING_CHALLENGER_FAMILIES,
  compareReconciliationReasoningOutputs,
  makeReconciliationReasoningChallengerHook
} from './reconciliationReasoningChallenger.js';
import { MODEL_CHALLENGER_FLAG_KEY } from './modelChallenger.js';
import { CHALLENGER_CAP_ENV } from './modelChallenger.js';
import {
  __SUPPLIER_BILL_SYSTEM_PROMPT,
  buildProposeMatchesUserPrompt,
  resolveSupplierBillDatePairs
} from './supplierBillReconciliationLlm.js';

const CONFIGURED_ENV = { [CHALLENGER_CAP_ENV]: '100000' };
const observingSnapshot = { [MODEL_CHALLENGER_FLAG_KEY]: { stage: 'shadow', source: 'client' } };

const DOCUMENT = {
  id: 'sb-phx-1',
  vendor_name: 'City of Phoenix Water Services',
  total_amount: 19.38,
  currency: 'USD',
  document_date: '2025-08-13',
  due_date: null,
  reference_number: '',
  payment_status: 'unpaid'
};

const BANK_LINE = {
  id: 'tx-phx-9',
  money_out: 19.38,
  currency: 'USD',
  date: '2025-08-12',
  description: 'PHX WATER SVC ACH 79553638',
  raw_description: 'PHX WATER SVC ACH 79553638',
  contact: ''
};

const DECIDING_RESULT = {
  proposals: [{ bank_transaction_id: 'tx-phx-9', confidence: 0.95, reasoning: 'exact amount + vendor', hops: ['amount_exact'] }],
  unmatchable_reason: null,
  model: 'qwen/qwen3.8-27b',
  model_source: 'response_proven'
};

const OBSERVATION = {
  document: DOCUMENT,
  candidateBankLines: [BANK_LINE],
  firmContext: { clientIdentity: { jurisdiction: 'US' }, knownCounterparties: ['City of Phoenix Water Services'] },
  configSnapshot: null,
  decidingResult: DECIDING_RESULT,
  decidingModel: { model: 'qwen/qwen3.8-27b', model_source: 'response_proven' },
  executionRoot: { type: 'reconciliation_reasoning', id: 'sb-phx-1' }
};

const makeMockClient = ({ tablePresent = true, spent = 0 } = {}) => {
  const inserts = [];
  return {
    inserts,
    query: async (sql, params) => {
      if (sql.includes('to_regclass')) return { rows: [{ present: tablePresent ? 'x' : null }] };
      if (sql.includes('coalesce(sum')) return { rows: [{ spent }] };
      if (sql.startsWith('insert into model_challenger_runs')) { inserts.push(params); return { rows: [] }; }
      return { rows: [] };
    }
  };
};

// Anthropic-shaped reply for the REVERSE call (the strong default's transport).
const anthropicFetch = (output, { model = 'claude-opus-4-8', captured = [] } = {}) => async (url, init) => {
  captured.push({ url, body: JSON.parse(init.body) });
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model,
      content: [{ text: typeof output === 'string' ? output : JSON.stringify(output) }]
    })
  };
};

const hookHarness = ({ env = CONFIGURED_ENV, snapshot = observingSnapshot, client = makeMockClient(), fetchImpl, sample = () => true } = {}) => {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const withClient = async (work) => {
    try {
      return await work(client);
    } finally {
      settle();
    }
  };
  const hook = makeReconciliationReasoningChallengerHook({
    family: 'supplier_bill',
    firmId: 'firm-1',
    clientId: 'client-1',
    snapshot,
    withClient,
    env,
    sample,
    fetchImpl,
    anthropicApiKey: 'sk-ant'
  });
  return { hook, client, done };
};

// ── the comparator ──────────────────────────────────────────────────────
await test('comparator: proposal-set semantics — flip, omission, reason drift, match; ids only in summaries', () => {
  const same = compareReconciliationReasoningOutputs({
    decidingResult: DECIDING_RESULT,
    challengerResult: { proposals: [{ bank_transaction_id: 'tx-phx-9', confidence: 0.7, reasoning: 'different words entirely' }], unmatchable_reason: null }
  });
  assert.deepEqual(same, { outcome: 'match', failure_class: null, summary: null },
    'same target set = match; confidence and reasoning are never compared');

  const flip = compareReconciliationReasoningOutputs({
    decidingResult: DECIDING_RESULT,
    challengerResult: { proposals: [{ bank_transaction_id: 'tx-other', confidence: 0.9, reasoning: 'x' }], unmatchable_reason: null }
  });
  assert.equal(flip.outcome, 'divergence');
  assert.equal(flip.failure_class, 'verdict_flip');
  assert.deepEqual(flip.summary, { field: 'proposed_bank_transaction_ids', deciding: ['tx-phx-9'], challenger: ['tx-other'] });

  const omission = compareReconciliationReasoningOutputs({
    decidingResult: DECIDING_RESULT,
    challengerResult: { proposals: [], unmatchable_reason: 'no_plausible_match' }
  });
  assert.equal(omission.failure_class, 'omission');

  const bothEmptySameReason = compareReconciliationReasoningOutputs({
    decidingResult: { proposals: [], unmatchable_reason: 'already_settled' },
    challengerResult: { proposals: [], unmatchable_reason: 'already_settled' }
  });
  assert.equal(bothEmptySameReason.outcome, 'match');

  const reasonDrift = compareReconciliationReasoningOutputs({
    decidingResult: { proposals: [], unmatchable_reason: 'already_settled' },
    challengerResult: { proposals: [], unmatchable_reason: 'no_plausible_match' }
  });
  assert.equal(reasonDrift.failure_class, 'format_drift');

  assert.equal(compareReconciliationReasoningOutputs({ decidingResult: DECIDING_RESULT, challengerResult: null }).outcome, 'parse_failure');

  const withText = compareReconciliationReasoningOutputs({
    decidingResult: DECIDING_RESULT,
    challengerResult: { proposals: [{ bank_transaction_id: 'tx-other', confidence: 0.9, reasoning: 'SECRET CLIENT DETAIL' }], unmatchable_reason: null }
  });
  assert.ok(!JSON.stringify(withText.summary).includes('SECRET'), 'free-text values never reach a summary');
});

// ── fail-closed construction ────────────────────────────────────────────
await test('hook construction fails closed: unknown family, missing injectors, no cap, no key', () => {
  const base = { family: 'supplier_bill', firmId: 'f', clientId: 'c', withClient: async () => {}, env: CONFIGURED_ENV, anthropicApiKey: 'k' };
  assert.ok(makeReconciliationReasoningChallengerHook(base), 'baseline constructs');
  assert.deepEqual(REASONING_CHALLENGER_FAMILIES,
    ['supplier_bill', 'sales_invoice', 'receipt', 'payment_confirmation', 'payment_account_statement', 'payout_statement'],
    'Q8 + RT-18: all six document-match families are threaded');
  assert.ok(makeReconciliationReasoningChallengerHook({ ...base, family: 'payout_statement' }), 'RT-18: the payout family constructs');
  assert.equal(makeReconciliationReasoningChallengerHook({ ...base, family: 'document_disposition' }), null, 'unthreaded family');
  assert.equal(makeReconciliationReasoningChallengerHook({ ...base, withClient: null }), null, 'no withClient');
  assert.equal(makeReconciliationReasoningChallengerHook({ ...base, env: {} }), null, 'no cap ⇒ fail-closed');
  assert.equal(makeReconciliationReasoningChallengerHook({ ...base, anthropicApiKey: null, env: { ...CONFIGURED_ENV } }), null, 'no anthropic key (env fallback empty)');
});

// ── the reverse replay: exact parity + the receipt ─────────────────────
await test('reverse shadow: Opus replays the EXACT observation and the agreement receipt lands under reconciliation_reasoning', async () => {
  const captured = [];
  const fetchImpl = anthropicFetch(
    { proposals: [{ bank_transaction_id: 'tx-phx-9', confidence: 0.93, reasoning: 'same', hops: ['amount_exact'] }], unmatchable_reason: null },
    { captured }
  );
  const { hook, client, done } = hookHarness({ fetchImpl });
  assert.ok(hook);
  hook(OBSERVATION);
  await done;

  // Replay parity — the strong default sees the same system prompt and the
  // same user prompt the seated rung decided on.
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured[0].body.system, __SUPPLIER_BILL_SYSTEM_PROMPT);
  const expectedUserPrompt = buildProposeMatchesUserPrompt({
    document: DOCUMENT,
    candidateBankLines: [BANK_LINE],
    firmContext: OBSERVATION.firmContext,
    datePairs: resolveSupplierBillDatePairs({ clientId: 'client-1', configSnapshot: null })
  });
  assert.equal(captured[0].body.messages[0].content, expectedUserPrompt);

  // The receipt: this lane, deciding = the rung (response-proven),
  // challenger = the strong default (response-proven), outcome = match.
  assert.equal(client.inserts.length, 1);
  const params = client.inserts[0];
  assert.equal(params[3], RECONCILIATION_REASONING_LANE);
  assert.equal(params[4], 'reconciliation_reasoning'); // root_execution_type
  assert.equal(params[5], 'sb-phx-1');
  assert.deepEqual(JSON.parse(params[6]), { model: 'qwen/qwen3.8-27b', model_source: 'response_proven' });
  const challengerBlob = JSON.parse(params[7]);
  assert.equal(challengerBlob.model, 'claude-opus-4-8');
  assert.equal(challengerBlob.model_source, 'response_proven');
  assert.equal(params[8], 'match');
});

await test('reverse shadow: a target flip receipts as verdict_flip divergence', async () => {
  const fetchImpl = anthropicFetch(
    { proposals: [], unmatchable_reason: 'no_plausible_match' }
  );
  const { hook, client, done } = hookHarness({ fetchImpl });
  hook(OBSERVATION);
  await done;
  assert.equal(client.inserts.length, 1);
  const params = client.inserts[0];
  assert.equal(params[8], 'divergence');
  assert.equal(params[9], 'omission');
  const summary = JSON.parse(params[10]);
  assert.deepEqual(summary, { field: 'proposed_bank_transaction_ids', deciding: ['tx-phx-9'], challenger: [] });
});

await test('reverse shadow: skips silently without an observing stage row or a deciding result', async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; throw new Error('must not be called'); };
  const { hook: darkHook, client: darkClient } = hookHarness({ fetchImpl, snapshot: null });
  darkHook(OBSERVATION);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(darkClient.inserts.length, 0, 'no stage row ⇒ no dispatch');

  const { hook: liveHook, client: liveClient } = hookHarness({ fetchImpl });
  liveHook({ ...OBSERVATION, decidingResult: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(liveClient.inserts.length, 0, 'no deciding result ⇒ nothing to challenge');
  assert.equal(fetched, false);
});
