import { releaseAdmissionLeasePreservingError } from './db/admissionLeaseLifecycle.js';
// Shared core for the LLM-mode reconciliation matchers — Slice E
// cleanup pass.
//
// `salesInvoiceReconciliationLlm.js` (AR) and
// `supplierBillReconciliationLlm.js` (AP) shipped as parallel modules
// that shared ~60% line-for-line content with direction-flipped
// tokens. Shipping them separately was the right call while the AP
// path was still being added — refactoring the live AR path in the
// same PR as adding AP was needless risk. Now that both paths are
// live + validated on a pilot client and each is pinned by its own test suite,
// the duplicated pieces live here once and the per-direction modules
// are thin wrappers that supply a "spec":
//
//   - the system prompt (genuinely different AR vs AP text),
//   - the user-prompt builder (different field names + bank-line
//     direction),
//   - the SQL queries (different document_type filter, money_in vs
//     money_out, counterparty column, matched_object_type),
//   - the object type / source string / match_kind / log tag.
//
// Everything else — window math, id derivation, response validation,
// the Anthropic call, and the UPSERT + audit + cascade block — is
// direction-agnostic and lives here. Adding a third matcher
// (receipts, payment confirmations, …) is now a one-spec PR.
//
// This is intelligence-NEUTRAL scaffolding: it does not add rules
// that compensate for the model. It is system-correctness plumbing
// around the load-bearing strong-LLM call (idempotent UPSERT, audit
// trail, cascade to payment status). Keep it that way — see
// CLAUDE.md and docs/donna-llm-trust-strategy.md.

import { extractJson } from './extractJson.js';
import { assertExecutionBudgetActive, clearVerdictTransactionBudget, currentExecutionBudget } from './executionBudget.js';
import { materialityCeilingForJurisdiction } from './outbound/packs.js';
import { cascadeAutoMatch } from './reconciliationTriage.js';
import { applyConvergenceStateBestEffort } from './reconcileConvergenceState.js';
import { applyDocumentPaymentStatusAfterMatch } from './firmDb.js';
import { assessDocumentEntityAlignment, crossEntityPayload, readClientIdentityWithClient } from './crossEntityGuard.js';
import { toIsoDay } from './dates.js';
// Config control plane for the reconciliation capabilities that remain staged.
// Distinct-date twin pairing graduated to foundational behaviour in 2026-08 and
// intentionally no longer consults this plane.
import { clientFlagActs } from './clientConfig.js';
import { firstLineLaneDecides } from './firstLineLane.js';
// Decision ledger (Phase 0B — family-matcher coverage). Records the auto-match
// authority decision (the band authorizeMatch produced) into llm_decisions, so the
// 0A.10 auto-match flips are visible to the ledger and carry the config snapshot they
// ran under. llmDecisions is a leaf (node:crypto only) — no import cycle. The write is
// ADDITIVE + SOFT-FAIL: a logging error never affects the match persist.
import { recordLlmDecision } from './llmDecisions.js';
import { classifyModelProvenance, shapeOpenAiCompatibleRequest } from './providerEndpoints.js';
// Q7 (the model lab, 2026-08-16): the compatible deciding path rides the
// llmCall envelope (sizes-only telemetry, typed refusals). llmCall is a leaf
// module (node built-ins only) — no import cycle.
import { llmCall } from './llmCall.js';
import { acquireEntityReadinessAdmissionLeaseWithClient } from './runtimeReadinessAdmission.js';
// The shared provider transport (2026-09-13): one deadline over headers +
// body bounded by the worker's execution budget, and ONE typed failure for a
// missing key, 401/403, 429/5xx, a reset socket, a hung request and an
// unreadable body. Leaf module (node built-ins + executionBudget.js) — no
// import cycle.
import {
  budgetAllowsRetry,
  classifyProviderStatus,
  classifyProviderThrow,
  fetchProviderJson,
  isProviderFailure,
  providerFetchWithDeadline,
  providerInvalidOutput,
  waitForProviderRetry
} from './providerTransport.js';
// RT-27 — the credit-note application writer + the call-local credit handle.
// Used only inside functions (never at module init): creditNoteApplications
// imports this core back for the evaluation/receipt helpers, the same
// call-time cycle shape as firmDb ↔ core.
import { applyCreditApplicationsWithClient, creditRefForIndex } from './creditNoteApplications.js';

export { toIsoDay };

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const MAX_BANK_LINES_PER_CALL = 40;
export const WINDOW_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_AUTO_THRESHOLD = 0.85;
export const FEW_SHOT_LIMIT = 3;
// Cap on the known-counterparty roster passed into the matcher prompt —
// keeps the "who the firm pays/invoices" list compact (a few hundred
// chars) rather than dumping a 500-contact Xero book into every call.
export const MAX_KNOWN_COUNTERPARTIES = 40;

// Model-facing candidate identity is deliberately call-local and compact.
// Production transaction ids share very long client/document prefixes and
// often differ only in a trailing tx number. Asking a model to copy one of
// those opaque strings lets correct reasoning attach to the wrong valid row.
// The model sees candidate_1..N; this boundary maps the chosen reference back
// to the exact persisted id before any authorization or write runs.
export const candidateRefForIndex = (index) => `candidate_${Number(index) + 1}`;

const candidateReferenceMaps = (candidateBankLines = []) => {
  const refToId = new Map();
  const idToRef = new Map();
  candidateBankLines.forEach((candidate, index) => {
    const id = candidate?.id == null ? '' : String(candidate.id);
    if (!id) return;
    const ref = candidateRefForIndex(index);
    refToId.set(ref, id);
    idToRef.set(id, ref);
  });
  return { refToId, idToRef };
};

// Per the weighted matcher's SUPPRESSION_STATUSES. Keeps both
// matchers in lockstep on firm-decision honouring — when the firm
// has rejected or confirmed a (tx, doc) pair, the LLM matcher must
// not re-propose against that same pair.
export const SUPPRESSION_STATUSES = new Set(['rejected', 'confirmed', 'auto_matched']);

// The RECONCILIATION_MATCHER_MODE gate is GONE (batch-2 terminal state 1,
// docs/donna-batch2-matcher-mode-dead-branch-plan.md): LLM-primary matching
// is unconditional for every family — the mode had been 'llm' in prod since
// Slice E graduated, so the weighted-PRIMARY branch was dead code. The
// weighted matcher BODY survives on its three live paths (LLM self-disable
// without an API key, infrastructure throw, the receipt exact-match
// backstop); per-family canarying stays on the matcher-level FLAG_ENABLED
// of each weighted orchestrator.

export const getAutoThreshold = () => {
  const raw = process?.env?.RECONCILIATION_LLM_AUTO_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_AUTO_THRESHOLD;
};

// ── Auto-match authority policy ──────────────────────────────────────
//
// See docs/proposal-2026-06-21-reconciliation-auto-match-authority.md.
//
// `auto_matched` is not a label — it is an unattended state mutation
// (writes the match row, suppresses re-proposal, cascades to payment
// state). The strong model decides WHICH bank line settles a document;
// it does NOT get to grant itself that authority from its own
// self-reported confidence. `authorizeMatch` is the separate authority
// decision: given the model's chosen target + the candidate set + the
// document, it returns the BAND only ('auto_matched' | 'suggested').
//
// CRITICAL (CLAUDE.md §2 + proposal §5): the gates do NOT rank
// candidates, re-score the match, or override the model's target
// choice — that would be the intelligence-substituting scaffolding we
// are retiring. They decide ONLY whether the model's judgment executes
// unattended. A failed gate SURFACES the match ('suggested') — it never
// hides it. The worst band is 'suggested'; nothing is rejected here.
//
// Off by default (RECONCILIATION_AUTO_MATCH_POLICY unset → everything
// 'suggested'), per the staged rollout: suggestion-only first, then
// per-firm canary with the full gate stack.
//
// CLIENT-SCOPED CANARY (RECONCILIATION_AUTO_MATCH_CLIENTS): the enable
// flag above is GLOBAL — flipping it grants unattended auto-match to
// every firm at once, the exact "not a global flip" hazard the extractor
// canary (EXTRACTOR_CLIENTS) already solved. The optional comma-separated
// client-id allowlist scopes auto-execution to the listed clients (the
// pilot-first canary) and FAILS CLOSED for any other or missing client —
// surfacing their matches as 'suggested', never hiding them. Unset = no
// client restriction (so the eventual full un-gate is just dropping the
// var). It composes with the enable flag and never overrides it: policy
// disabled → everything 'suggested' regardless of the allowlist; enabled
// + allowlist set → only listed clients auto-execute; enabled + allowlist
// unset → the prior global behaviour. NEVER delete
// RECONCILIATION_AUTO_MATCH_CLIENTS while the policy stays enabled — that
// silently widens the canary to a global flip.
export const DEFAULT_AUTO_MATCH_FLOOR = 0.9;          // above the observed 0.83–0.88 straddle zone
export const DEFAULT_AUTO_MATCH_SEPARATION = 0.1;     // margin over the runner-up proposal
export const DEFAULT_AUTO_MATCH_AMOUNT_ABS_TOL = 0.01;
export const DEFAULT_AUTO_MATCH_AMOUNT_REL_TOL = 0.005;
export const DEFAULT_AUTO_MATCH_FX_MIN = 0.3;         // sane implied-FX-rate band (absurd-coincidence guard)
export const DEFAULT_AUTO_MATCH_FX_MAX = 3.0;
export const DEFAULT_AUTO_MATCH_FEE_FLOOR = 0.8;      // same-currency processor-fee shortfall floor

