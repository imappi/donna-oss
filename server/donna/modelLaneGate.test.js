// Q6 — the lane gate's arithmetic, pinned. The honesty rule under test
// everywhere: insufficient evidence (absent table, zero runs, thin window,
// missing gold run) is RED with insufficient_data — never green. And the
// dormant demotion machinery behaves before any flip exists, so the flip
// commit wires a tested tripwire, not a hopeful one.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEMOTION_VERDICT_ARTIFACT,
  LANE_GATE_THRESHOLDS,
  PROMOTION_VERDICT_ARTIFACT,
  buildDemotionVerdict,
  buildPromotionVerdict,
  checkModelIdDrift,
  computeLaneGapTable,
  evaluateDemotionTripwire,
  evaluateLaneGate,
  gateGovernedLanes,
  laneGateThresholds,
  listDivergenceRunIds
} from './modelLaneGate.js';
import { getLane } from './modelLanes.js';

const LANE = 'bank_line_disposition'; // the pilot lane since Q6a; B2 was retired in RT-14
const round4 = (v) => Math.round(v * 10000) / 10000;

const makeMockClient = ({ tablePresent = true, aggregates = [], models = [], divergenceIds = [] } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('to_regclass')) return { rows: [{ present: tablePresent ? 'x' : null }] };
      if (sql.includes('group by outcome, failure_class')) return { rows: aggregates };
      if (sql.includes('distinct challenger')) return { rows: models };
      if (sql.includes('order by created_at desc')) return { rows: divergenceIds.map((id) => ({ id })) };
      return { rows: [] };
    }
  };
};

// A healthy 30-day window: 400 compared runs, agreement over threshold.
const healthyAggregates = [
  { outcome: 'match', failure_class: null, runs: 394, first_run_at: '2026-07-01T00:00:00Z', last_run_at: '2026-07-31T00:00:00Z' },
  { outcome: 'divergence', failure_class: 'format_drift', runs: 4, first_run_at: '2026-07-02T00:00:00Z', last_run_at: '2026-07-30T00:00:00Z' },
  { outcome: 'divergence', failure_class: 'verdict_flip', runs: 1, first_run_at: '2026-07-05T00:00:00Z', last_run_at: '2026-07-05T00:00:00Z' },
  { outcome: 'parse_failure', failure_class: null, runs: 1, first_run_at: '2026-07-09T00:00:00Z', last_run_at: '2026-07-09T00:00:00Z' },
  { outcome: 'challenger_error', failure_class: null, runs: 2, first_run_at: '2026-07-11T00:00:00Z', last_run_at: '2026-07-12T00:00:00Z' }
];
const healthyModels = [
  { challenger_model: 'qwen-3.8-instruct', deciding_model: 'gpt-5.4' }
];
const goldPass = {
  gold_set_version: 'bank_line_semantic_prompt_v1-gold.1',
  gate: 'PASS',
  response_models: ['qwen-3.8-instruct'],
  summary: { must_pass_rate: 1, pass_rate: 0.9, must_regressions: [] }
};

const healthyGapTable = async (overrides = {}) => computeLaneGapTable({
  client: makeMockClient({ aggregates: healthyAggregates, models: healthyModels, ...overrides }),
  laneId: LANE
});

await test('gap table: absent migration reads as table_present false with zero everything', async () => {
  const table = await computeLaneGapTable({ client: makeMockClient({ tablePresent: false }), laneId: LANE });
  assert.equal(table.table_present, false);
  assert.equal(table.runs, 0);
  assert.deepEqual(table.challenger_models, []);
  assert.equal(table.rates.decision_agreement, null);
});

await test('gap table: folds outcomes, failure classes, window, models, and rates from the receipts', async () => {
  const table = await healthyGapTable();
  assert.equal(table.runs, 402);
  assert.equal(table.match, 394);
  assert.equal(table.divergence, 5);
  assert.deepEqual(table.by_failure_class, { format_drift: 4, verdict_flip: 1 });
  assert.equal(table.first_run_at, '2026-07-01T00:00:00.000Z');
  assert.equal(table.last_run_at, '2026-07-31T00:00:00.000Z');
  assert.equal(table.window_days, 30);
  assert.deepEqual(table.challenger_models, ['qwen-3.8-instruct']);
  assert.deepEqual(table.deciding_models, ['gpt-5.4']);
  // compared = 394 + 5 + 1 = 400; agreement = (394 + 4) / 400
  assert.equal(table.rates.decision_agreement, 0.995);
  assert.equal(table.rates.verdict_flip, 0.0025);
  assert.equal(table.rates.parse_failure, 0.0025);
  assert.equal(table.rates.challenger_error, round4(2 / 402));
});

