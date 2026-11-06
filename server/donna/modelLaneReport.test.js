import assert from 'node:assert/strict';
import test from 'node:test';

import { computeModelLaneReport } from './modelLaneReport.js';
import { MODEL_LANES, getLane } from './modelLanes.js';

const makeMockClient = ({ tablePresent = true, aggregates = [], models = [] } = {}) => ({
  query: async (sql, params) => {
    if (sql.includes('to_regclass')) return { rows: [{ present: tablePresent ? 'x' : null }] };
    if (sql.includes('group by lane, outcome')) {
      assert.deepEqual(params, ['firm-1'], 'aggregates are firm-scoped');
      return { rows: aggregates };
    }
    if (sql.includes('distinct lane')) return { rows: models };
    return { rows: [] };
  }
});

await test('missing table → every registry lane with zero stats, table_present false — never an error', async () => {
  const report = await computeModelLaneReport({ client: makeMockClient({ tablePresent: false }), firmId: 'firm-1' });
  assert.equal(report.table_present, false);
  assert.equal(report.lanes.length, MODEL_LANES.length);
  const pilot = report.lanes.find((lane) => lane.id === 'bank_line_disposition');
  assert.equal(pilot.challenger.eligible, true);
  assert.deepEqual(pilot.stats.challenger_models, []);
  assert.equal(pilot.stats.runs, 0);
  // Q6: the model-policy feed rides the report — the pilot lane carries its
  // qualified set; ungoverned lanes carry null (never []).
  assert.deepEqual(pilot.qualified, [...getLane('bank_line_disposition').qualified]);
  // RT-12: the unified extraction lane joined the feed (its two providers'
  // strong defaults); bank_statement_vision is still ungoverned.
  const ungoverned = report.lanes.find((lane) => lane.id === 'bank_statement_vision');
  assert.equal(ungoverned.qualified, null);
  assert.deepEqual(report.lanes.find((lane) => lane.id === 'unified_extraction').qualified, ['claude-opus-4-8', 'gpt-5.4']);
});

await test('aggregates fold per outcome; model ids ride from the receipts', async () => {
  const report = await computeModelLaneReport({
    client: makeMockClient({
      aggregates: [
        { lane: 'bank_line_disposition', outcome: 'match', runs: 8, tokens: '1600', last_run_at: '2026-08-12T09:00:00Z' },
        { lane: 'bank_line_disposition', outcome: 'divergence', runs: 2, tokens: '400', last_run_at: '2026-08-12T10:00:00Z' },
        { lane: 'retired_lane_id', outcome: 'match', runs: 5, tokens: '0', last_run_at: null }
      ],
      models: [{ lane: 'bank_line_disposition', model: 'qwen-3.8-served' }]
    }),
    firmId: 'firm-1'
  });
  const pilot = report.lanes.find((lane) => lane.id === 'bank_line_disposition');
  assert.equal(pilot.stats.runs, 10);
  assert.equal(pilot.stats.match, 8);
  assert.equal(pilot.stats.divergence, 2);
  assert.equal(pilot.stats.tokens_total, 2000);
  assert.equal(pilot.stats.last_run_at, '2026-08-12T10:00:00.000Z');
  assert.deepEqual(pilot.stats.challenger_models, ['qwen-3.8-served']);
  assert.ok(!report.lanes.some((lane) => lane.id === 'retired_lane_id'),
    'a receipt for a lane the registry no longer carries is not rendered (still queryable in the table)');
});
// ── Q6c — the model lab: policies + the comparison reads ride the report ──
await test('Q6c — active policies, per-model verdict mix, and agreement pairs fold into the lane entry', async () => {
  const client = {
    query: async (sql, params) => {
      if (sql.includes("to_regclass('public.model_challenger_runs')")) return { rows: [{ present: 'x' }] };
      if (sql.includes("to_regclass('public.model_lane_policy')")) return { rows: [{ present: 'x' }] };
      if (sql.includes("to_regclass('public.reconciliation_evaluations')")) return { rows: [{ present: 'x' }] };
      if (sql.includes('group by lane, outcome')) return { rows: [] };
      if (sql.includes('distinct lane')) return { rows: [] };
      if (sql.includes('from model_lane_policy')) {
        return { rows: [{ id: 'p1', client_id: null, lane: 'bank_line_disposition', deciding_model: 'Qwen/Qwen3.5-397B-A17B', basis: 'experiment', reason: 'model lab', valid_from: '2026-08-16T00:00:00Z' }] };
      }
      if (sql.includes("group by lane, deciding->>'model'")) {
        return {
          rows: [
            { lane: 'bank_line_disposition', deciding_model: 'Qwen/Qwen3.5-397B-A17B', challenger_model: 'claude-opus-4-8', outcome: 'match', runs: 18 },
            { lane: 'bank_line_disposition', deciding_model: 'Qwen/Qwen3.5-397B-A17B', challenger_model: 'claude-opus-4-8', outcome: 'divergence', runs: 2 }
          ]
        };
      }
      if (sql.includes('from reconciliation_evaluations')) {
        assert.deepEqual(params, ['firm-1', 'bank_line_disposition'], 'verdict mix is family-scoped');
        return {
          rows: [
            { model: 'claude-opus-4-8', disposition: 'auto_explain', policy_basis: null, verdicts: 30 },
            { model: 'claude-opus-4-8', disposition: 'needs_human', policy_basis: null, verdicts: 12 },
            { model: 'qwen-served', disposition: 'auto_explain', policy_basis: 'experiment', verdicts: 25 },
            { model: 'qwen-served', disposition: 'needs_human', policy_basis: 'experiment', verdicts: 20 }
          ]
        };
      }
      return { rows: [] };
    }
  };
  const report = await computeModelLaneReport({ client, firmId: 'firm-1' });
  const lane = report.lanes.find((l) => l.id === 'bank_line_disposition');

  assert.equal(lane.policies.length, 1);
  assert.equal(lane.policies[0].deciding_model, 'Qwen/Qwen3.5-397B-A17B');
  assert.equal(lane.policies[0].basis, 'experiment');

  const byModel = Object.fromEntries(lane.comparison.verdicts_by_model.map((v) => [v.model, v]));
  assert.equal(byModel['claude-opus-4-8'].total, 42);
  assert.equal(byModel['claude-opus-4-8'].dispositions.auto_explain, 30);
  assert.equal(byModel['qwen-served'].policy_basis, 'experiment', 'experiment rows are sliceable per model');

  assert.equal(lane.comparison.agreement_pairs.length, 1);
  const pair = lane.comparison.agreement_pairs[0];
  assert.equal(pair.deciding_model, 'Qwen/Qwen3.5-397B-A17B');
  assert.equal(pair.challenger_model, 'claude-opus-4-8');
  assert.equal(pair.runs, 20);
  assert.equal(pair.match, 18);
  assert.equal(pair.divergence, 2);

  // Lanes outside the lab carry the empty comparison shape, never undefined.
  const other = report.lanes.find((l) => l.id === 'reconciliation_triage');
  assert.deepEqual(other.comparison, { verdicts_by_model: [], agreement_pairs: [] });
});