const envNum = (name, fallback) => {
  const n = Number(process?.env?.[name]);
  return Number.isFinite(n) ? n : fallback;
};
// Optional `env` (defaults to process.env) so the canary predicates below are
// unit-testable without mutating the process — the auto-match callers pass one
// arg and keep the prior process.env behaviour verbatim.
const envFlag = (name, env = process?.env) => {
  const v = String(env?.[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
};
// Comma-separated client-id allowlist (the auto-match canary scope).
// Mirrors the extractor's EXTRACTOR_CLIENTS parsing. Returns null when
// unset/empty (= no client restriction), else the trimmed id array.
const envClientAllowlist = (name, env = process?.env) => {
  const raw = env?.[name];
  if (!raw) return null;
  const items = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return items.length ? items : null;
};

// 0A.10 — shared flag key for the config control plane. The auto-match CLIENT
// allowlist is the NARROW-only authority boundary; flag_key is RECONCILIATION_AUTO_MATCH
// so the env allowlist var is ${KEY}_CLIENTS (= RECONCILIATION_AUTO_MATCH_CLIENTS) — the
// established convention. The master enable RECONCILIATION_AUTO_MATCH_POLICY is a SEPARATE
// var and is NOT migrated (it stays the global env enable, mirroring EXTRACTOR_MODE for the
// extractor canary); the config plane governs only the per-client allowlist dimension.
export const AUTO_MATCH_FLAG_KEY = 'RECONCILIATION_AUTO_MATCH';

// Resolve the policy from env on every call (deploy-time flips). All
// values configurable; the whole stack is gated behind the enable flag.
//
// RT-11 / decision D2 (2026-09-02): the materiality ceiling FOLLOWS THE PACK.
// `jurisdiction` (the client's) resolves the authored pack's
// reconciliation.materiality_ceiling, declared in the pack's HOME currency;
// the RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING env value is the ONLY
// override (set ⇒ it wins, whatever the pack says). No jurisdiction / no pack
// / no env ⇒ NaN, the F1 unset marker below. The receipt names the source so a
// persisted authorization can say WHY 500 was the line. RT-11b (2026-09-02):
// every family matcher threads the client's jurisdiction (loadFirmContext's
// clientIdentity) and the desktop host no longer stamps the env value at boot,
// so on the appliance the pack governs; a caller passing no jurisdiction gets
// env-or-unset, never an invented number.
export const getAutoMatchPolicy = ({ jurisdiction = null } = {}) => {
  const envCeiling = envNum('RECONCILIATION_AUTO_MATCH_MATERIALITY_CEILING', NaN);
  const packCeiling = Number.isFinite(envCeiling) ? null : materialityCeilingForJurisdiction(jurisdiction);
  return {
    enabled: envFlag('RECONCILIATION_AUTO_MATCH_POLICY'),
    floor: envNum('RECONCILIATION_AUTO_MATCH_FLOOR', DEFAULT_AUTO_MATCH_FLOOR),
    separation: envNum('RECONCILIATION_AUTO_MATCH_SEPARATION', DEFAULT_AUTO_MATCH_SEPARATION),
    amountAbsTol: envNum('RECONCILIATION_AUTO_MATCH_AMOUNT_ABS_TOL', DEFAULT_AUTO_MATCH_AMOUNT_ABS_TOL),
    amountRelTol: envNum('RECONCILIATION_AUTO_MATCH_AMOUNT_REL_TOL', DEFAULT_AUTO_MATCH_AMOUNT_REL_TOL),
    fxMin: envNum('RECONCILIATION_AUTO_MATCH_FX_MIN', DEFAULT_AUTO_MATCH_FX_MIN),
    fxMax: envNum('RECONCILIATION_AUTO_MATCH_FX_MAX', DEFAULT_AUTO_MATCH_FX_MAX),
    feeFloor: envNum('RECONCILIATION_AUTO_MATCH_FEE_FLOOR', DEFAULT_AUTO_MATCH_FEE_FLOOR),
    // F1 (2026-07-06, Kari): unset ceiling REFUSES act-mode instead of ∞.
    // NaN is the unset marker — Gate E fails closed on it with the distinct
    // reason 'materiality_ceiling_unset' (a config error, deliberately NOT a
    // pending-authority/grant-eligible hold).
    materialityCeiling: Number.isFinite(envCeiling) ? envCeiling : (packCeiling?.ceiling ?? NaN),
    materialityCeilingSource: Number.isFinite(envCeiling)
      ? 'env'
      : (packCeiling ? `pack:${packCeiling.pack_id}` : 'unset'),
    materialityCeilingCurrency: Number.isFinite(envCeiling) ? null : (packCeiling?.currency ?? null),
    // null = no client restriction (global, the prior behaviour); else the
    // canary's allowlisted client ids. Fails closed for any other client.
    clientAllowlist: envClientAllowlist(`${AUTO_MATCH_FLAG_KEY}_CLIENTS`)
  };
};

// Whether `clientId` may receive UNATTENDED auto-matches under the current
// policy's client allowlist (RECONCILIATION_AUTO_MATCH_CLIENTS). This is the
// SAME client-scoped canary check authorizeMatch applies (its "fails closed for
// any client not on a set allowlist" gate), extracted so the LEGACY triage
// matchers — receipt / bill / salesInvoice / paymentConfirmation /
// paymentAccountStatement, which promote to 'auto_matched' WITHOUT going through
// authorizeMatch — honor the same authority boundary. Promotion to auto_matched
// is an authority-bearing effect; it must not be reachable from a matcher that
// bypasses the canary. (The Honeybee leak: a non-allowlisted client auto-confirmed
// via the legacy receipt/bill matchers when the strong path fell back to them.)
//
// Deliberately NARROWING only: returns true when no allowlist is configured (the
// prior global behaviour — a no-op for every firm that has not set the canary, so
// existing matcher behaviour and tests are unchanged), and false (→ the caller
// writes 'suggested') for any client not on a SET allowlist. It does NOT consult
// policy.enabled — the legacy matchers auto-match independent of that flag, and
// this gate only fails them closed, never widens them. Fuller parity (routing the
// legacy auto decision through the complete authorizeMatch gate stack, incl. the
// ambiguity/twin guard) is a follow-up.
// 0A.10 — the env allowlist predicate is now the FALLBACK behind the config
// control plane. A `client_capability_config` row for this client decides
// (canary/auto act; off carves the client OUT of auto-match → 'suggested');
// no row ⇒ the flag's own NARROW-only env predicate (byte-identical). The
// `policy` arg is preserved so callers passing an explicit policy (and the unit
// tests) behave exactly as before. configSnapshot is threaded once per run by
// each matcher; null ⇒ env only.
export const clientAllowedToAutoMatch = (
  clientId,
  policy = getAutoMatchPolicy(),
  { configSnapshot = null, env = process.env } = {}
) => clientFlagActs({
  flagKey: AUTO_MATCH_FLAG_KEY,
  snapshot: configSnapshot,
  envFallback: () => {
    const allow = policy?.clientAllowlist;
    if (!Array.isArray(allow) || allow.length === 0) return true; // no restriction set
    const id = clientId == null ? '' : String(clientId).trim();
    return !!id && allow.includes(id);
  },
  env
});

// The §15 delegated-authority canary — the AUTHORITY boundary for the #5
// material-match auto-accept (docs/proposal-2026-06-23-delegated-authority-
// material-matches.md §15). Sibling of clientAllowedToAutoMatch above; it lives
// in core because it is a pure authority predicate the grant store
// (applyDelegatedAuthority / findActiveAuthorityGrant) gates on — keeping the
// import edge pointing store→core. (The firm-facing authorization-ask producer
// that also gated on it was retired in E2, the 2026-06-24 no-gate decision.)
//
// Unlike the auto-match canary (which only NARROWS an already-on policy), this
// GATES THE WHOLE feature: returns true ONLY when the flag is on AND (no
// allowlist OR the client is on it). Fail-closed by default → delegated
// authority is inert in prod until Slice 6b flips the flag for a canary client.
// Reads `env` (defaults to process.env) so the gate is testable and reads env,
// never a code default. NEVER widen by deleting RECONCILIATION_DELEGATED_AUTHORITY_CLIENTS
// while the flag is on — that silently turns the per-client canary into a global flip.
// 0A.8: shared flag key so the env master var and the config-plane DB flag_key can never
// drift (mirrors MATERIAL_AUTO_FYI_FLAG_KEY). This env predicate is now the FALLBACK behind
// the config control plane — applyDelegatedAuthority / findActiveAuthorityGrant route the
// gate through clientFlagActs with `() => delegatedAuthorityCanaryAllows(clientId, env)` as
// envFallback, so a client with no client_capability_config row keeps exactly this behaviour.
export const DELEGATED_AUTHORITY_FLAG_KEY = 'RECONCILIATION_DELEGATED_AUTHORITY';
export const delegatedAuthorityCanaryAllows = (clientId, env = process.env) => {
  if (!envFlag(DELEGATED_AUTHORITY_FLAG_KEY, env)) return false;
  const allow = envClientAllowlist(`${DELEGATED_AUTHORITY_FLAG_KEY}_CLIENTS`, env);
  if (!allow) return true; // flag on, no allowlist → every client
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// Whether a client allowlist was IN FORCE for the delegated-authority canary at
// call time — the env-state half of the accept receipt. Paired with the match's
// client_id it reconstructs "auto-executed under the <client>-only canary" from
// the data alone (CLAUDE.md "the model id is the receipt"). Mirrors
// policyReceipt.client_scoped for the auto-match path: true ⇒ a SET allowlist
// scoped this accept; false ⇒ the flag was on globally (no allowlist).
export const delegatedAuthorityClientScoped = (env = process.env) => {
  const allow = envClientAllowlist(`${DELEGATED_AUTHORITY_FLAG_KEY}_CLIENTS`, env);
  return Array.isArray(allow) && allow.length > 0;
};

// The no-gate material auto-post canary (2026-06-24 decision). A confident
// MATERIAL match (A–D affirmatively proved, only Gate E held) with NO covering
// grant does NOT rest on a firm CONFIRM/DECLINE click (the retired firm-ask) —
// the firm's STANDING POLICY is that it auto-reconciles + FYIs the owner
// (CLAUDE.md FIRST principle: confident ⇒ auto-reconcile; unsure ⇒ ask the
// OWNER, never a firm click queue). This predicate is the AUTHORITY boundary for
// that auto-post.
//
// It is a DEDICATED, brand-new var, deliberately NOT the §15 delegated-authority
// canary: auto-posting a material movement with NO per-line authority receipt is
// the single most consequential reconcile capability, so it gets its OWN explicit
// fail-closed switch that is GUARANTEED unset in prod — merging this can never
// silently flip a live book into material auto-posting (CLAUDE.md "do NOT flip
// prod silently / the model id is the receipt / verify the running tree"). Mirrors
// RECONCILIATION_AUTO_MATCH_CLIENTS exactly: flag on AND (no allowlist OR the
// client is on it). Fail-closed by default. NEVER widen by deleting the _CLIENTS
// allowlist while the flag is on — that silently turns the per-client canary into
// a global flip.
//
// 0A.5: this env predicate is now the FALLBACK behind the config control plane —
// applyMaterialAutoFyi passes `() => materialAutoFyiCanaryAllows(clientId, env)` as
// clientFlagActs' envFallback, so a client with no client_capability_config row keeps
// exactly this behaviour. The flag key is shared with the config plane via
// MATERIAL_AUTO_FYI_FLAG_KEY so the env master var and the DB flag_key can never drift.
export const MATERIAL_AUTO_FYI_FLAG_KEY = 'RECONCILIATION_MATERIAL_AUTO_FYI';
export const materialAutoFyiCanaryAllows = (clientId, env = process.env) => {
  if (!envFlag(MATERIAL_AUTO_FYI_FLAG_KEY, env)) return false;
  const allow = envClientAllowlist(`${MATERIAL_AUTO_FYI_FLAG_KEY}_CLIENTS`, env);
  if (!allow) return true; // flag on, no allowlist → every client (the full un-gate)
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// The env-state half of the auto-FYI accept receipt (twin of
// delegatedAuthorityClientScoped): true ⇒ a SET allowlist scoped this auto-post;
// false ⇒ the flag was on globally. Paired with the match's client_id it
// reconstructs "auto-posted under the <client>-only canary" from the data alone.
export const materialAutoFyiClientScoped = (env = process.env) => {
  const allow = envClientAllowlist(`${MATERIAL_AUTO_FYI_FLAG_KEY}_CLIENTS`, env);
  return Array.isArray(allow) && allow.length > 0;
};

// Distinct-date twin pairing (graduated 2026-08-27). The deterministic tie layer
// (indistinguishableTieGroups → the user-prompt tie note + the output mirroring +
// Gate D) treats two candidates sharing amount + currency + counterparty as an
// INDISTINGUISHABLE tie REGARDLESS of date — so a vendor the firm pays repeatedly
// at the same price (a daily fuel stop, a fixed-price subscription, the morning
// coffee) used to trip the tie on its OWN siblings even though each receipt's DATE ties
// it to exactly one bank line. That parks trivially-pairable lines at 'suggested'
// and ask the owner to click identical-looking rows apart — a "bookkeeping
// cookie banner" for what is just lazy intelligence. The tie layer now USES the
// date it already has for every client: when the document's date strictly singles
// out one twin (unique closest within the window, by at least the one-day
// margin below), that pairing is NOT a tie — the model date-pairs it and it may
// auto-reconcile. This also subsumes the former recurring-date canary: one
// unique-closest-date rule covers daily and monthly repeated amounts. Both
// canary/config keys were deleted at graduation; foundational behaviour must
// not depend on a per-client row being remembered.

// Slice E (the strong-matcher settled-verdict canary, 2026-06-25). When the
// strong matcher proposes nothing, it records the model's reason verbatim —
// usually 'no_plausible_match'. But a document whose amount is ALREADY covered
// by a SETTLED bank line is not unmatchable, it is already accounted for: the
// honest verdict is 'already_settled' (which the goal evaluator resolves to
// met/resolve_gap, never the firm-limbo the two-terminal-states principle
// forbids — see loopGoalRegistry §"already_settled" and CLAUDE.md). Today the
// matcher mis-records 'no_plausible_match' and the #623 evaluator self-heals it
// downstream; this canary lets the matcher record the truthful reason at SOURCE
// (CLAUDE.md "render the persisted verdict, not the legacy layer").
//
// Fail-closed, dedicated switch — it changes the persisted verdict a live
// book's lines carry, so it gets its OWN flag (NOT folded into an existing
// canary) that is GUARANTEED unset in prod until preview-validated. Mirrors the
// auto-match / material-auto-FYI canaries exactly: flag on AND (no allowlist OR
// the client is on it). NEVER widen by deleting the _CLIENTS allowlist while the
// flag is on — that silently turns the per-client canary into a global flip.
//
// 0A.4: this env predicate is now the FALLBACK behind the config control plane —
// resolveSettledVerdictReason passes `() => settledVerdictCanaryAllows(clientId, env)`
// as clientFlagActs' envFallback, so a client with no client_capability_config row keeps
// exactly this behaviour. The flag key is shared with the config plane via
// SETTLED_VERDICT_FLAG_KEY so the env master var and the DB flag_key can never drift.
export const SETTLED_VERDICT_FLAG_KEY = 'RECONCILIATION_SETTLED_VERDICT';
export const settledVerdictCanaryAllows = (clientId, env = process.env) => {
  if (!envFlag(SETTLED_VERDICT_FLAG_KEY, env)) return false;
  const allow = envClientAllowlist(`${SETTLED_VERDICT_FLAG_KEY}_CLIENTS`, env);
  if (!allow) return true; // flag on, no allowlist → every client
  const id = clientId == null ? '' : String(clientId).trim();
  return !!id && allow.includes(id);
};

// Serializable summary of the policy for the persisted authorization receipt.
// `client_scoped` records whether a client allowlist was in force when this
// match was authorized — paired with the row's client_id it reconstructs
// "auto-executed under the pilot-only canary" from the data alone (CLAUDE.md
// "the model id is the receipt" / "render the persisted verdict").
const policyReceipt = (policy) => ({
  enabled: !!policy?.enabled,
  floor: policy?.floor ?? null,
  separation: policy?.separation ?? null,
  materiality_ceiling: Number.isFinite(policy?.materialityCeiling) ? policy.materialityCeiling : null,
  // F1 — names the fail-closed refusal in the receipt: true when no finite
  // ceiling was configured, so a 'materiality_ceiling_unset' hold is
  // explicable from the persisted policy alone.
  materiality_ceiling_unset: !Number.isFinite(policy?.materialityCeiling),
  // RT-11b — WHERE the ceiling came from ('env' | 'pack:<id>' | 'unset') and
  // the pack's home currency when it did, so a persisted authorization
  // explains its own line without re-resolving policy at read time.
  materiality_ceiling_source: policy?.materialityCeilingSource ?? 'unset',
  materiality_ceiling_currency: policy?.materialityCeilingCurrency ?? null,
  client_scoped: Array.isArray(policy?.clientAllowlist) && policy.clientAllowlist.length > 0
});

export const normalizeCurrency = (c) => String(c || '').trim().toUpperCase();

// Strip legal-form suffixes + punctuation so "Globex Industries Ltd" and
// "GLOBEX INDUSTRIES" collapse to the same key for twin detection.
export const normalizeCounterparty = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[.,/]/g, ' ')
    .replace(/\b(oyj|oy|ltd|limited|ab|abp|plc|gmbh|ag|inc|llc|corp|co|kg|sa|sas|nv|bv|as|aps|spa|srl)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// The settlement magnitude of a candidate line, direction-agnostic: the
// nonzero side (the eval shape carries both money_in and money_out, one a
// literal 0; production carries one side and a null on the other). Used for
// the tie key so two AP debits group by their real amount, not by 0.
const tieAmount = (c) => {
  const i = Number(c?.money_in);
  const o = Number(c?.money_out);
  if (Number.isFinite(i) && i > 0) return i;
  if (Number.isFinite(o) && o > 0) return o;
  return Number.isFinite(i) ? i : (Number.isFinite(o) ? o : NaN);
};

// The deterministic indistinguishability key Gate D reasons over: amount +
// currency + normalized counterparty. Two lines sharing this key are
// indistinguishable on the visible fields.
const tieKey = (c) => {
  const amt = tieAmount(c);
  if (!Number.isFinite(amt)) return null;
  return `${amt.toFixed(2)}|${normalizeCurrency(c?.currency)}|${normalizeCounterparty(c?.contact || c?.description)}`;
};

// Group candidate lines into indistinguishable ties (size >= 2 sharing a
// tieKey), dropping any group a unique reference disambiguates (mirrors Gate
// D's reference-break). Returns an array of groups, each an array of the
// candidate objects. The single source of truth for both the user-prompt
// callout and the output-mirroring expansion below — so the note and the
// surfaced set can never disagree.
export const indistinguishableTieGroups = (candidateBankLines, document, { datePairs = true } = {}) => {
  const cands = Array.isArray(candidateBankLines) ? candidateBankLines : [];
  if (cands.length < 2) return [];
  const ref = String(document?.reference_number || '').trim().toLowerCase();
  const groups = new Map();
  for (const c of cands) {
    const key = tieKey(c);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const ties = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    if (ref) {
      const refMatches = members.filter((c) =>
        `${c?.description || ''} ${c?.raw_description || ''}`.toLowerCase().includes(ref));
      if (refMatches.length === 1) continue; // the reference singles one out
    }
    // Distinct-date twin pairing. When the
    // document's date strictly singles out one member, this group is NOT an
    // indistinguishable tie FOR THIS document — the date pairs it 1:1 (daily
    // fuel / coffee), so it must not drive the tie note or the output mirroring.
    if (datePairs && documentDateSinglesOutTwin(members, document, TWIN_DATE_PAIRING_MARGIN_DAYS)) continue;
    ties.push(members);
  }
  return ties;
};

// Render the indistinguishable-tie that the deterministic layer can already
// see as a SALIENT note for the user prompt. This surfaces an observation the
// model would otherwise have to re-derive from the candidate list — it does
// NOT choose the match or inject a proposal; the model still decides what to
// propose. Returns null when there is no tie. The system-prompt instruction
// alone left the model surfacing only one of two twins ~80% of runs (eval
// 2026-06-22); the data lives right next to the candidates, so the imperative
// belongs there too.
export const describeIndistinguishableGroups = (candidateBankLines, document, { datePairs = true } = {}) => {
  const ties = indistinguishableTieGroups(candidateBankLines, document, { datePairs });
  if (!ties.length) return null;
  const { idToRef } = candidateReferenceMaps(candidateBankLines);
  const groupLines = ties
    .map((members) => `  - candidate_refs [${members
      .map((c) => idToRef.get(String(c?.id)))
      .filter(Boolean)
      .join(', ')}] share the same amount, currency, and counterparty`)
    .join('\n');
  return `INDISTINGUISHABLE CANDIDATES DETECTED — nothing visible says which of these settled THIS document:
${groupLines}
You MUST return a proposal for EVERY candidate_ref in such a group (not just one), each at equal moderate confidence (~0.6-0.7). Returning only one silently hides the alternative a human needs to disambiguate. Only ONE of them actually settled the document — you are surfacing the candidates, not asserting all settled. If a group is instead a one-to-many split (lines that TOGETHER settle the document), say so in the reasoning and propose them all anyway.`;
};

// Symmetry invariant (ratified 2026-06-22, Slice E): indistinguishable inputs
// must get indistinguishable outputs. When the model proposes ONE member of a
// provable tie (same Gate-D key, no disambiguating reference), surface its
// sibling(s) too. Two prompt levers (a system-prompt rule + a user-prompt
// callout naming the ids with a hard imperative) both left Opus 4.8 surfacing
// only one of two twins ~80% of runs — it breaks a perfect tie arbitrarily
// under forced discrete output. This restores the symmetry the output format
// destroyed; it is NOT intelligence substitution and NOT a re-score:
//   - it never picks a different line, changes confidence, or changes a band;
//   - it only acts on lines PROVABLY indistinguishable from one the model
//     ITSELF proposed, copying that proposal's confidence (Gate D forces the
//     whole tie group to 'suggested' regardless, so no false-auto is possible);
//   - each mirrored proposal is audit-marked (`mirrored_from` + an
//     `indistinguishable_tie` hop) so the surfaced set stays reconstructable.
// A no-op when there is no tie or the model already proposed every member.
export const expandIndistinguishableTies = ({ proposals, candidateBankLines, document, datePairs = true } = {}) => {
  const props = Array.isArray(proposals) ? proposals : [];
  if (!props.length) return props;
  const ties = indistinguishableTieGroups(candidateBankLines, document, { datePairs });
  if (!ties.length) return props;
  // Map each candidate id to the group it belongs to.
  const groupOf = new Map();
  for (const members of ties) {
    for (const c of members) groupOf.set(String(c?.id), members);
  }
  const proposedIds = new Set(props.map((p) => String(p.bank_transaction_id)));
  const additions = [];
  for (const p of props) {
    const group = groupOf.get(String(p.bank_transaction_id));
    if (!group) continue;
    for (const sibling of group) {
      const sid = String(sibling?.id);
      if (!sibling?.id || proposedIds.has(sid)) continue;
      proposedIds.add(sid);
      additions.push({
        ...p,
        bank_transaction_id: sibling.id,
        reasoning: `Indistinguishable from ${p.bank_transaction_id} (same amount, currency, and counterparty; nothing visible says which settled this) — surfaced for human disambiguation.`,
        hops: [...new Set([...(Array.isArray(p.hops) ? p.hops : []), 'indistinguishable_tie'])],
        mirrored_from: p.bank_transaction_id
      });
    }
  }
  return additions.length ? [...props, ...additions] : props;
};

const hopList = (hops) => (Array.isArray(hops) ? hops.map((h) => String(h).toLowerCase()) : []);
export const hopsDeclareFx = (hops) =>
  hopList(hops).some((h) => h.startsWith('fx_conversion') || h.startsWith('processor:') || h.startsWith('processor_'));
export const hopsDeclareFee = (hops) =>
  hopList(hops).some((h) => h === 'processor_fee' || h.startsWith('processor:') || h.startsWith('processor_'));
export const hopsDeclarePartial = (hops) =>
  hopList(hops).some((h) => h === 'partial_payment' || h.startsWith('partial'));

// ── RT-21c: the settlement-row contract (a koontilasku) ────────────────
// A consolidated settlement statement lists several settlements; RT-21b
// persists each as a document line at its NET with the printed breakdown
// under payload.raw_extraction.settlement_row. The matcher names the row
// it settles with the hop `statement_row:<line_no>`, and the Keep layer
// then reasons PER ROW: Gate C exact at the row's net, separation among the
// candidates for the SAME row (proposals against different rows are not
// ties), Gate D on the row, the receipt naming the row. `partial_payment`
// is never the word for a listed row — the row IS the full settlement.
// The runner loads the document's settlement rows as
// `document.settlement_lines` ([{ id, line_no, description, amount,
// settlement_row, settled_by_bank_transaction_id }]).
export const STATEMENT_ROW_HOP_PREFIX = 'statement_row:';

export const settlementRowNoFromHops = (hops) => {
  for (const hop of hopList(hops)) {
    if (!hop.startsWith(STATEMENT_ROW_HOP_PREFIX)) continue;
    const n = Number(hop.slice(STATEMENT_ROW_HOP_PREFIX.length));
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
};

export const documentSettlementLines = (document) =>
  (Array.isArray(document?.settlement_lines) ? document.settlement_lines : []).filter((line) => line && line.id);

export const documentHasSettlementRows = (document) => documentSettlementLines(document).length > 0;

// The row a proposal names, from the document's persisted settlement lines.
// Returns { line_id, line_no, net, description, settlement_row,
// settled_by_bank_transaction_id } or null (no row hop / unknown row).
export const resolveSettlementRow = ({ document, hops } = {}) => {
  const lineNo = settlementRowNoFromHops(hops);
  if (lineNo == null) return null;
  const line = documentSettlementLines(document).find((l) => Number(l.line_no) === lineNo);
  if (!line) return null;
  const net = Number(line.amount);
  return {
    line_id: String(line.id),
    line_no: lineNo,
    net: Number.isFinite(net) ? net : null,
    description: line.description || null,
    settlement_row: line.settlement_row && typeof line.settlement_row === 'object' ? line.settlement_row : null,
    settled_by_bank_transaction_id: line.settled_by_bank_transaction_id || null
  };
};

// Gate C — amount/currency reconcile. Pure arithmetic + the model's
// declared hops; never a re-score. Returns false (→ NOT auto) when the
// match cannot be reconciled, which surfaces it as 'suggested'.
// With a settlement row (RT-21c) the row IS the document for this gate:
// exact at the row's net (same currency) or inside the FX band (cross
// currency); a partial / fee hop does not loosen it — fees are already
// netted on the row, and a listed row is never partially settled.
// RT-27: `priorSettled` (confirmed/auto_matched lines already on the document)
// and `creditApplied` (customer credit notes the runtime validated for THIS
// settlement) join the bank line on the SAME side of the equation — in the
// document's currency only, so a completing partial or an invoice-minus-credit
// settlement closes exactly; cross-currency judgment stays on the bank amount
// alone (credits are never applied cross-currency — the plan refuses them).
export const amountReconciles = ({ matchAmount, bankCurrency, document, hops, policy, settlementRow = null, priorSettled = 0, creditApplied = 0 }) => {
  const docTotal = settlementRow ? Number(settlementRow.net) : Number(document?.total_amount);
  const amt = Number(matchAmount);
  // No document total / non-positive amount → can't verify, can't direction-check.
  if (!Number.isFinite(docTotal) || docTotal <= 0) return false;
  if (!Number.isFinite(amt) || amt <= 0) return false;
  const sameCurrency = normalizeCurrency(bankCurrency) === normalizeCurrency(document?.currency);
  const tol = Math.max(policy.amountAbsTol, docTotal * policy.amountRelTol);
  if (sameCurrency) {
    if (settlementRow) return Math.abs(amt - docTotal) <= tol;                // a listed row: full settlement at its net
    const prior = Number.isFinite(Number(priorSettled)) && Number(priorSettled) > 0 ? Number(priorSettled) : 0;
    const credits = Number.isFinite(Number(creditApplied)) && Number(creditApplied) > 0 ? Number(creditApplied) : 0;
    const effective = amt + prior + credits;
    if (hopsDeclarePartial(hops)) return effective <= docTotal + tol;             // partial — no over-settlement
    if (hopsDeclareFee(hops)) return effective <= docTotal + tol && effective >= docTotal * policy.feeFloor; // fee shortfall
    return Math.abs(effective - docTotal) <= tol;                                 // full settlement
  }
  // Cross-currency: the gap MUST be explained by a declared FX/processor
  // hop, and the implied rate must be inside a sane band (blocks a bare
  // cross-currency number coincidence — fixture 011).
  if (!hopsDeclareFx(hops)) return false;
  const rate = amt / docTotal;
  return rate >= policy.fxMin && rate <= policy.fxMax;
};

// Gate D — ambiguity guard. If ≥2 candidate lines are indistinguishable
// on the visible fields (same amount, same currency, same counterparty),
// and no document reference uniquely identifies one of them, NEVER
// auto-match — surface all for human disambiguation. Encodes the
// fixture 010/014 gold (ratified 2026-06-21: surface both, auto none)
// as a deterministic rule independent of model confidence. A decoy
// (fixture 009: equal amount, DIFFERENT counterparty) is distinguishable
// and does NOT trip this gate.
// The distinct-date twin-pairing margin. Tight by design:
// a SINGLE day's separation is enough to tell two same-price charges apart (the
// daily-fuel / morning-coffee case). A
// module constant, not an env knob, by intent.
export const TWIN_DATE_PAIRING_MARGIN_DAYS = 1;

// Date-based tie-break for candidatesAmbiguous. Same vendor +
// amount makes every charge a twin on the visible fields, but the DOCUMENT's own
// date ties it to one. Returns true ONLY when the doc date sits uniquely closest
// to the TARGET line — within the match window AND beating the next-closest twin
// by `marginDays` — so a wrong pairing (doc date closest to a DIFFERENT twin) is
// never laundered into an auto-match. Conservative: a missing doc/target/twin
// date, or no clear winner, returns false (stays ambiguous). Pure.
const docDateBreaksTwinTie = ({ bankLine, twins, document, marginDays = TWIN_DATE_PAIRING_MARGIN_DAYS }) => {
  const docDay = toIsoDay(document?.document_date);
  if (!docDay) return false;
  const docMs = new Date(`${docDay}T00:00:00Z`).getTime();
  if (!Number.isFinite(docMs)) return false;
  const targetId = bankLine.id == null ? '' : String(bankLine.id);
  if (!targetId) return false;
  const dated = twins.map((c) => {
    const day = toIsoDay(c.date || c.transaction_date);
    const ms = day ? new Date(`${day}T00:00:00Z`).getTime() : NaN;
    return { id: c.id == null ? '' : String(c.id), dist: Math.abs(ms - docMs), ok: Number.isFinite(ms) };
  });
  if (dated.some((d) => !d.ok)) return false; // every twin must carry a usable date
  dated.sort((a, b) => a.dist - b.dist);
  const [closest, runnerUp] = dated;
  if (closest.id !== targetId) return false; // the doc date points at a DIFFERENT line
  if (closest.dist > WINDOW_DAYS * DAY_MS) return false; // outside the match window
  return runnerUp.dist - closest.dist >= marginDays * DAY_MS;
};

// Group-level twin: does the document's date strictly single out ONE member of a
// same-amount twin group (closest within window AND >= marginDays nearer than the
// runner-up)? When true the group is NOT an indistinguishable tie FOR THIS
// document — the date pairs it 1:1 (the daily-fuel / coffee case). No target line
// needed (unlike docDateBreaksTwinTie); used by indistinguishableTieGroups so the
// prompt tie-note and the output mirroring both stop treating date-separable
// twins as a coin-flip. Conservative + null-date-safe: any missing date → false.
const documentDateSinglesOutTwin = (members, document, marginDays) => {
  const docDay = toIsoDay(document?.document_date);
  if (!docDay) return false;
  const docMs = new Date(`${docDay}T00:00:00Z`).getTime();
  if (!Number.isFinite(docMs)) return false;
  const dated = (members || []).map((c) => {
    const day = toIsoDay(c?.date || c?.transaction_date);
    const ms = day ? new Date(`${day}T00:00:00Z`).getTime() : NaN;
    return { dist: Math.abs(ms - docMs), ok: Number.isFinite(ms) };
  });
  if (dated.length < 2 || dated.some((d) => !d.ok)) return false;
  dated.sort((a, b) => a.dist - b.dist);
  const [closest, runnerUp] = dated;
  if (closest.dist > WINDOW_DAYS * DAY_MS) return false;
  return runnerUp.dist - closest.dist >= marginDays * DAY_MS;
};

export const candidatesAmbiguous = ({ bankLine, candidateBankLines, document, policy }) => {
  if (!bankLine) return true; // can't assess the target → conservative
  const cands = Array.isArray(candidateBankLines) ? candidateBankLines : [];
  const targetAmt = Number(bankLine.money_in ?? bankLine.money_out);
  if (!Number.isFinite(targetAmt)) return true;
  const targetCur = normalizeCurrency(bankLine.currency);
  const targetParty = normalizeCounterparty(bankLine.contact || bankLine.description);
  const tol = Math.max(policy.amountAbsTol, (Number(document?.total_amount) || targetAmt) * policy.amountRelTol);
  const twins = cands.filter((c) => {
    const amt = Number(c.money_in ?? c.money_out);
    if (!Number.isFinite(amt) || Math.abs(amt - targetAmt) > tol) return false;
    if (normalizeCurrency(c.currency) !== targetCur) return false;
    return normalizeCounterparty(c.contact || c.description) === targetParty;
  });
  if (twins.length < 2) return false; // unique on the visible fields
  const ref = String(document?.reference_number || '').trim().toLowerCase();
  if (ref) {
    const refMatches = twins.filter((c) =>
      `${c.description || ''} ${c.raw_description || ''}`.toLowerCase().includes(ref));
    if (refMatches.length === 1) return false; // the reference disambiguates
  }
  // Distinct-date twin pairing. Same as above but a TIGHT
  // 1-day margin, so same-price charges a single day apart (daily fuel / coffee)
  // pair by date instead of staying a tie. Equidistant twins (no strict winner)
  // remain ambiguous. Never widens ambiguity.
  if (docDateBreaksTwinTie({ bankLine, twins, document, marginDays: TWIN_DATE_PAIRING_MARGIN_DAYS })) {
    return false;
  }
  return true;
};

// Highest confidence among the OTHER proposals for this document — the
// runner-up. A confident auto-match needs clear separation from the next
// best; two close proposals signal ambiguity the model itself surfaced.
export const secondBestConfidence = (allProposals, targetId) => {
  let best = 0;
  for (const p of allProposals || []) {
    if (!p || String(p.bank_transaction_id) === String(targetId)) continue;
    const c = Number(p.confidence);
    if (Number.isFinite(c) && c > best) best = c;
  }
  return best;
};

// The authority decision. Pure. Returns the BAND for the target the
// model already chose, plus the gate outcomes (the persisted receipt).
// auto_matched IFF A∧B∧C∧D∧E; otherwise 'suggested' (surfaced, never
// hidden). Policy disabled → 'suggested' for everything.
// The first Jev writing lane has a deliberately small executable vocabulary:
// one exact full settlement. Semantic selection belongs to Jev; arithmetic,
// company authority and materiality still belong to the existing runtime.
export const authorizeJevMatch = ({ proposal, bankLine, document, clientId, configSnapshot,
  policy = getAutoMatchPolicy(), env = process.env, settlementRow = null }) => {
  const amount = Number(settlementRow?.net ?? document?.total_amount);
  const bankAmount = Number(['sales_invoice', 'issued_receipt', 'payout_statement', 'deposit_slip'].includes(document?.document_type)
    ? bankLine?.money_in : bankLine?.money_out);
  const oppositeAmount = Number(['sales_invoice', 'issued_receipt', 'payout_statement', 'deposit_slip'].includes(document?.document_type)
    ? bankLine?.money_out || 0 : bankLine?.money_in || 0);
  const selected = proposal?.decision_source === 'jev_full_settlement'
    && Number.isFinite(proposal.confidence) && proposal.confidence >= 0 && proposal.confidence <= 1;
  const enabled = firstLineLaneDecides({ snapshot: configSnapshot, env });
  const allowed = enabled && policy?.enabled && clientAllowedToAutoMatch(clientId, policy, { configSnapshot, env });
  const exact = amount > 0 && Number.isFinite(amount) && bankAmount > 0 && oppositeAmount === 0
    && Math.round(amount * 100) === Math.round(bankAmount * 100) && document.currency === bankLine?.currency
    && (!documentHasSettlementRows(document) || Boolean(settlementRow?.line_id));
  const ceilingSet = Number.isFinite(policy.materialityCeiling);
  const gates = { A: selected && allowed, B: selected, C: exact, D: selected, E: ceilingSet && bankAmount <= policy.materialityCeiling };
  const reasons = [];
  if (!allowed) reasons.push('jev_or_auto_match_not_authorized');
  if (!selected) reasons.push('invalid_jev_selection');
  if (!exact) reasons.push('jev_full_settlement_not_executable');
  if (!gates.E) reasons.push(ceilingSet ? 'above_materiality_ceiling' : 'materiality_ceiling_unset');
  return { band: allowed && Object.values(gates).every(Boolean) ? 'auto_matched' : 'suggested',
    reasons: reasons.length ? reasons : ['jev_selected_full_settlement'], gates, secondBestConfidence: null,
    policy: policyReceipt(policy), settlement_row: settlementRow, decision_contract: 'jev-full-settlement-v1' };
};

export const authorizeMatch = ({
  proposal,
  allProposals,
  bankLine,
  candidateBankLines,
  document,
  matchAmount,
  // The document's owning client. Load-bearing for the client-scoped
  // auto-match gate below; null when a caller (e.g. the offline stability
  // harness, which scores the gate stack itself) does not scope by client.
  clientId = null,
  policy = getAutoMatchPolicy(),
  // Optional env (defaults to process.env) for remaining policy gates, kept
  // injectable so tests do not mutate the process.
  env = process.env,
  // Per-client config snapshot for the remaining config-governed policy gates.
  // The 5 family orchestrators resolve this once per run and thread it here.
  configSnapshot = null,
  // RT-21c: the settlement row this proposal names (resolveSettlementRow),
  // or undefined to resolve it here from the proposal's hops. When the
  // document carries settlement rows, every proposal MUST name one.
  settlementRow = undefined,
  // RT-27: prior settled lines and the validated credit-note amount riding
  // this settlement (Gate C arithmetic), plus the compact credit receipt
  // (buildCreditReceipt) carried on the authorization for the persisted
  // payload. All absent ⇒ byte-identical to before.
  priorSettled = 0,
  creditApplied = 0,
  creditReceipt = null
}) => {
  const confidence = Number(proposal?.confidence);
  const creditNotesReceipt = creditReceipt && typeof creditReceipt === 'object' ? { credit_notes: creditReceipt } : {};
  const rowsRequired = documentHasSettlementRows(document);
  const row = settlementRow === undefined ? resolveSettlementRow({ document, hops: proposal?.hops }) : settlementRow;
  const rowNo = row ? row.line_no : null;
  // Separation is measured among candidates for the SAME row — proposals
  // against different rows of one statement are not ties (prompt §2).
  const rowScopedProposals = row
    ? (allProposals || []).filter((p) => settlementRowNoFromHops(p?.hops) === rowNo)
    : allProposals;
  const second = secondBestConfidence(rowScopedProposals, proposal?.bank_transaction_id);
  // For Gates C/D the row is the document: its net is the amount, its own
  // reference (when printed) the reference.
  const gateDocument = row
    ? { ...document, total_amount: row.net, reference_number: row.settlement_row?.reference || document?.reference_number || null }
    : document;
  const rowReceipt = row
    ? { line_id: row.line_id, line_no: row.line_no, net: row.net, separation_scope: 'row' }
    : null;

  if (!policy?.enabled) {
    return {
      band: 'suggested',
      reasons: ['policy_disabled'],
      gates: {},
      secondBestConfidence: second,
      policy: policyReceipt(policy),
      settlement_row: rowReceipt,
      ...creditNotesReceipt
    };
  }

  // Client-scoped canary gate (mirrors EXTRACTOR_CLIENTS). When an allowlist is
  // set, only the listed clients may auto-execute; any other or missing client
  // FAILS CLOSED to 'suggested' — the match is surfaced for human review, never
  // hidden. This narrows the global enable flag; it never widens it (a disabled
  // policy already returned above).
  //
  // 0A.10 — routed through the config control plane via clientAllowedToAutoMatch:
  // a DB row for this client decides (canary/auto act; off carves out); no row ⇒
  // the flag's env allowlist (envFallback), byte-identical until a
  // client_capability_config row exists. configSnapshot + env are already in
  // scope (threaded by the 5 family orchestrators for all governed gates).
  if (!clientAllowedToAutoMatch(clientId, policy, { configSnapshot, env })) {
    return {
      band: 'suggested',
      reasons: ['client_not_in_auto_match_allowlist'],
      gates: {},
      secondBestConfidence: second,
      policy: policyReceipt(policy),
      settlement_row: rowReceipt,
      ...creditNotesReceipt
    };
  }

  const reasons = [];
  const gates = {};

  // Gate A — the model proposed this target with a usable confidence.
  gates.A = !!proposal && Number.isFinite(confidence);
  if (!gates.A) reasons.push('no_model_proposal');

  // Gate B — confidence floor + separation margin (not a knife-edge).
  const meetsFloor = Number.isFinite(confidence) && confidence >= policy.floor;
  const meetsSeparation = Number.isFinite(confidence) && confidence - second >= policy.separation;
  gates.B = meetsFloor && meetsSeparation;
  if (!meetsFloor) reasons.push('below_floor');
  if (!meetsSeparation) reasons.push('insufficient_separation');

  // Gate C — deterministic correctness (amount/currency/direction). On a
  // statement with settlement rows the proposal must name its row
  // (statement_row:<n>) and that row must exist and be open; the amount is
  // then judged exactly against the row's net (amountReconciles).
  if (rowsRequired && !row) {
    gates.C = false;
    reasons.push(settlementRowNoFromHops(proposal?.hops) != null ? 'unknown_statement_row' : 'statement_row_required');
  } else if (row && row.settled_by_bank_transaction_id && String(row.settled_by_bank_transaction_id) !== String(proposal?.bank_transaction_id)) {
    gates.C = false;
    reasons.push('statement_row_already_settled');
  } else {
    gates.C = amountReconciles({
      matchAmount,
      bankCurrency: bankLine?.currency,
      document: gateDocument,
      hops: proposal?.hops,
      policy,
      settlementRow: row,
      priorSettled,
      creditApplied
    });
    if (!gates.C) reasons.push('amount_or_currency_unreconciled');
  }

  // Gate D — ambiguity guard. Persisted dates break a same-vendor/amount tie
  // only when they identify a unique closest target; equidistant twins remain
  // ambiguous for every client. On a row match the row is the document (its
  // paid date, when printed, is the date that pairs a twin).
  const gateDDocument = row?.settlement_row?.paid_on
    ? { ...gateDocument, document_date: row.settlement_row.paid_on }
    : gateDocument;
  gates.D = !candidatesAmbiguous({
    bankLine,
    candidateBankLines,
    document: gateDDocument,
    policy
  });
  if (!gates.D) reasons.push('ambiguous_candidates');

  // Gate E — materiality ceiling. An UNSET (non-finite) ceiling fails closed
  // (F1, 2026-07-06): no match auto-executes under a missing config, and the
  // distinct reason keeps the hold out of the pending-authority/grant lanes
  // (isMatchedPendingAuthority / delegationGateProof key on the reason string).
  const ceilingSet = Number.isFinite(policy.materialityCeiling);
  gates.E = ceilingSet && Number(matchAmount) <= policy.materialityCeiling;
  if (!gates.E) reasons.push(ceilingSet ? 'above_materiality_ceiling' : 'materiality_ceiling_unset');

  const auto = gates.A && gates.B && gates.C && gates.D && gates.E;
  return {
    band: auto ? 'auto_matched' : 'suggested',
    reasons: auto ? ['all_gates_passed'] : reasons,
    gates,
    secondBestConfidence: second,
    policy: policyReceipt(policy),
    settlement_row: rowReceipt,
    ...creditNotesReceipt
  };
};

// The 'matched_pending_authority' state — groundwork (2026-06-23) for the
// delegated-authority follow-on. A match Donna FOUND (gates A–D pass) that
// is held at 'suggested' ONLY by the materiality ceiling (Gate E). This is
// NOT a hang and NOT a client-ask case: Donna resolved the line; the sole
// outstanding step is a human accept-to-POST (V1 forbids auto-posting the
// ledger). The follow-on will let recurring policies / explicit client or
// accountant approvals / prior accepted patterns grant Donna delegated
// authority to auto-accept these WITH an authority receipt — so the manual
// accept becomes a one-time authorization moment, not recurring toil.
//
// Pure predicate over the authorization receipt upsertMatchAndCascade
// already persists (payload.authorization). True only when materiality is
// the SOLE withhold reason — any other reason present (ambiguity, below
// floor, policy disabled, not in allowlist) is a genuine review case, not
// a pending-authority one.
export const isMatchedPendingAuthority = (authorization) => {
  if (!authorization || typeof authorization !== 'object') return false;
  if (authorization.band !== 'suggested') return false;
  const reasons = Array.isArray(authorization.reasons) ? authorization.reasons : [];
  return reasons.length > 0 && reasons.every((r) => r === 'above_materiality_ceiling');
};

// The AFFIRMATIVE gate proof a delegated-authority grant requires before it
// may auto-accept a material match — Slice 1 of the #5 design
// (docs/proposal-2026-06-23-delegated-authority-material-matches.md), the key
// safety fix.
//
// `isMatchedPendingAuthority` above is a CHEAP predicate over the reason list;
// it does NOT inspect the gate receipt. So a malformed, stale, migrated, or
// future-regression authorization object with band:'suggested' +
// reasons:['above_materiality_ceiling'] but a MISSING or false `gates` receipt
// would satisfy it. A grant must NEVER rescue such a receipt. This predicate is
// the strict proof the grant lookup keys off: the receipt must affirmatively
// show gates A,B,C,D === true and gate E === false. A missing/non-object
// `gates` FAILS CLOSED. Delegated authority may bypass Gate E ONLY — never
// A–D; this is where that invariant is enforced, not on the reason strings.
//
// LOCK-STEP (#5 Slice 5): one read-only MIRROR of this affirmative shape exists
// for the UI and must change in step with it, or it disagrees with the accept
// path about what "held" means: isMaterialityHeldSuggested in
// src/lib/documentsInbox.js (the held-suggested chip). NOTE: the convergence-
// metric SQL in parseDocumentsDb.js formerly mirrored this too, but no longer
// special-cases "held" — under the two-terminal principle ANY 'suggested' match
// (held or not) counts as HANGING there, so the metric needs no held-detection
// (lock-step now with reconcileConvergenceState.js, not this shape).
export const delegationGateProof = (authorization) => {
  if (!isMatchedPendingAuthority(authorization)) return false;
  const gates = authorization.gates;
  if (!gates || typeof gates !== 'object') return false; // no affirmative receipt → fail closed
  return (
    gates.A === true &&
    gates.B === true &&
    gates.C === true &&
    gates.D === true &&
    gates.E === false
  );
};

// Slice 2 of the #5 design — the band-flip a covering authority grant performs
// on a materiality-held match (docs/proposal-…-delegated-authority-material-
// matches.md §9). PURE: it only reshapes the in-memory authorization receipt
// `authorizeMatch` produced; it has NO store/db dependency. The grant LOOKUP
// lives in reconciliationAuthorityGrants.js, which imports THIS module — so the
// dependency points store→core, never core→store (no import cycle). The
// orchestrators call the store's applyDelegatedAuthority, which calls this.
//
// The headline invariant (CLAUDE.md, spec §1): a grant may bypass Gate E ONLY,
// never re-decide A–D. This function does NOT touch the gate receipt — it
// preserves `gates` (with E still false) verbatim, so the affirmative A–D proof
// the caller already verified via delegationGateProof stays intact and auditable.
// It must ONLY be called on an authorization delegationGateProof accepts.
//
// Returns a COMPLETE authorization so upsertMatchAndCascade's wholesale,
// top-level-shallow payload merge (reconciliation_matches.payload ||
// excluded.payload, ~line 1329) can never persist a partial receipt that drops
// the gate proof (spec §11): the band flips to 'auto_matched', the sole reason
// becomes 'delegated_authority' (distinct from 'all_gates_passed'), the
// preserved gate receipt + secondBestConfidence + policy ride through unchanged
// via the spread, and a `delegated_authority` sub-object makes the accept fully
// reconstructable.
export const grantAuthority = (authorization, grant) => ({
  ...authorization,
  band: 'auto_matched',
  reasons: ['delegated_authority'],
  delegated_authority: {
    grant_id: grant?.id ?? null,
    authorized_by_actor_type: grant?.authorized_by_actor_type ?? null,
    archetype: grant?.archetype ?? null,
    scope_kind: grant?.scope_kind ?? null,
    scope_key: grant?.scope_key ?? null,
    action: grant?.action ?? null,
    // When the standing authority was granted (its validity origin), not the
    // moment of this accept — that is the match's updated_at / audit timestamp.
    granted_at: grant?.valid_from ?? grant?.created_at ?? null
  }
});

// The no-gate material auto-post band-flip (2026-06-24 decision) — the TWIN of
// grantAuthority for a materiality-held match with NO covering grant. Same
// headline invariant (CLAUDE.md, spec §1): it bypasses Gate E ONLY and NEVER
// re-decides A–D — the `gates` receipt rides through verbatim (E still false) via
// the spread, so the affirmative A–D proof the caller verified with
// delegationGateProof stays intact and auditable. It differs from grantAuthority
// in PROVENANCE only: there is no standing grant, so the authority is the firm's
// standing policy that a confident material match auto-reconciles + FYIs the
// owner. The distinct reason 'material_auto_fyi' (vs 'delegated_authority' vs
// 'all_gates_passed') plus the `material_auto_fyi` sub-object record that lineage,
// so a policy auto-post is never mistaken for a grant-backed accept — and
// delegatedAuthorityGrantId returns null for it (there is no grant to suspend).
//
// `owner_notified` is the E3 seam: the line is auto-posted HERE, but the courtesy
// FYI to the owner is dispatched by the separate FYI rail (E3), which flips this
// to true. Persisted false so a not-yet-FYI'd auto-post is observable and the rail
// can find it. Returns a COMPLETE authorization (like grantAuthority) so the
// wholesale payload merge in upsertMatchAndCascade can never persist a partial
// receipt. Call ONLY on an authorization delegationGateProof accepts.
export const autoFyiAuthority = (authorization) => ({
  ...authorization,
  band: 'auto_matched',
  reasons: ['material_auto_fyi'],
  material_auto_fyi: {
    policy: 'material_auto_fyi',
    materiality_ceiling:
      authorization?.policy?.materiality_ceiling ?? authorization?.policy?.materialityCeiling ?? null,
    owner_notified: false
  }
});

// The orchestrator-facing accept seam (sibling of the store's
// applyDelegatedAuthority, but PURE — no store/db round-trip, just the env canary).
// Call it AFTER applyDelegatedAuthority: if a covering grant already flipped the
// band to auto_matched, delegationGateProof is false here and this is a NO-OP — the
// grant-backed `delegated_authority` receipt WINS. Only a STILL-held, no-grant
// material match (delegationGateProof true) for a client the DEDICATED material
// auto-FYI canary allows is flipped to an auto_matched auto-FYI accept. Fail-closed
// in both axes: canary off OR not materiality-held → the authorization passes
// through UNCHANGED (the held line stays 'suggested' and is SURFACED as hanging by
// the convergence projection — never laundered behind a firm-ask, per the no-gate
// decision).
export const applyMaterialAutoFyi = (authorization, { clientId = null, env = process.env, configSnapshot = null } = {}) => {
  // 0A.5 — config control plane shim. A DB row for this client ⇒ its stage decides
  // (empty=∅, fail-closed); no row ⇒ the env canary (envFallback), byte-identical to
  // pre-0A.5. The 5 family orchestrators resolve configSnapshot once per run and thread
  // it here. NOTE: the receipt's `client_scoped` half below still reflects the ENV
  // allowlist — when a DB row drives the gate it does not yet describe the config-plane
  // source (firm-default vs cohort vs client-specific). Enriching the receipt with that
  // provenance is a deliberate follow-up, not folded into this gate migration.
  const fyiActs = clientFlagActs({
    flagKey: MATERIAL_AUTO_FYI_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => materialAutoFyiCanaryAllows(clientId, env),
    env
  });
  if (!fyiActs) return authorization;
  if (!delegationGateProof(authorization)) return authorization;
  const upgraded = autoFyiAuthority(authorization);
  return {
    ...upgraded,
    material_auto_fyi: {
      ...upgraded.material_auto_fyi,
      client_scoped: materialAutoFyiClientScoped(env)
    }
  };
};

// #5 Slice 5 — the inverse of grantAuthority: read the covering grant's id off
// a delegated-authority accept receipt, or null if the receipt is not a
// delegated accept. Used by the auto-suspend-on-correction producer
// (updateReconciliationMatchInDb → suspendGrantAfterCorrection): when a human
// later corrects/rejects a match that a grant auto-accepted, this tells the
// writer WHICH grant to suspend. Pure; reads only the persisted receipt
// grantAuthority wrote — never re-derives the grant.
export const delegatedAuthorityGrantId = (authorization) => {
  if (!authorization || typeof authorization !== 'object') return null;
  const reasons = Array.isArray(authorization.reasons) ? authorization.reasons : [];
  const delegated = reasons.length === 1 && reasons[0] === 'delegated_authority';
  const sub = authorization.delegated_authority;
  if (!delegated && !(sub && typeof sub === 'object')) return null;
  const id = sub && typeof sub === 'object' ? sub.grant_id : null;
  return id == null || id === '' ? null : String(id);
};

export const getApiKey = () => process.env.ANTHROPIC_API_KEY || '';

export const getModel = () =>
  process.env.RECONCILIATION_MATCHER_LLM_MODEL || DEFAULT_MODEL;

// Same id shape as the weighted matcher so an LLM-mode row UPSERTs
// against the same (bank_transaction_id, matched_object_type,
// matched_object_id) pair — mode flips do not orphan prior rows.
const shortHash = (value = '') => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
};

const slugify = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

// objectType is supplied by the spec ('sales_invoice', 'supplier_bill',
// …). The per-direction modules expose a `makeMatchId(clientId, txId,
// docId)` wrapper that pins their own object type.
// RT-21c: a row match's id carries the row (lineNo in the slug, lineId in
// the hash) so two rows of one statement settled by two bank lines never
// collide on the primary key; a document-level id is byte-identical to
// before (no row ⇒ no suffix).
export const makeMatchId = ({ clientId, txId, objectType, docId, lineId = null, lineNo = null }) => {
  const raw = lineId ? `${clientId}|${txId}|${objectType}|${docId}|${lineId}` : `${clientId}|${txId}|${objectType}|${docId}`;
  const rowSuffix = lineId ? `-row${Number.isInteger(Number(lineNo)) ? Number(lineNo) : slugify(lineId)}` : '';
  return (
    `recon-${slugify(clientId)}-${slugify(txId)}-${slugify(objectType)}-${slugify(docId)}${rowSuffix}`.slice(0, 118) +
    `-${shortHash(raw)}`
  );
};

// Window: document_date ± WINDOW_DAYS (90). Broader than the
// weighted matcher's issue−7d through due+60d window because
// payment-processor + FX settlements run longer than the weighted
// matcher's window assumes — a Stripe payout for an invoice paid
// the day before due can land on the bank a week after due.
//
// Dates normalize through `toIsoDay` (./dates.js) because pg rows
// carry Date objects while tests and JSONB carry ISO strings — see
// the history note there (#299 ran every matcher call windowless).
export const computeWindow = (document) => {
  const issue = document?.document_date;
  if (!issue) return null;
  const day = toIsoDay(issue);
  if (!day) return null;
  const issueMs = new Date(`${day}T00:00:00Z`).getTime();
  if (!Number.isFinite(issueMs)) return null;
  return {
    lowerMs: issueMs - WINDOW_DAYS * DAY_MS,
    upperMs: issueMs + WINDOW_DAYS * DAY_MS
  };
};

export const isWithinWindow = (transaction, window) => {
  if (!window) return false;
  const raw = transaction.date || transaction.transaction_date;
  if (!raw) return false;
  const day = toIsoDay(raw);
  if (!day) return false;
  const ms = new Date(`${day}T00:00:00Z`).getTime();
  if (!Number.isFinite(ms)) return false;
  return ms >= window.lowerMs && ms <= window.upperMs;
};

// Validates the LLM response: proposals must reference real candidate
// ids, confidence must be a number, hops must be an array of strings.
// Malformed proposals are dropped silently so a single bad row does
// not void the whole call. A wholly-malformed response (unparseable
// JSON or wrong top-level shape) returns an explicit
// `unmatchable_reason: 'invalid_llm_response'` so the caller can
// distinguish "model said no" from "model output was junk".
// RT-27: `options.creditNotes` (the eligible credit notes in prompt order)
// maps each proposal's `applied_credits` handles and the top-level
// `credit_applications` handles back to persisted document ids inside the
// trusted boundary (AGENTS.md lesson L). Absent ⇒ byte-identical output.
export const parseProposeMatchesResponse = (text, candidateBankLines, options = null) => {
  const creditNotes = Array.isArray(options?.creditNotes) ? options.creditNotes.filter((c) => c && c.id) : null;
  const creditRefToId = new Map((creditNotes || []).map((c, idx) => [creditRefForIndex(idx), String(c.id)]));
  const mapCreditRefs = (raw) => {
    const list = Array.isArray(raw) ? raw : [];
    const ids = [];
    let invalid = 0;
    for (const entry of list) {
      const ref = entry && typeof entry === 'object' ? entry.credit_ref : entry;
      const id = creditRefToId.get(String(ref ?? ''));
      if (!id) { invalid += 1; continue; }
      if (!ids.includes(id)) ids.push(id);
    }
    return { ids, invalid };
  };
  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    return { proposals: [], unmatchable_reason: 'invalid_llm_response' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { proposals: [], unmatchable_reason: 'invalid_llm_response' };
  }
  const validIds = new Set((candidateBankLines || []).map((c) => String(c.id)));
  const { refToId } = candidateReferenceMaps(candidateBankLines);
  const rawProposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  const proposals = [];
  for (const p of rawProposals) {
    // New contract: candidate_ref is the only model-facing identifier. Accept
    // the historical bank_transaction_id shape as a parser compatibility leg
    // for stored eval fixtures and rolling deploys; it may contain either a
    // compact ref or an exact valid id. The returned proposal ALWAYS carries
    // the exact database id expected by downstream authorization/writers.
    const rawRef = p?.candidate_ref != null
      ? String(p.candidate_ref)
      : (p?.bank_transaction_id != null ? String(p.bank_transaction_id) : '');
    const id = refToId.get(rawRef) || (validIds.has(rawRef) ? rawRef : '');
    if (!id) continue;
    const confidence = Number(p.confidence);
    if (!Number.isFinite(confidence)) continue;
    const clamped = Math.min(Math.max(confidence, 0), 1);
    const hops = Array.isArray(p.hops)
      ? p.hops.map((h) => String(h)).filter(Boolean)
      : [];
    const proposal = {
      bank_transaction_id: id,
      confidence: clamped,
      reasoning: String(p.reasoning || ''),
      hops
    };
    if (creditNotes) {
      const mapped = mapCreditRefs(p.applied_credits);
      proposal.applied_credit_document_ids = mapped.ids;
      if (mapped.invalid) proposal.invalid_credit_refs = mapped.invalid;
    }
    proposals.push(proposal);
  }
  const unmatchable_reason = parsed.unmatchable_reason
    ? String(parsed.unmatchable_reason)
    : null;
  if (!creditNotes) return { proposals, unmatchable_reason };
  const rawApplications = Array.isArray(parsed.credit_applications) ? parsed.credit_applications : [];
  const credit_applications = [];
  let invalidCreditRefs = 0;
  for (const entry of rawApplications) {
    const ref = entry && typeof entry === 'object' ? entry.credit_ref : entry;
    const creditId = creditRefToId.get(String(ref ?? ''));
    if (!creditId) { invalidCreditRefs += 1; continue; }
    if (credit_applications.some((c) => c.credit_document_id === creditId)) continue;
    const confidence = Number(entry && typeof entry === 'object' ? entry.confidence : NaN);
    credit_applications.push({
      credit_document_id: creditId,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : null,
      reasoning: String((entry && typeof entry === 'object' && entry.reasoning) || '')
    });
  }
  return { proposals, unmatchable_reason, credit_applications, invalid_credit_refs: invalidCreditRefs };
};

// Transient HTTP statuses where a retry can plausibly succeed: Anthropic
// 429 (rate limit) and 529 (Overloaded), plus the standard slow-gateway
// 5xx / timeout family. A 529 is NOT a transport error, so before this it
// fell straight through to an empty-proposals return and the caller
// upserted `api_error_529` as a `no_match` verdict — a transient overload
// masquerading as a reconciliation judgment. Migration 028's own
// principle: "absence of a row is not a verdict" — and a FALSE no_match
// row is worse than absence (it opens gaps / drafts client asks off an
// API hiccup, blast radius ALL clients/docs). So we retry these, and if
// they stay broken we THROW (see below) instead of persisting the error.
// The transient set itself now lives in providerTransport.js
// (TRANSIENT_PROVIDER_STATUSES) — the classification is shared with the coder
// and the ask drafter so the same status gets the same treatment everywhere.
const DEFAULT_API_MAX_ATTEMPTS = 4;
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_API_RETRY_BASE_MS = 500;

// One Anthropic call. `systemPrompt` + `userPrompt` come from the
// spec; `candidateBankLines` is the (already-truncated) set the
// response is validated against. Returns `{ proposals,
// unmatchable_reason }`.
//
// Error contract (2026-09-13, the shared provider transport): the call
// THROWS a typed `ProviderFailureError` (providerTransport.js) on any
// provider failure it cannot turn into a readable response — a transient
// status (429/5xx/529), a reset socket or a request that timed out (headers
// or body) still failing after `maxAttempts` retries with jittered
// exponential backoff, a non-retryable status (400/401/403 — retrying
// cannot help; a 401/403 is a CREDENTIAL failure that rests on the
// operator), and, on the default proposal parser, a body that is not
// proposal JSON at all (`PROVIDER_INVALID_OUTPUT`, retried like a
// transient: no judgment exists to render). Every attempt is bounded by the
// worker's execution budget: the per-attempt timeout never exceeds what the
// job has left, and a backoff the budget cannot hold is refused. A throw
// propagates PAST the caller's verdict write; the family wrapper receipts it
// on the document (reconciliationProviderFailure.js) and the convergence
// clock re-drives it — so no false `no_match` row is written and no weighted
// replacement decision is made. Schema parsing of an OK response still
// returns empty proposals + an explicit model-stated `unmatchable_reason`
// (no_plausible_match / already_settled) — that legitimate no-match path is
// unchanged. `logTag` names the calling matcher in the error log.
// `parse` is an optional response parser. When omitted, the default
// match-proposal parser runs (validated against `candidateBankLines`).
// Phase 7.2a's bank-line disposition producer passes its own parser
// (a single disposition object, no proposals) so it can reuse this
// shared Anthropic transport + error handling rather than duplicate it
// (it wraps the call in its own try/catch and soft-degrades a throw to a
// `transport_error` disposition, so it benefits from the retry for free).
export const proposeMatchesViaAnthropic = async ({
  systemPrompt,
  userPrompt,
  candidateBankLines,
  document = null,
  model = DEFAULT_MODEL,
  apiKey,
  fetchImpl,
  parse = null,
  maxAttempts = DEFAULT_API_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_API_RETRY_BASE_MS,
  sleepImpl = null,
  logTag = 'reconciliationLlmCore',
  datePairs = true,
  // RT-27: options for the DEFAULT parser (e.g. { creditNotes }) — keeps the
  // tie-expansion path, unlike a custom `parse`.
  parseOptions = null,
  // Q7 (the model lab, 2026-08-16): optional deciding transport. When an
  // experiment policy seats a non-claude qualified rung on the
  // reconciliation_reasoning lane, the orchestrator passes
  // { provider: 'openai_compatible', endpoint, model, execution } and the
  // SAME observation (system + user prompt) rides the compatible endpoint —
  // then the SAME parser, tie-expansion and provenance tail runs on the
  // reply. The experiment swaps the judgment, never the guardrails. Absent
  // transport ⇒ the anthropic path below, byte-identical.
  transport = null,
  // Per-attempt request deadline (headers + body). Null ⇒ the transport's
  // PROVIDER_REQUEST_TIMEOUT_MS; always capped by the execution budget.
  requestTimeoutMs = null
}) => {
  const timeoutOverride = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0
    ? { timeoutMs: Number(requestTimeoutMs) }
    : {};
  if (transport?.provider === 'openai_compatible') {
    // Errors THROW, same contract as the anthropic branch: a transport
    // failure must never persist as a verdict (the orchestrator's per-doc
    // catch skips the verdict write; the next pass retries). The socket is
    // llmCall's; the deadline + typed failure come from the transport
    // wrapper, so a hung compatible endpoint is bounded like Anthropic.
    let text;
    let telemetry;
    try {
      ({ result: text, telemetry } = await llmCall({
        provider: 'openai_compatible',
        url: transport.endpoint.url,
        headers: transport.endpoint.headers,
        body: shapeOpenAiCompatibleRequest({
          model: transport.model,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          maxTokens: 2048
        }),
        sections: { system: systemPrompt, context: userPrompt },
        execution: transport.execution,
        promptVersion: null,
        parseResponse: (payload) => payload?.choices?.[0]?.message?.content ?? '',
        fetchImpl: providerFetchWithDeadline({ provider: 'openai_compatible', fetchImpl: fetchImpl || fetch, ...timeoutOverride })
      }));
    } catch (error) {
      if (error?.code === 'LLM_CALL_PROVIDER_ERROR') {
        throw classifyProviderStatus({ provider: 'openai_compatible', status: error.status, payload: { error: { message: error.message } } });
      }
      throw classifyProviderThrow({ provider: 'openai_compatible', error }) || error;
    }
    // Model-mismatch guard (the #1711 disposition guard, same law): when
    // the endpoint ATTESTS a model other than the policy's, the reply must
    // not become a verdict under EITHER model id — throw typed, nothing
    // persists, never a silent decider swap mid-experiment.
    const servedModel = telemetry?.model_source === 'response'
      && typeof telemetry?.model === 'string' && telemetry.model
      ? telemetry.model
      : null;
    if (servedModel && servedModel !== transport.model) {
      console.error(`[${logTag}] compatible endpoint MODEL MISMATCH — policy requested "${transport.model}", endpoint served "${servedModel}"; refusing the verdict`);
      throw Object.assign(
        new Error(`compatible endpoint model mismatch — requested "${transport.model}", served "${servedModel}"`),
        { code: 'POLICY_MODEL_MISMATCH' }
      );
    }
    const result = typeof parse === 'function'
      ? parse(text)
      : parseProposeMatchesResponse(text, candidateBankLines, parseOptions);
    if (typeof parse !== 'function') {
      // A body that is not proposal JSON at all is a transport-class
      // failure (no judgment exists to render) — typed, never a verdict.
      if (result?.unmatchable_reason === 'invalid_llm_response') {
        throw providerInvalidOutput('openai_compatible', { detail: 'the reply was not proposal JSON', model: servedModel || transport.model });
      }
      result.proposals = expandIndistinguishableTies({
        proposals: result.proposals,
        candidateBankLines,
        document,
        datePairs
      });
    }
    const provenance = classifyModelProvenance({ responseModel: servedModel, requestedModel: transport.model });
    result.model = provenance.model;
    result.model_source = provenance.model_source;
    console.log(`[${logTag}] proposals returned`, {
      model: transport.model,
      returned_model: result.model || null,
      model_source: result.model_source,
      candidate_count: Array.isArray(candidateBankLines) ? candidateBankLines.length : 0,
      proposal_count: Array.isArray(result?.proposals) ? result.proposals.length : null,
      unmatchable_reason: result?.unmatchable_reason || null
    });
    return result;
  }

  const fetcher = fetchImpl || fetch;
  const totalAttempts = Math.max(1, Number(maxAttempts) || DEFAULT_API_MAX_ATTEMPTS);
  const requestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  };
  let raw = null;
  let result = null;
  for (let attempt = 1; ; attempt += 1) {
    // ONE bounded attempt: headers + body under one deadline, the deadline
    // capped by the worker's execution budget. A non-OK status, a reset
    // socket, a timeout and an unreadable proposal body all land in
    // `failure` as the same typed shape; anything else (a bug) propagates.
    let failure = null;
    try {
      const fetched = await fetchProviderJson({
        provider: 'anthropic',
        url: ANTHROPIC_MESSAGES_URL,
        init: requestInit,
        fetchImpl: fetcher,
        attempts: attempt,
        ...timeoutOverride
      });
      raw = fetched.payload;
      if (!fetched.ok) {
        failure = classifyProviderStatus({ provider: 'anthropic', status: fetched.status, payload: raw, attempts: attempt });
      }
    } catch (error) {
      if (!isProviderFailure(error)) throw error;
      failure = error;
    }

    if (!failure) {
      const text = raw?.content?.[0]?.text || '';
      result = typeof parse === 'function'
        ? parse(text)
        : parseProposeMatchesResponse(text, candidateBankLines, parseOptions);
      if (typeof parse === 'function' || result?.unmatchable_reason !== 'invalid_llm_response') break;
      // The default proposal parser could not read the body at all: no
      // judgment exists to render. Retried like a transient (a re-ask
      // usually reads); never persisted as a no_match verdict.
      failure = providerInvalidOutput('anthropic', { detail: 'the reply was not proposal JSON', model: raw?.model || model });
    }

    failure.attempts = attempt;
    console.error(`[${logTag}] provider failure`, {
      code: failure.code, status: failure.status, reason: failure.reason, attempt, retryable: failure.retryable, owner: failure.owner
    });
    // Non-retryable (400/401/403): retrying won't help. Out of attempts:
    // throw so the false verdict is never written; the clock retries.
    if (!failure.retryable || attempt >= totalAttempts) throw failure;
    // Exponential backoff with full jitter before the next attempt — only
    // while the worker's budget can still hold the wait AND an attempt.
    const delay = Math.round(retryBaseMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
    if (!budgetAllowsRetry({ delayMs: delay })) {
      failure.budget = { ...(failure.budget || {}), retry_refused: 'execution_budget_exhausted', delay_ms: delay };
      throw failure;
    }
    await waitForProviderRetry({ provider: 'anthropic', delayMs: delay, sleepImpl, attempts: attempt });
  }

  // Symmetry invariant — only on the default match-proposal path (a custom
  // `parse`, e.g. the disposition producer, has no proposals to mirror).
  // Surfaces the provable sibling(s) of any tied line the model proposed.
  if (typeof parse !== 'function') {
    result.proposals = expandIndistinguishableTies({
      proposals: result.proposals,
      candidateBankLines,
      document,
      datePairs
    });
  }
  // The provider-RETURNED model id is the receipt: a silently-downgraded
  // deployment (e.g. a stale env override) shows up HERE, not in the
  // requested `model` string. Propagate it so the persist site can stamp
  // it on the match row, and record WHICH branch supplied it —
  // response_proven vs configured_fallback (CLAUDE.md "the model id is
  // the receipt"; descent-ladder spec §2.1).
  const provenance = classifyModelProvenance({ responseModel: raw?.model, requestedModel: model });
  result.model = provenance.model;
  result.model_source = provenance.model_source;
  // One line per LLM-matcher invocation. Presence proves LLM mode
  // engaged for this doc (its absence on a zero-match run means the
  // weighted matcher ran or no eligible candidates survived); the
  // payload preserves the model's unmatchable_reason, which is
  // otherwise dropped when there are no proposals to persist it on.
  console.log(`[${logTag}] proposals returned`, {
    model,
    returned_model: result.model || null,
    model_source: result.model_source,
    candidate_count: Array.isArray(candidateBankLines) ? candidateBankLines.length : 0,
    proposal_count: Array.isArray(result?.proposals) ? result.proposals.length : null,
    unmatchable_reason: result?.unmatchable_reason || null
  });
  return result;
};

export const ZERO_STATS = () => ({
  suggested_inserted: 0,
  suggested_refreshed: 0,
  auto_match_upgraded: 0,
  auto_match_eligible: 0,
  skipped_rejected: 0,
  skipped_confirmed: 0,
  skipped_auto_matched: 0,
  // Cascades re-run on an already-auto_matched row whose cascade never landed.
  // A converged book reports 0 here every sweep; a non-zero count is the repair
  // doing its job, and a count that never falls to 0 is a cascade failing for a
  // structural reason worth looking at.
  //
  // NOT rolled up into the parse summary: `accumulate` in parseDocumentsDb.js
  // hardcodes the keys it sums, and that file is isolation-listed, so surfacing
  // this counter there needs its own clearance. The DURABLE signal is the audit
  // pair (`reconciliation.cascade_failed` / `reconciliation.cascade_exhausted`)
  // plus `payload.cascade` on the row — both queryable without it.
  cascade_healed: 0,
  disabled: false,
  disabled_reason: null,
  mode: 'llm'
});

export const DISABLED_STATS = (reason) => ({
  ...ZERO_STATS(),
  disabled: true,
  disabled_reason: reason
});

export const pairKey = (txId, docId) => `${txId}|${docId}`;

// ── Bank-line-only explanations (the Exxon 25-07-29 fix) ──────────────
//
// Document evidence outranks a bank-line-only explanation. A line that
// the categorization pass explained from the bank line alone — a
// low-materiality client rule (`support_status='rule_explained'`) or
// the bank-line classifier (`payload.bank_line_auto_explained`) — used
// to vanish from every matcher's candidate pool, so a receipt arriving
// (or being matched) later stranded at NO MATCH while its line sat
// "explained" with no match row. The shared status filter below keeps
// those lines VISIBLE to the matchers; the per-line annotation hands
// the model the line's current explanation so it can weigh the
// document against it (more context, never a gate). Lines explained by
// a document match (`payload.reconciliation_match_type` points at a
// document) or by a human stay excluded — as does any line whose bank-line
// explanation the firm has CONFIRMED (a firm decision is honoured, same as
// SUPPRESSION_STATUSES). A posted line is admitted only when Donna's own
// auto-applied coding receipt proves the document arrived later; this attaches
// evidence without reopening the accounting state.
//
// June 2026 completion: the legacy transaction_intel pass explains
// lines with NO markers at all while pairing them to a merely
// SUGGESTED match, which made its own suggestion un-upgradeable — the
// strong matcher could never see the line to re-propose (and thereby
// auto-confirm) the pair. An `explained` line whose only match
// evidence is a LIVE unconfirmed `suggested` match is therefore also
// admitted; firm decisions (a confirmed or rejected match on the line)
// keep it suppressed.
//
// June 2026, second completion — the orphaned cascade stamp. The
// "explained by a document match stays excluded" rule above is only
// sound while the match row that justified the stamp is live at
// auto_matched/confirmed. The pre-guard transaction_intel refresh
// downgraded such rows back to its own `suggested` (status AND payload
// replaced), leaving lines stamped `reconciliation_match_type =
// '<doc type>'` with no settled match behind them — invisible to every
// matcher, so the damage could never self-heal. A doc-match-stamped
// line whose only live match evidence is a `suggested` row is
// therefore admitted too; any live auto_matched/confirmed/rejected row
// keeps it suppressed (genuinely settled lines and firm decisions are
// unaffected).
export const CANDIDATE_TX_STATUS_SQL = `(
          reconciliation_status is null
          or reconciliation_status not in ('explained', 'auto_reconciled', 'reconciled', 'posted')
          or (
            reconciliation_status = 'explained'
            and coalesce(payload->>'reconciliation_match_type', 'bank_line') = 'bank_line'
            and (
              payload->>'support_status' = 'rule_explained'
              or payload->>'bank_line_auto_explained' = 'true'
              -- The strong-model bank-line disposition pass (the successor to the
              -- retired bankLineAutoExplain) stamps a DIFFERENT marker key. Without
              -- this clause a line it explained stayed invisible to the matcher —
              -- the marker drift that stranded receipts (the Chevron case).
              or payload->>'bank_line_disposition_explained' = 'true'
              -- Coding auto-explain: the batch coder auto-APPLIED a category under
              -- the materiality limit (ai_suggestion_status='auto_applied'), which
              -- flips reconciliation_status='explained' with no bank-line marker at
              -- all. That is still a machine explanation a document should outrank —
              -- it is NOT a doc match (guarded by match_type='bank_line' above) nor a
              -- human/firm decision (those never carry 'auto_applied').
              or payload->>'ai_suggestion_status' = 'auto_applied'
            )
            and not exists (
              select 1 from reconciliation_matches rm
               where rm.bank_transaction_id = transactions.id
                 and rm.matched_object_type = 'bank_line'
                 and rm.status = 'confirmed'
            )
          )
          -- Coding recovery re-opens an unposted machine coding (coding_state
          -- back to proposed/held) and removes its auto_applied marker, but
          -- the row keeps the reconciliation_status that coding wrote. That
          -- status is not a settled relationship: the coding is unfinished
          -- and machine-owned, so its source document must still be able to
          -- attach. Human decisions and existing settled/rejected matches
          -- stay closed.
          or (
            reconciliation_status = 'explained'
            and coalesce(payload->>'reconciliation_match_type', 'bank_line') = 'bank_line'
            and coding_state in ('proposed', 'held')
            and coalesce(payload->>'ledger_journal_id', '') = ''
            and coalesce(payload->>'reviewed_by', '') in ('', 'coding_auto_post')
            and coalesce(payload->>'approved_by', '') in ('', 'coding_auto_post')
            and coalesce(payload->'accepted_coding_evidence', 'null'::jsonb) = 'null'::jsonb
            and coalesce(payload->>'auto_categorize_source', '') not in ('client_rule', 'merchant_lookup')
            and not exists (
              select 1 from reconciliation_matches rmr
               where rmr.bank_transaction_id = transactions.id
                 and rmr.status in ('confirmed', 'rejected', 'auto_matched')
            )
          )
          -- A description-only coding can reach the ledger before its receipt
          -- finishes parsing. That posting is terminal ACCOUNTING state, but
          -- it is not evidence that the later document is unrelated. Admit
          -- only Donna's own auto-applied, still-bank-line-only postings so the
          -- document can attach without reopening or rewriting the journal;
          -- human/firm postings and already document-matched lines stay closed.
          or (
            reconciliation_status = 'posted'
            and payload->>'ai_suggestion_status' = 'auto_applied'
            and coalesce(payload->>'reconciliation_match_type', 'bank_line') = 'bank_line'
            and not exists (
              select 1 from reconciliation_matches rmp
               where rmp.bank_transaction_id = transactions.id
                 and rmp.status in ('confirmed', 'rejected', 'auto_matched')
            )
          )
          or (
            reconciliation_status = 'explained'
            and coalesce(payload->>'reconciliation_match_type', 'bank_line') = 'bank_line'
            and exists (
              select 1 from reconciliation_matches rms
               where rms.bank_transaction_id = transactions.id
                 and rms.status = 'suggested'
            )
            and not exists (
              select 1 from reconciliation_matches rmf
               where rmf.bank_transaction_id = transactions.id
                 and rmf.status in ('confirmed', 'rejected')
            )
          )
          or (
            reconciliation_status in ('explained', 'reconciled')
            and coalesce(payload->>'reconciliation_match_type', 'bank_line') <> 'bank_line'
            and exists (
              select 1 from reconciliation_matches rmo
               where rmo.bank_transaction_id = transactions.id
                 and rmo.status = 'suggested'
            )
            and not exists (
              select 1 from reconciliation_matches rml
               where rml.bank_transaction_id = transactions.id
                 and rml.status in ('confirmed', 'rejected', 'auto_matched')
            )
          )
        )`;

// Companion SELECT columns for CANDIDATE_TX_STATUS_SQL — the payload
// markers the annotation helpers below need on each candidate row.
export const CANDIDATE_TX_EXPLAIN_SELECT_SQL = `payload->>'support_status' as support_status,
            payload->>'support_note' as support_note,
            payload->>'matched_client_rule_label' as matched_client_rule_label,
            payload->>'bank_line_auto_explained' as bank_line_auto_explained`;

// JS mirror of CANDIDATE_TX_STATUS_SQL's machine-only carve-outs — keep the two
// in lock-step. True for an `explained` line carrying a machine explanation a
// document should outrank, and for a `posted` line only when Donna's batch coder
// auto-applied it before the document arrived. Human/firm postings remain false.
export const isBankLineOnlyExplained = (tx = {}) => {
  const status = String(tx?.reconciliation_status || '');
  const machineExplanation = (
    tx?.support_status === 'rule_explained' ||
    tx?.bank_line_auto_explained === true ||
    String(tx?.bank_line_auto_explained || '') === 'true' ||
    tx?.bank_line_disposition_explained === true ||
    String(tx?.bank_line_disposition_explained || '') === 'true' ||
    tx?.ai_suggestion_status === 'auto_applied'
  );
  if (status === 'explained') return machineExplanation;
  // Posted is admitted only for the batch coder's explicit unattended
  // receipt. A human/firm posting never carries auto_applied and stays closed.
  return status === 'posted' && tx?.ai_suggestion_status === 'auto_applied';
};

const EXPLANATION_NOTE_MAX_CHARS = 140;

// One extra prompt line on a candidate that currently carries a
// bank-line-only explanation. Rendered by each spec's formatBankLine.
export const formatCurrentExplanationLine = (tx = {}) => {
  if (!isBankLineOnlyExplained(tx)) return '';
  const why = tx.matched_client_rule_label
    ? `client rule: ${tx.matched_client_rule_label}`
    : tx.support_note || 'bank-line classifier';
  const clipped = String(why).replace(/"/g, "'").slice(0, EXPLANATION_NOTE_MAX_CHARS);
  return `\n     currently_explained="${clipped}"`;
};

// Section appended to the user prompt when any candidate carries a
// bank-line-only explanation — tells the model that document evidence
// outranks it, so the existing explanation never suppresses a real
// settlement match.
export const formatCurrentExplanationNote = (candidateBankLines = []) => {
  if (!(candidateBankLines || []).some(isBankLineOnlyExplained)) return '';
  return `Note on currently_explained candidates: those lines were auto-explained without document evidence (a low-materiality client rule, the bank-line classifier/disposition, or the coder auto-applying a category under the materiality limit). Document evidence outranks a machine explanation: if this document genuinely settles such a line, propose the match exactly as you would for any other candidate — do not lower your confidence because the line already carries an explanation.`;
};

// ── Richer candidate view: opposite direction + reconciliation_status ──
// The eligible-direction SQL filter (AR→money_in, AP→money_out) is a
// query optimization, not a fact the model should be blind to. An inbound
// line on an outbound bill — a refund/contra — and a line that already
// carries a SETTLED reconciliation_status (reconciled / posted /
// duplicate) are exactly the signals a competent bookkeeper reads. We
// surface both ADDITIVELY: the common one-directional, unreconciled line
// renders exactly as before. Trust the strong model to interpret them.
//
// The bank-line-only `explained` case is deliberately excluded here — it
// is owned by formatCurrentExplanationLine/Note above, whose guidance
// ("document evidence outranks it, propose anyway") is the OPPOSITE of the
// already-settled guidance below; rendering both would contradict.
const OPPOSITE_DIRECTION = { money_in: 'money_out', money_out: 'money_in' };

// Statuses that carry no signal: a blank/unreconciled line is the default
// and rendering it would only add noise.
const UNINFORMATIVE_RECON_STATUS = new Set(['', 'none', 'null', 'unreconciled', 'pending']);

const isSettledStatusLine = (line = {}) => {
  if (isBankLineOnlyExplained(line)) return false;
  const status = String(line?.reconciliation_status ?? '').trim().toLowerCase();
  return Boolean(status) && !UNINFORMATIVE_RECON_STATUS.has(status);
};

// The extra per-candidate prompt lines (opposite-direction amount and/or
// settled status). `primaryDirection` is this matcher family's eligible
// direction ('money_in' for AR, 'money_out' for AP).
export const formatCandidateContextLines = (line = {}, primaryDirection = 'money_in') => {
  const out = [];
  const opposite = OPPOSITE_DIRECTION[primaryDirection] || 'money_out';
  const oppositeAmount = Number(line?.[opposite] ?? 0);
  if (oppositeAmount) out.push(`\n     ${opposite}=${oppositeAmount} ${line.currency || ''}`);
  if (isSettledStatusLine(line)) {
    out.push(`\n     reconciliation_status="${String(line.reconciliation_status).trim()}"`);
  }
  return out.join('');
};

// Conditional note appended when any candidate shows an opposite-direction
// amount or a settled status, so the richer view is read correctly.
export const formatRicherCandidateNote = (candidateBankLines = [], primaryDirection = 'money_in') => {
  const lines = candidateBankLines || [];
  const opposite = OPPOSITE_DIRECTION[primaryDirection] || 'money_out';
  const hasOpposite = lines.some((l) => Number(l?.[opposite] ?? 0));
  const hasSettled = lines.some(isSettledStatusLine);
  if (!hasOpposite && !hasSettled) return '';
  const parts = ['Note on the candidate view:'];
  if (hasOpposite) {
    parts.push(`some lines show a ${opposite} amount — the OPPOSITE direction to a normal settlement of this document. An opposite-direction line does not settle this document unless it is a genuine refund/contra the document itself evidences; otherwise do not propose it.`);
  }
  if (hasSettled) {
    parts.push(`some lines carry a reconciliation_status — a line already marked settled/reconciled is accounted for, so do not re-propose it unless this document is clear evidence of a SEPARATE, additional movement. If this document is already fully settled, return "proposals": [] with "unmatchable_reason": "already_settled".`);
  }
  return parts.join(' ');
};

// ── Firm context (the Failure C fix) ──────────────────────────────────
//
// These three helpers were added to BOTH per-direction modules when the
// live Pham-Xuan-Sang false positive shipped (an already-settled GBP
// bill offered against an unrelated EUR/VND debit purely on an FX amount
// coincidence). The fix is pure trust-the-strong-LLM: hand the model the
// firm's identity + the document's settled state and let it decline —
// never a currency/counterparty hard-gate (see CLAUDE.md Failures A/B/C
// and the §3 "MORE context, never a rule" decision). The logic is
// direction-agnostic; only the counterparty sentence and the document
// noun differ, so they are parameters and the helpers live here once.

// Firm-side anchor — tells the model who "we" are so a bank-line
// counterparty that is clearly a different party from the document's
// counterparty can be ruled out. Mirrors clientIdentityPrompt.js but
// framed for matching rather than extraction. `counterpartyClause` is
// the one direction-specific sentence (invoice/customer/payer vs
// bill/vendor). Returns null when no identity is available so the
// section drops out.
export const formatFirmAnchor = (clientIdentity, counterpartyClause) => {
  if (!clientIdentity) return null;
  const names = [
    clientIdentity.display_name,
    ...(Array.isArray(clientIdentity.legal_names) ? clientIdentity.legal_names : [])
  ]
    .map((n) => (n == null ? '' : String(n).trim()))
    .filter(Boolean);
  if (!names.length) return null;
  const display = names[0];
  const aliases = names.slice(1);
  const aliasLine = aliases.length
    ? ` (also recorded as ${aliases.map((a) => `"${a}"`).join(', ')})`
    : '';
  const jurisdiction = clientIdentity.jurisdiction
    ? String(clientIdentity.jurisdiction).trim()
    : '';
  const jurisdictionLine = jurisdiction
    ? `\nThe firm is based in ${jurisdiction} — infer its home/accounting currency from this; online payment links typically localize charges into that currency regardless of the document's currency.`
    : '';
  return `Firm (the bookkeeping client — "us"): "${display}"${aliasLine}.
${counterpartyClause}${jurisdictionLine}`;
};

// Settlement state for the document — lets the model decline a phantom
// second match against a doc already settled by another bank line.
// Reports the line count + recorded payment_status rather than a
// remaining-due figure: match_amount is in the BANK line's currency and
// the doc total in the doc's, so subtracting them is meaningless under
// FX (the exact Oxbridge GBP-bill / SGD-settlement case). `docNoun` is
// 'invoice' (AR) or 'bill' (AP). Returns null when there's no signal.
export const formatSettlement = (settlement, docNoun) => {
  if (!settlement) return null;
  const parts = [];
  if (settlement.settledCount > 0) {
    const amount = Number.isFinite(Number(settlement.settledAmount)) && Number(settlement.settledAmount) > 0
      ? ` (${Number(settlement.settledAmount).toFixed(2)} settled by those lines)`
      : '';
    parts.push(`${settlement.settledCount} bank line(s) already matched to this ${docNoun}${amount}`);
  }
  // RT-27 — credit notes already APPLIED to this document reduce what a
  // bank line should carry; the remaining due is the arithmetic the model
  // reasons against, never the printed total alone.
  if (Number.isFinite(Number(settlement.appliedCredits)) && Number(settlement.appliedCredits) > 0) {
    parts.push(`${Number(settlement.appliedCredits).toFixed(2)} already applied from customer credit note(s)`);
  }
  if (Number.isFinite(Number(settlement.remainingDue))) {
    parts.push(`remaining due: ${Number(settlement.remainingDue).toFixed(2)}`);
  }
  if (settlement.paymentStatus) parts.push(`recorded payment status: ${settlement.paymentStatus}`);
  if (!parts.length) return null;
  return `Settlement state for this ${docNoun} — ${parts.join('; ')}. If this ${docNoun} is already fully settled (status "paid"), only propose a further match given unambiguous evidence of a separate additional payment for it; this restriction does not apply when the status is not "paid".`;
};

// Dedupe (case-insensitive), trim, and cap a list of {name} rows into a
// compact string[]. Shared by both branches of loadKnownCounterparties.
const dedupeCapNames = (rows) => {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const name = row?.name == null ? '' : String(row.name).trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_KNOWN_COUNTERPARTIES) break;
  }
  return out;
};

// A missing xero_contacts table/column is the COMMON case (most firms
// aren't Xero-connected), so degrade to [] rather than throwing — the
// caller then falls through to the documents source.
const emptyOnMissingRelation = (error) => {
  if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
  throw error;
};

// Load the firm's known counterparties for the matcher prompt — the
// names it bills (suppliers) or invoices (customers). Lets the model
// POSITIVELY place a bank-line counterparty ("this line names Pham Xuan
// Sang, a separate vendor we pay — not this bill's vendor") rather than
// only ruling one out via the firm anchor. `role` is 'supplier' (AP) or
// 'customer' (AR). Source: the firm's synced Xero contact book,
// direction-filtered, when connected; else distinct counterparty names
// from parsed documents. Column names are branched (not interpolated)
// to stay obviously injection-free and SQL-writer-lint clean. Returns a
// deduped, capped, alpha-sorted string[]; [] when neither source has
// names.
export const loadKnownCounterparties = async ({ client, firmId, clientId, role } = {}) => {
  if (!client || !firmId || !clientId) return [];
  if (role !== 'supplier' && role !== 'customer') return [];

  if (role === 'supplier') {
    const xeroResult = await client
      .query(
        `select name from xero_contacts
          where firm_id = $1 and client_id = $2 and is_supplier = true and name is not null
          order by name
          limit $3`,
        [firmId, clientId, MAX_KNOWN_COUNTERPARTIES]
      )
      .catch(emptyOnMissingRelation);
    const fromXero = dedupeCapNames(xeroResult.rows);
    if (fromXero.length) return fromXero;

    const docResult = await client.query(
      `select distinct vendor_name as name from documents
        where firm_id = $1 and client_id = $2 and document_type = 'supplier_bill'
          and vendor_name is not null and vendor_name <> '' and duplicate_of is null
        order by vendor_name
        limit $3`,
      [firmId, clientId, MAX_KNOWN_COUNTERPARTIES]
    );
    return dedupeCapNames(docResult.rows);
  }

  const xeroResult = await client
    .query(
      `select name from xero_contacts
        where firm_id = $1 and client_id = $2 and is_customer = true and name is not null
        order by name
        limit $3`,
      [firmId, clientId, MAX_KNOWN_COUNTERPARTIES]
    )
    .catch(emptyOnMissingRelation);
  const fromXero = dedupeCapNames(xeroResult.rows);
  if (fromXero.length) return fromXero;

  const docResult = await client.query(
    `select distinct customer_name as name from documents
      where firm_id = $1 and client_id = $2 and document_type in ('sales_invoice', 'issued_receipt')
        and customer_name is not null and customer_name <> '' and duplicate_of is null
      order by customer_name
      limit $3`,
    [firmId, clientId, MAX_KNOWN_COUNTERPARTIES]
  );
  return dedupeCapNames(docResult.rows);
};

// Compact known-counterparties section for the prompt. The descriptor
// supplies the direction nouns: { noun: 'vendors'|'customers', verb:
// 'pays'|'invoices', selfNoun: "this bill's vendor"|"this invoice's
// customer" }. The instruction teaches the model to use the roster
// POSITIVELY — a bank line naming a different known counterparty settles
// THAT party, not this document — not as a hard gate. Returns null when
// the list is empty so the section drops out.
export const formatKnownCounterparties = (names, { noun, verb, selfNoun } = {}) => {
  const list = Array.isArray(names)
    ? names.map((n) => (n == null ? '' : String(n).trim())).filter(Boolean)
    : [];
  if (!list.length) return null;
  return `Known ${noun} for this firm (the counterparties it ${verb}): ${list.join(', ')}.
A bank line whose counterparty clearly names a DIFFERENT one of these — not ${selfNoun} — is evidence it settles THAT party, not this document. Use this roster to positively place a counterparty, not only to rule one out.`;
};

// Sibling documents — the false-twin killer (Honeybee Exxon, 2026-08-26).
// Matching runs one document per call, so when TWO same-amount documents
// and two same-amount bank lines exist, each per-document call sees both
// lines and only its own document: the model's honest answer is an
// equal-confidence tie, and the "ambiguity" that reaches the owner was
// manufactured by hiding the sibling. This section tells the model the
// truth about the world: every open same-amount sibling document, its
// date/reference, and whether it is already settled — so ties resolve
// 1:1 by each document's OWN date/reference instead of surfacing every
// line. Renders '' when there are no siblings, keeping every existing
// prompt byte-identical.
//
// Each sibling: { id, vendor_name, document_date (ISO day or null),
// total_amount, currency, reference_number, filename,
// settled_line_dates: [ISO day] }.
export const formatSiblingDocuments = (siblings, { docNoun = 'document' } = {}) => {
  const list = Array.isArray(siblings) ? siblings.filter((s) => s && s.id) : [];
  if (!list.length) return '';
  const rows = list.map((s) => {
    const settled = Array.isArray(s.settled_line_dates)
      ? s.settled_line_dates.filter(Boolean)
      : [];
    const state = settled.length
      ? `SETTLED by bank line(s) dated ${settled.join(', ')}`
      : 'open — its own matching pass proposes for it';
    return `  - id=${s.id} vendor_name="${s.vendor_name || ''}" total=${s.total_amount} ${s.currency || ''} date=${s.document_date || 'unknown'} reference="${s.reference_number || ''}" file="${s.filename || ''}" [${state}]`;
  });
  return `Other ${docNoun}s open for the SAME amount (context only — you are matching THIS ${docNoun}, never these):
${rows.join('\n')}
How to use the siblings:
- Same-amount ${docNoun}s and same-amount bank lines resolve ONE-TO-ONE across passes. Pair THIS ${docNoun} with the candidate line that best fits ITS OWN date and reference; a line that fits a sibling better belongs to that sibling's pass — give it low confidence here rather than proposing an equal tie.
- A sibling marked SETTLED has already consumed the listed line(s); THIS ${docNoun} pairs among the remaining candidates.
- Same-day retail and fuel ${docNoun}s: the bank line usually posts on the ${docNoun}'s own date or within a few days on EITHER side, so use closest-date proximity plus any site/terminal/reference codes in the line description — not a strict on-or-after-the-${docNoun}-date rule.
- A sibling identical in vendor, amount, date, AND reference may be the same ${docNoun} uploaded twice — never use it to justify claiming a second line; propose the single best line and state the duplicate suspicion in your reasoning.
- Declare an equal-confidence tie ONLY when, even with these siblings on the table, nothing visible tells which line settles THIS ${docNoun}.`;
};

// Orchestrator helper: load the firm's identity, assemble the settlement
// object, and (when `counterpartyRole` is given) load the known-
// counterparty roster — identical wiring in both per-direction
// orchestrators. Queried through the orchestrator's pg `client` (NOT
// getClientIdentityInDb, which uses a separate pool the test harness
// can't intercept) so it stays transaction-consistent and testable. The
// caller's existing-match loop supplies `settledCount` (that loop also
// builds the suppression sets, so it stays in the orchestrator). The
// settlement object is null unless there's an actual signal — a prior
// settling line OR a non-trivial payment_status.
export const loadFirmContext = async ({
  client,
  firmId,
  clientId,
  document,
  settledCount,
  counterpartyRole = null,
  paymentStatusIsSettlementSignal = true,
  // RT-27 — the settled AMOUNT (confirmed/auto_matched lines) and the credit
  // notes already applied to this document; null when the caller does not
  // track them (every non-AR family), keeping their prompts byte-identical.
  settledAmount = null,
  appliedCredits = null
}) => {
  const identityResult = await client.query(
    `select id, company_name, legal_names, jurisdiction from clients where firm_id = $1 and id = $2 limit 1`,
    [firmId, clientId]
  );
  const clientIdentity = identityResult.rows.length
    ? {
        display_name: identityResult.rows[0].company_name || null,
        legal_names: Array.isArray(identityResult.rows[0].legal_names)
          ? identityResult.rows[0].legal_names.filter(Boolean)
          : [],
        // Jurisdiction anchors the payment-link localization pattern:
        // a payment link charges the firm in its HOME currency (which
        // the model infers from the jurisdiction — SG → SGD) regardless
        // of the document's currency. Facts in, no currency map here.
        jurisdiction: identityResult.rows[0].jurisdiction || null
      }
    : null;

  // For most families the recorded payment_status is itself a settlement
  // signal: a bill/invoice only flips to 'paid' (or 'partial') once a bank
  // line settles it, so a non-trivial status means prior reconciliation.
  // Receipts are the exception — a receipt is intrinsically 'paid' the
  // moment it is uploaded (it IS proof of a completed payment), so its
  // payment_status says nothing about whether a bank line has been matched
  // yet. Such families pass paymentStatusIsSettlementSignal=false so an
  // as-yet-unmatched paid receipt does NOT get an "already settled, return
  // no proposals" note that would suppress its legitimate FIRST match;
  // settlement is then driven purely by settledCount (an actual prior
  // matched bank line). This is the trust-the-strong-LLM move — give the
  // model only signals that are real, never a rule that hides a match.
  const paymentStatusSignals =
    paymentStatusIsSettlementSignal &&
    !!document.payment_status &&
    document.payment_status !== 'unpaid' &&
    document.payment_status !== 'unknown';
  const creditsApplied = Number.isFinite(Number(appliedCredits)) && Number(appliedCredits) > 0 ? Number(appliedCredits) : 0;
  const hasSettlementSignal = settledCount > 0 || paymentStatusSignals || creditsApplied > 0;
  const docTotal = Number(document?.total_amount);
  const remainingDue = hasSettlementSignal && Number.isFinite(docTotal) && (settledAmount != null || creditsApplied > 0)
    ? Math.round((docTotal - (Number(settledAmount) || 0) - creditsApplied) * 100) / 100
    : null;
  const settlement = hasSettlementSignal
    ? {
        settledCount,
        paymentStatus: document.payment_status || null,
        ...(settledAmount != null ? { settledAmount: Number(settledAmount) || 0 } : {}),
        ...(creditsApplied > 0 ? { appliedCredits: creditsApplied } : {}),
        ...(remainingDue != null ? { remainingDue } : {})
      }
    : null;

  const knownCounterparties = counterpartyRole
    ? await loadKnownCounterparties({ client, firmId, clientId, role: counterpartyRole })
    : [];

  return { clientIdentity, settlement, knownCounterparties };
};

// Persist one LLM proposal: UPSERT the reconciliation_matches row,
// emit the audit event, and cascade payment-status on a fresh or
// upgraded auto-match. Mutates `stats` (the per-direction orchestrator
// owns the object so the cron rollup's `accumulate(stats)` sees the
// same shape regardless of which matcher ran).
//
// The spec supplies:
//   - objectType  → matched_object_type ('sales_invoice' | 'supplier_bill' | …)
//   - matchAmount → the eligible direction's amount (money_in | money_out)
//   - source      → payload.source / match_reason.source (load-bearing
//                   downstream; dashboards + parse_summary filter on it)
//   - matchKind   → audit metadata match_kind
//   - logTag      → console.error namespace on cascade failure
//
// Everything else is direction-agnostic. The UPSERT param ORDER is a
// contract pinned by the matcher test suites (matched_object_type at
// $5, match_amount at $7, payload at the tail) — do not reorder.

// How many times a failing cascade is re-attempted across sweeps before the row
// stops retrying and records an 'exhausted' receipt instead. Bounded so a
// permanently-broken cascade cannot burn a retry on every sweep forever; small
// because each attempt is a whole sweep apart, not a tight loop.
export const CASCADE_MAX_ATTEMPTS = 3;

// Historical match/evaluation statements can run in autocommit or inside a
// caller-owned transaction. A post-query check alone cannot undo autocommit
// after a lock wait. Probe with SAVEPOINT (25P01 means no transaction), fence
// only this verdict statement, and leave cascade partial-failure semantics intact.
const queryReconciliationVerdict = async (client, ...args) => {
  if (!currentExecutionBudget()) return client.query(...args);
  let ownsTransaction = false;
  let established = false;
  const savepoint = 'reconciliation_verdict_budget';
  try {
    assertExecutionBudgetActive();
    try {
      await client.query(`savepoint ${savepoint}`);
    } catch (error) {
      if (error?.code !== '25P01') throw error;
      await client.query('begin');
      ownsTransaction = true;
    }
    established = true;
    assertExecutionBudgetActive();
    const result = await client.query(...args);
    assertExecutionBudgetActive({ client });
    await client.query(ownsTransaction ? 'commit' : `release savepoint ${savepoint}`);
    return result;
  } catch (error) {
    if (established) {
      await client.query(ownsTransaction ? 'rollback' : `rollback to savepoint ${savepoint}`).catch(() => {});
      if (!ownsTransaction) await client.query(`release savepoint ${savepoint}`).catch(() => {});
    }
    // The family wrappers must retain queue-owned failure, never replace an
    // expired model verdict with weighted matching. This is worker expiry;
    // no provider identity is inferred from the model or source string.
    if (error?.code === 'EXECUTION_BUDGET_EXHAUSTED') {
      throw classifyProviderThrow({ provider: null, error, timedOut: true, reason: 'execution_budget_exhausted' });
    }
    throw error;
  } finally {
    if (ownsTransaction) clearVerdictTransactionBudget(client);
  }
};

export const upsertMatchAndCascade = async ({
  client,
  firmId,
  clientId,
  proposal,
  document,
  objectType,
  matchAmount,
  autoThreshold,
  // Authorization decision from authorizeMatch() — the band the model's
  // chosen target is allowed to execute at. The seam that USED to be
  // `proposal.confidence >= autoThreshold ? auto_matched : suggested`.
  // Absent → 'suggested' (the safe default; never silently auto-match
  // on raw confidence). See the auto-match authority policy above.
  authorization = null,
  // Provider-RETURNED model id captured at the API boundary (the
  // receipt — read the model from the data, not the requested string).
  returnedModel = null,
  source,
  matchKind,
  unmatchableReason = null,
  logTag = 'reconciliationLlmCore',
  // Phase 0B family-matcher coverage: the config snapshot id this run resolved
  // (clientConfig.persistConfigSnapshot, threaded once per run by the orchestrator).
  // null ⇒ the decision row is un-stamped, byte-identical to pre-bridge.
  configSnapshotId = null,
  stats,
  // RT-21c: the settlement row this match settles (resolveSettlementRow), or
  // null for a document-level match. Written to matched_line_id (migration
  // 150) and receipted on the payload.
  settlementRow = null,
  // RT-27: the credit-note applications validated under the lock for THIS
  // settlement ({ invoice, applications, actorId, model, authority }) — persisted
  // by applyCreditApplicationsWithClient right after a fresh/upgraded
  // auto_matched upsert and BEFORE the cascade, so the payment status the
  // cascade computes already counts them. The caller owns the transaction
  // (withCreditApplicationTransaction): a failing application rolls the match
  // row back with it — never an auto_matched row whose arithmetic relied on a
  // credit that did not land.
  creditApplications = null
}) => {
  const matchedLineId = settlementRow?.line_id ? String(settlementRow.line_id) : null;
  const matchId = makeMatchId({
    clientId,
    txId: proposal.bank_transaction_id,
    objectType,
    docId: document.id,
    lineId: matchedLineId,
    lineNo: settlementRow?.line_no ?? null
  });
  const admissionLease = await acquireEntityReadinessAdmissionLeaseWithClient({
    client,
    firmId,
    clientId,
    boundary: 'reconciliation_authority',
    resourceType: 'reconciliation_match',
    resourceId: matchId
  });
  let admissionWorkError;
  try {
  // The cross-entity Keep-layer check (Kari's dated go, 2026-08-09). The
  // §4b-xvi guard lived only in the LEGACY family matchers' auto decisions;
  // this seam — the one every *ReconciliationLlm module funnels through, and
  // the lane that actually runs once the Anthropic key is lit — bypassed it,
  // so a payment on ANOTHER ENTITY's card auto-matched under material_auto_fyi
  // (the Gate 0 Amex/Desert Bloom case: parties persisted, never read).
  // Deterministic assessment over verdicts the strong extractor already
  // persisted — no LLM call. A confident mismatch CAPS the write at
  // 'suggested' whatever band authorizeMatch granted, records the reason in
  // the authorization receipt, and stamps payload.cross_entity — the receipt
  // the auto-explain refusals, rule 1.7's fact ask, and the UI all render.
  // Absent identity/fields resolve 'unknown' → byte-identical, never blocking.
  const clientIdentity = await readClientIdentityWithClient(client, { firmId, clientId });
  const entityAlignment = assessDocumentEntityAlignment({ clientIdentity, document });
  const crossEntityMismatch = entityAlignment.verdict === 'mismatch';
  const writeStatus =
    !crossEntityMismatch && authorization?.band === 'auto_matched' ? 'auto_matched' : 'suggested';
  const writeScore = proposal.confidence;

  const summary =
    proposal.reasoning ||
    (writeStatus === 'auto_matched'
      ? 'LLM matcher proposed an auto-match.'
      : 'LLM matcher suggested this candidate.');

  const payload = {
    source,
    match_reason: {
      source,
      summary,
      confidence: proposal.confidence,
      hops: proposal.hops,
      reasoning: proposal.reasoning,
      unmatchable_reason: unmatchableReason || null
    },
    // The authorization receipt: why this match was (or was not) granted
    // unattended auto-match authority. The provider-RETURNED model id is
    // the deploy-vintage receipt (CLAUDE.md "the model id is the receipt").
    authorization: {
      band: writeStatus,
      model: returnedModel || null,
      second_best_confidence: authorization?.secondBestConfidence ?? null,
      gates: authorization?.gates || {},
      // On a cross-entity cap the granted band's reasons stay (honest
      // history: what authorizeMatch decided) and the cap appends its own.
      reasons: crossEntityMismatch
        ? [...(authorization?.reasons || []), 'cross_entity_mismatch']
        : (authorization?.reasons || []),
      policy: authorization?.policy || null,
      // The delegated-authority receipt (Slice 2 of #5): present only when a
      // covering grant upgraded this match (grantAuthority); null otherwise. It
      // is built into the full authorization here — never deep-merged — so the
      // wholesale top-level payload merge below always persists a COMPLETE
      // authorization (affirmative gate receipt + this receipt), never a partial
      // one that would misrepresent a delegated accept (spec §11).
      delegated_authority: authorization?.delegated_authority || null,
      // The no-gate material auto-post receipt (E2 / 2026-06-24 decision): present
      // only when applyMaterialAutoFyi flipped a still-held no-grant material match
      // to auto_matched; null otherwise. Carries owner_notified — the E3 FYI-rail
      // seam — so a material auto-post and whether its courtesy FYI has landed are
      // both reconstructable from the persisted receipt alone.
      material_auto_fyi: authorization?.material_auto_fyi || null,
      // RT-21c: the row the gates were judged on (null on a document-level match).
      settlement_row: authorization?.settlement_row || null,
      // RT-27: which credit notes this settlement applied (and which the
      // runtime refused, by code) — present only when credits were in play.
      ...(authorization?.credit_notes ? { credit_notes: authorization.credit_notes } : {})
    },
    recommended_action: writeStatus === 'auto_matched' ? 'auto_matched' : 'review',
    ...(crossEntityMismatch ? { cross_entity: crossEntityPayload(entityAlignment) } : {}),
    ...(matchedLineId
      ? { settlement_row: { line_id: matchedLineId, line_no: settlementRow.line_no ?? null, net: settlementRow.net ?? null, description: settlementRow.description ?? null } }
      : {})
  };

  // Same UPSERT shape as the weighted matcher — the status CASE
  // gate prevents downgrading a confirmed/rejected row, and the
  // CTE-returned `prior_status` lets us detect a real
  // suggested→auto_matched upgrade vs. an idempotent refresh.
  const insertResult = await queryReconciliationVerdict(client,
    `with prior as (
       select status as prior_status
       from reconciliation_matches
       where bank_transaction_id = $4
         and matched_object_type = $5
         and matched_object_id = $6
     )
     insert into reconciliation_matches (
       id, firm_id, client_id, bank_transaction_id,
       matched_object_type, matched_object_id,
       match_amount, match_confidence, match_reason,
       status, created_by, payload,
       matched_line_id
     ) values (
       $1, $2, $3, $4,
       $5, $6,
       $7, $8, $9,
       $10, 'system', $11::jsonb,
       $12
     )
     on conflict (bank_transaction_id, matched_object_type, matched_object_id) do update
       set match_amount = excluded.match_amount,
           match_confidence = excluded.match_confidence,
           match_reason = excluded.match_reason,
           matched_line_id = excluded.matched_line_id,
           payload = reconciliation_matches.payload || excluded.payload,
           status = case
             when reconciliation_matches.status = 'suggested'
              and excluded.status = 'auto_matched'
             then 'auto_matched'
             else reconciliation_matches.status
           end,
           updated_at = now()
       where reconciliation_matches.status not in ('confirmed', 'rejected', 'auto_matched')
     returning
       id,
       (xmax = 0) as inserted,
       status as final_status,
       coalesce((select prior_status from prior), 'inserted') as prior_status`,
    [
      matchId,
      firmId,
      clientId,
      proposal.bank_transaction_id,
      objectType,
      document.id,
      matchAmount,
      writeScore,
      summary,
      writeStatus,
      JSON.stringify(payload),
      matchedLineId
    ]
  );

  // The DO UPDATE carries `where status not in ('confirmed','rejected','auto_matched')`,
  // so a row that is ALREADY auto_matched returns NO row at all — it does not fall
  // through to the idempotent-refresh branch below. That distinction is the whole
  // reason the cascade repair hangs off this path and not off the `else`: the
  // already-auto_matched row (the only kind that can carry an unapplied cascade) is
  // never seen down there. See `healBlockedAutoMatch` below.
  const blockedUpsert = !insertResult.rows.length;

  const wasInserted = !blockedUpsert && Boolean(insertResult.rows[0].inserted);
  const priorStatus = blockedUpsert ? null : insertResult.rows[0].prior_status;
  const finalStatus = blockedUpsert ? null : insertResult.rows[0].final_status;
  const wasUpgraded =
    !blockedUpsert && !wasInserted && priorStatus === 'suggested' && finalStatus === 'auto_matched';

  const auditMetadata = {
    match_id: matchId,
    bank_transaction_id: proposal.bank_transaction_id,
    matched_object_id: document.id,
    matched_line_id: matchedLineId,
    match_kind: matchKind,
    matcher_mode: 'llm',
    score: writeScore,
    hops: proposal.hops,
    reasoning: proposal.reasoning,
    auto_threshold: autoThreshold,
    authorization: payload.authorization
  };

  // ── The cascade outcome is PERSISTED, not swallowed (Kari decision 2, Option B) ──
  //
  // For autocommit callers, the match row commits before the cascade (the budget
  // fence above owns only its verdict statement), so a cascade that throws used
  // to leave `reconciliation_matches.status = 'auto_matched'` while the transaction
  // still read unexplained and the document still read unpaid — and nothing ever
  // retried it. Under the FIRST principle that row rested in NEITHER terminal state:
  // not auto-reconciled (the cascade never landed) and not on the owner (nothing was
  // asked). Silent firm-side limbo that no surface reported, because every surface
  // read the side of the split that looked fine to it.
  //
  // The state rides the existing `payload` jsonb — no migration, no new table:
  //   { state: 'applied' | 'failed' | 'exhausted', at, attempts, error_class }
  //
  // Stamping is best-effort BY DESIGN, and it degrades safely in both directions: if
  // the stamp fails after a successful cascade the row stays unstamped and the next
  // sweep re-runs an idempotent cascade; if it fails after a failed cascade we lose
  // the attempt count and the next sweep retries. Neither is worse than the swallow
  // this replaces, and neither can wedge the sweep.
  const stampCascadeState = async (state, extra = {}) => {
    await client.query(
      `update reconciliation_matches
          set payload = payload || jsonb_build_object(
                'cascade', $3::jsonb || jsonb_build_object('state', $4::text, 'at', now())
              ),
              updated_at = now()
        where id = $1 and firm_id = $2`,
      [matchId, firmId, JSON.stringify(extra), state]
    );
  };

  const runCascade = async (label, { priorAttempts = 0 } = {}) => {
    try {
      await cascadeAutoMatch({
        client,
        firmId,
        clientId,
        matchId,
        bankTransactionId: proposal.bank_transaction_id,
        matchedObjectType: objectType,
        documentId: document.id
      });
      await applyDocumentPaymentStatusAfterMatch({
        client,
        firmId,
        matchId,
        matchedObjectType: objectType,
        documentId: document.id
      });
      try {
        await stampCascadeState('applied', { attempts: priorAttempts + 1 });
      } catch (stampError) {
        console.error(`[${logTag}] ${label} cascade applied but stamp failed`, {
          matchId,
          error: stampError?.message || String(stampError)
        });
      }
      return 'applied';
    } catch (error) {
      const attempts = priorAttempts + 1;
      // Bounded: after CASCADE_MAX_ATTEMPTS the row stops retrying and says so
      // loudly, rather than re-running a doomed cascade on every sweep forever.
      // 'exhausted' is a receipted dead end, not a quiet one — it is queryable
      // from the payload and carries its own audit action.
      const exhausted = attempts >= CASCADE_MAX_ATTEMPTS;
      const errorClass = error?.code || error?.constructor?.name || 'Error';
      console.error(`[${logTag}] ${label} cascade failed`, {
        matchId,
        attempts,
        exhausted,
        error: error?.message || String(error)
      });
      try {
        await stampCascadeState(exhausted ? 'exhausted' : 'failed', {
          attempts,
          error_class: errorClass
        });
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, 'reconciliation_match', $4, $5::jsonb)`,
          [
            firmId,
            clientId,
            exhausted ? 'reconciliation.cascade_exhausted' : 'reconciliation.cascade_failed',
            matchId,
            JSON.stringify({
              match_id: matchId,
              label,
              attempts,
              max_attempts: CASCADE_MAX_ATTEMPTS,
              error_class: errorClass,
              error: error?.message || String(error),
              bank_transaction_id: proposal.bank_transaction_id,
              matched_object_type: objectType,
              matched_object_id: document.id
            })
          ]
        );
      } catch (recordError) {
        console.error(`[${logTag}] ${label} cascade failure could not be recorded`, {
          matchId,
          error: recordError?.message || String(recordError)
        });
      }
      return exhausted ? 'exhausted' : 'failed';
    }
  };

  // RT-27 — the credit notes riding this settlement. Persisted in the SAME
  // transaction as the auto_matched row (the caller owns it); a throw here
  // propagates past the cascade and rolls the row back with it.
  const applyRidingCreditApplications = async () => {
    const riding = creditApplications && Array.isArray(creditApplications.applications) && creditApplications.applications.length
      ? creditApplications
      : null;
    if (!riding) return;
    const outcome = await applyCreditApplicationsWithClient({
      client,
      firmId,
      clientId,
      invoice: riding.invoice || document,
      applications: riding.applications,
      settlementMatchId: matchId,
      actorId: riding.actorId || 'system',
      model: riding.model || returnedModel || null,
      authority: riding.authority || { band: writeStatus, reasons: authorization?.reasons || [] },
      source
    });
    stats.credit_notes_applied = (stats.credit_notes_applied || 0) + outcome.applied.length;
  };

  // The heal. A blocked UPSERT means the row is already confirmed / rejected /
  // auto_matched. Only the auto_matched case is ours: if its cascade never landed,
  // re-run it now. A converged book does ONE indexed lookup and stops — `applied`
  // short-circuits before any cascade work.
  //
  // Rows written before this change carry no `cascade` key at all. They are treated
  // as unapplied, so the first sweep after deploy re-runs their cascade once and
  // stamps them. That is deliberate: it heals historical splits. It is safe because
  // both cascade steps are idempotent — `applyDocumentPaymentStatusAfterMatch`
  // recomputes the same status from the settled-match sum, and `cascadeAutoMatch`
  // never overwrites an already-resolved transaction.
  const healBlockedAutoMatch = async () => {
    const existing = await client.query(
      `select status,
              payload->'cascade'->>'state' as cascade_state,
              coalesce((payload->'cascade'->>'attempts')::int, 0) as cascade_attempts
         from reconciliation_matches
        where id = $1 and firm_id = $2`,
      [matchId, firmId]
    );
    const row = (existing.rows || [])[0];
    // confirmed / rejected are human terminal states — a cascade repair has no
    // business touching them. Only an auto_matched row can carry Donna's split.
    if (!row || row.status !== 'auto_matched') return;
    if (row.cascade_state === 'applied') return;
    if (row.cascade_state === 'exhausted') return;
    stats.cascade_healed += 1;
    await runCascade('heal', { priorAttempts: Number(row.cascade_attempts) || 0 });
  };

  // Phase 0B family-matcher coverage — record the auto-match authority DECISION (the
  // band authorizeMatch produced) into the decision ledger. Mirrors the audit_events
  // emit below: written ONLY on a genuine new (inserted) or upgraded decision, never on
  // an idempotent refresh — so a converged book never accrues a row per sweep. Follows
  // the triage matcher's decisionType:'match' / targetType:'reconciliation_match'
  // convention (reconciliationTriage.js). ADDITIVE + SOFT-FAIL: a logging error is
  // caught and never touches the persisted match, status, or cascade.
  const recordMatchDecision = async (decisionFinalState) => {
    try {
      await recordLlmDecision({
        client,
        firmId,
        clientId,
        decisionType: 'match',
        targetType: 'reconciliation_match',
        targetId: matchId,
        modelName: returnedModel || null,
        deterministicSignals: {
          second_best_confidence: authorization?.secondBestConfidence ?? null,
          gates: authorization?.gates || {},
          source
        },
        confidence: { score: proposal.confidence },
        policyBlockers: authorization?.reasons || [],
        llmReasoning: proposal.reasoning || null,
        finalState: decisionFinalState,
        configSnapshotId
      });
    } catch (error) {
      console.error(`[${logTag}] decision logging failed`, {
        matchId,
        error: error?.message || String(error)
      });
    }
  };

  // Nothing was written — the row is already confirmed, rejected or auto_matched.
  // The only repair that belongs here is an auto_matched row whose cascade never
  // landed; everything else returns as it always did.
  if (blockedUpsert) {
    await healBlockedAutoMatch();
  } else if (wasInserted) {
    stats.suggested_inserted += 1;
    const auditAction =
      writeStatus === 'auto_matched'
        ? 'reconciliation.candidate.auto_matched'
        : 'reconciliation.candidate.suggested';
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'reconciliation_match', $4, $5::jsonb)`,
      [firmId, clientId, auditAction, matchId, JSON.stringify(auditMetadata)]
    );
    await recordMatchDecision(finalStatus);
    if (writeStatus === 'auto_matched') {
      stats.auto_match_eligible += 1;
      await applyRidingCreditApplications();
      await runCascade('auto-match');
    }
  } else if (wasUpgraded) {
    stats.auto_match_upgraded += 1;
    stats.auto_match_eligible += 1;
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'reconciliation_match', $4, $5::jsonb)`,
      [
        firmId,
        clientId,
        'reconciliation.candidate.status_upgraded',
        matchId,
        JSON.stringify({ ...auditMetadata, prior_status: priorStatus, status: finalStatus })
      ]
    );
    await recordMatchDecision(finalStatus);
    await applyRidingCreditApplications();
    await runCascade('upgrade');
  } else {
    stats.suggested_refreshed += 1;
  }
  // RT-13 — the match row is an input of the persisted convergence verdict on
  // BOTH sides (the bank line's cascade / settled set, the document's no-line
  // membership), so the upsert re-derives both in the SAME transaction before
  // it returns. A suggested row that never cascades still changes the
  // document's population; a refreshed row costs one idempotent re-read.
  await applyConvergenceStateBestEffort(client, {
    firmId,
    transactionId: proposal.bank_transaction_id,
    documentId: document.id
  }, { logTag });
  } catch (error) {
    admissionWorkError = error;
    throw error;
  } finally {
    await releaseAdmissionLeasePreservingError(admissionLease, admissionWorkError);
  }
};

// ── Evaluation verdicts (migration 028) ──────────────────────────────
//
// Persist the matcher's verdict for a document even when it proposes
// nothing. Before this, the zero-proposal verdict — the model's honest
// no_plausible_match / insufficient_bank_feed / already_settled —
// survived only as a console log, so "evaluated, no match" was
// indistinguishable from "matcher never ran". Absence of a row is not
// a verdict; this stamp is what the ask-pipeline and the artifact's
// no-match / pending states key off.
//
// One row per (firm, client, target, matcher family), upserted to the
// LAST evaluation: every sweep re-evaluates, and a no_match from a
// cold-start pass is legitimately overwritten by 'proposed' once firm
// context accumulates (the June cold-start lesson). A live
// reconciliation_matches row always outranks this stamp — renderers
// consult matches first. The stamp lives in its OWN table because a
// zero-proposal verdict is an evaluation result, not a candidate
// pair; no-match pseudo-rows in reconciliation_matches would repeat
// the bankLineAutoExplain self-reference overload.

// Slice E (b) — does a SETTLED bank line already cover this document's amount?
// PURE correctness scaffolding (arithmetic + settled status), NOT an
// intelligence-substituting matching rule: it does not assert that THIS
// document settled that line, only that the amount is already accounted for —
// so the matcher can record the honest 'already_settled' reason instead of
// 'no_plausible_match'. The settled-status list + exact-net-amount + currency
// guard mirror loopsShadowProducers.__documentCoveredBySettledLine (the #623
// evaluator-side twin) EXACTLY so both sides agree on what "covered" means; the
// two MUST stay in sync (the matcher-side honest verdict here, the evaluator's
// resolve_gap there). Best-effort: a failed read counts as NOT covered.
export const documentAmountCoveredBySettledLine = async ({
  client,
  firmId,
  clientId,
  totalAmount,
  currency
} = {}) => {
  if (!client || !firmId || !clientId) return false;
  const amount = totalAmount == null ? null : Math.abs(Number(totalAmount));
  if (!amount || !Number.isFinite(amount) || amount <= 0) return false;
  const cur = currency || null;
  const hit = await client
    .query(
      `select 1 from transactions t
        where t.firm_id = $1
          and t.client_id = $2
          and t.reconciliation_status in ('reconciled', 'posted', 'auto_reconciled', 'explained')
          and (abs(coalesce(t.money_out, 0)) = $3 or abs(coalesce(t.money_in, 0)) = $3)
          and ($4::text is null or t.currency is null or t.currency = $4)
        limit 1`,
      [firmId, clientId, amount, cur]
    )
    .catch(() => ({ rows: [] }));
  return (hit.rows || []).length > 0;
};

// Slice E (b) — resolve the no-proposal verdict reason HONESTLY. The strong
// matcher records the model's stated reason verbatim; when it proposed nothing
// and that reason is 'no_plausible_match' (or none) BUT a settled bank line
// already covers the document's amount, the truthful reason is 'already_settled'
// — the document corroborates a line the books already closed, which the goal
// evaluator resolves to met/resolve_gap rather than opening firm limbo (CLAUDE.md
// two-terminal-states FIRST principle; loopGoalRegistry §"already_settled").
//
// Gated behind the fail-closed RECONCILIATION_SETTLED_VERDICT canary so prod is
// unchanged until preview-validated: flag OFF → the model's reason survives
// verbatim and the #623 evaluator self-heal remains the prod safety net; flag ON
// for the client → the matcher records 'already_settled' at source. Only ever
// promotes an UNMATCHED no_plausible_match/none to already_settled — never
// rewrites an explicit insufficient_bank_feed / invalid_llm_response (those carry
// real signal) and never touches a run that produced a proposal.
export const resolveSettledVerdictReason = async ({
  client,
  firmId,
  clientId,
  document,
  proposalCount = 0,
  unmatchableReason = null,
  env = process.env,
  // 0A.4 — per-client config snapshot (readClientConfigSnapshot output) for the config
  // control plane. A DB row for this client ⇒ its stage decides (empty=∅, fail-closed);
  // null/absent ⇒ the env canary (envFallback), byte-identical to pre-0A.4. The 5 family
  // orchestrators resolve this once per run and thread it here.
  configSnapshot = null
} = {}) => {
  const reason = unmatchableReason || null;
  if (proposalCount > 0) return reason; // a proposal was made → not an unmatched run
  if (reason && reason !== 'no_plausible_match' && reason !== 'no_match') return reason;
  const settledVerdictActs = clientFlagActs({
    flagKey: SETTLED_VERDICT_FLAG_KEY,
    snapshot: configSnapshot,
    envFallback: () => settledVerdictCanaryAllows(clientId, env),
    env
  });
  if (!settledVerdictActs) return reason;
  const covered = await documentAmountCoveredBySettledLine({
    client,
    firmId,
    clientId,
    totalAmount: document?.total_amount,
    currency: document?.currency
  });
  return covered ? 'already_settled' : reason;
};

const EVALUATION_VERDICTS = new Set([
  // Execution failed after reasoning; the existing convergence clock retries.
  'failed',
  'proposed',
  'no_match',
  'no_candidates',
  // Phase 7.2a — the bank-line disposition producer stamps this on a
  // bare bank line the strong model judged immaterial recurring noise
  // (no document, no human needed). A live match still outranks it.
  'auto_explained'
]);

export const makeEvaluationId = ({ clientId, targetType, targetId, matcherFamily }) => {
  const raw = `${clientId}|${targetType}|${targetId}|${matcherFamily}`;
  return (
    `recon-eval-${slugify(clientId)}-${slugify(targetId)}-${slugify(matcherFamily)}`.slice(0, 110) +
    `-${shortHash(raw)}`
  );
};

// Best-effort, same as runCascade above: a verdict-stamp failure must
// not fail the matcher run (matches outrank observability), so this
// logs and returns false instead of throwing.
export const recordReconciliationEvaluation = async ({
  client,
  firmId,
  clientId,
  targetType = 'document',
  targetId,
  matcherFamily,
  verdict,
  unmatchableReason = null,
  proposalCount = 0,
  candidateCount = 0,
  eligibleCount = 0,
  model = null,
  // Optional structured detail written to the (pre-existing) jsonb
  // column. Phase 7.2a stores its disposition / materiality / reasoning
  // here so the verdict is self-describing for a renderer. Omitted by
  // the document matchers, which leave it '{}' — APPEND-only param so
  // their call sites and the contract param order are unchanged.
  payload = null,
  logTag = 'reconciliationLlmCore',
  // Phase 0B no-match coverage (the #650 follow-up) — OPT-IN, family matchers only. When
  // true and the verdict is a non-'proposed' terminal (the model evaluated candidates and
  // matched nothing), record the no-match DECISION into llm_decisions, gated to a GENUINE
  // new/changed verdict so the last-wins re-stamp every sweep never accrues a row per
  // sweep (the row-explosion #650 avoids). Other callers (bankLineDisposition) leave it
  // false ⇒ byte-identical, no decision written. ADDITIVE + SOFT-FAIL.
  recordDecision = false,
  configSnapshotId = null
} = {}) => {
  if (!client || !firmId || !clientId || !targetId || !matcherFamily) return false;
  if (!EVALUATION_VERDICTS.has(verdict)) return false;
  const id = makeEvaluationId({ clientId, targetType, targetId, matcherFamily });
  try {
    // The CTE captures the PRIOR verdict (if any) before the upsert overwrites it, and the
    // `(xmax = 0)` RETURNING flag distinguishes a fresh insert from an idempotent update —
    // the same prior-vs-now trick upsertMatchAndCascade uses to record only genuine
    // decisions. Params + columns are unchanged; only the prior-capture + RETURNING are new.
    const upsertResult = await queryReconciliationVerdict(client,
      `with prior as (
         select verdict as prior_verdict
           from reconciliation_evaluations
          where firm_id = $2 and client_id = $3 and target_type = $4
            and target_id = $5 and matcher_family = $6
       )
       insert into reconciliation_evaluations (
         id, firm_id, client_id, target_type, target_id, matcher_family,
         matcher_mode, verdict, unmatchable_reason,
         proposal_count, candidate_count, eligible_count, model, payload
       ) values (
         $1, $2, $3, $4, $5, $6,
         'llm', $7, $8,
         $9, $10, $11, $12, $13::jsonb
       )
       on conflict (firm_id, client_id, target_type, target_id, matcher_family) do update
         set verdict = excluded.verdict,
             unmatchable_reason = excluded.unmatchable_reason,
             proposal_count = excluded.proposal_count,
             candidate_count = excluded.candidate_count,
             eligible_count = excluded.eligible_count,
             matcher_mode = excluded.matcher_mode,
             model = excluded.model,
             payload = excluded.payload,
             evaluated_at = now()
       returning (xmax = 0) as inserted,
                 (select prior_verdict from prior) as prior_verdict`,
      [
        id,
        firmId,
        clientId,
        targetType,
        targetId,
        matcherFamily,
        verdict,
        unmatchableReason || null,
        proposalCount,
        candidateCount,
        eligibleCount,
        model,
        JSON.stringify(payload && typeof payload === 'object' ? payload : {})
      ]
    );

    // No-match decision-ledger coverage — only for an opt-in family matcher, only on a
    // non-'proposed' terminal ('proposed' is covered per-proposal by #650's
    // upsertMatchAndCascade write), and only when the verdict is genuinely NEW or CHANGED.
    // SOFT-FAIL: a ledger error never fails the verdict stamp (matches outrank observability).
    if (recordDecision && verdict !== 'proposed') {
      const row = upsertResult.rows?.[0] || {};
      const inserted = row.inserted === true;
      const priorVerdict = row.prior_verdict ?? null;
      if (inserted || priorVerdict !== verdict) {
        try {
          await recordLlmDecision({
            client,
            firmId,
            clientId,
            decisionType: 'match',
            targetType,
            targetId,
            modelName: model || null,
            deterministicSignals: {
              matcher_family: matcherFamily,
              proposal_count: proposalCount,
              candidate_count: candidateCount,
              eligible_count: eligibleCount,
              unmatchable_reason: unmatchableReason || null
            },
            llmReasoning: unmatchableReason || null,
            finalState: verdict,
            configSnapshotId
          });
        } catch (decErr) {
          console.error(`[${logTag}] no-match decision logging failed`, {
            target_id: targetId,
            matcher_family: matcherFamily,
            error: decErr?.message || String(decErr)
          });
        }
      }
    }
    return true;
  } catch (error) {
    if (isProviderFailure(error)) throw error;
    console.error(`[${logTag}] evaluation stamp failed`, {
      target_id: targetId,
      matcher_family: matcherFamily,
      verdict,
      error: error?.message || String(error)
    });
    return false;
  }
};
