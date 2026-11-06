// Donna — the shadow-challenger harness, slice Q2 (descent ladder).
//
// Spec: docs/design-donna-qwen-descent-ladder.md §3. Every live case decided
// by a lane's qualified model can also run — async, post-commit, no-throw,
// receipt-only — through the current rung's candidate model. The DIVERGENCE
// is the product of the run. This module is the harness only: gates,
// sampling, the cost cap, comparison, and the receipt write. It owns NO
// transport (the seam supplies `callChallenger` at wiring time, Q4) and NO
// lane wiring (no lane is challenger-eligible at Q2 — the registry pins
// that).
//
// THE SHADOW CONTRACT (the feedChatProposalShadow / loopsShadowProducers
// shape, conformed to rather than invented):
//   - dispatched POST-COMMIT: by the time this runs, the deciding call's
//     result is consumed and its transaction committed; nothing here can
//     delay, reorder, or alter a live decision;
//   - runs on its OWN connection (withClient, injected) in its own
//     transaction-less insert;
//   - NO-THROW BY CONTRACT: every failure is swallowed into a warn log; the
//     caller's flow is unaffected whether the challenger ran, failed, or
//     was skipped;
//   - table-presence guarded: a deploy without migration 116 is a silent
//     no-op, not an error.
//
// EVIDENCE-ONLY, STRUCTURALLY: this module imports no writer — no firmDb
// mutation surface, no proposalStore, no memory mint, no ask pipeline, no
// ledger path — and its return value is null or a receipt id the caller is
// expected to ignore. Pinned by modelChallenger.boundary.test.js.
//
// COST OWNERSHIP: challenger tokens are Donna's R&D spend, never the
// customer's meter. The cap is FAIL-CLOSED: no configured cap ⇒ no
// dispatch. Cap amounts are Kari's call (spec §9.2) and arrive as
// configuration before Q4 stages the first pilot client.

import crypto from 'node:crypto';

import { clientFlagObserves } from './clientConfig.js';
import { getLane } from './modelLanes.js';

// Config-plane flag (the rollout-flags rail): observe-only behaviour, so it
// gates on stageObserves via clientFlagObserves — shadow/canary/auto observe;
// off/dry_run do not (the LOOPS_SHADOW_RISK_CONTEXT precedent). Dark
// everywhere until a client is explicitly staged.
export const MODEL_CHALLENGER_FLAG_KEY = 'MODEL_CHALLENGER';

// The compatible rung's two dispatch knobs (spec §9.2/§9.5, decided
// 2026-08-12), shared by every lane's challenger wiring. Lived in the B2
// wiring module (bankLineChallenger.js) until RT-14 retired that lane; the
// env names are unchanged — model ids and tuning caps are legitimate env
// per the flags rail.
//   OPENAI_COMPATIBLE_MODEL      the rung's candidate model id
//   MODEL_CHALLENGER_CAP_TOKENS  per-client monthly token cap (the AMOUNT is
//                                Kari's §9.2 call)
export const CHALLENGER_MODEL_ENV = 'OPENAI_COMPATIBLE_MODEL';
export const CHALLENGER_CAP_ENV = 'MODEL_CHALLENGER_CAP_TOKENS';

// Cheap pre-check so a sweep can skip the per-client snapshot read when the
// forward challenger cannot possibly run: the endpoint pair
// (OPENAI_COMPATIBLE_BASE_URL / _API_KEY, Q3) plus the two knobs above. Any
// of the four absent ⇒ nothing dispatches — fail-closed three times over
// (env, flag, cap).
export const challengerEndpointConfigured = (env = process.env) => Boolean(
  String(env.OPENAI_COMPATIBLE_BASE_URL || '').trim()
  && String(env.OPENAI_COMPATIBLE_API_KEY || '').trim()
  && String(env[CHALLENGER_MODEL_ENV] || '').trim()
  && Number(env[CHALLENGER_CAP_ENV]) > 0
);

export const modelChallengerObserves = ({ snapshot = null, env = process.env } = {}) =>
  clientFlagObserves({ flagKey: MODEL_CHALLENGER_FLAG_KEY, snapshot, envFallback: () => false, env });

// One row per run; the outcome vocabulary is CHECK-pinned by migration 116.
export const CHALLENGER_OUTCOMES = Object.freeze([
  'match',
  'divergence',
  'challenger_error',
  'parse_failure'
]);

