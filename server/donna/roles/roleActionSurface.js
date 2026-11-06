// Donna — the role action-surface inventory (S1 of
// docs/design-donna-specialist-roles.md §5: the COVERAGE AUDIT's
// machine-readable half; prose + reasoning in
// docs/donna-specialist-role-coverage-audit.md).
//
// THE QUESTION THIS ANSWERS (INV-S2(b)): does the canonical action namespace
// cover the invoicing_collections role's WHOLE autonomous surface — every
// consequential operation any initiation path (chat-compiled, scheduled,
// event-driven, background sweep) can perform in that role's lane — and is
// each one checked by the ONE shared role/authority decision
// (roles/roleAuthority.js decideRoleAction)? Enforcement may not graduate
// past 'shadow' until the answer is yes — machine-checked by
// roleActionSurface.test.js against clientConfig.SHADOW_CEILING_FLAGS.
//
// This module is the accountingMutationRegistry pattern one seam over: a
// DECLARATIVE inventory verified by tests, so the audit can't silently drift
// out of date. Two exports are load-bearing beyond documentation:
//   - SURFACE_OPERATION_TYPES joins the canonical action namespace (the
//     roleRegistry union's third member) — the identities the two S0 seams
//     (mutation-registry verbs, outbound action types) did NOT carry;
//   - SURFACE_OPERATION_CAPABILITY is consumed by operatorCapability.js so
//     the capability ladder learns the whole surface and ONE function keeps
//     owning "which class may invoke this" (reuse, never a second
//     permissions system — specialist-roles doc §9).
//
// Pure leaf: imports only the outbound gate's enums (itself clientConfig-only)
// so it loads in-sandbox under `node --test` like the other contract leaves.

import { OUTBOUND_ACTION_TYPES, OUTBOUND_ACTION_FLAG_KEYS } from '../outbound/actionGate.js';

const deepFreeze = (node) => {
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) deepFreeze(value);
    Object.freeze(node);
  }
  return node;
};

// ── Controlled vocabularies (the test validates every entry against these) ──

// Where an operation initiates/executes. 'covered_by' entries are initiation
// paths whose consequential terminal executes under another entry's identity.
export const SURFACE_SEAMS = Object.freeze([
  'chat_apply',        // compiled chat/drawer verbs through chatApplySpine
  'operator_route',    // direct api.js operator routes (reverse, ledger push)
  'outbound_executor', // actionExecutor.js — the one send path
  'outbound_sweep',    // outboundActionsDue's non-send sweep operations
  'event_webhook',     // signature/token-verified external event ingestion
  'owner_surface',     // the OWNER principal acting (approve/cancel/correct)
  'report'             // owner digest / metrics — read-and-render lanes
]);

// Consequence classes — why an operation is (or is not) leash-relevant.
export const CONSEQUENCE_CLASSES = Object.freeze([
  'external_send',       // email/PDF leaves for a third party or the owner
  'external_object',     // creates an object on an external provider (Stripe)
  'ledger_post',         // writes ledger journals (through the one gateway)
  'authority_demotion',  // narrows automation (conservative direction)
  'authority_promotion', // widens automation (a config-plane stage write)
  'db_enrichment',       // DB-only evidence enrichment feeding later verdicts
  'workflow_state',      // case/queue state with a tracked continuation
  'principal_authority', // the owner's own approval/correction acts
  'none'                 // read-only aggregation / rendering
]);

// ── The namespace closure (audit finding: five identities missing at S0) ────
// The S0 canonical namespace was registryVerbs() ∪ OUTBOUND_ACTION_TYPES.
// The audit found five consequential operations OUTSIDE both enums; these
// identities close the gap and join the namespace via roleRegistry's union.
// reverse_apply is operatorCapability's own REVERSE_ACTION_TYPE (pinned equal
// by test) — already capability-gated, but absent from the S0 namespace.
export const SURFACE_OPERATION_TYPES = Object.freeze([
  'reverse_apply',
  'create_pay_link',
  'record_reply_correction',
  'capture_structured_reference',
  'graduate_earned_auto'
]);

