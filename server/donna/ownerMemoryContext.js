// Donna — BizOS Slice 2c-iii (sub-PR 1): the owner memory-context TAXONOMY +
// TYPED COMPOSITION. The pure, dependency-free half of the canary seam (§C, §E1).
//
// 2c-ii stamped the v2 bundle as telemetry beside an untouched legacy prompt.
// 2c-iii feeds a governed v2 section INTO the owner prompt for a canaried client.
// This module is the boundary that makes that safe to reason about:
//
//   1. `classifyRetrieval` — maps a `buildMemoryBundle` outcome to the §E1
//      discriminated STATUS TAXONOMY (`available` / `empty` / `unavailable` /
//      `blocked`). Amendment 1: a memory block is NOT binary. A successful
//      zero-result read (`empty`) must behave differently from a timeout
//      (`unavailable`) or an integrity failure (`blocked`). "Fail closed"
//      sometimes means a controlled *unavailable*/*blocked* response, never
//      "answer normally with an empty block."
//
//   2. `legacyMemoryContext` / `v2MemoryContext` — the DISCRIMINATED UNION
//      constructors (§C). The v1 `context.known_facts = null; context.memory =
//      section` mutation permitted impossible states (both present; a degraded
//      status carrying facts). The v2 constructor REFUSES those at construction.
//
//   3. `composeOwnerPromptContext` — accepts EXACTLY one memory mode and returns
//      a NEW prompt context (never mutates a base context already built with
//      legacy facts). Strips any pre-existing memory fields, then sets exactly
//      one — so a copied legacy field can never ride along into a v2 prompt.
//
//   4. `assertNoCrossModeMemoryLeak` — the defence-in-depth invariant (§C/§F,
//      invariant 10): the composed prompt context carries memory for the DECLARED
//      mode only, and a degraded status (`unavailable`/`blocked`) carries no
//      memory content at all.
//
// This module does NOT render the fact values into a prompt-safe block — that is
// sub-PR 2 (`ownerMemoryRender.js`, the per-predicate typed renderer, §E2/§E3).
// It also does NOT read config, touch the DB, or call the model. Pure leaf,
// unit-tested with hand-built inputs.

import { RETRIEVAL_FAILURES } from './memoryRetrieval.js';

// ── The §E1 status taxonomy ──────────────────────────────────────────────────

// The four discriminated statuses a v2 memory context can carry. The composer and
// the prompt act on each differently (§E1 table): `available` uses the memory;
// `empty` proceeds normally without implying a failure; `unavailable` answers
// general questions but asserts no stored business facts; `blocked` is a
// controlled memory-unavailable / security response with no memory-dependent
// answer at all.
export const MEMORY_STATUSES = Object.freeze(['available', 'empty', 'unavailable', 'blocked']);

// The allowlisted, non-leaky public reason a caller may surface for a non-happy
// status (`null` when there is nothing to say — `available`/`empty`). Deliberately
// coarse: it never reveals which record, subject, or policy was involved.
export const MEMORY_PUBLIC_REASONS = Object.freeze(['timeout', 'service_error', 'identity', 'integrity', 'policy']);

// The statuses that MUST carry no memory content (no facts, no conflict markers).
// A degraded read surfaces nothing — the whole point of amendment 1.
const DEGRADED_STATUSES = Object.freeze(new Set(['unavailable', 'blocked']));

// RETRIEVAL_FAILURES (§12) → { status, public_reason }. The mapping is the
// load-bearing §E1 decision, kept in ONE table so the taxonomy is auditable.
//
//   - `service_unavailable`         → unavailable (system momentarily down; not a
//                                      security event; the model may say memory is
//                                      temporarily unavailable and answer general
//                                      questions without asserting stored facts).
//   - `subject_ambiguous`           → unavailable (retrieval could not pin which
//                                      business subject the owner meant; decline to
//                                      assert stored facts — but not a hard block).
//   - `integrity_failed`            → blocked/integrity. HARD-STOPS the
//                                      memory-dependent turn (amendment 1: not
//                                      "alert and continue").
//   - `principal_unresolved`        → blocked/identity  (who is asking is unknown).
//   - `audience_unresolved`         → blocked/identity.
//   - `policy_denied`               → blocked/policy. NOTE: an ordinary per-record
//     `acl_resolution_failed`         purpose exclusion never reaches here — those
//     `consumer_not_permitted`        stay INSIDE an `ok` result (empty/available).
//                                      A TOP-LEVEL refusal on these is an
//                                      unexpected denial → fail closed, not empty.
//   - `invalid_request`             → blocked/service_error. A wiring bug at canary
//     `unknown_purpose`               must fail loud + closed (it fires every turn
//                                      until rolled back), never silently degrade.
//
// A `policy_denied` that is an EXPECTED purpose outcome is represented upstream as
// an `ok` result with zero eligible items (→ `empty`); it is never a top-level
// refusal. So classifying a top-level `policy_denied`/`acl_resolution_failed` as
// `blocked` matches "consciously classified as empty (expected) OR blocked
// (unexpected) — never hidden in a universal empty array" (§E1).
const FAILURE_TAXONOMY = Object.freeze({
  service_unavailable:    { status: 'unavailable', public_reason: 'service_error' },
  subject_ambiguous:      { status: 'unavailable', public_reason: 'service_error' },
  integrity_failed:       { status: 'blocked',     public_reason: 'integrity' },
  principal_unresolved:   { status: 'blocked',     public_reason: 'identity' },
  audience_unresolved:    { status: 'blocked',     public_reason: 'identity' },
  policy_denied:          { status: 'blocked',     public_reason: 'policy' },
  acl_resolution_failed:  { status: 'blocked',     public_reason: 'policy' },
  consumer_not_permitted: { status: 'blocked',     public_reason: 'policy' },
  invalid_request:        { status: 'blocked',     public_reason: 'service_error' },
  unknown_purpose:        { status: 'blocked',     public_reason: 'service_error' }
});

