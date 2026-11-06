// Donna Loops — the execution gate: graduation tiers + firm/case suspension
// (goal-first uplift, design §10 Step 6 / §13.8). PURE, dependency-free leaf.
//
// See docs/loops-architecture-uplift-design.md §10 (Step 6: "Per-LoopDefinition
// executionPolicy + firm-level/case-level suspension replace the ad-hoc
// env/metadata gates; one graduation model") and §13.8 (the one-bounded-action
// taxonomy that bounds V1 autonomy under INV-13). The §2 gating audit found the
// control scattered across FOUR mechanisms with no shared graduation model:
//   - LOOPS_SHADOW                (binary global on/off)        -> off vs shadow+
//   - RECONCILIATION_MATCHER_MODE + per-family FLAG_ENABLED      -> canary
//   - per-firm metadata.*.enabled (auto-explain, bld, rules)     -> firm tier / suspension
//   - a pile of *_ENABLED envs in parseDocument.js               -> per-loop tier
// This leaf is the ONE deterministic model that subsumes them: a monotone
// graduation ladder (off < shadow < canary < active), an explicit firm/case
// SUSPENSION kill switch that overrides the ladder, and an action-taxonomy gate
// pinning what a run may DO at each tier. It mutates nothing and calls no LLM —
// like nextCaseSelector it EMITS a decision + receipt; the engine (Step 5/6)
// reads it and performs the lease/run/persist.
//
// CLAUDE.md "Keep"-layer discipline: graduation/suspension are system-correctness
// controls (who may act, and how far), NOT intelligence-substituting rules. The
// V1-forbidden set (accounting mutation, client-visible message, memory/policy
// activation) stays forbidden at EVERY tier — those remain human-authorized (the
// principle's "the human word is terminal" half); graduation never unlocks them.
//
// The OTHER half of executionPolicy — the per-wake BUDGET caps
// (maxModelCallsPerWake/...) — lives in loopRun.js (normalizeExecutionPolicy /
// accountBudget). This file is the orthogonal TIER/SUSPENSION half; together they
// are the full executionPolicy gate. Kept dependency-free (no imports) so a
// reader can depend on it without widening an import cycle, like loopGoal.js.

// ---- graduation ladder (subsumes LOOPS_SHADOW / matcher-mode / FLAG_ENABLED) --

// A MONOTONE tier ladder. Graduation moves UP one rung at a time (shadow ->
// canary -> active, the careful canary rollout the repo already does by hand); an
// emergency drop (kill switch) may slam DOWN any number of rungs, including
// straight to `off`. Ordered by RANK so "at least tier X" is a comparison.
export const EXECUTION_TIERS = ['off', 'shadow', 'canary', 'active'];

const TIER_RANK = Object.freeze(Object.fromEntries(EXECUTION_TIERS.map((t, i) => [t, i])));

export const tierRank = (tier) => {
  const r = TIER_RANK[tier];
  if (r === undefined) throw new Error(`unknown execution tier "${tier}"`);
  return r;
};

export const tierAtLeast = (tier, minTier) => tierRank(tier) >= tierRank(minTier);

// ---- the one-bounded-action taxonomy (§13.8) ------------------------------

// A LoopRun does exactly ONE of these per wake (§13.8). These are the V1-SAFE
// actions autonomy may take — loop-internal workflow only, nothing client-facing
// and nothing that posts accounting state.
export const RUN_ACTIONS = [
  'goal_report_only',      // evaluate + persist the GoalReport, change nothing else
  'noop_escalation',       // no-op / escalate to a human
  'workflow_mutation',     // move case status / owner (loop-internal state)
  'proposal_creation',     // draft a proposal (NOT applied)
  'blocker_change',        // create / resolve a blocker
  'external_sync_enqueue'  // enqueue an outbox row (the dispatcher is Step 7)
];

// Forbidden to autonomy at EVERY tier — these require a human-authorized step
// (INV-13 / §13.8: V1 "may NOT mutate accounting state, emit client-visible
// messages, or activate memory/policy"). Graduation never unlocks these; a
// human_authorized criterion does.
export const V1_FORBIDDEN_ACTIONS = [
  'accounting_state_mutation', // post to ledger / Xero / QBO
  'client_visible_message',    // send_ask_batch and friends
  'memory_policy_activation'   // activate a firm_fact / rule / policy
];

