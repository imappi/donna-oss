// Donna — the lane gate, slice Q6 (descent ladder).
//
// Spec: docs/design-donna-qwen-descent-ladder.md §5.2 (promotion), §5.3
// (automatic demotion), §5.4 (the model-policy feed). This module is the
// PROMOTION/DEMOTION ARITHMETIC over the two evidence sources —
//   1. the live GAP TABLE: challenger match rates per lane over a minimum
//      run count AND a minimum calendar window, computed from the
//      model_challenger_runs receipts;
//   2. the GOLD-SET report: the reproducible offline half (per lane —
//      (bankLineGoldSet.js + scripts/run_bank_line_goldset.js for B2 —
//      deleted with the lane in RT-14),
//      bankLineDispositionGoldSet.js +
//      scripts/run_bank_line_disposition_goldset.js for the Q6a pilot).
// — and the builder of the WRITTEN VERDICT ARTIFACT a human signs. WHO
// signs is spec §9.1 (open at Q6): the artifact carries an empty signature
// block and wires NO flip. A flip is a config-plane staged change
// (laneModelFlagKey, spec §6) made in its own commit with the signed
// verdict attached — never an output of this module.
//
// BOUNDARY: like modelLaneReport.js, this is a READ module — no writer, no
// challenger-harness import (the boundary test allowlists importers of
// modelChallenger.js; a report module does its own table-presence check).
// The outcome vocabulary below mirrors migration 116's CHECK constraint.
//
// HONESTY RULE (the slice's exit condition): an absent table, zero runs,
// or a thin window reads as RED with insufficient_data — never green. At
// Q6 there are zero challenger rows anywhere (host, cap, and staging are
// open §9 decisions), so the gate's first real verdict is exactly that.
//
// DORMANCY: the demotion half (reverse-shadow tripwire + model-id drift)
// is machinery for a state that does not exist yet — no lane has flipped.
// Nothing in production calls it; the flip commit wires it. It is built
// and tested now because retrofitting a tripwire after a flip is how a
// breach goes unnoticed.

import { MODEL_LANES, getLane, laneModelFlagKey } from './modelLanes.js';

export const PROMOTION_VERDICT_ARTIFACT = 'donna.lanePromotionVerdict.v1';
export const DEMOTION_VERDICT_ARTIFACT = 'donna.laneDemotionVerdict.v1';

// Per-lane gate thresholds. Conservative on purpose — a flip changes which
// model decides on real books; these numbers move only by a dated call
// (the GOLD_SET_THRESHOLDS precedent). Rates are over COMPARED runs
// (match + divergence + parse_failure); challenger_error is transport
// evidence with its own ceiling and denominator (all runs).
const BANK_LINE_THRESHOLDS = Object.freeze({
  min_runs: 200,
  min_window_days: 14,
  min_decision_agreement_rate: 0.98, // match + format_drift (cosmetic) over compared
  max_verdict_flip_rate: 0.005,
  max_materiality_miss_rate: 0.01,
  max_parse_failure_rate: 0.02,
  max_challenger_error_rate: 0.05,
  // The demotion tripwire fires on a much thinner sample than promotion
  // needs — a breached lane must not get to keep deciding for weeks
  // while the window refills (spec §5.3: automatic, no human).
  tripwire_min_runs: 50
});

export const LANE_GATE_THRESHOLDS = Object.freeze({
  // Q6a (2026-08-13): the disposition pilot gates on the bank-line numbers —
  // same population (bare bank lines), same safety axis. Its gold set is
  // bankLineDispositionGoldSet.js (Q6b, same day). The B2 lane
  // (bank_line_classification) that first carried these thresholds was
  // retired in RT-14 (2026-09-02) with its env-dark sweep.
  bank_line_disposition: BANK_LINE_THRESHOLDS
});

export const laneGateThresholds = (laneId) => LANE_GATE_THRESHOLDS[laneId] || null;

const DIVERGENCE_LINK_LIMIT = 200;

// Per-lane gold-set runner, so a red no_gold_set_report names the right
// command. A gated lane without one gets the generic pointer.
const GOLD_RUNNER_BY_LANE = Object.freeze({
  bank_line_disposition: 'scripts/run_bank_line_disposition_goldset.js'
});