// ── Capability requirements for the surface identities ──────────────────────
// Consumed by operatorCapability.requiredCapabilityForAction — the ONE
// function that answers "which class may invoke this" for every seam. The
// four outbound send types are included so the chat seam's fail-closed
// founder default stops mislabeling them (the S0 registry validation skipped
// them for exactly this reason — that skip closes with S1).
//   reviewer — the R1 occupant's own class must clear its own verbs; every
//     reviewer entry here is either gate-staged (owner approval / stage /
//     grant authority is the real send gate) or conservative-direction.
//   founder — authority promotion and the reverse executor stay founder-only.
export const SURFACE_OPERATION_CAPABILITY = deepFreeze({
  issue_invoice: 'reviewer',
  send_quote: 'reviewer',
  send_receivable_reminder: 'reviewer',
  send_payable_notice: 'reviewer',
  create_pay_link: 'reviewer',
  record_reply_correction: 'reviewer',
  capture_structured_reference: 'reviewer',
  graduate_earned_auto: 'founder',
  reverse_apply: 'founder'
});

// ── The R1 (invoicing_collections) autonomous-surface inventory ─────────────
// One row per operation the lane can perform without a human driving it, plus
// the initiation-only and principal-authority rows so nothing is silently out
// of scope. Fields:
//   operation      — what happens (module-level name)
//   seam           — SURFACE_SEAMS member
//   identity       — canonical action identity, or null with covered_by
//   covered_by     — for initiation-only rows: the identity whose leash-checked
//                    execution is this row's consequential terminal
//   role           — attributed role id, or null = Donna core (the shared
//                    orchestrator's own delegated surface; role leash does not
//                    bind, the existing stage/approval/grant gates do)
//   flag_key       — the config-plane stage governing the lane (null = always-on
//                    deterministic Keep layer or principal surface)
//   consequences   — CONSEQUENCE_CLASSES members
//   decision_site  — where the ONE role/authority decision runs for this row
//   wired          — is that decision actually called there today (honest
//                    tri-state is not needed; a false here is an INV-S2(b)
//                    coverage gap and holds the shadow ceiling down)
export const R1_AUTONOMOUS_SURFACE = deepFreeze([
  // ── Seam B: the outbound executor (the one send path) ──
  {
    operation: 'execute issue_invoice',
    seam: 'outbound_executor',
    identity: 'issue_invoice',
    role: 'invoicing_collections',
    flag_key: OUTBOUND_ACTION_FLAG_KEYS.issue_invoice,
    consequences: ['external_send', 'ledger_post', 'workflow_state'],
    // The AR ledger leg (issuance.postIssuanceArLeg → the one ledger gateway),
    // the anchor lifecycle flip, the PDF artifact, and the follow-up/recurrence
    // mints are COMPONENT consequences of this identity: they never run
    // independently and their authorization IS the send's authorization.
    decision_site: 'outbound/actionExecutor.js (claim transaction)',
    wired: true
  },
  {
    operation: 'execute send_quote',
    seam: 'outbound_executor',
    identity: 'send_quote',
    role: 'invoicing_collections',
    flag_key: OUTBOUND_ACTION_FLAG_KEYS.send_quote,
    consequences: ['external_send', 'workflow_state'],
    decision_site: 'outbound/actionExecutor.js (claim transaction)',
    wired: true
  },
  {
    operation: 'execute send_receivable_reminder',
    seam: 'outbound_executor',
    identity: 'send_receivable_reminder',
    role: 'invoicing_collections',
    flag_key: OUTBOUND_ACTION_FLAG_KEYS.send_receivable_reminder,
    consequences: ['external_send', 'workflow_state'],
    decision_site: 'outbound/actionExecutor.js (claim transaction)',
    wired: true
  },
  {
    // AP, not AR: no bench role owns payables today, so this executes on
    // Donna core's own delegated surface (owner-directed, M4). A future
    // payables-owning role claims it by adding it to that role's action_set —
    // a deliberate edit, never a drift (attribution derives from the claim).
    operation: 'execute send_payable_notice',
    seam: 'outbound_executor',
    identity: 'send_payable_notice',
    role: null,
    flag_key: OUTBOUND_ACTION_FLAG_KEYS.send_payable_notice,
    consequences: ['external_send'],
    decision_site: 'outbound/actionExecutor.js (claim transaction)',
    wired: true
  },

  // ── Seam C: the due-sweep's non-send operations (each its own flag) ──
  {
    operation: 'ensure Stripe pay-links for open receivables',
    seam: 'outbound_sweep',
    identity: 'create_pay_link',
    role: 'invoicing_collections',
    flag_key: 'OUTBOUND_PAY_LINKS',
    consequences: ['external_object'],
    decision_site: 'outbound/payLinks.js ensureOutboundPayLinks (entry)',
    wired: true
  },
  {
    operation: 'classify owner replies; mark auto-sends wrong (D1 correction)',
    seam: 'outbound_sweep',
    identity: 'record_reply_correction',
    role: 'invoicing_collections',
    flag_key: 'OUTBOUND_REPLY_INGESTION',
    consequences: ['authority_demotion', 'workflow_state'],
    decision_site: 'outbound/replyIngestion.js processOwnerReplies (entry)',
    wired: true
  },
  {
    operation: 'capture structured references (bank lines + parsed invoices)',
    seam: 'outbound_sweep',
    identity: 'capture_structured_reference',
    role: 'invoicing_collections',
    flag_key: 'OUTBOUND_REFERENCE_CAPTURE',
    consequences: ['db_enrichment'],
    decision_site: 'outbound/referenceCapture.js (both capture entries)',
    wired: true
  },
  {
    // The authority plane adjusting itself: an earned ladder graduates a
    // client's flag to 'auto' THROUGH the audited config-plane writer, under
    // the AUTO_FORBIDDEN veto. Attributed to Donna core BY LAW, never to a
    // role — a role must not hold the verb that widens its own authority
    // (INV-S10's corollary; validateRoleRegistry refuses the claim).
    operation: 'graduate earned-auto ladders',
    seam: 'outbound_sweep',
    identity: 'graduate_earned_auto',
    role: null,
    flag_key: null, // governed by AUTO_FORBIDDEN_FLAGS + the ladder's own state
    consequences: ['authority_promotion'],
    decision_site: 'outbound/earnedAutoLadder.js sweepEarnedAutoGraduations (entry)',
    wired: true
  },

  // ── Initiation-only rows: mints whose consequential terminal is the
  //    executor's leash-checked send. mintOutboundAction is the one funnel;
  //    nothing a mint schedules executes except through the executor. ──
  {
    operation: 'detect overdue receivables (open cases, mint step-1 reminders)',
    seam: 'outbound_sweep',
    identity: null,
    covered_by: 'send_receivable_reminder',
    role: 'invoicing_collections',
    flag_key: OUTBOUND_ACTION_FLAG_KEYS.send_receivable_reminder,
    consequences: ['workflow_state'],
    decision_site: 'execution (outbound/actionExecutor.js)',
    wired: true
  },
  {
    operation: 'detect upcoming payables (mint owner notices)',
    seam: 'outbound_sweep',
    identity: null,
    covered_by: 'send_payable_notice',
    role: null,
    flag_key: OUTBOUND_ACTION_FLAG_KEYS.send_payable_notice,
    consequences: ['workflow_state'],
    decision_site: 'execution (outbound/actionExecutor.js)',
    wired: true
  },
  {
    operation: 'advance dunning cadence / issuance follow-ups / recurrence',
    seam: 'outbound_executor',
    identity: null,
    covered_by: 'send_receivable_reminder',
    role: 'invoicing_collections',
    flag_key: null,
    consequences: ['workflow_state'],
    decision_site: 'execution (outbound/actionExecutor.js)',
    wired: true
  },
  {
    operation: 'owner invoice command (WhatsApp/Telegram → draft + held action)',
    seam: 'chat_apply',
    identity: null,
    covered_by: 'issue_invoice',
    role: 'invoicing_collections',
    flag_key: null,
    consequences: ['workflow_state'],
    decision_site: 'execution (outbound/actionExecutor.js)',
    wired: true
  },

  // ── Operator route: the reverse executor (S0 namespace gap, closed) ──
  {
    operation: 'reverse a prior apply (the reverse executor)',
    seam: 'operator_route',
    identity: 'reverse_apply',
    role: null,
    flag_key: 'OPERATOR_CAPABILITY_ENFORCE',
    consequences: ['ledger_post'],
    decision_site: 'firmDb.assertActionCapability (the converged chat-seam gate)',
    wired: true
  },

  // ── Event webhooks: deterministic world-state ingestion (Keep layer).
  //    Not role actions — the world updating Donna, verified at the boundary
  //    (signature/token), acting only through named deterministic writers. ──
  {
    operation: 'pay-link settlement webhook (settle case, cancel reminders)',
    seam: 'event_webhook',
    identity: null,
    covered_by: null,
    role: null,
    flag_key: 'OUTBOUND_PAY_LINKS',
    consequences: ['workflow_state'],
    decision_site: 'n/a — deterministic settlement-truth sync, no discretion',
    wired: true
  },
  {
    operation: 'reply inbound webhook (store reply rows)',
    seam: 'event_webhook',
    identity: null,
    covered_by: 'record_reply_correction',
    role: 'invoicing_collections',
    flag_key: 'OUTBOUND_REPLY_INGESTION',
    consequences: ['workflow_state'],
    decision_site: 'processing (outbound/replyIngestion.js)',
    wired: true
  },
  {
    operation: 'unsubscribe route (counterparty suppression)',
    seam: 'event_webhook',
    identity: null,
    covered_by: null,
    role: null,
    flag_key: null,
    consequences: ['workflow_state'],
    decision_site: 'n/a — the counterparty\'s own statutory opt-out, no discretion',
    wired: true
  },

  // ── The owner's authority surface: the principal acting, never the role.
  //    These are the authority BASIS (per_send_owner_approval, corrections),
  //    gated by channel binding / signed tokens / assertFirmAccess. ──
  {
    operation: 'owner approve/cancel/edit held drafts; mark auto-sent wrong; reverse AR post',
    seam: 'owner_surface',
    identity: null,
    covered_by: null,
    role: null,
    flag_key: null,
    consequences: ['principal_authority'],
    decision_site: 'n/a — principal authority, not occupant action (INV-S10)',
    wired: true
  },

  // ── Report lanes ──
  {
    operation: 'daily owner digest (approvals, must-review, needs-info)',
    seam: 'report',
    identity: null,
    covered_by: null,
    role: null,
    flag_key: null,
    consequences: ['none'],
    decision_site: 'n/a — renders persisted state to the principal',
    wired: true
  },
  {
    operation: 'daily outbound metrics rollup',
    seam: 'report',
    identity: null,
    covered_by: null,
    role: null,
    flag_key: null,
    consequences: ['none'],
    decision_site: 'n/a — read-only aggregation',
    wired: true
  }
]);

// ── Coverage helpers ────────────────────────────────────────────────────────

// A consequential entry needs either its own canonical identity or a
// covered_by terminal; principal/report/deterministic rows opt out by
// carrying consequences that are not occupant-discretionary.
const OCCUPANT_DISCRETIONARY = new Set([
  'external_send', 'external_object', 'ledger_post',
  'authority_demotion', 'authority_promotion', 'db_enrichment'
]);

// The INV-S2(b) gap list. Non-empty ⇒ the namespace does NOT cover the
// surface ⇒ SPECIALIST_ROLE_ENFORCE must stay at or below 'shadow'
// (machine-checked against clientConfig.SHADOW_CEILING_FLAGS by
// roleActionSurface.test.js). Shrinks by wiring decisions and assigning
// identities — never by softening this predicate.
export const roleSurfaceCoverageGaps = () =>
  R1_AUTONOMOUS_SURFACE.filter((entry) => {
    const discretionary = (entry.consequences || []).some((c) => OCCUPANT_DISCRETIONARY.has(c));
    if (!discretionary) return false;
    if (!entry.identity && !entry.covered_by) return true;
    return entry.wired !== true;
  }).map((entry) => ({ operation: entry.operation, seam: entry.seam }));
