// Outbound action gate (M0.4, G3 — execution plan A2). ONE pure classifier:
// action × entity × confidence × safety checks × config-plane stage →
//   auto_execute | hold_for_approval | blocked.
//
// D1 note (RESOLVED, Kari 2026-07-24 — §4 of the execution plan): NO internal
// review lane — 'hold_for_internal_review' stays reserved-unused forever
// unless a dated doctrine amendment says otherwise; NOTHING emits it. The
// recorded posture is owner-approve + EARNED auto (earnedAutoLadder.js):
// graduation through the audited config-plane writer after N clean
// owner-approved sends, still gated per terminal by AUTO_FORBIDDEN_FLAGS.
// The deterministic-verdict confidence clause lives in the classifier below.
//
// D6 note (confirmed at build time): NO fourth per-domain grant-table copy was
// minted. The gate consumes config-plane STAGES (042) only; when per-
// counterparty auto graduation needs scoped grants (M1/M2, the D4 pay-link
// signal), generalize the 040 grant engine into action_authority_grants —
// do not copy it here.
//
// Stage semantics (A2 — STRICTER than the generic stageActs ladder, on
// purpose: every third-party send holds for OWNER approval until the earned
// terminal):
//   off/dry_run/missing → mode 'off' — pipeline dark for this action type
//                    (dry_run does not observe, per stageObserves)
//   shadow         → mode 'shadow' — verdicts receipted, nothing sends
//   canary         → mode 'act', verdict ≤ hold_for_approval (approval REQUIRED)
//   auto           → mode 'act', auto_execute reachable (the earned state; the
//                    four flag keys sit in AUTO_FORBIDDEN_FLAGS until Kari
//                    approves each action type's terminal)
//
// Keep-layer posture: deterministic, pure, fail-closed. No LLM. Every refusal
// carries a named reason so the receipt explains itself.

import {
  clientFlagActs, clientFlagObserves
} from '../clientConfig.js';

// Per-action-type flag keys on the config control plane (CLAUDE.md rollout
// rail: born as client_capability_config flags, envFallback () => false —
// NEVER an env pair). All four born 'off'.
export const OUTBOUND_ACTION_FLAG_KEYS = Object.freeze({
  issue_invoice: 'OUTBOUND_INVOICING',
  send_quote: 'OUTBOUND_QUOTES',
  send_receivable_reminder: 'OUTBOUND_DUNNING',
  send_payable_notice: 'OUTBOUND_PAYABLES'
});

export const OUTBOUND_ACTION_TYPES = Object.freeze(Object.keys(OUTBOUND_ACTION_FLAG_KEYS));

// OWNER-DIRECTED action types (M4): the send's RECIPIENT is the owner
// themselves — never a third party (the executor resolves the recipient from
// the client profile, not from party channels, so a third-party send is
// structurally impossible for these). Because the person being mailed IS the
// approver, an acting stage (canary/auto) delivers directly: holding an
// owner-directed notice for the owner's own approval would be a click queue
// about receiving mail — the exact absurdity decide-and-notify forbids. This
// does NOT touch the AUTO_FORBIDDEN posture: the flag's 'auto' terminal
// (unattended THIRD-PARTY sends, the thing Kari's per-terminal approvals
// govern) stays vetoed and irrelevant here; 'off'/'dry_run' keep the lane
// dark and 'shadow' keeps it receipt-only. Hard blocks still bind.
export const OWNER_DIRECTED_ACTION_TYPES = Object.freeze(['send_payable_notice']);

// Pinned by migrations.test.js against the 091 CHECK. hold_for_internal_review
// is reserved-unused pending D1 — keep it LAST and keep nothing emitting it.
export const OUTBOUND_GATE_VERDICTS = Object.freeze([
  'auto_execute', 'hold_for_approval', 'blocked', 'hold_for_internal_review'
]);

export const OUTBOUND_ACTION_STATUSES = Object.freeze([
  'scheduled', 'hold_for_approval', 'approved', 'executing',
  'executed', 'cancelled', 'failed'
]);

export const OUTBOUND_RECEIPT_OUTCOMES = Object.freeze([
  'sent', 'cancelled', 'refused', 'failed'
]);

// Paid-truth verdict vocabulary the send-time guard (G4, M1) will speak. The
// gate consumes it fail-closed TODAY: only an explicit 'unpaid' lets a
// receivable reminder through; 'ambiguous'/missing holds, 'settled' blocks
// (the A3 rule: ambiguity holds, never sends; a settled anchor auto-cancels).
export const PAID_TRUTH_VERDICTS = Object.freeze(['unpaid', 'ambiguous', 'settled']);

