// Donna — seat approval-authority decisions (build spec §3.4).
//
// Pure leaf over the two other leaves (seatActionClasses.js, seatModel.js,
// operatorCapability.js): given the acting SEAT, the compiled action type, and
// the resolvable amount, decide ALLOW or ROUTE. There is no bare "deny" for a
// seat inside its entity scope — an approval a seat lacks authority for is
// NEVER hidden (spec: auto-routing): the decision names the smallest role that
// carries the authority, the caller refuses the apply with that routing in the
// body, receipts `seat.approval_routed` with provenance, and the item STAYS
// proposed for the authorized queue. Two-terminal guard: this layer only ever
// sees items the doctrine already routed to a human (proposals awaiting
// approval); confident work keeps auto-reconciling regardless of seats.
//
// Materiality bounds are CODE DEFAULTS per Kari's dated 2026-08-03 posture
// ("materiality numbers stay code defaults… tune from the sample close");
// per-entity overrides are the named extension point on the
// action_authority_grants engine — not built here, deliberately.

import { CAPABILITY_CLASSES, requiredCapabilityForAction } from './operatorCapability.js';
import { SEAT_ROLE_CAPABILITY_CLASS } from './seatModel.js';
import { AMOUNT_GATED_ACTION_CLASSES, actionClassForVerb } from './seatActionClasses.js';

const rank = (cls) => CAPABILITY_CLASSES.indexOf(cls);

// Default per-role materiality bounds, MINOR units of the entity's book
// currency, compared against the ABSOLUTE amount. null = unbounded.
// Proposed defaults for Kari to ratify (spec §7): JUNIOR 500.00,
// SENIOR 5,000.00, PARTNER/OWNER unbounded.
export const SEAT_MATERIALITY_BOUNDS_MINOR = Object.freeze({
  junior: 50000,
  senior: 500000,
  partner: null,
  owner: null
});

// The seat roles in escalation order — the routing ladder.
const SEAT_ROLE_LADDER = Object.freeze(['junior', 'senior', 'partner', 'owner']);

// Smallest seat role whose capability class satisfies `requiredClass`.
// ('reviewer'-required verbs route to SENIOR: no seat maps to reviewer, and
// senior is the first ladder rung at-or-above that rank.)
export const seatRoleForRequiredClass = (requiredClass) => {
  const required = rank(requiredClass);
  if (required < 0) return 'owner';
  for (const role of SEAT_ROLE_LADDER) {
    if (rank(SEAT_ROLE_CAPABILITY_CLASS[role]) >= required) return role;
  }
  return 'owner';
};

// Smallest seat role whose materiality bound covers |amountMinor| AND whose
// class satisfies the verb — the routing target for an over-bound amount.
const seatRoleForAmount = ({ amountMinor, floorRole }) => {
  const abs = Math.abs(Number(amountMinor));
  const floorIdx = Math.max(0, SEAT_ROLE_LADDER.indexOf(floorRole));
  for (let i = floorIdx; i < SEAT_ROLE_LADDER.length; i += 1) {
    const role = SEAT_ROLE_LADDER[i];
    const bound = SEAT_MATERIALITY_BOUNDS_MINOR[role];
    if (bound == null || abs <= bound) return role;
  }
  return 'owner';
};

