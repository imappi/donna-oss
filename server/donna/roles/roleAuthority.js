// Donna — the ONE shared role/authority decision (S1 of
// docs/design-donna-specialist-roles.md §5; INV-S2).
//
// THE CONVERGENCE. Before S1 the tree had two live authorization seams that
// never shared a decision: the chat/drawer spine's capability check
// (operatorCapability.authorizeActionType, wired via firmDb.assertActionCapability)
// and the outbound executor's gate (actionGate.classifyOutboundAction). Each
// seam keeps its own DOMAIN checks — compile/allowlist/anti-tamper on chat;
// suppression/paid-truth/stage/approval on outbound — but the role/authority
// question ("may THIS occupant, in THIS role, at THIS capability class,
// perform THIS canonical action?") is answered HERE and nowhere else, for
// every initiation path: chat-compiled, scheduled, event-driven, background.
// This is REUSE of the capability pattern (the capability half of the verdict
// IS operatorCapability's own authorizeActionType); a second permissions
// system is a rejected alternative (specialist-roles doc §9).
//
// Role input resolution differs by seam, deliberately (the audit's law):
//   - chat seam: the role is the ACTING principal's specialist assignment
//     (none exist until S2's hire flow — callers pass null, and the decision
//     reduces byte-identically to the capability verdict);
//   - system-initiated seams (executor, sweeps): the role is the identity's
//     OWNING role — roleRegistry.roleForActionIdentity, the unique action_set
//     claim; unclaimed ⇒ null ⇒ Donna core (leash not applicable, the
//     existing stage/approval/grant gates still bind).
//
// Enforcement is staged behind SPECIALIST_ROLE_ENFORCE on the config control
// plane (envFallback () => false — the rollout-flags rail; born 'off'):
//   off / dry_run / shadow → a denial only LOGS a would-block (and at shadow
//     the callers additionally receipt it) — nothing changes behavior;
//   canary / auto → a denial refuses (the chat seam throws 403; the outbound
//     executor holds the action to the owner with a named reason — the second
//     terminal state, never an error terminal).
// The flag may not be staged past 'shadow' while the coverage audit has open
// gaps — INV-S2(b), enforced by clientConfig.SHADOW_CEILING_FLAGS plus the
// roleActionSurface.test.js linkage.
//
// Pure leaf: imports only pure siblings; the DB write for the would-block
// receipt takes an INJECTED query fn (the auditChatApplyEvent discipline), so
// this module loads in-sandbox under `node --test`.

import {
  findRoleDefinition, canonicalActionNamespace, roleForActionIdentity
} from './roleRegistry.js';
import { authorizeActionType, requiredCapabilityForAction, CAPABILITY_CLASSES } from '../operatorCapability.js';
import { clientFlagActs, clientFlagObserves } from '../clientConfig.js';
import { OPERATOR_AGENT_ID } from '../mentions/mentionResolution.js';

// The staging flag. Born on the config control plane; never an env pair.
export const SPECIALIST_ROLE_FLAG_KEY = 'SPECIALIST_ROLE_ENFORCE';

export { roleForActionIdentity };

