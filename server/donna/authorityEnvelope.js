// Donna — the authority-envelope classifier (Accounting Runtime Hardening, Slice G).
//
// Slice E's consequence diff already answers "can this commit, or must it stay
// proposed?" (accountingDiff.buildCommit): a `requires_review` line is appliable but
// `can_auto_commit=false` — it stays proposed pending THIS classifier. Slice G is the
// authority layer that turns that bare verdict into a two-terminal-states decision:
// a MATERIAL match held at `requires_review` either auto-reconciles via DELEGATED
// AUTHORITY + an authority receipt (terminal 1), or escalates to the owner (terminal 2).
// There is no third "awaiting a firm click" state — that is the FIRST principle
// (CLAUDE.md), and the #5 delegated-authority design is what lets a material line reach
// "auto-reconciled" honestly instead of resting on a per-line firm click.
//
// IT MINTS NO NEW STORE (the no-third-spine GUARD, CLAUDE.md). The grant rows live in
// `reconciliation_authority_grants` (migration 040) and the config stage in
// `client_capability_config` (042); the fail-closed lookup + per-row guards already
// live in `reconciliationAuthorityGrants.js` (findActiveAuthorityGrant /
// grantRowAllowsAutoAccept — they bypass Gate E and nothing else). This module NEVER
// re-decides WHICH line settles what and NEVER re-implements those guards: it CLASSIFIES
// the already-fetched authority state into the runtime's Operator-Contract vocabulary,
// and exposes the per-scope materiality threshold the case snapshot needs.
//
// Pure leaf: imports ONLY clientConfig.js (node:crypto-only — no DB, no LLM, no heavy
// chain) so it runs in-sandbox under `node --test`, the same discipline as accountingDiff.js
// and preflight.js. EVERY input is PRE-COMPUTED and passed in:
//   - commit                  — the Slice-E buildCommit verdict (the gate to resolve)
//   - coveringGrant           — the row findActiveAuthorityGrant returned (or null). Its
//                               presence MEANS the store's guards (status/ceiling/currency/
//                               dates/correction/first-use/config-canary/A–D proof) ALL
//                               passed — this module trusts that, it does not re-check it.
//   - configStage             — the AUTHORITY_ENVELOPE_CLASSIFIER flag's resolved stage
//                               (off|dry_run|shadow|canary|auto). Gates whether the
//                               auto_reconcile verdict may ACT; fail-closed when off/absent.
//   - firstUseAccountInvolved — never auto-reconcile a first-use account (mirrors the
//                               store's guard 5.6); escalate to the owner instead.
//
// DESIGN-FIRST: this is the classification substrate only. WIRING it so a material match
// actually auto-commits unattended is the first step that needs Kari's greenlight (it is
// the first slice that could let something AUTO-COMMIT) — the classifier reports
// `can_act`, the gated caller decides to act on it.

import { stageActs } from './clientConfig.js';

// The capability flag (plan §7) that stages this classifier off → … → auto. Pinned here
// so the wiring caller and the config plane agree on the key.
export const AUTHORITY_ENVELOPE_FLAG_KEY = 'AUTHORITY_ENVELOPE_CLASSIFIER';

// The two-terminal-states vocabulary, plus the must-fix surface. A row may come to rest
// ONLY at auto_reconcile (terminal 1) or escalate_to_owner (terminal 2); `blocked` is a
// VIOLATION to SURFACE (a blocking check failed), never a resting state.
export const AUTHORITY_ENVELOPES = Object.freeze(['auto_reconcile', 'escalate_to_owner', 'blocked']);

// Project an envelope onto the operator-contract CHECK status vocabulary (CHECK_STATUSES),
// so the classifier's two-terminal verdict can ride on a shadow receipt's check report as a
// first-class, persisted observation — no schema change (a check is a named {name,status,detail}).
// auto_reconcile is the settled terminal (pass); escalate_to_owner is the owner-held terminal
// (requires_review — surfaced, never silently terminal); blocked is the must-fix surface (fail).
// Because the envelope is DERIVED from the same Slice-E commit verdict the check report already
// produced, the mapped status never EXCEEDS the report's existing worst status — appending it is
// always consistent, never an escalation the checks didn't already justify.
export const AUTHORITY_ENVELOPE_CHECK_STATUS = Object.freeze({
  auto_reconcile: 'pass',
  escalate_to_owner: 'requires_review',
  blocked: 'fail'
});

// Echo only the non-sensitive, reconstructable grant fields onto the verdict (CLAUDE.md
// "the model id is the receipt": the authority decision must be reconstructable from the
// receipt alone). Never the provenance blob or the authorizing actor id.
const echoGrant = (grant) => {
  if (!grant || typeof grant !== 'object') return null;
  const ceiling = Number(grant.amount_ceiling);
  return {
    id: grant.id ?? null,
    scope_kind: grant.scope_kind ?? null,
    scope_key: grant.scope_key ?? null,
    archetype: grant.archetype ?? null,
    amount_ceiling: Number.isFinite(ceiling) ? ceiling : null,
    currency: grant.currency ?? null
  };
};

