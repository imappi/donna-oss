// Donna Loops — the execution GATE bridge (goal-first uplift, design §10 Step 6).
//
// loopExecutionPolicy.js is the PURE graduation model (tier ladder + suspension +
// the §13.8 action taxonomy); it knows nothing about WHERE a firm's tier or a
// suspension comes from. This module is the thin bridge that resolves those from
// the actual SOURCES — the LOOPS_SHADOW env and firms.metadata — and hands the
// pure model a decision to make. It is the ONE place the goal-first loop reads a
// gate; the §2 audit found that control scattered across four mechanisms with no
// shared model, and Step 6 collapses the goal-first loop's slice of that onto this.
//
// The boundary stays where Step 5 put it (loopRunEngine.js:34): the CALLER
// (loopInboxWorker) holds the gate, the engine never reads it. So this is consumed
// by the worker before a wake, not inside the run.
//
// Back-compat is exact and load-bearing. With only LOOPS_SHADOW set (prod today):
//   - LOOPS_SHADOW off  -> global tier 'off'    -> the whole goal layer is inert,
//                          byte-identical to today (the drain skips, nothing runs).
//   - LOOPS_SHADOW on   -> global tier 'shadow' -> every firm defaults to 'shadow'
//                          (today's "observe-only" behaviour), now NAMED.
// A firm is graduated past shadow ONLY by BOTH raising the global ceiling
// (LOOPS_TIER) AND assigning that firm a tier in metadata — so a single env flip
// can never silently push prod to autonomous, the careful-canary discipline the
// repo already follows by hand, now a rule (design §10 / §13.8).
//
// CLAUDE.md "Keep"-layer: this is a system-correctness control (who may act, how
// far) — not intelligence-substituting scaffolding. It calls no LLM and decides no
// verdict; it only gates the bounded wake the strong-model judgment flows through.

import { EXECUTION_TIERS, tierRank, decideExecution } from './loopExecutionPolicy.js';