const round = (value) => (value == null ? null : Math.round(value * 10000) / 10000);

// ── The gap table ───────────────────────────────────────────────────────
// firmId null = fleet-wide (the promotion evidence — Donna's R&D view);
// a firm id narrows to that firm's receipts. Model ids ride from the data
// (deciding->>'model' / challenger->>'model'), never from config — which
// is what makes the qualified-set drift check below able to catch a
// silent env override (the OPENAI_MODEL incident's shape).
export const computeLaneGapTable = async ({ client, laneId, firmId = null }) => {
  const empty = {
    lane: laneId,
    table_present: false,
    runs: 0,
    match: 0,
    divergence: 0,
    parse_failure: 0,
    challenger_error: 0,
    by_failure_class: {},
    first_run_at: null,
    last_run_at: null,
    window_days: 0,
    challenger_models: [],
    deciding_models: [],
    rates: {
      decision_agreement: null,
      verdict_flip: null,
      materiality_miss: null,
      parse_failure: null,
      challenger_error: null
    }
  };

  const present = await client.query("select to_regclass('public.model_challenger_runs') as present");
  if (!present.rows[0]?.present) return empty;
  const table = { ...empty, table_present: true };

  const aggregates = firmId
    ? await client.query(
      `select outcome, failure_class, count(*)::int as runs,
              min(created_at) as first_run_at, max(created_at) as last_run_at
         from model_challenger_runs
        where lane = $1 and firm_id = $2
        group by outcome, failure_class`,
      [laneId, firmId]
    )
    : await client.query(
      `select outcome, failure_class, count(*)::int as runs,
              min(created_at) as first_run_at, max(created_at) as last_run_at
         from model_challenger_runs
        where lane = $1
        group by outcome, failure_class`,
      [laneId]
    );

  for (const row of aggregates.rows || []) {
    const runs = Number(row.runs) || 0;
    table.runs += runs;
    if (table[row.outcome] != null) table[row.outcome] += runs;
    if (row.outcome === 'divergence') {
      const cls = row.failure_class || 'unclassified';
      table.by_failure_class[cls] = (table.by_failure_class[cls] || 0) + runs;
    }
    const first = row.first_run_at ? new Date(row.first_run_at).toISOString() : null;
    const last = row.last_run_at ? new Date(row.last_run_at).toISOString() : null;
    if (first && (!table.first_run_at || first < table.first_run_at)) table.first_run_at = first;
    if (last && (!table.last_run_at || last > table.last_run_at)) table.last_run_at = last;
  }
  if (table.first_run_at && table.last_run_at) {
    table.window_days = (new Date(table.last_run_at) - new Date(table.first_run_at)) / 86_400_000;
  }

  const models = firmId
    ? await client.query(
      `select distinct challenger->>'model' as challenger_model, deciding->>'model' as deciding_model
         from model_challenger_runs
        where lane = $1 and firm_id = $2`,
      [laneId, firmId]
    )
    : await client.query(
      `select distinct challenger->>'model' as challenger_model, deciding->>'model' as deciding_model
         from model_challenger_runs
        where lane = $1`,
      [laneId]
    );
  const challengerModels = new Set();
  const decidingModels = new Set();
  for (const row of models.rows || []) {
    if (row.challenger_model) challengerModels.add(row.challenger_model);
    if (row.deciding_model) decidingModels.add(row.deciding_model);
  }
  table.challenger_models = [...challengerModels].sort();
  table.deciding_models = [...decidingModels].sort();

  const compared = table.match + table.divergence + table.parse_failure;
  const formatDrift = table.by_failure_class.format_drift || 0;
  if (compared > 0) {
    table.rates.decision_agreement = round((table.match + formatDrift) / compared);
    table.rates.verdict_flip = round((table.by_failure_class.verdict_flip || 0) / compared);
    table.rates.materiality_miss = round((table.by_failure_class.materiality_miss || 0) / compared);
    table.rates.parse_failure = round(table.parse_failure / compared);
  }
  if (table.runs > 0) table.rates.challenger_error = round(table.challenger_error / table.runs);

  return table;
};

