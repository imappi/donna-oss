// Donna — the role registry (S0 of docs/design-donna-specialist-roles.md §5).
//
// PURE DATA + validation for the bench: RoleDefinition / RoleAssignment /
// AIProfile per that doc's §1. Nothing routes through this registry on a live
// path in S0 — the same posture capabilityRegistry.js takes ("its value now is
// the verified inventory + the lint"). S1 wires the compiled leash (the role
// check on the canonical action identity, staged behind
// SPECIALIST_ROLE_ENFORCE); S2 compiles envelopes from the templates here; S4
// attaches voice to the AI profiles. Donna herself is NOT a RoleDefinition —
// she is the shared orchestration runtime acting under authority delegated by
// the principal; every role below is a NARROWING of that delegated surface.
//
// The canonical action namespace is the union of the closed enums the live
// seams declare: the chat/drawer spine's verb set (accountingMutationRegistry,
// capability-checked in operatorCapability), the outbound executor's action
// types behind their gate (actionGate), and — since the S1 coverage audit
// (roleActionSurface.js, docs/donna-specialist-role-coverage-audit.md) — the
// audited surface operations the first two enums did not carry (the reverse
// executor's verb and the due-sweep's non-send operations). Growing the
// namespace happens by growing THOSE declarations, never by editing here —
// canonicalActionNamespace derives, it does not declare. The subset tests
// (roleRegistry.test.js) pin INV-S2(a)/(c) against it; INV-S2(b) — the
// namespace covers R1's whole autonomous surface before enforcement passes
// shadow — is pinned by roleActionSurface.test.js. The ONE role/authority
// decision both seams converge on is roles/roleAuthority.js decideRoleAction.
//
// Pure leaf: imports only the registries it narrows. Loads in-sandbox
// under `node --test` like the other contract leaves.

import { registryVerbs } from '../accountingMutationRegistry.js';
import { OUTBOUND_ACTION_TYPES, OUTBOUND_ACTION_FLAG_KEYS } from '../outbound/actionGate.js';
import { CAPABILITY_CLASSES, requiredCapabilityForAction } from '../operatorCapability.js';
import { SURFACE_OPERATION_TYPES } from './roleActionSurface.js';
import { LOOP_EVENT_REGISTRY } from '../loopEventRegistry.js';

const deepFreeze = (node) => {
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) deepFreeze(value);
    Object.freeze(node);
  }
  return node;
};

// ── The canonical action namespace ──────────────────────────────────────────
// Union of the known closed enums (chat registry ∪ outbound gate ∪ the S1
// audit's surface operations). Growing this list happens by growing THOSE
// declarations (a new registry verb, a new outbound action type, a new audited
// surface operation), never by editing here — this function derives, it does
// not declare.
export const canonicalActionNamespace = () =>
  Object.freeze([...new Set([
    ...registryVerbs(), ...OUTBOUND_ACTION_TYPES, ...SURFACE_OPERATION_TYPES
  ])]);

// Attribution for system-initiated work (scheduled / event-driven /
// background): a canonical identity belongs to the UNIQUE role whose
// action_set claims it; unclaimed ⇒ null ⇒ Donna core (the shared
// orchestrator's own delegated surface — role leash not applicable, the
// existing stage/approval/grant gates still bind). Uniqueness is a registry
// law (validateRoleRegistry refuses a verb claimed by two roles), so this
// lookup can never be ambiguous. Chat-initiated work resolves its role from
// the ACTING principal's assignment instead — who is acting, not whose lane
// the verb lives in.
export const roleForActionIdentity = (actionType) => {
  const verb = String(actionType || '');
  const claim = ROLE_DEFINITIONS.find((role) => role.action_set.includes(verb));
  return claim ? claim.id : null;
};

// ── Assignment vocabulary (RoleAssignment, §1) ──────────────────────────────
export const ACTOR_TYPES = Object.freeze(['ai', 'human']);
export const ASSIGNMENT_STATUSES = Object.freeze(['proposed', 'active', 'suspended', 'ended']);
export const ROLE_SCOPES = Object.freeze(['client', 'firm']);