await test('gap table: firm scoping rides the params, fleet view passes only the lane', async () => {
  const scoped = makeMockClient({ aggregates: [], models: [] });
  await computeLaneGapTable({ client: scoped, laneId: LANE, firmId: 'firm-1' });
  assert.ok(scoped.calls.some((c) => c.sql.includes('firm_id = $2') && c.params?.[1] === 'firm-1'));
  const fleet = makeMockClient({ aggregates: [], models: [] });
  await computeLaneGapTable({ client: fleet, laneId: LANE });
  assert.ok(fleet.calls.every((c) => !c.sql.includes('firm_id = $2')));
});

await test('THE EXIT CONDITION: an empty table is red insufficient-data, never green', async () => {
  const table = await computeLaneGapTable({ client: makeMockClient({ aggregates: [], models: [] }), laneId: LANE });
  const gate = evaluateLaneGate({ gapTable: table, goldReport: goldPass, candidateModel: 'qwen-3.8-instruct', qualified: ['gpt-5.4'] });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, true);
  assert.ok(gate.reasons.some((r) => r.code === 'no_runs'));
});

await test('gate: run-count and calendar-window minimums are independent conditions', async () => {
  const thin = await computeLaneGapTable({
    client: makeMockClient({
      aggregates: [{ outcome: 'match', failure_class: null, runs: 50, first_run_at: '2026-07-01T00:00:00Z', last_run_at: '2026-07-02T00:00:00Z' }],
      models: healthyModels
    }),
    laneId: LANE
  });
  const gate = evaluateLaneGate({ gapTable: thin, goldReport: goldPass, candidateModel: 'qwen-3.8-instruct', qualified: ['gpt-5.4'] });
  assert.equal(gate.verdict, 'red');
  assert.equal(gate.insufficient_data, true);
  assert.ok(gate.reasons.some((r) => r.code === 'insufficient_runs'));
  assert.ok(gate.reasons.some((r) => r.code === 'window_too_short'));
});

await test('gate: green on healthy numbers + passing gold run + single named candidate + clean qualified set', async () => {
  const gate = evaluateLaneGate({
    gapTable: await healthyGapTable(),
    goldReport: goldPass,
    candidateModel: 'qwen-3.8-instruct',
    qualified: ['gpt-5.4']
  });
  assert.deepEqual(gate.reasons, []);
  assert.equal(gate.verdict, 'green');
  assert.equal(gate.insufficient_data, false);
});

await test('gate: a verdict-flip rate over threshold is red even on a big healthy window', async () => {
  const flippy = healthyAggregates.map((row) => (row.failure_class === 'verdict_flip' ? { ...row, runs: 6 } : row));
  const table = await computeLaneGapTable({
    client: makeMockClient({ aggregates: flippy, models: healthyModels }),
    laneId: LANE
  });
  const gate = evaluateLaneGate({ gapTable: table, goldReport: goldPass, candidateModel: 'qwen-3.8-instruct', qualified: ['gpt-5.4'] });
  assert.equal(gate.verdict, 'red');
  assert.ok(gate.reasons.some((r) => r.code === 'verdict_flip_rate_above_threshold'));
  assert.equal(gate.insufficient_data, false, 'a threshold breach is a real red, not thin data');
});

