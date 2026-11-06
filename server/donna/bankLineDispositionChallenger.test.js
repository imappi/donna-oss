// Q6a — the disposition-lane challenger wiring, pinned in the B2 wiring's
// test shape. Load-bearing properties: exact replay (the lane's own system
// + user prompts, verbatim — no schema suffix), the lane comparator's
// verdict/materiality/cosmetic split, safe-fallback semantics never
// dispatched, and the same fail-closed construction as B2.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BANK_LINE_DISPOSITION_CHALLENGER_LANE,
  bankLineDispositionChallengerConfigured,
  compareBankLineDispositionOutputs,
  makeBankLineDispositionChallengerHook
} from './bankLineDispositionChallenger.js';
import { CHALLENGER_MODEL_ENV, CHALLENGER_CAP_ENV } from './modelChallenger.js';
import { MODEL_CHALLENGER_FLAG_KEY } from './modelChallenger.js';
import {
  buildBankLineDispositionUserPrompt,
  __buildMoneyOutSystemPrompt
} from './bankLineDispositionLlm.js';

// RT-11b (2026-09-02): the disposition ceiling FOLLOWS THE PACK (reconciliation.
// disposition_ceiling, resolved from the client's canonical jurisdiction); env
// is the only override and no pack ⇒ the guard fails closed. The fixtures in
// this file carry display-string / packless jurisdictions, so the ceiling is
// pinned through the env override here (the same convention the family-matcher
// tests use for RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING). The pack path
// itself is pinned in dispositionMateriality.test.js and the RT-11b appliance
// fixture (materialityCeilingPackAppliancePgLifecycle.test.js).
process.env.DISPOSITION_MATERIALITY_CEILING = '500';

const CONFIGURED_ENV = {
  OPENAI_COMPATIBLE_BASE_URL: 'https://example-host.test/v1',
  OPENAI_COMPATIBLE_API_KEY: 'sk-compat',
  [CHALLENGER_MODEL_ENV]: 'qwen-3.8-test',
  [CHALLENGER_CAP_ENV]: '100000'
};

const observingSnapshot = { [MODEL_CHALLENGER_FLAG_KEY]: { stage: 'shadow', source: 'client' } };

const TX = {
  id: 'tx-88',
  description: 'AWS EMEA',
  raw_description: 'AWS EMEA SARL',
  money_out: 42.5,
  currency: 'EUR',
  transaction_date: '2026-08-01'
};

const FIRM_CONTEXT = {
  clientIdentity: { jurisdiction: 'SG' },
  knownCounterparties: [],
  recurrenceCount: 6
};

const SEMANTIC = {
  disposition: 'auto_explain',
  downgraded_from: null,
  materiality: 'immaterial',
  expense_kind: 'software_subscription',
  confidence: 0.9,
  reasoning: 'recurring known SaaS',
  materiality_ceiling: null,
  unmatchable_reason: null
};

const CONTEXT = { firmContext: FIRM_CONTEXT, direction: 'money_out', model: 'claude-opus-4-8' };

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

const challengerFetch = (output, { model = 'qwen-3.8-served' } = {}) => async (url, init) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({
    model,
    choices: [{ message: { role: 'assistant', content: typeof output === 'string' ? output : JSON.stringify(output) } }],
    usage: { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360 }
  }),
  __captured: { url, body: JSON.parse(init.body) }
});

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
  const hook = makeBankLineDispositionChallengerHook({
    firmId: 'firm-1',
    clientId: 'client-1',
    snapshot,
    withClient,
    env,
    sample,
    fetchImpl
  });
  return { hook, client, done };
};

// ── configuration + construction gates (the B2 contract, same env four) ──
await test('configured predicate is the shared rung config; construction fails closed on missing injectors', () => {
  assert.equal(bankLineDispositionChallengerConfigured(CONFIGURED_ENV), true);
  assert.equal(bankLineDispositionChallengerConfigured({ ...CONFIGURED_ENV, [CHALLENGER_CAP_ENV]: '' }), false);
  assert.equal(makeBankLineDispositionChallengerHook({ firmId: 'f', clientId: 'c', withClient: async () => {}, env: {} }), null);
  assert.equal(makeBankLineDispositionChallengerHook({ firmId: 'f', clientId: 'c', env: CONFIGURED_ENV }), null, 'no withClient');
  assert.equal(makeBankLineDispositionChallengerHook({ clientId: 'c', withClient: async () => {}, env: CONFIGURED_ENV }), null, 'no firmId');
});