// ── AIProfile — persona lives on the AI OCCUPANT, never the role (§1) ───────
// model_policy 'lane_qualified' = models resolve per-lane through the descent
// ladder's qualified sets (modelLanes.js); free per-agent model choice is a
// rejected alternative (specialist-roles doc §9).
// role_prompt (S4) is the occupant's VOICE only — how the persona speaks, not
// what it may do or know. Authority lives on the plane (grants + stages),
// truth lives in the shared workspace context (INV-S3); a role_prompt that
// claimed either would be a bug. Composed into the role-thread system prompt
// by feedChat.buildRoleFeedChatSystemPrompt.
export const AI_PROFILES = deepFreeze({
  clara: {
    persona: 'Clara',
    mascot: '/team-collections.png',
    model_policy: 'lane_qualified',
    role_prompt:
      'Warm and brisk. States amounts, dates, and who owes what precisely. '
      + 'Courteous but unembarrassed about chasing money that is due. '
      + 'Short sentences; no filler.'
  },
  vera: {
    persona: 'Vera',
    mascot: '/team-tax.png',
    model_policy: 'lane_qualified',
    role_prompt:
      'Precise and unhurried. Names the rule and the jurisdiction before the '
      + 'conclusion, and says plainly when something needs a decision or is '
      + 'outside what the books show. Never guesses a treatment.'
  },
  milo: {
    persona: 'Milo',
    mascot: '/team-inventory.png',
    model_policy: 'lane_qualified',
    role_prompt:
      'Practical and concrete. Thinks in units, locations, and landed cost. '
      + 'Flags mismatches between what was ordered, received, and billed '
      + 'before anything else.'
  }
});

// ── RoleDefinitions (§1) ────────────────────────────────────────────────────
// action_set: the compiled leash — a subset of the canonical namespace. An
//   EMPTY set is the safe default for a role whose verbs the S1 coverage audit
//   has not yet named: an occupant of that role can mutate NOTHING.
// authority_template: envelope PRESET — flag keys to stage and grant SHAPES to
//   offer for principal approval. Never actual grants (INV-S10: pre-assigned
//   is not pre-authorized; hiring stages observe/propose/ask only).
// event_interests: trigger ids REGISTERED in the loop event registry
//   (loopEventRegistry.js) — never invented names; validated below. Since S5
//   the collections lane declares the role.* handoff events its own writers
//   produce (roles/roleEvents.js); a role-lane LoopDefinition subscribes to
//   them by adding the id to its triggerMatchers when that loop ships.
// certification: the S6 CLAIM RECORD (roles/roleCertification.js), or null.
//   null = no Autonomous claim — the card reads Preview / supervised. A
//   non-null value is set ONLY by a dated, human-signed commit attaching a
//   green certification verdict artifact:
//     { manifest: {role, jurisdiction, version}, verdict: 'green',
//       verdict_artifact, signed_by, signed_at }
//   Deep validation (validateCertificationRecord) lives in roleCertification
//   so this module stays a pure leaf; roleCertification.test.js pins that
//   every non-null record here validates, and the claim ladder fail-closes
//   to 'preview' on anything less (INV-S9). The MANIFESTS (what a claim is
//   measured against, per role × jurisdiction × version) are declared there
//   too — never here.
export const ROLE_DEFINITIONS = deepFreeze([
  {
    id: 'invoicing_collections',
    title: 'Invoices & Collections',
    responsibilities: [
      'issue and send invoices and quotes',
      'track settlement against paid truth',
      'run the dunning cadence within the pack',
      'rest receivable cases only terminal or on the owner'
    ],
    default_scope: 'client',
    // The three send verbs plus the S1 audit's sweep operations in this
    // role's lane (pay-link creation for its receivables, D1 corrections off
    // owner replies to its sends, reference capture feeding its paid-truth).
    // send_payable_notice is DELIBERATELY absent (AP is not this role's
    // accountability), and graduate_earned_auto may never appear in ANY
    // action_set (a role must not widen its own authority — validated below).
    action_set: [
      'issue_invoice', 'send_quote', 'send_receivable_reminder',
      'create_pay_link', 'record_reply_correction', 'capture_structured_reference'
    ],
    capability_class: 'reviewer',
    authority_template: {
      flags: [
        OUTBOUND_ACTION_FLAG_KEYS.issue_invoice,
        OUTBOUND_ACTION_FLAG_KEYS.send_quote,
        OUTBOUND_ACTION_FLAG_KEYS.send_receivable_reminder,
        'OUTBOUND_PAY_LINKS',
        'OUTBOUND_REPLY_INGESTION',
        'OUTBOUND_REFERENCE_CAPTURE'
      ],
      grant_shapes: [
        { kind: 'standing_send_authority', fields: ['amount_ceiling', 'expires_at', 'review_after'] }
      ]
    },
    skills: [],
    retrieval_profile: 'role:invoicing_collections',
    // S5: the typed role↔owner handoff events this role's own lane produces
    // (recordOutboundRoleTransition at the outbound writers). Real registered
    // trigger ids, never invented names — validated against the loop event
    // registry below.
    event_interests: ['role.handed_to_owner', 'role.resumed_from_owner'],
    certification: null,
    default_ai_profile: 'clara'
  },
  {
    id: 'tax',
    title: 'Tax',
    responsibilities: [
      'prepare filings from the books',
      'flag treatments needing a decision',
      'never file without explicit authority'
    ],
    default_scope: 'client',
    // No canonical filing verbs exist yet in either seam — the S1 coverage
    // audit names them. Empty = this role can mutate nothing (the safe
    // default), and the test pins the emptiness so growing it is deliberate.
    action_set: [],
    capability_class: 'reviewer',
    authority_template: {
      flags: ['HMRC_MTD_VAT', 'FINLAND_ALV_RETURN'],
      grant_shapes: []
    },
    skills: [],
    retrieval_profile: 'role:tax',
    event_interests: [],
    certification: null,
    default_ai_profile: 'vera'
  },
  {
    id: 'inventory_purchasing',
    title: 'Inventory & Purchasing',
    responsibilities: [
      'purchase orders through receipt',
      'stock levels, reservations, counts',
      'inventory valuation and posting'
    ],
    default_scope: 'client',
    // post_inventory_journal is registered (founder-only, never dispatched
    // from chat) — the rest of the inventory kernel's operations gain
    // canonical identities in the S1 audit / I-lane wiring.
    action_set: ['post_inventory_journal'],
    capability_class: 'founder',
    authority_template: {
      flags: ['INVENTORY_ACCOUNTING'],
      grant_shapes: [
        { kind: 'inventory_posting_authority', fields: ['expires_at', 'review_after'] }
      ]
    },
    skills: [],
    retrieval_profile: 'role:inventory_purchasing',
    event_interests: [],
    certification: null,
    default_ai_profile: 'milo'
  }
]);