// THE decision. Pure — no throw, no DB, no clock. Outcomes:
//   { outcome: 'allow' }
//   { outcome: 'route', route_to_role, reason }  — reasons:
//       'requires_<class>_capability' — the verb's class outranks the seat
//       'amount_exceeds_bound'        — |amount| over the seat's bound
//       'amount_unresolved'           — bounded role + amount-gated class but
//                                       no resolvable amount: FAIL-CLOSED
//                                       upward, never silently through
// Every field the routing receipt needs rides the result (provenance).
export const decideSeatAuthority = ({ seatRole, actionType, amountMinor = null } = {}) => {
  const role = String(seatRole || '').trim().toLowerCase();
  const capabilityClass = SEAT_ROLE_CAPABILITY_CLASS[role] || 'viewer';
  const requiredClass = requiredCapabilityForAction(actionType);
  const actionClass = actionClassForVerb(actionType);
  const base = {
    seat_role: role,
    capability_class: capabilityClass,
    required_class: requiredClass,
    action_class: actionClass,
    action_type: String(actionType || ''),
    amount_minor: amountMinor == null ? null : Number(amountMinor)
  };
  if (rank(capabilityClass) < rank(requiredClass)) {
    return {
      ...base,
      outcome: 'route',
      route_to_role: seatRoleForRequiredClass(requiredClass),
      reason: `requires_${requiredClass}_capability`
    };
  }
  const bound = SEAT_MATERIALITY_BOUNDS_MINOR[role];
  const amountGated = actionClass ? AMOUNT_GATED_ACTION_CLASSES.has(actionClass) : false;
  if (bound != null && amountGated) {
    const amount = base.amount_minor;
    if (amount == null || Number.isNaN(amount)) {
      return {
        ...base,
        outcome: 'route',
        route_to_role: SEAT_ROLE_LADDER[Math.min(SEAT_ROLE_LADDER.indexOf(role) + 1, SEAT_ROLE_LADDER.length - 1)],
        reason: 'amount_unresolved',
        bound_minor: bound
      };
    }
    if (Math.abs(amount) > bound) {
      return {
        ...base,
        outcome: 'route',
        route_to_role: seatRoleForAmount({ amountMinor: amount, floorRole: role }),
        reason: 'amount_exceeds_bound',
        bound_minor: bound
      };
    }
  }
  return { ...base, outcome: 'allow' };
};

// ── Amount resolution (consumed by the assertActionCapability wiring) ────────
//
// Compiled chat actions carry TARGETS (transaction_id(s) / document_id), not
// amounts — verified against the live shapes, not guessed. Resolution order:
//   1. a direct amount key on the action (some future shapes may carry one);
//   2. the referenced rows, via the injected lookups (the wiring caller owns
//      the one DB read, same discipline as the assignment-role read).
// Unresolvable + bounded role + amount-gated class ⇒ decideSeatAuthority
// fail-closes upward — a missing amount can only ever ROUTE, never slip
// through a bound.
const DIRECT_AMOUNT_KEYS = ['amount_minor', 'amount', 'total_amount', 'gross_amount'];

export const directActionAmount = (action = null) => {
  if (!action || typeof action !== 'object') return null;
  for (const key of DIRECT_AMOUNT_KEYS) {
    const value = action[key] ?? action.params?.[key];
    if (value == null || value === '') continue;
    const num = Number(value);
    if (!Number.isNaN(num)) {
      // amount_minor is already minor units; the display keys are major.
      return key === 'amount_minor' ? Math.round(num) : Math.round(num * 100);
    }
  }
  return null;
};

export const actionTargetIds = (action = null) => ({
  transactionIds: [
    ...(Array.isArray(action?.transaction_ids) ? action.transaction_ids : []),
    ...(action?.transaction_id ? [action.transaction_id] : [])
  ].filter(Boolean),
  documentIds: [
    ...(Array.isArray(action?.document_ids) ? action.document_ids : []),
    ...(action?.document_id ? [action.document_id] : [])
  ].filter(Boolean)
});

// Amount for a MULTI-target action is the LARGEST absolute row amount — a
// batch is authorized at the materiality of its most material line, never
// averaged under the bound.
export const resolveActionAmountMinor = async ({
  action = null,
  clientId = null,
  lookupTransactionAmounts = null, // async (ids, clientId) => [majorAmounts]
  lookupDocumentAmounts = null     // async (ids, clientId) => [majorAmounts]
} = {}) => {
  const direct = directActionAmount(action);
  if (direct != null) return direct;
  const { transactionIds, documentIds } = actionTargetIds(action);
  const amounts = [];
  if (transactionIds.length > 0 && typeof lookupTransactionAmounts === 'function') {
    amounts.push(...(await lookupTransactionAmounts(transactionIds, clientId) || []));
  }
  if (documentIds.length > 0 && typeof lookupDocumentAmounts === 'function') {
    amounts.push(...(await lookupDocumentAmounts(documentIds, clientId) || []));
  }
  const numeric = amounts.map(Number).filter((n) => !Number.isNaN(n));
  if (numeric.length === 0) return null;
  const maxAbs = Math.max(...numeric.map((n) => Math.abs(n)));
  return Math.round(maxAbs * 100);
};