// The verdict's divergence links: run ids only (the receipts store no case
// content; reconstruction goes through the export script). Bounded, and
// the bound is DECLARED next to the totals so a capped list never reads as
// the whole population.
export const listDivergenceRunIds = async ({ client, laneId, firmId = null, limit = DIVERGENCE_LINK_LIMIT }) => {
  const present = await client.query("select to_regclass('public.model_challenger_runs') as present");
  if (!present.rows[0]?.present) return { run_ids: [], limit, truncated: false };
  const rows = firmId
    ? await client.query(
      `select id from model_challenger_runs
        where lane = $1 and firm_id = $2 and outcome in ('divergence', 'parse_failure', 'challenger_error')
        order by created_at desc
        limit $3`,
      [laneId, firmId, Number(limit)]
    )
    : await client.query(
      `select id from model_challenger_runs
        where lane = $1 and outcome in ('divergence', 'parse_failure', 'challenger_error')
        order by created_at desc
        limit $2`,
      [laneId, Number(limit)]
    );
  const runIds = (rows.rows || []).map((row) => row.id);
  return { run_ids: runIds, limit, truncated: runIds.length >= limit };
};

// ── Gate evaluation (promotion direction, spec §5.2) ────────────────────
// gapTable   — computeLaneGapTable output.
// goldReport — the runner's report ({ gate, summary: { must_pass_rate … },
//              gold_set_version, response_models }) or null when no run
//              exists — which is itself a red reason, never a pass.
// candidateModel — the rung under evaluation; the receipts must show
//              exactly this model as the (single) challenger.
// qualified  — the lane's current qualified set (registry), for the
//              deciding-side drift check.
export const evaluateLaneGate = ({
  gapTable,
  goldReport = null,
  candidateModel = null,
  qualified = null,
  thresholds = null
} = {}) => {
  const t = thresholds || laneGateThresholds(gapTable?.lane);
  const reasons = [];
  const insufficient = [];
  const fail = (code, detail) => reasons.push({ code, detail });
  const thin = (code, detail) => { reasons.push({ code, detail }); insufficient.push(code); };

  if (!t) fail('no_thresholds_for_lane', `no gate thresholds are registered for lane "${gapTable?.lane}" — register them in LANE_GATE_THRESHOLDS by a dated call`);

  // Live-evidence sufficiency — an empty table is red, never green.
  if (!gapTable?.table_present) thin('table_absent', 'model_challenger_runs is absent — migration 116 has not run here');
  else if (!gapTable.runs) thin('no_runs', 'zero challenger runs recorded for the lane');
  else if (t) {
    if (gapTable.runs < t.min_runs) thin('insufficient_runs', `${gapTable.runs} runs < min ${t.min_runs}`);
    if (gapTable.window_days < t.min_window_days) thin('window_too_short', `${round(gapTable.window_days)} days < min ${t.min_window_days}`);
  }

  // Live-evidence thresholds.
  if (t && gapTable?.runs) {
    const r = gapTable.rates;
    if (r.decision_agreement != null && r.decision_agreement < t.min_decision_agreement_rate) {
      fail('decision_agreement_below_threshold', `${r.decision_agreement} < ${t.min_decision_agreement_rate}`);
    }
    if (r.verdict_flip != null && r.verdict_flip > t.max_verdict_flip_rate) {
      fail('verdict_flip_rate_above_threshold', `${r.verdict_flip} > ${t.max_verdict_flip_rate}`);
    }
    if (r.materiality_miss != null && r.materiality_miss > t.max_materiality_miss_rate) {
      fail('materiality_miss_rate_above_threshold', `${r.materiality_miss} > ${t.max_materiality_miss_rate}`);
    }
    if (r.parse_failure != null && r.parse_failure > t.max_parse_failure_rate) {
      fail('parse_failure_rate_above_threshold', `${r.parse_failure} > ${t.max_parse_failure_rate}`);
    }
    if (r.challenger_error != null && r.challenger_error > t.max_challenger_error_rate) {
      fail('challenger_error_rate_above_threshold', `${r.challenger_error} > ${t.max_challenger_error_rate}`);
    }
  }

  // Candidate identity: one candidate per window, and it is the one named.
  if (gapTable?.challenger_models?.length > 1) {
    fail('mixed_challenger_models', `the window mixes candidates [${gapTable.challenger_models.join(', ')}] — one candidate's evidence per verdict`);
  }
  if (candidateModel && gapTable?.challenger_models?.length === 1 && gapTable.challenger_models[0] !== candidateModel) {
    fail('candidate_model_mismatch', `receipts show "${gapTable.challenger_models[0]}", verdict names "${candidateModel}"`);
  }

  // Deciding-side drift (the §3.6/§5.3 tripwire shape, read pre-flip): a
  // governed lane whose receipts show a deciding model outside the
  // qualified set is running on an unrecorded model decision.
  if (Array.isArray(qualified) && gapTable?.deciding_models?.length) {
    const outside = gapTable.deciding_models.filter((model) => !qualified.includes(model));
    if (outside.length) {
      fail('deciding_model_outside_qualified_set', `receipts show deciding model(s) [${outside.join(', ')}] outside the qualified set [${qualified.join(', ')}]`);
    }
  }

  // Gold-set half — required, zero MUST regressions, and its own gate met.
  if (!goldReport) {
    const runner = GOLD_RUNNER_BY_LANE[gapTable?.lane] || 'the lane\'s gold-set runner (none registered — see GOLD_RUNNER_BY_LANE)';
    thin('no_gold_set_report', `no gold-set run supplied — run ${runner} against the candidate`);
  }
  else {
    if ((goldReport.summary?.must_pass_rate ?? 0) < 1) {
      fail('gold_set_must_regressions', `must_pass_rate ${goldReport.summary?.must_pass_rate} — MUST classes are zero-tolerance: ${JSON.stringify(goldReport.summary?.must_regressions ?? [])}`);
    }
    if (goldReport.gate !== 'PASS') fail('gold_set_below_thresholds', `gold-set gate is ${goldReport.gate ?? 'absent'}`);
    if (candidateModel && Array.isArray(goldReport.response_models)
      && goldReport.response_models.length
      && !(goldReport.response_models.length === 1 && goldReport.response_models[0] === candidateModel)) {
      fail('gold_set_model_mismatch', `gold run responses came from [${goldReport.response_models.join(', ')}], verdict names "${candidateModel}"`);
    }
  }

  return {
    verdict: reasons.length ? 'red' : 'green',
    insufficient_data: insufficient.length > 0,
    reasons
  };
};

