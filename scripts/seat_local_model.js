// Seat a model of your own choosing — served by your own OpenAI-compatible
// endpoint (llama.cpp's llama-server, Ollama, vLLM, …) — as ONE named
// company's deciding model, lane by lane or on every lane that can take it.
// And the inverse (--clear).
//
// THE OWNER'S DECISION (2026-11-10, modelLanes.js SELF_HOSTED_DECISION): an
// explicit opt-in, never the default. The seated model is UNQUALIFIED: Donna
// has not measured it; every receipt, the lane banner, Host A's lane
// inventory and the settings screen say so; it never counts as qualified or
// as promotion evidence. It changes who decides, never what the checks
// require.
//
// WHAT THIS DOES:
//  - Writes through the one policy writer (modelLanePolicy.js
//    setLaneDecidingPolicy, basis 'self_hosted_unqualified'): a client row,
//    an active firm member, a reason, the audit receipt in the same
//    transaction. The writer refuses a qualified model id, a cloud family id
//    (claude-*, gpt-*), a lane that cannot take one, a firm-wide seat.
//  - Before writing, asks the endpoint which models it serves (GET /models)
//    and refuses when the seat's id is not among them — so the receipt's
//    model id is the one the server answers with, and a server that would
//    answer as another model is caught here, not mid-book.
//  - Prints THE PLAN: every lane for this company, and where it runs — the
//    seated lanes, the lanes that stay on a cloud provider (the complete list
//    of what still leaves this machine about this company, by provider), and
//    the lanes that are dark.
//
// The environment supplies ONLY the endpoint and its key
// (OPENAI_COMPATIBLE_BASE_URL, OPENAI_COMPATIBLE_API_KEY — no key needed for
// a loopback address). Setting them changes no deciding model; only this
// command's seat row does.
//
// SAFETY: dry-run by default (prints the plan and the probe, writes nothing).
// --apply to write. --clear removes this company's self-hosted seats (only
// self-hosted ones; a lab or promotion row is never touched here).
//
// USAGE:
//   node scripts/seat_local_model.js --firm F --client C --member M \
//     --model qwen2.5-7b-instruct --all --reason "own server" [--apply]
//   node scripts/seat_local_model.js --firm F --client C --member M \
//     --model qwen2.5-7b-instruct --lanes transaction_coding,ask_drafting --reason "…" --apply
//   node scripts/seat_local_model.js --firm F --client C --member M --clear --reason "…" --apply

import { withFirmDbClient, getFirmDatabaseUrl } from '../server/donna/firmDb.js';
import {
  clearLaneDecidingPolicy,
  listLaneDecidingPolicies,
  setLaneDecidingPolicy
} from '../server/donna/modelLanePolicy.js';
import { SELF_HOSTED_BASIS, getLane, isQualifiedAnywhere, selfHostedLanes } from '../server/donna/modelLanes.js';
import { inferProviderFromModel, resolveOpenAiCompatibleEndpoint } from '../server/donna/providerEndpoints.js';
import { buildSelfHostedLanePlan } from '../server/donna/selfHostedPlan.js';
import { jevDispositionEnabled } from '../server/donna/jevDisposition.js';

export const parseArgv = (argv = process.argv.slice(2)) => {
  const out = { apply: false, clear: false, all: false, lanes: [], firmId: null, clientId: null, memberId: null, model: null, reason: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i]; };
    if (a === '--apply') out.apply = true;
    else if (a === '--clear') out.clear = true;
    else if (a === '--all') out.all = true;
    else if (a === '--lanes') out.lanes = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--firm') out.firmId = next();
    else if (a === '--client') out.clientId = next();
    else if (a === '--member') out.memberId = next();
    else if (a === '--model') out.model = next();
    else if (a === '--reason') out.reason = next();
  }
  return out;
};