await test('gate: mixed candidates in the window, or a candidate the verdict does not name, is red', async () => {
  const mixed = await healthyGapTable({
    models: [
      { challenger_model: 'qwen-3.8-instruct', deciding_model: 'gpt-5.4' },
      { challenger_model: 'qwen-3.9-instruct', deciding_model: 'gpt-5.4' }
    ]
  });
  assert.ok(evaluateLaneGate({ gapTable: mixed, goldReport: goldPass, qualified: ['gpt-5.4'] })
    .reasons.some((r) => r.code === 'mixed_challenger_models'));

  const misnamed = evaluateLaneGate({
    gapTable: await healthyGapTable(),
    goldReport: { ...goldPass, response_models: ['qwen-3.8-instruct'] },
    candidateModel: 'some-other-model',
    qualified: ['gpt-5.4']
  });
  assert.ok(misnamed.reasons.some((r) => r.code === 'candidate_model_mismatch'));
  assert.ok(misnamed.reasons.some((r) => r.code === 'gold_set_model_mismatch'));
});

await test('gate: the deciding-side drift tripwire reads the receipts against the qualified set (the OPENAI_MODEL shape)', async () => {
  const drifted = await healthyGapTable({
    models: [
      { challenger_model: 'qwen-3.8-instruct', deciding_model: 'gpt-5.4' },
      { challenger_model: 'qwen-3.8-instruct', deciding_model: 'gpt-5.4-nano' }
    ]
  });
  const gate = evaluateLaneGate({ gapTable: drifted, goldReport: goldPass, candidateModel: 'qwen-3.8-instruct', qualified: ['gpt-5.4'] });
  assert.equal(gate.verdict, 'red');
  const reason = gate.reasons.find((r) => r.code === 'deciding_model_outside_qualified_set');
  assert.ok(reason && reason.detail.includes('gpt-5.4-nano'));
});

await test('gate: no gold run is red insufficient-data; MUST regressions and a failed gold gate are hard reds', async () => {
  const noGold = evaluateLaneGate({ gapTable: await healthyGapTable(), goldReport: null, qualified: ['gpt-5.4'] });
  assert.equal(noGold.verdict, 'red');
  assert.equal(noGold.insufficient_data, true);
  assert.ok(noGold.reasons.some((r) => r.code === 'no_gold_set_report'
    && r.detail.includes('run_bank_line_disposition_goldset.js')));

  // Q6b: the red reason names the LANE'S OWN runner — the disposition
  // pilot points at its gold set, not B2's.
  const noGoldDisposition = evaluateLaneGate({
    gapTable: { ...(await healthyGapTable()), lane: 'bank_line_disposition' },
    goldReport: null,
    qualified: ['claude-opus-4-8']
  });
  assert.ok(noGoldDisposition.reasons.some((r) => r.code === 'no_gold_set_report'
    && r.detail.includes('run_bank_line_disposition_goldset.js')));

  const regressed = evaluateLaneGate({
    gapTable: await healthyGapTable(),
    goldReport: {
      ...goldPass,
      gate: 'FAIL',
      summary: { must_pass_rate: 0.95, must_regressions: [{ fixture_id: 'restaurant_material', failed: ['evidence_sufficient'] }] }
    },
    qualified: ['gpt-5.4']
  });
  assert.ok(regressed.reasons.some((r) => r.code === 'gold_set_must_regressions' && r.detail.includes('restaurant_material')));
  assert.ok(regressed.reasons.some((r) => r.code === 'gold_set_below_thresholds'));
});

await test('promotion verdict: a written, signable artifact — numbers, links, no flip, empty §9.1 signature', async () => {
  const gapTable = await healthyGapTable();
  const gate = evaluateLaneGate({ gapTable, goldReport: goldPass, candidateModel: 'qwen-3.8-instruct', qualified: ['gpt-5.4'] });
  const verdict = buildPromotionVerdict({
    laneId: LANE,
    candidateModel: 'qwen-3.8-instruct',
    gapTable,
    goldReport: goldPass,
    gate,
    divergenceLinks: { run_ids: ['mcr-1', 'mcr-2'], limit: 200, truncated: false },
    producedAt: '2026-08-12T12:00:00Z'
  });
  assert.equal(verdict.artifact, PROMOTION_VERDICT_ARTIFACT);
  assert.equal(verdict.produced_at, '2026-08-12T12:00:00.000Z');
  assert.deepEqual(verdict.qualified_before, [...getLane(LANE).qualified]);
  assert.equal(verdict.numbers.gap_table.runs, 402);
  assert.equal(verdict.numbers.gold_set.summary.must_pass_rate, 1);
  assert.deepEqual(verdict.divergence_links.run_ids, ['mcr-1', 'mcr-2']);
  assert.equal(verdict.divergence_links.total_non_match, 8);
  assert.equal(verdict.flip.happens_here, false);
  assert.ok(verdict.flip.mechanism.includes('LANE_MODEL_BANK_LINE_DISPOSITION'));
  assert.deepEqual(
    { signed_by: verdict.signature.signed_by, signed_at: verdict.signature.signed_at, decision: verdict.signature.decision },
    { signed_by: null, signed_at: null, decision: null }
  );
});