// ── The written promotion verdict (spec §5.2: numbers + divergence links;
// a human signs — §9.1 decides who; NO flip rides in the artifact) ──────
export const buildPromotionVerdict = ({
  laneId,
  candidateModel = null,
  gapTable,
  goldReport = null,
  gate,
  divergenceLinks = { run_ids: [], limit: DIVERGENCE_LINK_LIMIT, truncated: false },
  producedAt = new Date()
} = {}) => {
  const lane = getLane(laneId);
  return {
    artifact: PROMOTION_VERDICT_ARTIFACT,
    produced_at: new Date(producedAt).toISOString(),
    lane: laneId,
    candidate_model: candidateModel,
    qualified_before: lane?.qualified ? [...lane.qualified] : null,
    gate,
    numbers: {
      gap_table: gapTable,
      gold_set: goldReport
        ? {
          gold_set_version: goldReport.gold_set_version ?? null,
          gate: goldReport.gate ?? null,
          response_models: goldReport.response_models ?? null,
          summary: goldReport.summary ?? null
        }
        : null
    },
    divergence_links: {
      ...divergenceLinks,
      total_non_match: (gapTable?.divergence || 0) + (gapTable?.parse_failure || 0) + (gapTable?.challenger_error || 0),
      reconstruct_with: 'node scripts/export_challenger_divergences.js --lane ' + laneId
    },
    flip: {
      happens_here: false,
      mechanism: `config-plane staged change on ${laneModelFlagKey(laneId)} + qualified-set extension in modelLanes.js, one commit, this verdict attached`,
      note: 'A green gate makes this artifact SIGNABLE; the flip itself is a separate, dated, human-signed change (spec §5.2/§6). Nothing auto-flips.'
    },
    signature: {
      signed_by: null,
      signed_at: null,
      decision: null,
      note: 'WHO signs a promotion is spec §9.1 — open at Q6. Unsigned means unactionable.'
    }
  };
};

