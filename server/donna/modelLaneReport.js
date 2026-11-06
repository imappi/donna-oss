// Donna — the descent-ladder report read, slice Q5.
//
// Spec: docs/design-donna-qwen-descent-ladder.md §7 (the settings surface
// shows the ladder honestly) + §8 Q5. PURE OBSERVABILITY: reads the lane
// registry and aggregates the model_challenger_runs receipts — no
// inference, no writer, no challenger import (the boundary keeps the
// harness importable only by named lane-wiring modules; this module does
// its own table-presence check instead of borrowing the harness's).
// Model ids ride FROM THE DATA (challenger->>'model' on each receipt) —
// never from env or code defaults (the model-id-is-the-receipt rail).

import { MODEL_LANES } from './modelLanes.js';
import { listLaneDecidingPolicies } from './modelLanePolicy.js';

// The model lab (Q6c) compares deciding models on the DISPOSITION lane —
// its verdicts persist in reconciliation_evaluations under this family.
// Extend per lane as more lanes join the lab.
const COMPARISON_FAMILY_BY_LANE = Object.freeze({
  bank_line_disposition: 'bank_line_disposition'
});

const emptyStats = () => ({
  runs: 0,
  match: 0,
  divergence: 0,
  challenger_error: 0,
  parse_failure: 0,
  tokens_total: 0,
  last_run_at: null,
  challenger_models: []
});

// { lanes: [...], table_present } — one entry per registry lane, stats
// folded in where receipts exist. A missing migration (or a deploy where
// nothing ever ran) reads as zeros + table_present:false, never an error:
// the surface renders the honest empty state.
export const computeModelLaneReport = async ({ client, firmId }) => {
  const byLane = new Map(MODEL_LANES.map((lane) => [lane.id, emptyStats()]));

  const present = await client.query("select to_regclass('public.model_challenger_runs') as present");
  const tablePresent = Boolean(present.rows[0]?.present);

  if (tablePresent) {
    const aggregates = await client.query(
      `select lane, outcome, count(*)::int as runs,
              coalesce(sum((usage->>'total_tokens')::bigint), 0)::bigint as tokens,
              max(created_at) as last_run_at
         from model_challenger_runs
        where firm_id = $1
        group by lane, outcome`,
      [firmId]
    );
    for (const row of aggregates.rows || []) {
      const stats = byLane.get(row.lane);
      if (!stats) continue; // a receipt for a retired lane id stays queryable, not renderable
      stats.runs += Number(row.runs) || 0;
      if (stats[row.outcome] != null) stats[row.outcome] += Number(row.runs) || 0;
      stats.tokens_total += Number(row.tokens) || 0;
      const at = row.last_run_at ? new Date(row.last_run_at).toISOString() : null;
      if (at && (!stats.last_run_at || at > stats.last_run_at)) stats.last_run_at = at;
    }

    const models = await client.query(
      `select distinct lane, challenger->>'model' as model
         from model_challenger_runs
        where firm_id = $1
          and challenger->>'model' is not null`,
      [firmId]
    );
    for (const row of models.rows || []) {
      const stats = byLane.get(row.lane);
      if (stats && row.model) stats.challenger_models.push(row.model);
    }
    for (const stats of byLane.values()) stats.challenger_models.sort();
  }

  // Q6c — the model lab's two comparison reads, both from persisted rows
  // (never a fresh inference): the ACTIVE policy rows (which qualified
  // model currently decides, on what basis), and per-model evidence — the
  // verdict mix each deciding model produced on this firm's book
  // (reconciliation_evaluations; model ids from the data) plus the
  // deciding-vs-challenger agreement pairs from the shadow receipts.
  const policies = await listLaneDecidingPolicies({ client, firmId });

  const agreementByLane = new Map();
  if (tablePresent) {
    const pairs = await client.query(
      `select lane, deciding->>'model' as deciding_model, challenger->>'model' as challenger_model,
              outcome, count(*)::int as runs
         from model_challenger_runs
        where firm_id = $1
        group by lane, deciding->>'model', challenger->>'model', outcome`,
      [firmId]
    );
    for (const row of pairs.rows || []) {
      if (!agreementByLane.has(row.lane)) agreementByLane.set(row.lane, new Map());
      const key = `${row.deciding_model || '?'}→${row.challenger_model || '?'}`;
      const byPair = agreementByLane.get(row.lane);
      if (!byPair.has(key)) {
        byPair.set(key, {
          deciding_model: row.deciding_model || null,
          challenger_model: row.challenger_model || null,
          runs: 0,
          match: 0,
          divergence: 0,
          parse_failure: 0,
          challenger_error: 0
        });
      }
      const pair = byPair.get(key);
      const runs = Number(row.runs) || 0;
      pair.runs += runs;
      if (pair[row.outcome] != null) pair[row.outcome] += runs;
    }
  }

  const verdictsByLane = new Map();
  const evalsPresent = await client.query("select to_regclass('public.reconciliation_evaluations') as present");
  if (evalsPresent.rows[0]?.present) {
    for (const [laneId, family] of Object.entries(COMPARISON_FAMILY_BY_LANE)) {
      const verdicts = await client.query(
        `select model, payload->>'disposition' as disposition, payload->>'policy_basis' as policy_basis,
                count(*)::int as verdicts
           from reconciliation_evaluations
          where firm_id = $1 and matcher_family = $2
          group by model, payload->>'disposition', payload->>'policy_basis'`,
        [firmId, family]
      );
      const byModel = new Map();
      for (const row of verdicts.rows || []) {
        const model = row.model || 'unknown';
        if (!byModel.has(model)) byModel.set(model, { model, total: 0, policy_basis: null, dispositions: {} });
        const entry = byModel.get(model);
        const n = Number(row.verdicts) || 0;
        entry.total += n;
        if (row.policy_basis) entry.policy_basis = row.policy_basis;
        const d = row.disposition || 'unknown';
        entry.dispositions[d] = (entry.dispositions[d] || 0) + n;
      }
      verdictsByLane.set(laneId, [...byModel.values()].sort((a, b) => b.total - a.total));
    }
  }

  return {
    table_present: tablePresent,
    lanes: MODEL_LANES.map((lane) => ({
      id: lane.id,
      title: lane.title,
      kind: lane.kind,
      endpoint_class: lane.endpointClass,
      challenger: lane.challenger,
      // The model-policy feed (Q6): null = not yet governed; a list = the
      // lane's ALLOWED deciding models. Every surface renders choice only
      // within this set — the model lab's dropdown included; there is no
      // free picker.
      qualified: lane.qualified,
      // Q6c — active policy rows for this lane (firm-wide row first).
      policies: policies.filter((p) => p.lane === lane.id),
      stats: byLane.get(lane.id),
      comparison: {
        verdicts_by_model: verdictsByLane.get(lane.id) || [],
        agreement_pairs: [...(agreementByLane.get(lane.id)?.values() || [])].sort((a, b) => b.runs - a.runs)
      }
    }))
  };
};