// Confidence floor for the auto lane (the preflight 0.75 / matcher 0.85
// convention — auto is the high bar). Below it, an 'auto' stage still holds.
export const OUTBOUND_AUTO_CONFIDENCE_FLOOR = 0.85;

export const outboundFlagKeyForAction = (actionType) =>
  OUTBOUND_ACTION_FLAG_KEYS[actionType] || null;

// Resolve the gate MODE for an action type from the per-client config
// snapshot. envFallback is () => false everywhere — the flags have no legacy
// env predicate and never will (born on the plane).
export const outboundGateMode = ({ actionType, snapshot = null, env = process.env } = {}) => {
  const flagKey = outboundFlagKeyForAction(actionType);
  if (!flagKey) return { mode: 'off', flagKey: null, stage: null };
  const stage = snapshot && typeof snapshot === 'object' && snapshot[flagKey]
    ? snapshot[flagKey].stage
    : null;
  const acts = clientFlagActs({ flagKey, snapshot, envFallback: () => false, env });
  const observes = clientFlagObserves({ flagKey, snapshot, envFallback: () => false, env });
  if (acts) return { mode: 'act', flagKey, stage };
  if (observes) return { mode: 'shadow', flagKey, stage };
  return { mode: 'off', flagKey, stage };
};

// THE classifier. Pure — every input is passed in; the store/executor gather
// them. Returns { verdict, mode, flagKey, stage, reasons } where reasons is
// the machine-parseable refusal/hold trail for the receipt's checks array.
export const classifyOutboundAction = ({
  actionType,
  snapshot = null,
  env = process.env,
  suppressed = false,
  doNotContact = false,
  hasRecipient = true,
  paidTruth = null,
  confidence = null
} = {}) => {
  const reasons = [];
  const { mode, flagKey, stage } = outboundGateMode({ actionType, snapshot, env });

  if (!OUTBOUND_ACTION_TYPES.includes(actionType)) {
    return {
      verdict: 'blocked', mode: 'off', flagKey: null, stage: null,
      reasons: ['unknown_action_type']
    };
  }

  // Hard blocks — no stage or approval overrides these (the Keep layer).
  if (suppressed) reasons.push('recipient_suppressed');
  if (doNotContact) reasons.push('party_do_not_contact');
  if (!hasRecipient) reasons.push('no_recipient_channel');
  if (actionType === 'send_receivable_reminder' && paidTruth === 'settled') {
    reasons.push('already_settled');
  }
  if (reasons.length > 0) {
    return { verdict: 'blocked', mode, flagKey, stage, reasons };
  }

  if (mode === 'off') {
    return { verdict: 'blocked', mode, flagKey, stage, reasons: ['flag_off'] };
  }

  // Holds — the row rests on the owner (terminal 2), never sends unattended.
  if (actionType === 'send_receivable_reminder' && paidTruth !== 'unpaid') {
    // Missing or ambiguous paid-truth: ambiguity holds, never sends (A3).
    return {
      verdict: 'hold_for_approval', mode, flagKey, stage,
      reasons: [paidTruth === 'ambiguous' ? 'paid_truth_ambiguous' : 'paid_truth_missing']
    };
  }
  // Owner-directed types (M4): at an acting stage the notice goes to the
  // OWNER directly — the recipient IS the approver, so there is no hold lane
  // and no confidence floor to clear. Hard blocks above still bind.
  if (OWNER_DIRECTED_ACTION_TYPES.includes(actionType)) {
    return { verdict: 'auto_execute', mode, flagKey, stage, reasons: [] };
  }
  if (stage !== 'auto') {
    return {
      verdict: 'hold_for_approval', mode, flagKey, stage,
      reasons: ['stage_below_auto']
    };
  }
  // D1's confidence clause (§4, RESOLVED 2026-07-24): a DETERMINISTIC
  // paid-truth verdict satisfies the auto confidence floor. For a reminder,
  // reaching this line means the guard said an explicit 'unpaid' (the
  // paid-truth branch above holds everything else) — and that verdict is
  // deterministic whichever lane produced it (the pay-link settlement signal
  // outranks, then the composed lanes; the guard never guesses). The
  // detector's null-confidence mints must therefore not hold a graduated
  // client. Other action types keep the numeric floor.
  const deterministicVerdict = actionType === 'send_receivable_reminder' && paidTruth === 'unpaid';
  if (!deterministicVerdict && !(Number(confidence) >= OUTBOUND_AUTO_CONFIDENCE_FLOOR)) {
    return {
      verdict: 'hold_for_approval', mode, flagKey, stage,
      reasons: ['confidence_below_auto_floor']
    };
  }
  return { verdict: 'auto_execute', mode, flagKey, stage, reasons: [] };
};