await test('divergence links: bounded and the bound is declared', async () => {
  const links = await listDivergenceRunIds({
    client: makeMockClient({ divergenceIds: ['a', 'b'] }),
    laneId: LANE,
    limit: 2
  });
  assert.deepEqual(links.run_ids, ['a', 'b']);
  assert.equal(links.truncated, true, 'hitting the limit declares truncation — a capped list never reads as the population');
});

// ── the dormant demotion half ───────────────────────────────────────────

await test('demotion tripwire: thin reverse-shadow samples give no verdict; a breach on a sufficient sample fires', async () => {
  const thin = await computeLaneGapTable({
    client: makeMockClient({
      aggregates: [{ outcome: 'match', failure_class: null, runs: 10, first_run_at: '2026-09-01T00:00:00Z', last_run_at: '2026-09-02T00:00:00Z' }],
      models: healthyModels
    }),
    laneId: LANE
  });
  const armed = evaluateDemotionTripwire({ gapTable: thin });
  assert.deepEqual({ breached: armed.breached, sufficient: armed.sufficient }, { breached: false, sufficient: false });

  const breachedTable = await computeLaneGapTable({
    client: makeMockClient({
      aggregates: [
        { outcome: 'match', failure_class: null, runs: 90, first_run_at: '2026-09-01T00:00:00Z', last_run_at: '2026-09-08T00:00:00Z' },
        { outcome: 'divergence', failure_class: 'verdict_flip', runs: 10, first_run_at: '2026-09-01T00:00:00Z', last_run_at: '2026-09-08T00:00:00Z' }
      ],
      models: healthyModels
    }),
    laneId: LANE
  });
  const breach = evaluateDemotionTripwire({ gapTable: breachedTable });
  assert.equal(breach.sufficient, true);
  assert.equal(breach.breached, true);
  assert.ok(breach.reasons.some((r) => r.code === 'verdict_flip_rate_above_threshold'));
  assert.ok(LANE_GATE_THRESHOLDS[LANE].tripwire_min_runs < LANE_GATE_THRESHOLDS[LANE].min_runs,
    'the tripwire fires on a thinner sample than promotion needs — a breached lane must not keep deciding while a window refills');
});

await test('model-id drift: one drifted deciding receipt on a governed lane is an immediate-demotion signal', () => {
  assert.deepEqual(checkModelIdDrift({ decidingModels: ['gpt-5.4'], qualified: ['gpt-5.4'] }),
    { governed: true, drifted: false, outside: [] });
  assert.deepEqual(checkModelIdDrift({ decidingModels: ['gpt-5.4', 'gpt-5.4-nano'], qualified: ['gpt-5.4'] }),
    { governed: true, drifted: true, outside: ['gpt-5.4-nano'] });
  assert.deepEqual(checkModelIdDrift({ decidingModels: ['anything'], qualified: null }),
    { governed: false, drifted: false, outside: [] }, 'an ungoverned lane (qualified null) cannot drift — there is no law to drift from');
});

await test('demotion verdict: receipted like promotion, automatic, no signature block', () => {
  const verdict = buildDemotionVerdict({
    laneId: LANE,
    trigger: 'model_id_drift',
    details: { outside: ['gpt-5.4-nano'] },
    revertToModel: 'gpt-5.4',
    producedAt: '2026-09-09T00:00:00Z'
  });
  assert.equal(verdict.artifact, DEMOTION_VERDICT_ARTIFACT);
  assert.equal(verdict.automatic, true);
  assert.equal(verdict.revert_to_model, 'gpt-5.4');
  assert.equal(verdict.flip.happens_here, false);
  assert.equal('signature' in verdict, false, 'demotion requires no human (spec §5.3)');
});