// ── INT-6 DOCTRINE CARVE (ledger-integrations finish plan §2, approved via
// PR #800; Kari decision #2, 2026-07-06) ─────────────────────────────────────
// The plan's words: "loopExecutionPolicy.js currently forbids
// accounting_state_mutation at every tier. INT-6 carves the narrow exception:
// export-of-an-already-posted-journal under a live grant — never coding, never
// posting, never corrections."
//
// The carve is a NEW, NARROWER action key — NOT a loosening of
// accounting_state_mutation, which stays in V1_FORBIDDEN_ACTIONS above,
// unchanged, covering posting/coding/corrections as before. A grant-gated
// action is unlocked by exactly ONE thing: a live ledger_sync_authority_grant
// (migration 054, ledgerSyncAuthorityGrants.js — founder-minted, time-bounded,
// auto-suspended on export correction), surfaced here as the caller-verified
// `authorityGrants` receipt. Graduation never unlocks it (it is not in
// RUN_ACTIONS); humanAuthorizations never unlocks it (it is not in
// V1_FORBIDDEN_ACTIONS); and even WITH a grant it acts only at an autonomous
// tier (canary+), never at shadow. Failure of any invariant falls back to a
// firm case / the pending-export operator surface — never a silent skip.
export const GRANT_GATED_ACTIONS = [
  'posted_journal_export' // export an ALREADY-POSTED Donna journal to Xero/QBO
];

// shadow rung: observe-only — evaluate + persist the verdict, take no
// state-changing action. This IS the current LOOPS_SHADOW semantics, now named.
const SHADOW_ACTIONS = Object.freeze(['goal_report_only', 'noop_escalation']);

// What a tier permits. canary and active share the SAME action set — a canary is
// a SCOPE (which firms/cases get the tier), not a different capability; the
// difference is enforced by per-firm tier assignment, not by this gate.
export const resolveAutonomy = (tier) => {
  switch (tier) {
    case 'off':
      return { level: 'none', allowedActions: [] };
    case 'shadow':
      return { level: 'shadow', allowedActions: [...SHADOW_ACTIONS] };
    case 'canary':
    case 'active':
      return { level: 'autonomous', allowedActions: [...RUN_ACTIONS] };
    default:
      throw new Error(`unknown execution tier "${tier}"`);
  }
};

// ---- suspension (firm-level / case-level kill switch) ---------------------

// Reuses the contract's AUTHORITY vocabulary (design §13.6 / Phase 0 §3g): only
// an authority may suspend, resume, or change a tier. An OWNER such as a `client`
// can supply evidence but can never govern autonomy.
export const AUTHORITY_ACTOR_TYPES = ['firm_operator', 'accountant', 'admin', 'system'];

export const isAuthority = (actorType) => AUTHORITY_ACTOR_TYPES.includes(actorType);

export const SUSPENSION_SCOPES = ['firm', 'case'];

// Construct a well-formed suspension record (the kill switch + its actor
// receipt). Throws unless an AUTHORITY raised it — a suspension is a governance
// act, not an automatic one. raisedAt is epoch ms or ISO; carried as given.
export const buildSuspension = ({ scope, reason, actorType, actorId = null, raisedAt = null } = {}) => {
  if (!SUSPENSION_SCOPES.includes(scope)) {
    throw new Error(`buildSuspension: scope must be one of ${SUSPENSION_SCOPES.join('/')}`);
  }
  if (!isAuthority(actorType)) {
    throw new Error(`buildSuspension: ${actorType || 'an owner'} may not suspend — authority required`);
  }
  if (!reason) throw new Error('buildSuspension: a reason is required (the governance receipt)');
  return Object.freeze({
    scope,
    reason,
    authorizedByActorType: actorType,
    authorizedByActorId: actorId,
    raisedAt
  });
};

// A bare boolean is accepted as a kill switch (true => suspended) so a caller can
// pass a simple flag; an object is taken as-is. Anything falsy means not suspended.
const normalizeSuspension = (s) => {
  if (!s) return null;
  return s === true ? { reason: 'suspended' } : s;
};

// The set of V1-FORBIDDEN actions a firm has EXPLICITLY human-authorized for
// autonomy — the contract's `human_authorized` criterion (§13.6/§13.8, CLAUDE.md
// "the human word is terminal"). An authorization is the STANDING record of a human
// "yes" (e.g. the firm setting "auto-send client questions"); it never comes from
// graduation. Normalized to a Set and filtered to KNOWN forbidden actions, so a
// stray/typo'd or non-forbidden key can never unlock anything (no silent pass).
const normalizeAuthorizations = (auth) => {
  const set = new Set();
  for (const a of Array.isArray(auth) ? auth : []) {
    if (V1_FORBIDDEN_ACTIONS.includes(a)) set.add(a);
  }
  return set;
};