// The lane × failure-class taxonomy (spec §4.1). First vocabulary — extended
// by evidence, not speculation. `policy_mismatch` is the env-override
// tripwire: artifact-as-ran ≠ artifact-as-qualified is a divergence
// regardless of content.
export const CHALLENGER_FAILURE_CLASSES = Object.freeze([
  'schema_invalid',
  'verdict_flip',
  'amount_error',
  'direction_error',
  'materiality_miss',
  'omission',
  'fabrication',
  'format_drift',
  'refusal_or_timeout',
  'policy_mismatch'
]);

export const challengerTablePresent = async (client) => {
  if (!client) return false;
  const present = await client.query("select to_regclass('public.model_challenger_runs') as present");
  return Boolean(present.rows[0]?.present);
};

// The month key the spend ledger sums under — UTC, YYYY-MM — and its
// half-open UTC range [start, end). A range compare (rather than a
// to_char over created_at) keeps the sum on the spend index.
export const spendMonthKey = (date = new Date()) => date.toISOString().slice(0, 7);

export const spendMonthRange = (month) => {
  const [year, monthNumber] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const end = new Date(Date.UTC(year, monthNumber, 1));
  return { start: start.toISOString(), end: end.toISOString() };
};

// Sum of challenger tokens already spent for (firm, client) in the given
// month. Reads the receipts themselves — no separate metering store.
export const monthTokenSpend = async (client, { firmId, clientId, month = spendMonthKey() } = {}) => {
  const { start, end } = spendMonthRange(month);
  const res = await client.query(
    `select coalesce(sum((usage->>'total_tokens')::bigint), 0) as spent
       from model_challenger_runs
      where firm_id = $1
        and client_id = $2
        and created_at >= $3
        and created_at < $4`,
    [firmId, clientId, start, end]
  );
  return Number(res.rows[0]?.spent || 0);
};

// The §23.3-shape model_artifact for a hosted-API challenger. Fields a
// hosted provider cannot attest are EXPLICITLY null — never fabricated
// (spec §3.6). Field vocabulary mirrors world/traceReceipts.js
// MODEL_ARTIFACT_FIELDS; sync is pinned by test (the world boundary forbids
// the import, same resolution as providerEndpoints.js).
export const buildChallengerModelArtifact = ({
  provider = null,
  model = null,
  modelSource = null,
  runtime = 'hosted_api'
} = {}) => ({
  provider,
  base_model_id: model,
  base_model_digest: null,
  adapter_id: null,
  adapter_digest: null,
  quantization: null,
  runtime,
  runtime_version: null,
  vision_projector_digest: null,
  tool_protocol_version: null,
  prompt_snapshot_id: null,
  retrieval_snapshot_id: null,
  routing_snapshot_id: null,
  hardware_profile: null,
  execution_mode: 'hosted_api',
  model_id_source: modelSource,
  network_egress: 'external_api',
  fallback_occurred: modelSource !== 'response_proven'
});

// Default comparator: structural equality on the parsed results, model
// provenance keys excluded (they differ by construction). It can say MATCH
// or DIVERGENCE; it deliberately does NOT guess a failure class — that
// classification is lane-specific and arrives with each lane's comparator
// at wiring time (Q4+). Retention posture: the summary carries KEY NAMES
// only, never values.
const stripProvenance = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { model, model_source, ...rest } = value;
  return rest;
};

export const defaultComparator = ({ decidingResult, challengerResult } = {}) => {
  const a = stripProvenance(decidingResult);
  const b = stripProvenance(challengerResult);
  if (JSON.stringify(a) === JSON.stringify(b)) return { outcome: 'match', failure_class: null, summary: null };
  const keysA = a && typeof a === 'object' ? Object.keys(a) : [];
  const keysB = b && typeof b === 'object' ? Object.keys(b) : [];
  const differing = [...new Set([...keysA, ...keysB])]
    .filter((key) => JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key]))
    .sort();
  return {
    outcome: 'divergence',
    failure_class: null,
    summary: { differing_keys: differing }
  };
};

let warnedMissingChallengerTable = false;