// The EXACT back-compat predicate (mirrors loopsShadowProducers.isLoopsShadowEnabled)
// so flipping the master behaves byte-identically to today's shadow gate.
const shadowEnvOn = (env) => {
  const raw = String(env?.LOOPS_SHADOW || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
};

const asTier = (value) => {
  const t = String(value || '').trim().toLowerCase();
  return EXECUTION_TIERS.includes(t) ? t : null;
};

const minTier = (a, b) => (tierRank(a) <= tierRank(b) ? a : b);

// The system-wide CEILING (and default tier). An explicit, validated LOOPS_TIER is
// authoritative — the deliberate knob for a canary/active rollout. Absent it, the
// legacy LOOPS_SHADOW master decides: on -> 'shadow', off -> 'off' (inert). An
// invalid LOOPS_TIER is ignored (falls back to the master), never a silent pass.
// Raising the ceiling alone does NOT make any firm autonomous: a firm still defaults
// to 'shadow' until ALSO assigned a tier in metadata, so no single env flip can push
// prod past observe-only — the careful-canary discipline, made a rule (design §10).
export const globalLoopTier = (env = process.env) => {
  const explicit = asTier(env?.LOOPS_TIER);
  if (explicit) return explicit;
  return shadowEnvOn(env) ? 'shadow' : 'off';
};

// The drain-level master switch — replaces isLoopsShadowEnabled() at the drain
// entry. "Is the goal-first loop enabled AT ALL." Off -> skip the whole drain,
// exactly as LOOPS_SHADOW off does today.
export const isLoopSystemEnabled = (env = process.env) =>
  tierRank(globalLoopTier(env)) >= tierRank('shadow');

// The per-FIRM tier for a loop. The firm's metadata assignment, defaulted to
// 'shadow' once the system is on (back-compat: LOOPS_SHADOW on == every firm in
// shadow) and CLAMPED to the global ceiling — a firm can never exceed the master.
// A firm may also explicitly set 'off' to opt OUT while the system runs. The
// per-loop key (loops['<loopKey>'].tier) overrides the firm-wide key (loops.tier).
export const resolveFirmTier = ({ loopKey = null, firmMetadata = null, env = process.env } = {}) => {
  const ceiling = globalLoopTier(env);
  if (ceiling === 'off') return 'off'; // master off — no metadata can lift a firm
  const loops = firmMetadata?.loops || {};
  const perLoop = loopKey ? asTier(loops?.[loopKey]?.tier) : null;
  const firmWide = asTier(loops?.tier);
  const assigned = perLoop || firmWide || 'shadow';
  return minTier(assigned, ceiling);
};

// The firm-level suspension (kill switch) read from firms.metadata.loops.suspended.
// A bare `true` is a minimal kill switch; a richer object ({ reason, authorizedBy…,
// raisedAt }) is carried through verbatim as the governance receipt.
export const resolveFirmSuspension = ({ firmMetadata = null } = {}) => {
  const s = firmMetadata?.loops?.suspended;
  if (!s) return null;
  if (s === true) return { scope: 'firm', reason: 'firm_suspended' };
  return { scope: 'firm', ...s };
};

// Friendly, per-feature settings booleans that map onto a single V1-forbidden
// action — the human-readable face of an authorization. `auto_send_client_asks`
// is the firm's "Donna may send client questions on its own" toggle; turning it on
// authorizes the `client_visible_message` action. Add a row here when a new
// forbidden action gets a settings toggle (e.g. a future auto-post).
const FRIENDLY_AUTHORIZATION_FLAGS = Object.freeze({
  auto_send_client_asks: 'client_visible_message'
});

// The firm's standing HUMAN AUTHORIZATIONS for otherwise-V1-forbidden actions —
// the contract's `human_authorized` criterion (§13.6/§13.8), read from
// firms.metadata.loops. Two sources, unioned:
//   - loops.authorizations: an explicit array of forbidden-action keys, and/or
//   - the friendly per-feature booleans above (loops.auto_send_client_asks => …).
// These are set through firm SETTINGS by an authority actor (audited at write time,
// a later slice); the gate only HONOURS them, and the pure policy only acts on one
// at an autonomous tier. Absent → [] — forbidden-by-default, byte-identical to today.
export const resolveFirmAuthorizations = ({ firmMetadata = null } = {}) => {
  const loops = firmMetadata?.loops || {};
  const out = new Set();
  if (Array.isArray(loops.authorizations)) {
    for (const a of loops.authorizations) if (typeof a === 'string') out.add(a);
  }
  for (const [flag, action] of Object.entries(FRIENDLY_AUTHORIZATION_FLAGS)) {
    if (loops[flag] === true) out.add(action);
  }
  return [...out];
};

// THE gate the worker calls per wake. Resolves the firm's tier + suspension from
// metadata and decides via the pure policy. `caseSuspension` is a forward-compatible
// hook — bookkeeping_cases has no suspension source column yet (a later slice adds
// one), so the worker passes null today; the pure model already honours it. The
// requestedAction is the wake's bounded §13.8 action (the reconciliation wake is
// 'goal_report_only', allowed at shadow+ — so today's behaviour is preserved).
export const decideLoopExecution = ({
  loopKey = null, firmMetadata = null, caseSuspension = null,
  requestedAction = null, env = process.env
} = {}) => {
  const tier = resolveFirmTier({ loopKey, firmMetadata, env });
  const firmSuspension = resolveFirmSuspension({ firmMetadata });
  const humanAuthorizations = resolveFirmAuthorizations({ firmMetadata });
  return decideExecution({ tier, firmSuspension, caseSuspension, requestedAction, humanAuthorizations, loopKey });
};

// Thin DB reader for the worker: the firm's loop-execution context (its metadata).
// Soft-fails to {} so a missing firm / absent column degrades to the default tier
// rather than aborting the surrounding drain — the same no-throw discipline the
// rest of the worker holds.
export const readFirmExecutionContext = async (client, firmId) => {
  if (!client || !firmId) return { firmMetadata: {} };
  const res = await client.query(
    `select metadata from firms where id = $1 limit 1`, [firmId]
  ).catch(() => ({ rows: [] }));
  return { firmMetadata: res.rows?.[0]?.metadata || {} };
};

// ── Legacy GLOBAL feature flags (design §10 Step 6 — "one place the gates are
//    read") ──────────────────────────────────────────────────────────────────
//
// The §2 audit found loop/pipeline control scattered across four mechanisms with
// no shared model. Steps 5–6 collapsed the goal-first loop's slice onto the tier
// model above. The REMAINING legacy gates are GLOBAL pipeline/intelligence kill-
// switches — the `*_ENABLED` env wave in `inngest/parseDocument.js`, the per-cron
// `*_ENABLED` masters — that are NOT per-firm loop wakes: a global on/off pipeline
// toggle has no firm-level graduation, so it would be a category error to route it
// through `decideLoopExecution` (which models a per-firm tier + the §13.8 loop
// action taxonomy). Step 6's win for THESE is to centralize the READ in this one
// module so there is a single predicate — NOT to give them a tier. Behaviour is
// byte-identical to the historical inline predicates (verified in the tests).
//
// `legacyFlagEnabled` reproduces the historical default-OFF shape EXACTLY
// (the *_ENABLED wave): `String(env.X || '').toLowerCase() === 'true'`. No
// trim (the inline predicates didn't trim — matching that is the whole
// point). The default-ON shape (`String(env.X ?? 'true') !== 'false'`, the
// shadow-mode idiom) lost its last caller in RT-05 and was deleted in RT-14:
// a flag that is ON when unset is the anti-pattern the config-plane rail
// exists to end, so the helper no longer offers it.
export const legacyFlagEnabled = (name, { env = process.env } = {}) =>
  String(env?.[name] || '').toLowerCase() === 'true';