// ── the comparator ──────────────────────────────────────────────────────
await test('comparator: disposition flip → verdict_flip; materiality → materiality_miss; kind-only → format_drift; null → parse_failure', () => {
  const flip = compareBankLineDispositionOutputs({
    decidingResult: SEMANTIC,
    challengerResult: { ...SEMANTIC, disposition: 'needs_human' }
  });
  assert.deepEqual(flip, {
    outcome: 'divergence',
    failure_class: 'verdict_flip',
    summary: { field: 'disposition', deciding: 'auto_explain', challenger: 'needs_human' }
  });

  const materiality = compareBankLineDispositionOutputs({
    decidingResult: SEMANTIC,
    challengerResult: { ...SEMANTIC, materiality: 'material' }
  });
  assert.equal(materiality.failure_class, 'materiality_miss');

  const kind = compareBankLineDispositionOutputs({
    decidingResult: SEMANTIC,
    challengerResult: { ...SEMANTIC, expense_kind: 'cloud_hosting' }
  });
  assert.equal(kind.failure_class, 'format_drift');

  assert.equal(compareBankLineDispositionOutputs({ decidingResult: SEMANTIC, challengerResult: null }).outcome, 'parse_failure');
  assert.equal(compareBankLineDispositionOutputs({ decidingResult: SEMANTIC, challengerResult: { ...SEMANTIC } }).outcome, 'match');
  // reasoning is free text and must never reach a summary
  const withReasoning = compareBankLineDispositionOutputs({
    decidingResult: SEMANTIC,
    challengerResult: { ...SEMANTIC, disposition: 'chase_receipt', reasoning: 'SECRET CLIENT DETAIL' }
  });
  assert.ok(!JSON.stringify(withReasoning.summary).includes('SECRET'), 'free-text values never reach the summary');
});

// ── end to end through the REAL registry ────────────────────────────────
await test('hook fires: exact replay of the deciding prompts, receipt on the disposition lane, response-proven challenger', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    const response = await challengerFetch(SEMANTIC)(url, init);
    captured = response.__captured;
    return response;
  };
  const { hook, client, done } = hookHarness({ fetchImpl });
  assert.ok(typeof hook === 'function');
  hook(TX, SEMANTIC, CONTEXT);
  await done;

  // EXACT parity: the system message IS the lane's system prompt for the
  // direction+jurisdiction, and the user message IS the lane's user prompt
  // — verbatim, no schema suffix, no transport-shape compromise.
  assert.equal(captured.url, 'https://example-host.test/v1/chat/completions');
  assert.equal(captured.body.model, 'qwen-3.8-test');
  assert.equal(captured.body.messages[0].content, __buildMoneyOutSystemPrompt('SG'));
  assert.equal(
    captured.body.messages[1].content,
    buildBankLineDispositionUserPrompt({ transaction: TX, firmContext: FIRM_CONTEXT, clientAnswer: null, direction: 'money_out' })
  );

  assert.equal(client.inserts.length, 1);
  const [, firmId, clientId, lane, rootType, rootId, deciding, challenger, outcome] = client.inserts[0];
  assert.deepEqual([firmId, clientId, lane, rootType, rootId],
    ['firm-1', 'client-1', BANK_LINE_DISPOSITION_CHALLENGER_LANE, 'bank_line_disposition', 'tx-88']);
  assert.deepEqual(JSON.parse(deciding), { model: 'claude-opus-4-8', model_source: 'configured_fallback' });
  assert.equal(JSON.parse(challenger).model, 'qwen-3.8-served');
  assert.equal(JSON.parse(challenger).model_source, 'response_proven');
  assert.equal(outcome, 'match');
});