// ── The dispatcher ──────────────────────────────────────────────────────
// Called by the SEAM (never by a lane or route directly — the boundary test
// pins the importer set) after a deciding call on a challenger-eligible
// lane has returned and committed. Returns { run_id } when a receipt was
// written, null in EVERY other case — skipped, capped, dark, failed.
//
//   laneId            — modelLanes registry id; the lane must be
//                       challenger-eligible or the dispatch is a no-op.
//   snapshot          — the client's config snapshot (readClientConfigSnapshot
//                       shape) for the flag gate.
//   decidingResult    — the parsed result the deciding model produced.
//   decidingModel     — { model, model_source } as stamped by the deciding
//                       call (response-sourced provenance).
//   execution         — { root: { type, id } }, the llmCall rail-3 ref.
//   callChallenger    — async () => ({ result, telemetry }) — the seam-owned
//                       transport for the rung's candidate. This harness
//                       never builds a request itself.
//   capTokensPerClientMonth — REQUIRED to dispatch; absent/invalid ⇒ no-op
//                       (fail-closed — spec §3.3, amounts are Kari's §9.2).
//   comparator        — lane comparator; defaultComparator when absent.
//   sample            — () => boolean; sampling hook (lane fraction applied
//                       by the seam; injectable for tests).
//   withClient        — connection injector (the shadow-contract seam).
export const dispatchChallengerRun = async ({
  firmId,
  clientId,
  laneId,
  snapshot = null,
  decidingResult,
  decidingModel = null,
  execution = null,
  callChallenger,
  capTokensPerClientMonth = null,
  comparator = defaultComparator,
  sample = () => true,
  withClient,
  env = process.env,
  now = () => new Date(),
  // Injectable for tests ONLY — production callers always take the registry
  // default, so eligibility remains the registry's single say.
  laneResolver = getLane
} = {}) => {
  try {
    if (!firmId || !clientId || !laneId || typeof withClient !== 'function') return null;
    if (typeof callChallenger !== 'function') return null;
    const rootType = execution?.root?.type;
    const rootId = execution?.root?.id;
    if (!rootType || !rootId) return null;

    // Gate 1 — the lane must exist and be challenger-eligible (registry).
    const lane = laneResolver(laneId);
    if (!lane || !lane.challenger?.eligible) return null;

    // Gate 2 — the config-plane flag (observe-only; dark by default).
    if (!modelChallengerObserves({ snapshot, env })) return null;

    // Gate 3 — sampling.
    if (!sample()) return null;

    // Gate 4 — the cost cap, fail-closed: no configured cap ⇒ no dispatch.
    const cap = Number(capTokensPerClientMonth);
    if (!Number.isFinite(cap) || cap <= 0) return null;

    return await withClient(async (client) => {
      if (!(await challengerTablePresent(client))) {
        if (!warnedMissingChallengerTable) {
          warnedMissingChallengerTable = true;
          console.warn('[model-challenger] staged but migration 116 (model_challenger_runs) is absent — challenger capture is skipped until db:migrate runs');
        }
        return null;
      }

      const month = spendMonthKey(now());
      const spent = await monthTokenSpend(client, { firmId, clientId, month });
      if (spent >= cap) return null;

      // The challenger call — outside any transaction (it is a network
      // call), after every gate. A throw here is caught below and
      // receipted as challenger_error, because "the candidate failed on
      // this case" is itself evidence.
      let challengerResult = null;
      let telemetry = null;
      let outcome = null;
      let failureClass = null;
      let summary = null;
      try {
        ({ result: challengerResult, telemetry = null } = await callChallenger() || {});
        const verdict = comparator({ decidingResult, challengerResult }) || {};
        outcome = CHALLENGER_OUTCOMES.includes(verdict.outcome) ? verdict.outcome : 'parse_failure';
        failureClass = verdict.failure_class ?? null;
        summary = verdict.summary ?? null;
      } catch (error) {
        outcome = 'challenger_error';
        summary = { error: String(error?.message || error).slice(0, 500) };
      }

      const challengerModel = telemetry?.model ?? null;
      const challengerSource = telemetry?.model_source === 'response' || telemetry?.model_source === 'response_proven'
        ? 'response_proven'
        : 'configured_fallback';

      const runId = `mcr-${crypto.randomUUID()}`;
      await client.query(
        `insert into model_challenger_runs
           (id, firm_id, client_id, lane, root_execution_type, root_execution_id,
            deciding, challenger, outcome, failure_class, divergence_summary, usage)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          runId, firmId, clientId, laneId, rootType, String(rootId),
          JSON.stringify({
            model: decidingModel?.model ?? null,
            model_source: decidingModel?.model_source ?? null
          }),
          JSON.stringify({
            model: challengerModel,
            model_source: challengerSource,
            model_artifact: buildChallengerModelArtifact({
              provider: telemetry?.provider ?? null,
              model: challengerModel,
              modelSource: challengerSource
            })
          }),
          outcome, failureClass,
          summary == null ? null : JSON.stringify(summary),
          telemetry?.usage == null ? null : JSON.stringify(telemetry.usage)
        ]
      );
      return { run_id: runId };
    });
  } catch (error) {
    try {
      // Observable but ids-only — never case content (the retention posture).
      console.warn(
        '[model-challenger] dispatch swallowed error '
        + `(firm=${firmId} client=${clientId} lane=${laneId}): ${error?.message || error}`
      );
    } catch { /* never throw from the logger */ }
    return null;
  }
};