// Static assertion (dev-time): every declared RETRIEVAL_FAILURES value has a
// taxonomy mapping, so a new failure code can never fall through to a silent
// default. Runtime keeps a fail-closed default too (below).
for (const failure of RETRIEVAL_FAILURES) {
  if (!FAILURE_TAXONOMY[failure]) {
    throw new Error(`ownerMemoryContext: RETRIEVAL_FAILURES value '${failure}' has no §E1 taxonomy mapping`);
  }
}

// A budget-trimmed authorised memory surfaces as a caller-observable exclusion in
// the consumer receipt (`reason_category ∈ {budget, item_too_large}`), NOT as a
// failure. When present, the projection is partial → the model must be told it is
// `incomplete` (amendment 1 / test 11), never implied complete.
const TRUNCATION_REASONS = Object.freeze(new Set(['budget', 'item_too_large']));

const hasBudgetTruncation = (result) => {
  const visibleExcluded = result?.consumer_receipt?.visible_excluded;
  return Array.isArray(visibleExcluded)
    && visibleExcluded.some((r) => TRUNCATION_REASONS.has(r?.reason_category));
};

// classifyRetrieval({ result, timedOut, threw }) → { status, public_reason, incomplete }
//
// The single §E1 mapper. `result` is a `buildMemoryBundle` return; `timedOut` is
// set by the deadline wrapper (§J, sub-PR 6) when the hot-path retrieval was
// cancelled; `threw` is set when the retrieval call raised (invariant 10a — a
// throw must yield no-memory, never legacy).
export const classifyRetrieval = ({ result = null, timedOut = false, threw = false } = {}) => {
  // A cancelled retrieval is a controlled degradation, distinct from a zero-result
  // read. It never falls back to legacy (§D) — the caller renders an empty section.
  if (timedOut) return { status: 'unavailable', public_reason: 'timeout', incomplete: false };

  // A raised retrieval is unexpected but must still fail to no-memory, not legacy.
  if (threw || !result || typeof result !== 'object') {
    return { status: 'unavailable', public_reason: 'service_error', incomplete: false };
  }

  if (result.status === 'ok') {
    const items = result.bundle?.context_items;
    const n = Array.isArray(items) ? items.length : 0;
    const incomplete = hasBudgetTruncation(result);
    // `available` iff ≥1 usable recorded fact; a pure-conflict result (0 items,
    // ≥1 conflict marker) is `empty` — there is nothing to ASSERT, only to flag.
    return { status: n > 0 ? 'available' : 'empty', public_reason: null, incomplete };
  }

  // A refusal maps through the §E1 table; an unknown code fails closed to blocked
  // (never a silent "answer normally").
  const mapped = FAILURE_TAXONOMY[result.failure];
  if (mapped) return { ...mapped, incomplete: false };
  return { status: 'blocked', public_reason: 'service_error', incomplete: false };
};

// ── The discriminated memory-context union (§C) ──────────────────────────────

// The LEGACY arm — the firm_facts paste, unchanged. Carried behind the flag for a
// deliberate, instant rollback (§G). `known_facts` is whatever
// buildClientPortalChatContext produced (an array of fact strings, or null).
export const legacyMemoryContext = ({ knownFacts = null } = {}) =>
  Object.freeze({ mode: 'legacy', known_facts: knownFacts ?? null });