await test('the challenger side runs the SAME deterministic downgrades: auto_explain+material lands as needs_human → verdict_flip', async () => {
  const { hook, client, done } = hookHarness({
    fetchImpl: challengerFetch({ disposition: 'auto_explain', materiality: 'material', expense_kind: 'software_subscription', confidence: 0.8, reasoning: 'x' })
  });
  hook(TX, SEMANTIC, CONTEXT);
  await done;
  const [, , , , , , , , outcome, failureClass, summary] = client.inserts[0];
  assert.equal(outcome, 'divergence');
  assert.equal(failureClass, 'verdict_flip');
  assert.equal(JSON.parse(summary).challenger, 'needs_human',
    'parseDispositionResponse downgraded the contradictory auto_explain exactly as the deciding side would');
});

await test('non-JSON challenger content → parse_failure receipt (not challenger_error)', async () => {
  const { hook, client, done } = hookHarness({
    fetchImpl: challengerFetch('I would ask a human about this one.')
  });
  hook(TX, SEMANTIC, CONTEXT);
  await done;
  const [, , , , , , , , outcome] = client.inserts[0];
  assert.equal(outcome, 'parse_failure');
});

await test('hook no-ops: safe-fallback semantic, missing tx id, dark flag — nothing dispatched', async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; throw new Error('must not be called'); };

  const { hook: h1, client: c1 } = hookHarness({ fetchImpl });
  h1(TX, { ...SEMANTIC, confidence: 0, unmatchable_reason: 'transport_error' }, CONTEXT);
  h1({ ...TX, id: null }, SEMANTIC, CONTEXT);

  const { hook: h2, client: c2 } = hookHarness({ fetchImpl, snapshot: null });
  h2(TX, SEMANTIC, CONTEXT);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetched, false);
  assert.equal(c1.inserts.length + c2.inserts.length, 0);
});

await test('a genuine parse carrying a model-supplied unmatchable_reason with real confidence still dispatches', async () => {
  const { hook, client, done } = hookHarness({ fetchImpl: challengerFetch(SEMANTIC) });
  hook(TX, { ...SEMANTIC, unmatchable_reason: 'model_noted_ambiguity', confidence: 0.6 }, CONTEXT);
  await done;
  assert.equal(client.inserts.length, 1);
});

// ── the wiring pins (source-level): both sweep owners construct/forward ──
await test('the isolation-list touch is pinned: parseDocumentsDb threads the connection injector into the drain', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve: resolvePath } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const parseDb = readFileSync(resolvePath(here, 'parseDocumentsDb.js'), 'utf8');
  assert.ok(
    parseDb.includes('runReconciliationTerminalDrain({ client, firmId, clientId, challengerWithClient: withFirmDbClient })'),
    'parseDocumentsDb.js must pass challengerWithClient: withFirmDbClient to the terminal drain — the one-line Q6a isolation touch'
  );
  const drain = readFileSync(resolvePath(here, 'loopsShadowProducers.js'), 'utf8');
  assert.ok(drain.includes('enabledOverride: true, fetchImpl, challengerHook, decidingPolicy'),
    'the drain forwards the hook AND the model-lab policy (Q6c) into both direction sweeps');
  const cron = readFileSync(resolvePath(here, 'inngest/bankLineDisposition.js'), 'utf8');
  assert.ok(cron.includes('runBankLineDispositionForClient({ client, firmId, clientId, challengerHook, decidingPolicy })'),
    'the hourly cron forwards the hook AND the model-lab policy (Q6c) into the sweep');
});

// ── Q6c — the model lab: REVERSE shadow (the strong default challengers
// the experiment rung) ──────────────────────────────────────────────────

const EXPERIMENT_POLICY = { deciding_model: 'Qwen/Qwen3.5-397B-A17B', basis: 'experiment' };
// Reverse mode needs no compatible env — only the cap (and the anthropic key).
const REVERSE_ENV = { [CHALLENGER_CAP_ENV]: '100000' };

const anthropicFetch = (output, { model = 'claude-opus-4-8-served' } = {}) => async (url, init) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({
    model,
    content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }],
    usage: { input_tokens: 300, output_tokens: 60 }
  }),
  __captured: { url, body: JSON.parse(init.body) }
});