// Pure: which lanes the request names, and every refusal the writer would
// give, before anything is written.
export const buildLocalSeatRequest = ({ opts, lanes = undefined } = {}) => {
  const errors = [];
  const offered = selfHostedLanes(lanes).map((lane) => lane.id);
  if (!opts.firmId) errors.push('--firm is required');
  if (!opts.clientId) errors.push('--client is required (a self-hosted seat is for one named company)');
  if (!opts.memberId) errors.push('--member is required (an active firm member sets the seat)');
  if (!String(opts.reason || '').trim()) errors.push('--reason is required');
  let requested = opts.all ? offered : opts.lanes;
  if (!opts.clear && !requested.length) errors.push(`name --lanes or --all (lanes that can take a local model: ${offered.join(', ')})`);
  if (opts.clear && !requested.length) requested = offered;
  for (const id of requested) {
    const lane = getLane(id);
    if (!lane) errors.push(`unknown lane "${id}"`);
    else if (!lane.selfHosted) errors.push(`lane "${id}" cannot take a local model`);
  }
  if (!opts.clear) {
    const model = String(opts.model || '').trim();
    if (!model) errors.push('--model is required: the id your endpoint serves');
    else if (isQualifiedAnywhere(model)) errors.push(`"${model}" is a qualified model id; a local seat names an unqualified model`);
    else if (inferProviderFromModel(model)) errors.push(`"${model}" names a cloud provider's model family; name the local model`);
  }
  return { lanes: requested, offered, errors, ok: errors.length === 0 };
};