// The V2 arm — the governed, classified section. Construction VALIDATES the
// discriminated union so an impossible state cannot be built (§C, test 2):
//   - status must be one of MEMORY_STATUSES;
//   - public_reason must be an allowlisted reason or null;
//   - `available` REQUIRES ≥1 recorded fact;
//   - `empty` carries NO recorded facts (conflict markers allowed);
//   - `unavailable`/`blocked` carry NO memory content at all (no facts, no
//     conflicts) — a degraded read surfaces nothing (amendment 1).
//
// `recorded_facts` and `conflicts` are the already-prompt-safe arrays produced by
// the sub-PR 2 renderer; this constructor only shapes + validates the envelope.
export const v2MemoryContext = ({
  status,
  public_reason = null,
  recorded_facts = [],
  conflicts = [],
  as_of = null,
  incomplete = false
} = {}) => {
  if (!MEMORY_STATUSES.includes(status)) {
    throw new Error(`v2MemoryContext: invalid status '${status}'`);
  }
  if (public_reason != null && !MEMORY_PUBLIC_REASONS.includes(public_reason)) {
    throw new Error(`v2MemoryContext: invalid public_reason '${public_reason}'`);
  }
  const facts = Array.isArray(recorded_facts) ? recorded_facts : [];
  const marks = Array.isArray(conflicts) ? conflicts : [];

  if (DEGRADED_STATUSES.has(status) && (facts.length || marks.length)) {
    throw new Error(`v2MemoryContext: status '${status}' must carry no memory content (facts=${facts.length}, conflicts=${marks.length})`);
  }
  if (status === 'available' && facts.length === 0) {
    throw new Error("v2MemoryContext: status 'available' requires ≥1 recorded fact");
  }
  if (status === 'empty' && facts.length > 0) {
    throw new Error("v2MemoryContext: status 'empty' must carry no recorded facts");
  }

  return Object.freeze({
    mode: 'v2',
    status,
    public_reason: public_reason ?? null,
    recorded_facts: Object.freeze(facts),
    conflicts: Object.freeze(marks),
    as_of: as_of ?? null,
    incomplete: !!incomplete
  });
};

// ── Composition (§C) — one mode, no mutation ─────────────────────────────────

// The stable prompt-context field the v2 section lives under.
export const MEMORY_CONTEXT_FIELD = 'memory';
// The stable field the legacy paste lives under (matches buildClientPortalChatContext).
export const LEGACY_FACTS_FIELD = 'known_facts';
// The governed, epoch-fenced history (§F, sub-PR 5) lives under this field.
export const MEMORY_HISTORY_FIELD = 'memory_history';

// composeOwnerPromptContext({ baseContext, memoryContext, history }) → new context
//
// Returns a NEW object. NEVER mutates baseContext (§C: the composer must not
// mutate a context already built with legacy facts). Strips ANY pre-existing
// memory fields from the copy, then sets EXACTLY one arm — so a legacy field can
// never ride along into a v2 prompt, and vice versa.
export const composeOwnerPromptContext = ({ baseContext = {}, memoryContext, history } = {}) => {
  if (!memoryContext || (memoryContext.mode !== 'legacy' && memoryContext.mode !== 'v2')) {
    throw new Error('composeOwnerPromptContext: memoryContext must be a legacy or v2 discriminated union');
  }
  const base = baseContext && typeof baseContext === 'object' ? baseContext : {};
  // Drop both memory arms from the copy up front — exactly one is re-set below.
  const {
    [LEGACY_FACTS_FIELD]: _legacyDrop,
    [MEMORY_CONTEXT_FIELD]: _v2Drop,
    ...rest
  } = base;
  const out = { ...rest };

  if (memoryContext.mode === 'legacy') {
    out[LEGACY_FACTS_FIELD] = memoryContext.known_facts ?? null;
    out[MEMORY_CONTEXT_FIELD] = null;
  } else {
    out[LEGACY_FACTS_FIELD] = null;
    out[MEMORY_CONTEXT_FIELD] = memoryContext;
  }

  // The governed history is threaded through when supplied (the epoch fence, §F).
  // `undefined` means "caller did not manage history here" → leave base's copy.
  if (history !== undefined) out[MEMORY_HISTORY_FIELD] = history;

  return out;
};

// assertNoCrossModeMemoryLeak(promptContext, mode) — defence in depth (§C/§F).
//
// The caller DECLARES the mode it intended; this asserts the composed context
// matches, with no cross-contamination. Throws on any leak (invariant 10). A
// belt-and-braces check on top of the constructor + composer guarantees.
export const assertNoCrossModeMemoryLeak = (promptContext, mode) => {
  if (!promptContext || typeof promptContext !== 'object') {
    throw new Error('assertNoCrossModeMemoryLeak: no prompt context');
  }
  if (mode !== 'legacy' && mode !== 'v2') {
    throw new Error(`assertNoCrossModeMemoryLeak: unknown mode '${mode}'`);
  }

  const legacy = promptContext[LEGACY_FACTS_FIELD];
  // An empty array / null legacy field is not a leak — only actual carried facts.
  const hasLegacyFacts = legacy != null && !(Array.isArray(legacy) && legacy.length === 0);
  const memory = promptContext[MEMORY_CONTEXT_FIELD];
  const hasV2 = memory != null && typeof memory === 'object' && memory.mode === 'v2';

  if (mode === 'v2') {
    if (hasLegacyFacts) {
      throw new Error('cross-mode leak: v2 mode but legacy known_facts present in prompt context');
    }
    if (!hasV2) {
      throw new Error('cross-mode leak: v2 mode but no v2 memory context present');
    }
    if (DEGRADED_STATUSES.has(memory.status)
      && ((memory.recorded_facts || []).length || (memory.conflicts || []).length)) {
      throw new Error(`cross-mode leak: v2 status '${memory.status}' carries memory content`);
    }
  } else {
    // legacy mode — no v2 section may be present.
    if (hasV2) {
      throw new Error('cross-mode leak: legacy mode but v2 memory context present in prompt context');
    }
  }
  return true;
};