// The set of GRANT-GATED actions the caller has verified a LIVE authority
// grant for (INT-6). The policy leaf stays pure and dependency-free: the
// fail-closed grant lookup (status/window/correction guards) lives in
// ledgerSyncAuthorityGrants.js; the caller passes the surviving action keys
// here. Filtered to KNOWN grant-gated actions so a stray key never unlocks
// anything — same no-silent-pass discipline as normalizeAuthorizations.
const normalizeGrantAuthorities = (grants) => {
  const set = new Set();
  for (const g of Array.isArray(grants) ? grants : []) {
    if (GRANT_GATED_ACTIONS.includes(g)) set.add(g);
  }
  return set;
};

// ---- the execution gate ---------------------------------------------------

// THE gate. Given a loop's graduation tier for this firm and any firm/case
// suspension, decide whether a run may EXECUTE and — if a requestedAction is
// supplied — whether that specific action is permitted. Non-mutating: returns a
// decision + receipt; the engine performs the lease/run/persist.
//
// Precedence (highest first):
//   1. firm suspension  -> blocked, the broadest fact ('firm_suspended')
//   2. case suspension  -> blocked ('case_suspended')
//   3. tier 'off'       -> blocked ('tier_off')
//   4. otherwise        -> allowed at the tier's autonomy level
// `tier` defaults to 'off': an absent gate reads as OFF, never as "unbounded"
// (the same safe-default discipline as loopRun's budget caps).
//
// requestedAction (optional, from RUN_ACTIONS ∪ V1_FORBIDDEN_ACTIONS ∪ GRANT_GATED_ACTIONS):
//   - a V1-forbidden action is NEVER unlocked by graduation -> 'requires_human_authority'
//     UNLESS the firm has an explicit human authorization for it (humanAuthorizations,
//     the `human_authorized` criterion) AND the tier is autonomous (canary+); then it
//     is permitted with a `humanAuthorized` receipt. Authorized-but-below-canary reports
//     'tier_too_low'. Absent the authorization it stays forbidden at every tier.
//   - a GRANT-GATED action (INT-6 carve) is unlocked ONLY by a live authority grant
//     (authorityGrants) AND an autonomous tier -> permitted with a `grantAuthorized`
//     receipt; no grant -> 'requires_authority_grant' at every tier; grant-but-shadow
//     -> 'tier_too_low'.
//   - an action above the tier's set -> 'tier_too_low'
//   - an unknown action -> throws (no silent pass for a hallucinated action)
//
// humanAuthorizations (optional): the firm's standing human authorizations — an
// array of V1-forbidden action keys (e.g. ['client_visible_message']) the firm has
// turned on through settings. Defaults to [] (forbidden-by-default, today's behaviour).
//
// authorityGrants (optional): the grant-gated action keys the caller has verified a
// LIVE ledger_sync_authority_grant for (INT-6). Defaults to [] (no grant, no export).
export const decideExecution = ({
  tier = 'off',
  firmSuspension = null,
  caseSuspension = null,
  requestedAction = null,
  humanAuthorizations = [],
  authorityGrants = [],
  loopKey = null
} = {}) => {
  const firmS = normalizeSuspension(firmSuspension);
  const caseS = normalizeSuspension(caseSuspension);
  const authorizations = normalizeAuthorizations(humanAuthorizations);
  const grantAuthorities = normalizeGrantAuthorities(authorityGrants);

  let allowed = true;
  let blockedReason = null;
  let suspension = null;

  if (firmS) {
    allowed = false; blockedReason = 'firm_suspended'; suspension = firmS;
  } else if (caseS) {
    allowed = false; blockedReason = 'case_suspended'; suspension = caseS;
  } else if (!tierAtLeast(tier, 'shadow')) {
    // tierAtLeast also validates the tier name — an unknown tier throws here.
    allowed = false; blockedReason = 'tier_off';
  }

  const autonomy = allowed ? resolveAutonomy(tier) : { level: 'none', allowedActions: [] };

  const decision = {
    loopKey: loopKey || null,
    tier,
    allowed,
    autonomyLevel: autonomy.level,
    allowedActions: autonomy.allowedActions,
    humanAuthorizations: [...authorizations],
    authorityGrants: [...grantAuthorities],
    blockedReason,
    suspension
  };

  if (requestedAction != null) {
    Object.assign(decision, evaluateAction(requestedAction, {
      allowed, blockedReason, allowedActions: autonomy.allowedActions,
      autonomyLevel: autonomy.level, authorizations, grantAuthorities
    }));
  }
  return decision;
};

