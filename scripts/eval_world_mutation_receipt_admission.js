import { grantRowAllowsAutoAccept } from '../server/donna/reconciliationAuthorityGrants.js';

export const MUTATION_RECEIPT_ADMISSION_VERSION = 'eaw.mutation-receipt-admission.v1';

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '';
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Slice 1 evidence admission only. This validator never repairs attribution and
// never treats run-level metadata as a receipt for a mutation.
export function admitMutationReceipts({ worldId, mutations } = {}) {
  const blockers = [];
  if (!nonEmpty(worldId)) blockers.push(blocker(null, 'world_id_missing'));
  if (!Array.isArray(mutations) || mutations.length === 0) {
    blockers.push(blocker(null, 'mutation_set_missing'));
  } else {
    const identities = new Set();
    for (const mutation of mutations) {
      const mutationId = nonEmpty(mutation?.mutation_id) ? mutation.mutation_id : null;
      if (!mutationId) blockers.push(blocker(null, 'mutation_id_missing'));
      else if (identities.has(mutationId)) blockers.push(blocker(mutationId, 'mutation_id_duplicate'));
      else identities.add(mutationId);
      validateMutation(mutation, mutationId, worldId, blockers);
    }
  }

  return Object.freeze({
    version: MUTATION_RECEIPT_ADMISSION_VERSION,
    admitted: blockers.length === 0,
    admitted_mutation_ids: blockers.length === 0 ? Object.freeze(mutations.map(({ mutation_id }) => mutation_id)) : Object.freeze([]),
    blockers: Object.freeze(blockers),
    production_proof: Object.freeze({ status: 'pending', dependency: 'Unit 40' }),
  });
}

function validateMutation(mutation, mutationId, worldId, blockers) {
  if (!plainObject(mutation)) return blockers.push(blocker(mutationId, 'mutation_receipt_invalid'));
  if (mutation.world_id !== worldId) blockers.push(blocker(mutationId, 'world_id_contradiction'));
  if (!nonEmpty(mutation.action)) blockers.push(blocker(mutationId, 'action_missing'));

  const actor = mutation.actor;
  if (!plainObject(actor) || !nonEmpty(actor.id) || !nonEmpty(actor.type)) {
    blockers.push(blocker(mutationId, 'actor_missing'));
  } else if (actor.id.trim().toLowerCase() === 'system' || actor.type.trim().toLowerCase() === 'system') {
    blockers.push(blocker(mutationId, 'system_actor_forbidden'));
  }

  const authority = mutation.authority_basis;
  if (!plainObject(authority) || !nonEmpty(authority.kind)) {
    blockers.push(blocker(mutationId, 'authority_basis_missing'));
    return;
  }
  if (authority.action !== mutation.action) blockers.push(blocker(mutationId, 'authority_action_contradiction'));
  if (!plainObject(actor) || authority.principal_id !== actor.id) blockers.push(blocker(mutationId, 'authority_principal_contradiction'));

  if (authority.kind === 'delegated_reconciliation_grant') {
    if (!grantRowAllowsAutoAccept(authority.grant, authority.context)) {
      blockers.push(blocker(mutationId, 'delegated_authority_not_covering'));
    }
  } else if (authority.kind === 'direct_principal') {
    if (!nonEmpty(authority.authority_id)) blockers.push(blocker(mutationId, 'direct_authority_id_missing'));
  } else {
    blockers.push(blocker(mutationId, 'authority_kind_unsupported'));
  }
}

function blocker(mutationId, reason) {
  return Object.freeze({ mutation_id: mutationId, reason });
}
