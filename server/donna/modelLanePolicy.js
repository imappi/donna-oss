// Donna — the model-policy feed's persisted half, slice Q6c (descent
// ladder; the model lab).
//
// Spec: docs/design-donna-qwen-descent-ladder.md §5.4 + the §8 Q6c
// addendum. `modelLanes.js` names each governed lane's ALLOWED deciding
// models (the qualified set, code, dated commits); THIS store records
// which of them is currently the lane's deciding model for a (firm[,
// client]) — migration 121. Absence of an active row = the strong default
// decides (fail-closed: an empty table changes nothing anywhere).
//
// A policy row's deciding_model must sit inside the lane's qualified set,
// or the registry's separately declared experimental eligibility. The latter
// requires a client-scoped experiment and active member authority, and never
// qualifies a model for promotion. The settings
// dropdown, the enable script, and any future route all pass through
// here, so model choice can never widen beyond the feed — the free picker
// stays structurally impossible (rejected twice; the dropdown is a
// selector WITHIN the feed, not a picker outside it).
//
// BASIS is the honesty column: 'promotion' rides a signed gate verdict
// (§5.2 — none exist yet); 'experiment' rides a dated Kari call on a lab
// book (2026-08-16: the Honeybee model-lab call). Writers run their own
// transaction: close the prior active row + insert the new one + the
// audit_events receipt, all-or-nothing (audit-as-precondition — no
// receipt, no policy change).

import { randomUUID } from 'node:crypto';

import { getLane } from './modelLanes.js';

export const MODEL_LANE_POLICY_SET_ACTION = 'model_lane.policy_set';
export const MODEL_LANE_POLICY_CLEARED_ACTION = 'model_lane.policy_cleared';

const tablePresent = async (client) => {
  const present = await client.query("select to_regclass('public.model_lane_policy') as present");
  return Boolean(present.rows[0]?.present);
};