export const findRoleDefinition = (roleId) =>
  ROLE_DEFINITIONS.find((role) => role.id === roleId) || null;

// ── Validation ──────────────────────────────────────────────────────────────
// Returns an array of problem strings; empty = valid. The test asserts empty,
// so a malformed definition fails CI rather than failing quietly at some
// future read site.

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

const classRank = (cls) => CAPABILITY_CLASSES.indexOf(cls);

export const validateRoleRegistry = () => {
  const problems = [];
  const namespace = new Set(canonicalActionNamespace());
  const seenIds = new Set();
  const verbClaims = new Map(); // verb → first claiming role id (uniqueness law)

  for (const role of ROLE_DEFINITIONS) {
    const tag = `role ${role?.id || '<missing id>'}`;
    if (!isNonEmptyString(role.id)) problems.push(`${tag}: missing id`);
    if (seenIds.has(role.id)) problems.push(`${tag}: duplicate id`);
    seenIds.add(role.id);
    if (!isNonEmptyString(role.title)) problems.push(`${tag}: missing title`);
    if (!Array.isArray(role.responsibilities) || role.responsibilities.length === 0
      || !role.responsibilities.every(isNonEmptyString)) {
      problems.push(`${tag}: responsibilities must be a non-empty string list`);
    }
    if (!ROLE_SCOPES.includes(role.default_scope)) problems.push(`${tag}: bad default_scope`);
    if (!Array.isArray(role.action_set)) {
      problems.push(`${tag}: action_set must be a list`);
    } else {
      for (const verb of role.action_set) {
        // INV-S2(a): every role verb lives in the canonical namespace.
        if (!namespace.has(verb)) problems.push(`${tag}: verb '${verb}' is outside the canonical namespace`);
        // The role's class must clear the capability gate's requirement for
        // EVERY verb it holds — a role that could never legally run its own
        // verb is a definition bug. The S0 skip for outbound-seam verbs is
        // CLOSED: since S1 the capability ladder knows the whole surface
        // (operatorCapability ← roleActionSurface.SURFACE_OPERATION_CAPABILITY).
        if (classRank(role.capability_class) < classRank(requiredCapabilityForAction(verb))) {
          problems.push(`${tag}: capability_class '${role.capability_class}' cannot invoke verb '${verb}'`);
        }
        // A role must never hold a verb that widens (or withdraws) its own
        // authority (INV-S10's corollary — graduation and grant approval
        // belong to the authority plane and the PRINCIPAL, never to an
        // occupant). approve/revoke_role_grant joined the namespace with the
        // team-screen recede (chat-routed owner acts) — same law.
        if (['graduate_earned_auto', 'approve_role_grant', 'revoke_role_grant'].includes(verb)) {
          problems.push(`${tag}: no role may hold '${verb}'`);
        }
        // Attribution uniqueness: system-initiated work resolves its role by
        // which action_set claims the identity (roleForActionIdentity), so a
        // verb claimed by two roles would make attribution ambiguous.
        if (verbClaims.has(verb) && verbClaims.get(verb) !== role.id) {
          problems.push(`${tag}: verb '${verb}' is already claimed by role '${verbClaims.get(verb)}'`);
        }
        if (!verbClaims.has(verb)) verbClaims.set(verb, role.id);
      }
    }
    if (!CAPABILITY_CLASSES.includes(role.capability_class)) problems.push(`${tag}: bad capability_class`);
    const tpl = role.authority_template;
    if (!tpl || typeof tpl !== 'object') {
      problems.push(`${tag}: missing authority_template`);
    } else {
      if (!Array.isArray(tpl.flags) || !tpl.flags.every((f) => isNonEmptyString(f) && f === f.toUpperCase())) {
        problems.push(`${tag}: authority_template.flags must be UPPER_SNAKE flag keys`);
      }
      if (!Array.isArray(tpl.grant_shapes)
        || !tpl.grant_shapes.every((g) => g && isNonEmptyString(g.kind)
          && Array.isArray(g.fields) && g.fields.every(isNonEmptyString))) {
        problems.push(`${tag}: authority_template.grant_shapes malformed`);
      }
    }
    if (!Array.isArray(role.skills)) problems.push(`${tag}: skills must be a list`);
    if (!isNonEmptyString(role.retrieval_profile) || !role.retrieval_profile.startsWith('role:')) {
      problems.push(`${tag}: retrieval_profile must be 'role:<id>'`);
    }
    if (!Array.isArray(role.event_interests)) {
      problems.push(`${tag}: event_interests must be a list`);
    } else {
      for (const interest of role.event_interests) {
        // S5 wiring law: an event interest is a trigger id REGISTERED in the
        // loop event registry — an invented name here would be doc-ware that
        // nothing can ever dispatch.
        if (!LOOP_EVENT_REGISTRY[interest]) {
          problems.push(`${tag}: event_interest '${interest}' is not a registered loop event`);
        }
      }
    }
    if (role.certification !== null && typeof role.certification !== 'object') {
      problems.push(`${tag}: certification must be null or an S6 claim record (see roleCertification.js)`);
    }
    if (!AI_PROFILES[role.default_ai_profile]) {
      problems.push(`${tag}: default_ai_profile '${role.default_ai_profile}' not in AI_PROFILES`);
    }
  }
  return problems;
};