// THE decision. Pure — every input is passed in; no DB, no config read, no
// throw. Two dimensions, both fail-closed where they bind:
//   role leash — binds only when a roleId is supplied: unknown role denies;
//     an identity outside the role's action_set denies (INV-S2's compiled
//     leash; action_set ⊆ canonical namespace by INV-S2(a), so a leashed
//     pass is always a canonical identity). roleId null ⇒ leash not
//     applicable (Donna core / a plain principal).
//   capability — operatorCapability's own ladder, unchanged: the effective
//     class is the caller's (chat seam: resolved from the principal) or the
//     role's own capability_class (system seams). With neither, the
//     capability dimension is not applicable (Donna core acting under her
//     delegated surface — the outbound gate's stage/approval checks are the
//     real authority there and have already run or will run).
// Returns { allowed, action_type, role_id, in_namespace, role_allowed,
// capability, reasons } — reasons is the machine-readable denial trail for
// receipts and would-block logs, empty on a pass.
export const decideRoleAction = ({ actionType, roleId = null, capabilityClass = null } = {}) => {
  const verb = String(actionType || '');
  const inNamespace = canonicalActionNamespace().includes(verb);
  const reasons = [];

  let role = null;
  let roleAllowed = null; // null = leash not applicable
  if (roleId != null) {
    role = findRoleDefinition(roleId);
    if (!role) {
      roleAllowed = false;
      reasons.push('unknown_role');
    } else if (!inNamespace) {
      roleAllowed = false;
      reasons.push('outside_canonical_namespace');
    } else if (!role.action_set.includes(verb)) {
      roleAllowed = false;
      reasons.push('outside_role_action_set');
    } else {
      roleAllowed = true;
    }
  }

  const effectiveClass = capabilityClass ?? (role ? role.capability_class : null);
  const capability = effectiveClass != null
    ? authorizeActionType({ actionType: verb, capabilityClass: effectiveClass })
    : null;
  if (capability && !capability.allowed) reasons.push(capability.reason);

  return {
    action_type: verb,
    role_id: role ? role.id : (roleId ?? null),
    in_namespace: inNamespace,
    role_allowed: roleAllowed,
    capability,
    allowed: roleAllowed !== false && (capability ? capability.allowed : true),
    reasons
  };
};

// ── D7 — instructed-agent authority composition (universal mentions slice 4;
//    design-donna-universal-mentions.md §2 D7, test matrix §10) ──────────────
//
// When an AGENT acts on a SEAT'S instruction, the action is bounded by BOTH
// authorities: authorized at the compiled action_type against
// min(rank(instructing seat's class), rank(agent's effective class)) — a
// lower-class seat cannot instruct an agent above the seat's own class, and
// an agent never lends its class upward. The same one capability resolver
// (authorizeActionType) answers the composed question — never a second
// permissions system.
//
// FOUNDER-ONLY verbs are NEVER instructable — refused whoever instructs,
// founder included: an instructed agent is not the founder, and the
// fail-closed default (an unknown verb requires founder) makes an unknown
// verb un-instructable for free. Every return carries the full composition
// for the receipt (both identities' classes + the effective one).

// The agent side of the min: the operator ('donna') composes as founder —
// the runtime carries no class ceiling of its own, so the instructing seat's
// class alone bounds it; a bench hire composes at its ROLE's capability
// class (profiles carry voice, never authority — roleRegistry's law); an
// unknown/unhired role fail-closes to viewer.
export const agentEffectiveCapabilityClass = ({ agentId = null, roleId = null } = {}) => {
  if (String(agentId || '').trim().toLowerCase() === OPERATOR_AGENT_ID) return 'founder';
  const role = findRoleDefinition(roleId);
  return role ? role.capability_class : 'viewer';
};

const classRank = (cls) => CAPABILITY_CLASSES.indexOf(cls);

export const decideInstructedAgentAction = ({
  actionType, instructingClass = null, agentClass = null
} = {}) => {
  const verb = String(actionType || '');
  const requiredClass = requiredCapabilityForAction(verb);
  const instructing = CAPABILITY_CLASSES.includes(instructingClass) ? instructingClass : 'viewer';
  const agent = CAPABILITY_CLASSES.includes(agentClass) ? agentClass : 'viewer';
  const effective = classRank(instructing) <= classRank(agent) ? instructing : agent;
  const base = {
    action_type: verb,
    instructing_class: instructing,
    agent_class: agent,
    effective_class: effective,
    required_class: requiredClass
  };
  if (requiredClass === 'founder') {
    return { ...base, allowed: false, reason: 'founder_only_never_instructable' };
  }
  const capability = authorizeActionType({ actionType: verb, capabilityClass: effective });
  return {
    ...base,
    allowed: capability.allowed,
    reason: capability.allowed ? 'capability_satisfied' : capability.reason
  };
};