// The per-scope materiality threshold for the case snapshot's riskContext (the handoff's
// "materiality = per-scope authority ceiling"). Given the grants fetched for a scope, the
// threshold is the MOST CONSERVATIVE active grant's ceiling — the smallest auto-acceptable
// amount, so MORE lines count material (→ escalate), which fails toward the owner. Only an
// ACTIVE, un-corrected grant with a positive ceiling counts; otherwise null (→ the snapshot
// keeps `materiality_band: unknown`, the honest state when no authority threshold exists).
export const materialityThresholdFromGrants = (grants) => {
  const rows = Array.isArray(grants) ? grants : (grants ? [grants] : []);
  let threshold = null;
  for (const grant of rows) {
    if (!grant || grant.status !== 'active') continue;
    if (Number(grant.correction_count) > 0) continue;
    const ceiling = Number(grant.amount_ceiling);
    if (!Number.isFinite(ceiling) || ceiling <= 0) continue;
    if (threshold == null || ceiling < threshold) threshold = ceiling;
  }
  return threshold;
};

// Classify the authority disposition of an apply, given the Slice-E commit verdict and the
// already-fetched authority state. Fail-closed everywhere: any doubt routes to the owner
// (terminal 2), never to an unattended commit.
//
// Returns:
//   envelope            — 'auto_reconcile' | 'escalate_to_owner' | 'blocked'
//   terminal_target     — 'auto_reconciled' | 'owner_clarification' | null (null = blocked)
//   authority_source    — 'delegated_grant' | null (null = the diff itself permitted commit)
//   grant               — the echoed covering grant (or null)
//   materiality_threshold — the covering grant's ceiling (or null)
//   config_stage        — the resolved AUTHORITY_ENVELOPE_CLASSIFIER stage
//   stage_acts          — does that stage take its live action? (canary/auto)
//   can_act             — may the caller auto-reconcile on this verdict NOW?
//                         (auto_reconcile AND — when a grant is the authority — stage_acts)
//   reason              — machine-readable cause
export const classifyAuthorityEnvelope = ({
  commit = null,
  coveringGrant = null,
  configStage = 'off',
  firstUseAccountInvolved = false
} = {}) => {
  const stage = typeof configStage === 'string' ? configStage : 'off';
  const acts = stageActs(stage);
  const base = {
    grant: null,
    materiality_threshold: null,
    config_stage: stage,
    stage_acts: acts
  };
  const escalate = (reason) => ({
    envelope: 'escalate_to_owner',
    terminal_target: 'owner_clarification',
    authority_source: null,
    ...base,
    can_act: false,
    reason
  });

  // No verdict to classify → fail toward the owner, never auto.
  if (!commit || typeof commit !== 'object') return escalate('no_commit_verdict');

  // A blocking check failed (MUST-FIX). Not a resting state — surface it. Never auto.
  if (commit.status === 'fail' || commit.reason === 'blocking_check_failed') {
    return {
      envelope: 'blocked',
      terminal_target: null,
      authority_source: null,
      ...base,
      can_act: false,
      reason: 'blocking_check_failed'
    };
  }

  // The diff itself already permits an unattended commit (pass / warnings-only): this line
  // is NOT materiality-held, so the authority envelope is not the gate. It auto-reconciles
  // on its own checks — no grant needed, and the classifier's own stage does not hold it.
  if (commit.can_auto_commit === true || commit.disposition === 'commit') {
    return {
      envelope: 'auto_reconcile',
      terminal_target: 'auto_reconciled',
      authority_source: null,
      ...base,
      can_act: true,
      reason: commit.reason || 'commit_verdict_permits'
    };
  }

  // From here the line is held at `stay_proposed`. The authority envelope decides its
  // terminal. The only authority-resolvable hold is the materiality ceiling (Gate E,
  // surfaced as requires_review_authority); any other stay_proposed reason is not ours to
  // auto-clear → owner.
  if (commit.reason !== 'requires_review_authority') {
    return escalate(commit.reason ? `stay_proposed:${commit.reason}` : 'stay_proposed');
  }

  // Never auto-reconcile a first-use / unapproved account (mirrors the store's guard 5.6).
  if (firstUseAccountInvolved) return escalate('first_use_account');

  // A covering grant means findActiveAuthorityGrant already cleared every fail-closed guard
  // (incl. the delegated-authority canary + the A–D proof). The line auto-reconciles via
  // delegated authority — but only ACTS when THIS classifier's own flag is at canary/auto.
  if (coveringGrant) {
    const grant = echoGrant(coveringGrant);
    return {
      envelope: 'auto_reconcile',
      terminal_target: 'auto_reconciled',
      authority_source: 'delegated_grant',
      ...base,
      grant,
      materiality_threshold: grant?.amount_ceiling ?? null,
      can_act: acts,
      reason: acts ? 'delegated_authority_grant' : 'delegated_authority_grant_stage_observe'
    };
  }

  // Material, held, no covering authority → the one thing only the owner can answer.
  return escalate('no_covering_grant');
};