// RoleAssignment validation (§1). Data-shape law only at S0 — no store exists
// yet; `client_assignments` (migration 001) is the substrate S2 builds on.
// Two invariants bite already:
//   - INV-S10: a grant may exist only with an explicit authority basis — a
//     grant without provenance is invalid at the SHAPE level.
//   - actor_type 'ai' requires an ai_profile; 'human' forbids one (persona
//     belongs to AI occupants only).
export const validateRoleAssignment = (assignment) => {
  const problems = [];
  if (!assignment || typeof assignment !== 'object') return ['assignment must be an object'];
  if (!findRoleDefinition(assignment.role)) problems.push(`unknown role '${assignment.role}'`);
  if (!ACTOR_TYPES.includes(assignment.actor_type)) problems.push(`bad actor_type '${assignment.actor_type}'`);
  if (!ASSIGNMENT_STATUSES.includes(assignment.status)) problems.push(`bad status '${assignment.status}'`);
  if (!isNonEmptyString(assignment.occupant)) problems.push('missing occupant principal');
  if (assignment.actor_type === 'ai' && !AI_PROFILES[assignment.ai_profile]) {
    problems.push('ai occupant requires a known ai_profile');
  }
  if (assignment.actor_type === 'human' && assignment.ai_profile) {
    problems.push('human occupant must not carry an ai_profile');
  }
  const grants = assignment.grants ?? [];
  if (!Array.isArray(grants)) {
    problems.push('grants must be a list');
  } else {
    for (const grant of grants) {
      if (!grant || !isNonEmptyString(grant.kind) || !isNonEmptyString(grant.authority_basis)) {
        problems.push('every grant needs kind + authority_basis (INV-S10: no basis, no grant)');
        break;
      }
    }
  }
  return problems;
};