// ── Automatic demotion (spec §5.3) — DORMANT until a lane flips ─────────
// (a) The reverse-shadow tripwire: post-flip, the FORMER deciding model
// runs as the shadow challenger against the promoted one; the gap table of
// those reverse runs breaching the lane's thresholds reverts the flip. The
// tripwire fires on a thinner sample than promotion needs (tripwire_min_runs)
// and requires no human.
export const evaluateDemotionTripwire = ({ gapTable, thresholds = null } = {}) => {
  const t = thresholds || laneGateThresholds(gapTable?.lane);
  if (!t || !gapTable?.table_present || gapTable.runs < t.tripwire_min_runs) {
    return {
      armed: true,
      breached: false,
      sufficient: false,
      reasons: [],
      note: `tripwire armed; ${gapTable?.runs ?? 0} reverse-shadow runs < ${t?.tripwire_min_runs ?? '?'} — no verdict on a thin sample`
    };
  }
  const reasons = [];
  const r = gapTable.rates;
  if (r.decision_agreement != null && r.decision_agreement < t.min_decision_agreement_rate) {
    reasons.push({ code: 'decision_agreement_below_threshold', detail: `${r.decision_agreement} < ${t.min_decision_agreement_rate}` });
  }
  if (r.verdict_flip != null && r.verdict_flip > t.max_verdict_flip_rate) {
    reasons.push({ code: 'verdict_flip_rate_above_threshold', detail: `${r.verdict_flip} > ${t.max_verdict_flip_rate}` });
  }
  if (r.materiality_miss != null && r.materiality_miss > t.max_materiality_miss_rate) {
    reasons.push({ code: 'materiality_miss_rate_above_threshold', detail: `${r.materiality_miss} > ${t.max_materiality_miss_rate}` });
  }
  return { armed: true, breached: reasons.length > 0, sufficient: true, reasons, note: null };
};

// (b) Provider model-id drift: a deciding receipt whose model id sits
// outside the qualified set demotes IMMEDIATELY — the provider (or an env
// override) changed the model under the lane. No sample minimum: one
// drifted receipt is one unrecorded model decision.
export const checkModelIdDrift = ({ decidingModels = [], qualified = null } = {}) => {
  if (!Array.isArray(qualified)) return { governed: false, drifted: false, outside: [] };
  const outside = decidingModels.filter((model) => model && !qualified.includes(model));
  return { governed: true, drifted: outside.length > 0, outside };
};

// Demotion is receipted like promotion — same artifact discipline, but
// AUTOMATIC (no signature block: §5.3 requires no human; the receipt
// records what fired and what the lane reverts to).
export const buildDemotionVerdict = ({
  laneId,
  trigger, // 'tripwire_breach' | 'model_id_drift'
  details,
  revertToModel = null,
  gapTable = null,
  producedAt = new Date()
} = {}) => ({
  artifact: DEMOTION_VERDICT_ARTIFACT,
  produced_at: new Date(producedAt).toISOString(),
  lane: laneId,
  automatic: true,
  trigger,
  details,
  revert_to_model: revertToModel,
  numbers: { gap_table: gapTable },
  flip: {
    happens_here: false,
    mechanism: `stage revert on ${laneModelFlagKey(laneId)} + qualified-set correction in modelLanes.js, this receipt attached`,
    note: 'Demotion is automatic (spec §5.3) — the wiring that enacts it lands in the flip commit; re-promotion re-runs the gate.'
  }
});

// Fleet view for the gate runner: every lane with a challenger or a
// qualified set, so a gate run also reports lanes it did NOT evaluate.
export const gateGovernedLanes = () => MODEL_LANES
  .filter((lane) => lane.challenger?.eligible || Array.isArray(lane.qualified))
  .map((lane) => ({ id: lane.id, qualified: lane.qualified, eligible: Boolean(lane.challenger?.eligible) }));