// Gate a single requested action against the run's allowance + the tier's set.
// A V1-forbidden action is the special case: graduation never unlocks it, but an
// explicit human authorization (authorizations — the `human_authorized` criterion)
// does, and ONLY at an autonomous tier (canary+), never at shadow. The receipt
// carries `humanAuthorized: true` whenever the authorization is the deciding factor,
// so a downstream send/post is auditable as "autonomous, standing-human-authorized"
// rather than a bare autonomous act.
const evaluateAction = (requestedAction, {
  allowed, blockedReason, allowedActions, autonomyLevel = 'none',
  authorizations = new Set(), grantAuthorities = new Set()
} = {}) => {
  const known = RUN_ACTIONS.includes(requestedAction)
    || V1_FORBIDDEN_ACTIONS.includes(requestedAction)
    || GRANT_GATED_ACTIONS.includes(requestedAction);
  if (!known) throw new Error(`decideExecution: unknown action "${requestedAction}"`);
  if (!allowed) {
    return { requestedAction, actionAllowed: false, actionBlockedReason: blockedReason };
  }
  if (GRANT_GATED_ACTIONS.includes(requestedAction)) {
    // The INT-6 carve: only a live authority grant unlocks a grant-gated
    // action — not graduation, not humanAuthorizations. And only at an
    // autonomous tier: shadow observes what WOULD export, it never exports.
    if (!grantAuthorities.has(requestedAction)) {
      return { requestedAction, actionAllowed: false, actionBlockedReason: 'requires_authority_grant' };
    }
    if (autonomyLevel !== 'autonomous') {
      return { requestedAction, actionAllowed: false, actionBlockedReason: 'tier_too_low', grantAuthorized: true };
    }
    return { requestedAction, actionAllowed: true, actionBlockedReason: null, grantAuthorized: true };
  }
  if (V1_FORBIDDEN_ACTIONS.includes(requestedAction)) {
    if (!authorizations.has(requestedAction)) {
      // No standing human "yes" — forbidden at every tier (the default, unchanged).
      return { requestedAction, actionAllowed: false, actionBlockedReason: 'requires_human_authority' };
    }
    if (autonomyLevel !== 'autonomous') {
      // Authorized, but autonomy still observes-only at shadow — don't act yet.
      return { requestedAction, actionAllowed: false, actionBlockedReason: 'tier_too_low', humanAuthorized: true };
    }
    return { requestedAction, actionAllowed: true, actionBlockedReason: null, humanAuthorized: true };
  }
  if (!allowedActions.includes(requestedAction)) {
    return { requestedAction, actionAllowed: false, actionBlockedReason: 'tier_too_low' };
  }
  return { requestedAction, actionAllowed: true, actionBlockedReason: null };
};

// ---- graduation transitions -----------------------------------------------

const directionOf = (fromRank, toRank) =>
  toRank === fromRank ? 'none' : toRank > fromRank ? 'up' : 'down';

// Decide whether a proposed tier change is legal. Rules:
//   - UP must be MONOTONE single-step (off->shadow->canary->active); no skipping
//     a rung — the careful rollout discipline, made a rule instead of a habit.
//   - DOWN (incl. straight to 'off') is always legal — a kill switch must slam
//     off from any tier.
//   - ANY change requires an AUTHORITY actor (§13.6); an owner (e.g. client) can
//     never move the tier.
// Non-mutating: returns { allowed, direction, reason, actor? }; caller writes it.
export const decideGraduation = ({ from, to, actorType, actorId = null } = {}) => {
  const fromRank = tierRank(from); // validates names (throws on unknown)
  const toRank = tierRank(to);
  const direction = directionOf(fromRank, toRank);

  if (!isAuthority(actorType)) {
    return { allowed: false, direction, reason: 'authority_required' };
  }
  if (direction === 'none') {
    return { allowed: false, direction, reason: 'no_change' };
  }
  if (direction === 'down') {
    // de-graduation / emergency drop — always permitted to an authority.
    return {
      allowed: true, direction,
      reason: to === 'off' ? 'emergency_stop' : 'de_graduation',
      actor: { actorType, actorId }
    };
  }
  // graduation up: one rung at a time.
  if (toRank - fromRank > 1) {
    return { allowed: false, direction, reason: 'must_graduate_one_step' };
  }
  return { allowed: true, direction, reason: 'graduated', actor: { actorType, actorId } };
};

// The next rung up the ladder, clamped at the top (idempotent at 'active').
export const nextTier = (tier) => {
  const r = tierRank(tier);
  return r + 1 < EXECUTION_TIERS.length ? EXECUTION_TIERS[r + 1] : tier;
};