// Active policy for (firm, client, lane). A client-specific row overrides
// the firm-wide (client_id null) row — the 042 precedence shape. Missing
// table or no row ⇒ null ⇒ the caller uses the lane's strong default.
export const readLaneDecidingPolicy = async ({ client, firmId, clientId = null, laneId } = {}) => {
  if (!client || !firmId || !laneId) return null;
  if (!(await tablePresent(client))) return null;
  const result = await client.query(
    `select id, client_id, lane, deciding_model, basis, reason, valid_from
       from model_lane_policy
      where firm_id = $1
        and lane = $2
        and valid_to is null
        and (client_id = $3 or client_id is null)
      order by client_id nulls last
      limit 1`,
    [firmId, laneId, clientId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    client_id: row.client_id,
    lane: row.lane,
    deciding_model: row.deciding_model,
    basis: row.basis,
    reason: row.reason,
    valid_from: row.valid_from ? new Date(row.valid_from).toISOString() : null
  };
};

// All active policy rows for a firm (the settings report's read).
export const listLaneDecidingPolicies = async ({ client, firmId } = {}) => {
  if (!client || !firmId) return [];
  if (!(await tablePresent(client))) return [];
  const result = await client.query(
    `select id, client_id, lane, deciding_model, basis, reason, valid_from
       from model_lane_policy
      where firm_id = $1 and valid_to is null
      order by lane, client_id nulls first`,
    [firmId]
  );
  return (result.rows || []).map((row) => ({
    id: row.id,
    client_id: row.client_id,
    lane: row.lane,
    deciding_model: row.deciding_model,
    basis: row.basis,
    reason: row.reason,
    valid_from: row.valid_from ? new Date(row.valid_from).toISOString() : null
  }));
};

const closeActiveRow = async (client, { firmId, clientId, laneId }) => {
  const closed = clientId
    ? await client.query(
      `update model_lane_policy
          set valid_to = now(), updated_at = now()
        where firm_id = $1 and lane = $2 and client_id = $3 and valid_to is null
        returning deciding_model, basis`,
      [firmId, laneId, clientId]
    )
    : await client.query(
      `update model_lane_policy
          set valid_to = now(), updated_at = now()
        where firm_id = $1 and lane = $2 and client_id is null and valid_to is null
        returning deciding_model, basis`,
      [firmId, laneId]
    );
  return closed.rows[0] || null;
};

// Set the lane's deciding model. Throws (typed) on an ungoverned lane or a
// model outside the qualified set — the feed rail. Runs its own
// transaction; the audit receipt commits WITH the policy or neither does.
export const setLaneDecidingPolicy = async ({
  client,
  firmId,
  clientId = null,
  laneId,
  decidingModel,
  basis = 'experiment',
  reason = null,
  actorType = 'system',
  actorId = null,
  manageTransaction = true,
  env = process.env
} = {}) => {
  if (!client || !firmId || !laneId) throw new Error('setLaneDecidingPolicy: client, firmId, laneId are required');
  const lane = getLane(laneId);
  if (!lane) throw Object.assign(new Error(`unknown lane "${laneId}"`), { code: 'UNKNOWN_LANE' });
  const model = typeof decidingModel === 'string' ? decidingModel.trim() : '';
  const experiment = basis === 'experiment' && lane.experimental
    && model && model === String(env[lane.experimental.modelEnvironmentKey] || '').trim();
  if (!Array.isArray(lane.qualified) && !lane.experimental) {
    throw Object.assign(
      new Error(`lane "${laneId}" is not governed by the model-policy feed (qualified is null)`),
      { code: 'LANE_NOT_GOVERNED' }
    );
  }
  if (!lane.qualified?.includes(model) && !experiment) {
    throw Object.assign(
      new Error(`model "${model}" is outside the lane's qualified set [${(lane.qualified || []).join(', ')}] and has no explicit experimental eligibility`),
      { code: 'MODEL_NOT_QUALIFIED' }
    );
  }
  if (!['experiment', 'promotion'].includes(basis)) {
    throw Object.assign(new Error(`unknown basis "${basis}"`), { code: 'UNKNOWN_BASIS' });
  }
  if (experiment && (!clientId || actorType !== 'firm_member' || !actorId || !String(reason || '').trim())) {
    throw Object.assign(new Error('An experimental seat requires a named client, active member and authority reason'), { code: 'EXPERIMENT_AUTHORITY_REQUIRED' });
  }

  const id = randomUUID();
  if (manageTransaction) await client.query('begin');
  try {
    if (experiment) {
      const authority = await client.query(`select m.id from firm_members m
        join clients c on c.firm_id = m.firm_id
        where m.firm_id = $1 and m.id = $2 and m.status = 'active' and c.id = $3
        for share of m, c`, [firmId, actorId, clientId]);
      if (!authority.rows.length) throw Object.assign(new Error('Experimental seat authority is no longer active'), { code: 'EXPERIMENT_AUTHORITY_REQUIRED' });
    }
    const prior = await closeActiveRow(client, { firmId, clientId, laneId });
    await client.query(
      `insert into model_lane_policy
         (id, firm_id, client_id, lane, deciding_model, basis, reason, set_by_actor_type, set_by_actor_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, firmId, clientId, laneId, model, basis, reason, actorType, actorId]
    );
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        firmId,
        clientId,
        actorType,
        actorId,
        MODEL_LANE_POLICY_SET_ACTION,
        'model_lane_policy',
        id,
        JSON.stringify({
          lane: laneId,
          deciding_model: model,
          basis,
          ...(experiment ? { eligibility: 'client_scoped_experiment', authority_basis: 'active_firm_member', globally_qualified: false } : {}),
          reason,
          prior: prior ? { deciding_model: prior.deciding_model, basis: prior.basis } : null
        })
      ]
    );
    if (manageTransaction) await client.query('commit');
  } catch (error) {
    try { if (manageTransaction) await client.query('rollback'); } catch { /* best-effort */ }
    throw error;
  }
  return { id, lane: laneId, deciding_model: model, basis };
};

// Clear the lane's policy — the lane returns to its strong default.
// Receipted like a set; a no-op clear (nothing active) writes no receipt.
export const clearLaneDecidingPolicy = async ({
  client,
  firmId,
  clientId = null,
  laneId,
  reason = null,
  actorType = 'system',
  actorId = null
} = {}) => {
  if (!client || !firmId || !laneId) throw new Error('clearLaneDecidingPolicy: client, firmId, laneId are required');
  await client.query('begin');
  try {
    const prior = await closeActiveRow(client, { firmId, clientId, laneId });
    if (prior) {
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          firmId,
          clientId,
          actorType,
          actorId,
          MODEL_LANE_POLICY_CLEARED_ACTION,
          'model_lane_policy',
          null,
          JSON.stringify({
            lane: laneId,
            reason,
            prior: { deciding_model: prior.deciding_model, basis: prior.basis }
          })
        ]
      );
    }
    await client.query('commit');
    return { cleared: Boolean(prior), prior };
  } catch (error) {
    try { await client.query('rollback'); } catch { /* best-effort */ }
    throw error;
  }
};