// Resolve what a denial DOES for this client, from the config snapshot
// (outboundGateMode's shape): 'act' = refuse/throw; 'shadow' = log + receipt;
// 'off' = log only. envFallback () => false — the flag has no legacy env
// predicate and never will.
export const specialistRoleGateMode = ({ snapshot = null, env = process.env } = {}) => {
  const acts = clientFlagActs({ flagKey: SPECIALIST_ROLE_FLAG_KEY, snapshot, envFallback: () => false, env });
  const observes = clientFlagObserves({ flagKey: SPECIALIST_ROLE_FLAG_KEY, snapshot, envFallback: () => false, env });
  if (acts) return 'act';
  if (observes) return 'shadow';
  return 'off';
};

// The one would-block log line — greppable, uniform across seams. Runs at
// every non-acting stage (off AND shadow both log; shadow additionally
// receipts via recordRoleWouldBlock).
export const logSpecialistRoleWouldBlock = ({
  logger = console, seam, firmId = null, clientId = null, decision
} = {}) => {
  const scope = [firmId, clientId].filter(Boolean).join('/');
  logger.warn?.(
    `[specialistRole] would-block '${decision?.action_type}' (role ${decision?.role_id || 'none'}) `
    + `at ${seam}${scope ? ` [${scope}]` : ''}: ${decision?.reasons?.join(',') || 'denied'}`
  );
};

// The sweep-op posture in one call (the due-sweep's non-send operations —
// pay links, reply corrections, reference capture, ladder graduation): decide
// with claim-derived attribution, then resolve what a denial does. Returns
// { proceed, wouldBlock, decision }:
//   allowed            → proceed, nothing logged (the common path — zero cost);
//   denied + acting    → proceed:false — the caller returns a receipted
//                        skip ('role_leash_denied'), never throws mid-sweep;
//   denied + off/shadow → proceed:true with the would-block logged (and
//                        receipted at shadow when a query fn is supplied).
export const gateRoleSurfaceOperation = async ({
  actionType, snapshot = null, env = process.env, seam,
  firmId = null, clientId = null, logger = console, query = null,
  // Injectable for tests (the actionExecutor roleDecisionFn discipline);
  // runtime callers never pass it.
  decisionFn = null
} = {}) => {
  const decide = decisionFn || decideRoleAction;
  const decision = decide({ actionType, roleId: roleForActionIdentity(actionType) });
  if (decision.allowed) return { proceed: true, wouldBlock: false, decision };
  const mode = specialistRoleGateMode({ snapshot, env });
  if (mode === 'act') return { proceed: false, wouldBlock: false, decision };
  logSpecialistRoleWouldBlock({ logger, seam, firmId, clientId, decision });
  if (mode === 'shadow' && typeof query === 'function') {
    await recordRoleWouldBlock({
      query, firmId, clientId, seam, decision,
      warn: (...args) => logger.warn?.(...args)
    });
  }
  return { proceed: true, wouldBlock: true, decision };
};

// The shadow receipt: one audit_events row per would-block, best-effort (a
// failed observation write must never take down the observed path — the
// receipts-not-gates posture every shadow lane starts at). Query fn injected
// so this module stays a pure leaf.
export const recordRoleWouldBlock = async ({
  query, firmId, clientId = null, seam, decision,
  warn = (...args) => console.warn(...args)
} = {}) => {
  try {
    if (typeof query !== 'function' || !firmId) return false;
    await query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'specialist_role_gate', 'specialist_role.would_block', 'action_type', $3, $4::jsonb)`,
      [
        firmId,
        clientId || null,
        decision?.action_type || null,
        JSON.stringify({
          seam,
          role_id: decision?.role_id || null,
          reasons: decision?.reasons || [],
          in_namespace: decision?.in_namespace ?? null
        })
      ]
    );
    return true;
  } catch (err) {
    warn(`[specialistRole] would-block receipt failed (best-effort) for '${decision?.action_type || 'unknown'}'`, err?.message || err);
    return false;
  }
};
