// Local trial authority. Eligibility is deliberately separate from qualification.
import { createHash } from 'node:crypto';
import { readLaneDecidingPolicy, setLaneDecidingPolicy } from './modelLanePolicy.js';

export const JEV_EXPERIMENT_VERSION = 'jev-local-experiment-v1';
export const JEV_EXPERIMENT_LANE = 'jev_reconciliation';
export const experimentDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive = value => Number.isFinite(value) && value > 0;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function freezeJevShadowBudget(budget) {
  if (budget == null) return null;
  const b = structuredClone(budget);
  for (const key of ['max_calls', 'max_input_tokens', 'max_output_tokens']) {
    if (!Number.isSafeInteger(b[key]) || b[key] <= 0) fail('jev_shadow_invalid_budget');
  }
  for (const key of ['approved_usd', 'input_usd_per_million', 'output_usd_per_million']) {
    if (!positive(b[key])) fail('jev_shadow_invalid_budget');
  }
  if (!b.model || !b.approval_basis || !b.price_source || !Array.isArray(b.coverage) || !b.coverage.length
      || b.coverage.some(value => typeof value !== 'string' || !value)
      || !b.versions || typeof b.versions !== 'object' || !Object.keys(b.versions).length) fail('jev_shadow_invalid_budget');
  // Reserve the complete per-call maximum, including failed calls. Token counts
  // at the provider gate admit only 90% of the approved input ceiling.
  const ceiling = b.max_calls * (b.max_input_tokens * b.input_usd_per_million
    + b.max_output_tokens * b.output_usd_per_million) / 1e6;
  if (ceiling > b.approved_usd + 1e-9) fail('jev_shadow_budget_exceeds_approval');
  return { ...b, maximum_usd: ceiling, sha256: experimentDigest(b) };
}

export async function enrollJevExperiment({ client, firmId, clientId, actorId, authorityBasis,
  trialId, expiresAt, model = process.env.TYPESAFE_MODEL, shadow = null, env = process.env,
  manageTransaction = true }) {
  if (!trialId || !authorityBasis || !clientId || !actorId || !Number.isFinite(Date.parse(expiresAt))) fail('jev_experiment_invalid_authority');
  const experiment = { version: JEV_EXPERIMENT_VERSION, trial_id: trialId,
    firm_id: firmId, client_id: clientId, actor_id: actorId, authority_basis: authorityBasis,
    expires_at: new Date(expiresAt).toISOString(), outbound_sends: false, probability_floor: null,
    shadow: freezeJevShadowBudget(shadow) };
  const policy = await setLaneDecidingPolicy({ client, firmId, clientId, laneId: JEV_EXPERIMENT_LANE,
    decidingModel: model, basis: 'experiment', reason: JSON.stringify(experiment),
    actorType: 'firm_member', actorId, manageTransaction, env });
  return { ...policy, client_id: clientId, experiment };
}

export async function readJevExperiment({ client, firmId, clientId, model = process.env.TYPESAFE_MODEL,
  now = new Date() }) {
  const policy = await readLaneDecidingPolicy({ client, firmId, clientId, laneId: JEV_EXPERIMENT_LANE });
  let experiment;
  try { experiment = JSON.parse(policy?.reason); } catch { return null; }
  if (policy?.basis !== 'experiment' || policy.client_id !== clientId || policy.deciding_model !== model
      || experiment?.version !== JEV_EXPERIMENT_VERSION || experiment.firm_id !== firmId
      || experiment.client_id !== clientId || !experiment.actor_id || !experiment.authority_basis
      || experiment.outbound_sends !== false || experiment.probability_floor !== null
      || !(Date.parse(experiment.expires_at) > new Date(now).getTime())) return null;
  const member = await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active'", [firmId, experiment.actor_id]);
  if (!member.rows.length) return null;
  if (experiment.shadow) {
    const { sha256, maximum_usd, ...budget } = experiment.shadow;
    try { if (freezeJevShadowBudget(budget).sha256 !== sha256) return null; } catch { return null; }
  }
  return { ...policy, experiment };
}