// Ask the endpoint which models it serves. Returns { ok, models, error }.
export const probeServedModels = async ({ env = process.env, fetchImpl = fetch } = {}) => {
  let endpoint;
  try {
    endpoint = resolveOpenAiCompatibleEndpoint({ env });
  } catch (error) {
    return { ok: false, models: [], error: error.message };
  }
  const url = endpoint.url.replace(/\/chat\/completions$/, '/models');
  try {
    const response = await fetchImpl(url, { headers: endpoint.headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return { ok: false, models: [], error: `GET /models answered ${response.status}` };
    const payload = await response.json();
    const models = (Array.isArray(payload?.data) ? payload.data : []).map((entry) => entry?.id).filter((id) => typeof id === 'string');
    return { ok: true, models, error: null };
  } catch (error) {
    return { ok: false, models: [], error: error?.message || String(error) };
  }
};

export const formatPlan = (plan) => {
  const lines = [];
  lines.push('THE PLAN for this company:');
  for (const row of plan.rows) {
    if (row.where === 'self_hosted') {
      lines.push(`  SEATED (UNQUALIFIED, your endpoint)  ${row.lane} — ${row.covers.join('; ')}`);
      if (row.warning) lines.push(`    NOTE: ${row.warning}`);
    }
  }
  for (const row of plan.rows) {
    if (row.where.startsWith('cloud:')) lines.push(`  stays on ${row.where.slice(6).padEnd(9)} ${row.lane} — ${row.reason}`);
  }
  for (const row of plan.rows) {
    if (row.where === 'dark') lines.push(`  DARK (no key)        ${row.lane} — ${row.reason}`);
  }
  lines.push(`WHAT STILL GOES TO A CLOUD MODEL PROVIDER about this company: ${plan.cloud.length ? plan.cloud.map((c) => `${c.lane} → ${c.provider}`).join(', ') : 'nothing'}.`);
  lines.push('Not a model call, still off this machine: the coder fetches a merchant\'s own website (https://<domain>) when a line names one.');
  lines.push('On a seated lane: no reverse shadow, no challenger; no other model is called, and a failed answer is a typed failure, never a substitute.');
  return lines.join('\n');
};

const log = (...args) => console.log('[seat-local-model]', ...args);

export const run = async (opts, { env = process.env, fetchImpl = fetch, withClient = withFirmDbClient } = {}) => {
  const request = buildLocalSeatRequest({ opts });
  if (!request.ok) {
    for (const error of request.errors) log(`REFUSED: ${error}`);
    return { applied: false, refused: request.errors };
  }
  const seatedAfter = opts.clear ? [] : request.lanes;
  // Read-only: whether the company's Typesafe lane acts (it decides
  // disposition before any seat). Unknown when the read fails.
  let jevOn = null;
  try {
    jevOn = await withClient((client) => jevDispositionEnabled(client, opts.firmId, opts.clientId));
  } catch { jevOn = null; }
  const plan = buildSelfHostedLanePlan({ seatedLanes: seatedAfter, env, jevOn });
  if (jevOn === null) log('NOTE: could not read whether the Typesafe lane (JEV_RECONCILIATION) is on for this company; if it is, it decides disposition before the seat.');
  log(`firm=${opts.firmId} company=${opts.clientId} ${opts.clear ? 'CLEAR self-hosted seats' : `model=${opts.model} basis=${SELF_HOSTED_BASIS}`}`);
  console.log(formatPlan(plan));

  if (!opts.clear) {
    const probe = await probeServedModels({ env, fetchImpl });
    if (!probe.ok) {
      log(`REFUSED: the endpoint did not answer GET /models (${probe.error}). Start it, or set OPENAI_COMPATIBLE_BASE_URL.`);
      return { applied: false, refused: ['endpoint_unreachable'], plan };
    }
    if (!probe.models.includes(opts.model)) {
      log(`REFUSED: the endpoint serves [${probe.models.join(', ') || 'nothing'}], not "${opts.model}". Seat the id it answers with.`);
      return { applied: false, refused: ['model_not_served'], plan, served: probe.models };
    }
    log(`endpoint serves "${opts.model}" — OK`);
  }
  if (!opts.apply) {
    log('DRY-RUN — nothing written. Re-run with --apply.');
    return { applied: false, plan };
  }
  const results = [];
  const proposedRulesLeft = [];
  await withClient(async (client) => {
    if (opts.clear) {
      const active = await listLaneDecidingPolicies({ client, firmId: opts.firmId });
      const clearedPolicyIds = [];
      for (const laneId of request.lanes) {
        const row = active.find((p) => p.lane === laneId && p.client_id === opts.clientId);
        if (!row || row.basis !== SELF_HOSTED_BASIS) continue; // never clears a lab or promotion row
        clearedPolicyIds.push(row.id);
        const result = await clearLaneDecidingPolicy({
          client, firmId: opts.firmId, clientId: opts.clientId, laneId,
          reason: opts.reason, actorType: 'firm_member', actorId: opts.memberId
        });
        log(`CLEARED: ${laneId} (was ${row.deciding_model}) — back to the firm-wide policy or the default`);
        results.push({ laneId, ...result });
      }
      // What the cleared seats left behind: merchant rules they PROPOSED that
      // still wait for a person. Listed, never deleted or retired here — a
      // proposal decides nothing until a person activates it, and retiring
      // one is that person's call (PATCH /client-rules/{id}).
      const left = clearedPolicyIds.length
        ? await client.query(
          `select id, pattern_text, account_code, payload->'proposed_by'->>'model' as model
             from client_rules
            where firm_id = $1 and client_id = $2 and status = 'proposed'
              and payload->'proposed_by'->>'policy_id' = any($3::text[])
            order by pattern_text, id`,
          [opts.firmId, opts.clientId, clearedPolicyIds]
        )
        : { rows: [] };
      proposedRulesLeft.push(...left.rows);
      for (const rule of left.rows) {
        log(`PROPOSED RULE LEFT BY THE SEAT (not active; review or discard it): ${rule.id} ${rule.pattern_text} -> ${rule.account_code} (proposed by ${rule.model || 'unknown model'})`);
      }
      if (clearedPolicyIds.length && !left.rows.length) log('no proposed rule left by the cleared seats');
      return;
    }
    for (const laneId of request.lanes) {
      const result = await setLaneDecidingPolicy({
        client, firmId: opts.firmId, clientId: opts.clientId, laneId,
        decidingModel: opts.model, basis: SELF_HOSTED_BASIS,
        reason: opts.reason, actorType: 'firm_member', actorId: opts.memberId
      });
      log(`SEATED (UNQUALIFIED): ${laneId} → ${opts.model}`);
      results.push(result);
    }
  });
  return { applied: true, plan, results, ...(opts.clear ? { proposed_rules_left: proposedRulesLeft } : {}) };
};

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seat_local_model.js');
if (invokedDirectly) {
  const opts = parseArgv();
  if (!getFirmDatabaseUrl()) {
    console.error('[seat-local-model] FAILED: no database URL. Set DATABASE_URL (or POSTGRES_URL / SUPABASE_DB_URL).');
    process.exit(1);
  }
  run(opts)
    .then((r) => process.exit(r.applied || (!opts.apply && !r.refused) ? 0 : 1))
    .catch((err) => { console.error('[seat-local-model] FAILED', err?.code || '', err?.message || err); process.exit(1); });
}