const reverseHarness = ({ env = REVERSE_ENV, snapshot = observingSnapshot, client = makeMockClient(), fetchImpl, decidingPolicy = EXPERIMENT_POLICY } = {}) => {
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  const withClient = async (work) => {
    try {
      return await work(client);
    } finally {
      settle();
    }
  };
  const hook = makeBankLineDispositionChallengerHook({
    firmId: 'firm-1',
    clientId: 'client-1',
    snapshot,
    withClient,
    env,
    sample: () => true,
    fetchImpl,
    decidingPolicy,
    anthropicApiKey: 'sk-ant-test'
  });
  return { hook, client, done };
};

await test('Q6c reverse: an experiment policy flips the shadow direction — the strong default challengers the rung over anthropic, no compatible env needed', async () => {
  const qwenSemantic = { ...SEMANTIC, model: 'qwen-served-by-provider', model_source: 'response' };
  let captured = null;
  const fetchImpl = async (url, init) => {
    const response = await anthropicFetch(SEMANTIC)(url, init);
    captured = response.__captured;
    return response;
  };
  const { hook, client, done } = reverseHarness({ fetchImpl });
  assert.ok(typeof hook === 'function', 'reverse mode constructs without the compatible env pair');
  hook(TX, qwenSemantic, CONTEXT);
  await done;

  assert.ok(captured.url.includes('anthropic'), 'the reverse challenger rides the core anthropic transport');
  assert.equal(captured.body.model, 'claude-opus-4-8', 'the challenger is the FORMER deciding model');
  assert.equal(captured.body.system, __buildMoneyOutSystemPrompt('SG'), 'exact replay, reverse direction included');

  assert.equal(client.inserts.length, 1);
  const [, , , lane, , rootId, deciding, challenger, outcome] = client.inserts[0];
  assert.equal(lane, BANK_LINE_DISPOSITION_CHALLENGER_LANE);
  assert.equal(rootId, 'tx-88');
  assert.equal(JSON.parse(deciding).model, 'qwen-served-by-provider',
    'the deciding side is the rung, response-proven by the compatible transport');
  assert.equal(JSON.parse(deciding).model_source, 'response');
  assert.equal(JSON.parse(challenger).model, 'claude-opus-4-8-served');
  assert.equal(outcome, 'match');
});

await test('Q6c reverse: a rung/strong disagreement receipts as a divergence with the lane comparator', async () => {
  const { hook, client, done } = reverseHarness({
    fetchImpl: anthropicFetch({ ...SEMANTIC, disposition: 'needs_human', materiality: 'material' })
  });
  hook(TX, { ...SEMANTIC, model: 'qwen-served-by-provider' }, CONTEXT);
  await done;
  const [, , , , , , , , outcome, failureClass] = client.inserts[0];
  assert.equal(outcome, 'divergence');
  assert.equal(failureClass, 'verdict_flip');
});

await test('Q6c reverse: fails closed without the cap or the anthropic key; the core-default policy stays FORWARD mode', () => {
  const noCap = makeBankLineDispositionChallengerHook({
    firmId: 'f', clientId: 'c', withClient: async () => {}, env: {},
    decidingPolicy: EXPERIMENT_POLICY, anthropicApiKey: 'sk-ant'
  });
  assert.equal(noCap, null, 'no cap ⇒ no reverse dispatch (same fail-closed gate as forward)');

  const noKey = makeBankLineDispositionChallengerHook({
    firmId: 'f', clientId: 'c', withClient: async () => {}, env: REVERSE_ENV,
    decidingPolicy: EXPERIMENT_POLICY, anthropicApiKey: null
  });
  assert.equal(noKey, null, 'no anthropic key ⇒ no reverse challenger (env has none in this test)');

  const defaultPolicy = makeBankLineDispositionChallengerHook({
    firmId: 'f', clientId: 'c', withClient: async () => {}, env: {},
    decidingPolicy: { deciding_model: 'claude-opus-4-8', basis: 'experiment' }, anthropicApiKey: 'sk-ant'
  });
  assert.equal(defaultPolicy, null,
    'the strong default deciding ⇒ forward mode ⇒ null without the compatible env (never opus challengering opus)');
});