await test('dormancy is structural: no production module calls the demotion machinery yet', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { dirname, resolve: resolvePath } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const serverRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
  const walk = (dir, acc = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = resolvePath(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) acc.push(full);
    }
    return acc;
  };
  const importers = walk(serverRoot)
    .filter((file) => !file.endsWith('modelLaneGate.js'))
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('evaluateDemotionTripwire') || source.includes('buildDemotionVerdict');
    });
  assert.deepEqual(importers, [],
    'the demotion machinery is dormant until a flip exists — its production wiring lands in the flip commit, extending this test');
});

await test('registry views: thresholds resolve per lane; the governed-lane view names the pilot', () => {
  assert.ok(laneGateThresholds(LANE));
  assert.ok(laneGateThresholds('bank_line_disposition'), 'the Q6a pilot lane gates');
  assert.equal(laneGateThresholds('unified_extraction'), null, 'a lane without registered thresholds cannot gate — evaluateLaneGate reds on it');
  const governed = gateGovernedLanes();
  assert.deepEqual(governed, [
    // Kari's 20 September approval qualifies the all-desktop default.
    { id: 'jev_reconciliation', qualified: ['jev-1.13.0'], eligible: true },
    // RT-12 (2026-09-02, decision D1): THE load-bearing extraction lane is
    // provider-agnostic; its qualified set is its two providers' strong
    // defaults. No challenger wiring (eligible stays false). Registry order.
    { id: 'unified_extraction', qualified: ['claude-opus-4-8', 'gpt-5.4'], eligible: false },
    // Q7 (2026-08-16): the load-bearing reconciliation lane joined the feed
    // for the Honeybee lab — experiment-seatable cloud 27B, Opus reverse
    // shadow; promotion still needs the signed verdict. Registry order.
    { id: 'reconciliation_reasoning', qualified: ['claude-opus-4-8', 'qwen/qwen3.8-27b'], eligible: true },
    // Q9 (2026-08-16, the sole-model lab): the coding lane joined the feed —
    // experiment-seatable 27B, no challenger wiring (eligible stays false);
    // product-wide promotion still needs the signed verdict.
    // 2026-11-10 (owner's decision: Claude only): claude-opus-5-5 joins as the
    // strong default, gpt-5.4 the alternative; rides the Claude-only verdict.
    // The text lanes and the document lanes join the feed with both strong
    // defaults (registry order). No challenger wiring.
    { id: 'transaction_coding', qualified: ['claude-opus-5-5', 'gpt-5.4', 'qwen/qwen3.8-27b'], eligible: false },
    { id: 'type_extractors_legacy', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'bank_statement_vision', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'document_chat', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'ask_drafting', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'memory_extraction', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'owner_invoice_command_read', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'client_intake_draft', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'marketing_drafting', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'parser_repair', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    // Q6c (2026-08-16): the §9.5 staged candidate joined the disposition
    // lane's qualified set under the model-lab call — experiment-basis
    // policy-selectable; product-wide promotion still needs the signed verdict.
    // Corrected same day: 35B-A3B = hosted small-MoE comparison rung (not a
    // 27B substitute); Qwen3.8-27B-UD-Q4_K_XL = the dense local 27B rung,
    // experiment-admitted only.
    // (bank_line_classification, the B2 pilot, was retired in RT-14, 2026-09-02.)
    { id: 'bank_line_disposition', qualified: ['claude-opus-4-8', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen3.8-27B-UD-Q4_K_XL', 'qwen/qwen3.8-27b'], eligible: true },
    { id: 'document_routing', qualified: ['claude-opus-5-5', 'gpt-5.4'], eligible: false },
    { id: 'receipt_classification', qualified: ['claude-opus-5-5', 'gpt-5.4-nano'], eligible: false }
  ]);
  assert.deepEqual([...getLane(LANE).qualified], ['claude-opus-4-8', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.5-35B-A3B', 'Qwen3.8-27B-UD-Q4_K_XL', 'qwen/qwen3.8-27b']);
});