// RENDER (not classify) — map the matcher's PERSISTED authorization receipt into the same
// envelope vocabulary. "Render the persisted verdict, not a second inference" (CLAUDE.md):
// where `classifyAuthorityEnvelope` DECIDES from a commit verdict + grant (the chat-runtime
// path, which has no reconciliation match), this READS the decision the matcher already made
// and persisted on `reconciliation_matches.payload.authorization` — band + reasons written by
// grantAuthority / autoFyiAuthority / authorizeMatch. It NEVER recomputes the gates or the
// grant lookup; it only translates the persisted band/reasons. Pure (no heavy import): it
// reads plain persisted fields, so the leaf stays sandbox-loadable.
//
// authority_source distinguishes HOW terminal-1 was reached, for the receipt:
//   delegated_grant   — a covering grant bypassed Gate E (reasons:['delegated_authority'])
//   material_auto_fyi — the no-grant firm-policy auto-FYI (reasons:['material_auto_fyi'])
//   gates_passed      — a non-material match, all gates passed (reasons:['all_gates_passed'])
//   null              — band/reasons not recognized as an auto-accept
export const renderAuthorityEnvelopeFromAuthorization = (authorization) => {
  const unknown = (reason) => ({
    envelope: 'escalate_to_owner',
    terminal_target: 'owner_clarification',
    authority_source: null,
    rendered: true,
    band: authorization && typeof authorization === 'object' ? (authorization.band ?? null) : null,
    reason
  });
  if (!authorization || typeof authorization !== 'object') return unknown('no_authorization_receipt');
  const band = authorization.band ?? null;
  const reasons = Array.isArray(authorization.reasons) ? authorization.reasons : [];

  if (band === 'auto_matched') {
    const source = reasons.includes('delegated_authority')
      ? 'delegated_grant'
      : reasons.includes('material_auto_fyi')
        ? 'material_auto_fyi'
        : reasons.includes('all_gates_passed')
          ? 'gates_passed'
          : null;
    return {
      envelope: 'auto_reconcile',
      terminal_target: 'auto_reconciled',
      authority_source: source,
      rendered: true,
      band,
      reason: reasons.length ? `auto_matched:${reasons.join('+')}` : 'auto_matched'
    };
  }

  if (band === 'suggested') {
    // A materiality-held suggestion (the SOLE withhold reason is the ceiling) is the
    // two-terminal-states violation surface — it rests on no authority, so it escalates to
    // the owner. Any other 'suggested' reason is a genuine review case → also the owner.
    const materialityHeld = reasons.length > 0 && reasons.every((r) => r === 'above_materiality_ceiling');
    return {
      envelope: 'escalate_to_owner',
      terminal_target: 'owner_clarification',
      authority_source: null,
      rendered: true,
      band,
      reason: materialityHeld ? 'materiality_held_no_authority' : 'suggested_under_review'
    };
  }

  // 'rejected' / null / any other persisted band: not an auto-accept, not our terminal to set.
  return unknown(band ? `band:${band}` : 'no_band');
};

// Project the matcher's PERSISTED authorization into the preflight `matchVerdict` shape
// ({ reconciles, reason }) so preflight.matchVerdictCheck RENDERS the persisted reconciliation
// verdict (never re-checks — the "render the persisted verdict" rail). ONE render path: it
// delegates to renderAuthorityEnvelopeFromAuthorization, so the match check and the authority
// envelope can never disagree. A line the matcher AUTO-RECONCILED (envelope auto_reconcile) →
// reconciles:true (pass); anything else → reconciles:false (requires_review — surfaced toward
// the owner). Returns null when there is NO persisted authorization to render, so the caller
// emits NO check (an unmatched / unauthorized line must not manufacture a verdict). The echoed
// authority_source / band ride along for the receipt; matchVerdictCheck reads only reconciles/reason.
export const matchVerdictFromAuthorization = (authorization) => {
  if (!authorization || typeof authorization !== 'object') return null;
  const envelope = renderAuthorityEnvelopeFromAuthorization(authorization);
  return {
    reconciles: envelope.envelope === 'auto_reconcile',
    reason: envelope.reason || null,
    authority_source: envelope.authority_source ?? null,
    band: envelope.band ?? null
  };
};
