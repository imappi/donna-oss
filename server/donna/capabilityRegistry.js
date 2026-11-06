// Donna — the versioned capability registry (BizOS Slice 1a, D-PA-7).
//
// One control plane, many registered domain packs (design-donna-personal-agent.md §6;
// contract pinned in design-donna-bizos-slice-1-intent-capability.md §2-§4). This module
// GENERALIZES the accountingMutationRegistry embryo — it never rivals it (no-third-spine):
// the first pack, finance.*.v1, is a DERIVATION of ACCOUNTING_MUTATION_REGISTRY rows plus a
// static overlay for pack-new fields, so there is exactly one source of truth for the shared
// fields and the compatibility test (capabilityRegistry.test.js) proves the mapping is
// lossless. Nothing routes through this registry on a live path in Slice 1 — like the
// hardening plan's Slice A, its value now is the verified inventory + the lint that refuses
// a new capability shipping with unsafe gaps.
//
// The immutability boundary (addendum §2): meaning / input_schema / output_schema /
// side-effect SEMANTICS change → a NEW capability id (v2 alongside v1). Executor or verifier
// implementation, risk classification, or rollout policy change → a new registry snapshot /
// policy version / code version; receipts pin those. A metadata correction never forces v2.
//
// Pure leaf: imports only the two registries it generalizes + node:crypto. Loads in-sandbox
// under `node --test` like the other contract leaves.

import { createHash } from 'node:crypto';

import {
  ACCOUNTING_MUTATION_REGISTRY,
  KNOWN_WRITERS,
  AUTONOMY_CLASSES,
  PRESENCE_STATES,
  RECEIPT_STATES,
  REVERSIBILITY_CLASSES
} from './accountingMutationRegistry.js';
import { requiredCapabilityForAction, CAPABILITY_CLASSES } from './operatorCapability.js';

const deepFreeze = (node) => {
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) deepFreeze(value);
    Object.freeze(node);
  }
  return node;
};

// ── Controlled vocabularies (addendum §3) ────────────────────────────────────────

// domain.verb.vN — a version bump is a NEW id, never an in-place edit.
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$/;

export const CAPABILITY_ACCESS = Object.freeze(['read', 'write']);

// CATEGORIES, not a severity ordering — array index carries no meaning here (Kari amendment
// #6): severity lives in the explicit floor map below, never in list position.
export const SIDE_EFFECT_CLASSES = Object.freeze([
  'none',
  'internal_state',
  'governed_memory',   // governed memory records (D-PA-6) — deliberately NOT 'firm_memory'
  'client_visible',
  'external_comms',
  'external_ledger',   // posts to the books of record — Donna's ledger_journals and/or
                       // provider mirrors; the statutory record is high-impact either way
  'external_payment'
]);

// Ordered ONLY so floors can compare (low < medium < high < critical).
export const RISK_CLASSES = Object.freeze(['low', 'medium', 'high', 'critical']);
const riskRank = (risk) => RISK_CLASSES.indexOf(risk);

// The explicit side-effect → minimum-risk floor map (addendum §3). A capability may declare
// HIGHER risk than its floor, never lower.
export const SIDE_EFFECT_RISK_FLOORS = Object.freeze({
  none: 'low',
  internal_state: 'low',
  governed_memory: 'medium',
  client_visible: 'medium',
  external_comms: 'medium',
  external_ledger: 'high',
  external_payment: 'critical'
});

export const SCHEMA_STATUSES = Object.freeze(['declared', 'legacy_untyped']);
export const DRY_RUN_STATES = Object.freeze(['supported', 'unsupported']);
// The guarantee the executor DECLARES today — 'none' means no guarantee is declared,
// whatever a writer happens to do; allowed only via the legacy-gap manifest.
export const IDEMPOTENCY_KINDS = Object.freeze(['natural_key', 'caller_key', 'none']);
// Whether execution needs a scoped authority grant BEYOND the operator capability class.
// 'none' across the whole retrofit today (the 083 inventory posting-authority check ships
// ready but wires later, an isolation-class slice); the D-PA-9 slice populates this as
// enforcement actually lands — the field records enforced reality, never aspiration.
export const GRANT_REQUIREMENTS = Object.freeze(['none', 'scoped_grant']);

// The gap names the closed legacy manifest may carry (addendum §4). Outside the manifest,
// a WRITE capability carrying any of these is refused by the validator.
export const LEGACY_GAP_KINDS = Object.freeze([
  'legacy_untyped',
  'idempotency_none',
  'execution_verifier_missing',
  'execution_receipt_none',
  'eval_scenarios_empty'
]);

// ── The closed legacy-gap manifest (addendum §4) ─────────────────────────────────
//
// Exactly the 16 finance.*.v1 retrofit capabilities, each naming which controls it lacks.
// This manifest only SHRINKS: upgrading a verb (declaring its schema, verifying+declaring
// its idempotency, naming its execution verifier, wiring its receipt, adding evals) removes
// the entry from its gap list in the same commit. Adding a member, or adding a gap to an
// existing member, fails the contract test by name — "honest gap" is a migration state for
// the retrofit, never the standard registration path.

const COMMON_LEGACY_GAPS = ['legacy_untyped', 'execution_verifier_missing', 'eval_scenarios_empty'];

// G2 idempotency sweep (godmode build-spec-g2 PR-13): 12 of the 14 legacy
// `idempotency_none` rows are DELETED — those writers were verified (not
// guessed) to carry a natural key or state guard, several gained via
// G−1/PR-4/PR-8/PR-10 while the manifest still carried the gap row. The two
// that remain (correct_document_field, answer_evidence_request) each carry
// their recorded honest posture in the overlay's idempotency_note — a bare
// 'none' with no recorded reason is refused by the validator.
export const LEGACY_CAPABILITY_GAP_MANIFEST = deepFreeze({
  'finance.apply_category.v1': [...COMMON_LEGACY_GAPS],
  'finance.sync_to_accounting.v1': [...COMMON_LEGACY_GAPS], // dry-run + natural-key verified (firmDb ledger post path)
  'finance.link_transaction.v1': [...COMMON_LEGACY_GAPS],
  'finance.link_document.v1': [...COMMON_LEGACY_GAPS, 'execution_receipt_none'],
  'finance.reject_match.v1': [...COMMON_LEGACY_GAPS, 'execution_receipt_none'],
  'finance.correct_document_field.v1': [...COMMON_LEGACY_GAPS, 'idempotency_none', 'execution_receipt_none'],
  'finance.recode_decided.v1': [...COMMON_LEGACY_GAPS, 'execution_receipt_none'],
  'finance.mark_personal.v1': [...COMMON_LEGACY_GAPS, 'execution_receipt_none'],
  'finance.mark_evidence_owed.v1': [...COMMON_LEGACY_GAPS],
  'finance.ask_client.v1': [...COMMON_LEGACY_GAPS],
  'finance.leave_review_note.v1': [...COMMON_LEGACY_GAPS],
  'finance.remember_merchant.v1': [...COMMON_LEGACY_GAPS],
  'finance.remember_fact.v1': [...COMMON_LEGACY_GAPS],
  'finance.retry_parse.v1': [...COMMON_LEGACY_GAPS],
  'finance.answer_evidence_request.v1': [...COMMON_LEGACY_GAPS, 'idempotency_none', 'execution_receipt_none'],
  'finance.post_inventory_journal.v1': [...COMMON_LEGACY_GAPS] // dry-run + one_success_per_basis verified (postingDb.js)
});

// ── The finance.*.v1 pack: a derivation of ACCOUNTING_MUTATION_REGISTRY ──────────
//
// The overlay carries ONLY the pack-new fields; every shared field is read from the
// registry row at build time (including required_capability_class, derived from
// operatorCapability so nothing is hand-copied). The overlay cannot add or remove verbs —
// asserted by the contract test.
//
// Overlay honesty (verified against the writers, not guessed):
//   - sync_to_accounting: postLedgerTransactionInDb takes dryRun and refuses a re-post of an
//     already-journaled transaction unless forced → dry_run supported, natural_key.
//   - post_inventory_journal: postingDb.js runs the full check chain under dryRun=true
//     writing nothing, and replays idempotently on one_success_per_basis → same.
//   - PR-13 (the G2 idempotency sweep) verified the remaining retrofit verbs against
//     their writers: 12 declared natural_key (see the sweep comment inside the overlay),
//     and the two that genuinely have no key (correct_document_field,
//     answer_evidence_request) carry their recorded honest posture in idempotency_note.
//     Dry-run stays unsupported across the retrofit — that half is unchanged.

const FINANCE_OVERLAY = deepFreeze({
  // G2 idempotency sweep (godmode build-spec-g2 PR-13) — the legacy retrofit
  // postures reconciled with WRITER REALITY, both directions. Every flip below
  // was verified at the writer, not guessed; the spine's applied-status stamp
  // already gives action-level replay idempotency, so the window these
  // declarations describe is the crash BETWEEN writer commit and stamp:
  //   apply_category / recode_decided / mark_personal / leave_review_note —
  //     updateTransactionReviewItemInDb targets ONE review item (the natural
  //     key); the status/payload/transaction writes are convergent overwrites,
  //     the learn_rule leg is the deterministic rule-id upsert, and the
  //     LLM-confirm confirmation bump is review-item-keyed
  //     (__shouldBumpRuleConfirmation, this PR) so a replay re-stamps the same
  //     state and can never phantom-promote a rule to auto-apply strength.
  //     leave_review_note's document leg merges under updateDocumentInDb's
  //     FOR UPDATE row lock.
  //   link_transaction / link_document — createManualReconciliationMatchInDb
  //     derives the match id from the (client, bank line, object type,
  //     document) tuple, looks up the prior row, and 409s a replay against an
  //     already-confirmed match — never a second row; the reconcile cascade is
  //     written idempotent (coalesce(reconciled_at, now())).
  //   reject_match — the match id is the natural key; the status write is a
  //     convergent overwrite and the payment-status revert fires only on the
  //     settled→unsettled EDGE (on a replay prevStatus is already 'rejected'),
  //     so nothing double-reverts; the loops regression hook self-filters the
  //     same way.
  //   mark_evidence_owed — a pure per-transaction boolean stamp (the
  //     mark_immaterial precedent: same command → same end state; the
  //     transaction id is the natural key).
  //   ask_client — the SAME F-19 id-deterministic writer draft_evidence_request
  //     already declares natural_key on: open-ask dedup on the canonical
  //     anchor + the deterministic (anchor, generation) id collapsing through
  //     `on conflict (id)`; a mint never bumps send_count.
  //   remember_merchant — the rule id derives from (client, pattern, account)
  //     with on-conflict-update; the cascade re-applies the same coding.
  //   remember_fact — the deterministic fact id + distinct-append provenance
  //     merge; dismissed/erased tombstones are never resurrected by a replay.
  //   retry_parse — the requeue fires only from RETRYABLE_PARSE_STATUSES,
  //     re-checked in the UPDATE's WHERE; a replay reports
  //     parse_status_not_retryable, never a second requeue.
  // The two verbs that KEEP 'none' carry their recorded honest posture in
  // idempotency_note — the validator refuses a bare 'none' without one.
  apply_category: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  sync_to_accounting: { side_effect_class: 'external_ledger', risk_class: 'high', idempotency: 'natural_key', dry_run: 'supported' },
  link_transaction: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  link_document: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  resolve_match_group: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  reject_match: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  // accept_match — same natural-key posture as reject_match: the match id is
  // the key, the confirmed status write is a convergent overwrite, and the
  // reconcile cascade is written idempotent (coalesce(reconciled_at, now())).
  accept_match: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  correct_document_field: {
    side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'none', dry_run: 'unsupported',
    // Honest posture, recorded not guarded: document_corrections is an
    // append-only correction JOURNAL by design (each correction is a dated
    // event with a random id — there is no natural key to collapse on). A
    // crash-window replay records a second correction row whose prior_value
    // equals its corrected_value (a self-evident no-op), while the document
    // write itself converges under the row's FOR UPDATE lock; the few-shot
    // reader dedupes newest-first per (field_path, document_type), so the
    // duplicate changes no prompt and no document state. Bounded + harmless.
    idempotency_note: 'append-only correction journal (random event id, no natural key); a replay adds a self-evident no-op row (prior_value == corrected_value) while the document writeback converges under its row lock; few-shot reads dedupe per (field_path, document_type) — double-execution bounded and harmless'
  },
  recode_decided: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  mark_personal: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  mark_evidence_owed: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  ask_client: { side_effect_class: 'client_visible', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  leave_review_note: { side_effect_class: 'internal_state', risk_class: 'low', idempotency: 'natural_key', dry_run: 'unsupported' },
  remember_merchant: { side_effect_class: 'governed_memory', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  remember_fact: { side_effect_class: 'governed_memory', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  retry_parse: { side_effect_class: 'internal_state', risk_class: 'low', idempotency: 'natural_key', dry_run: 'unsupported' },
  answer_evidence_request: {
    side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'none', dry_run: 'unsupported',
    // Honest posture, recorded not overclaimed: the resolve WRITE itself is
    // ask-id-keyed and convergent (status overwrite; response_payload merge of
    // the same content; responded_at keeps the FIRST answer) — no second row
    // can mint. What stops a natural_key claim is the post-commit reply-recode
    // leg: a replay re-invokes the strong coder on the same durable reply
    // (cost + a possibly different verdict, applied only at high confidence
    // through the guarded review writer, degradable to manual review), and the
    // loops inbox event is at-least-once by design.
    idempotency_note: 'the resolve write converges on the ask id (no duplicate rows; responded_at keeps the first answer), but the post-commit reply-recode re-invokes the coder on a replay (bounded: high-confidence-only apply through the guarded review writer, degrades to manual review) and the loops inbox event is at-least-once by design'
  },
  record_mileage: { side_effect_class: 'external_ledger', risk_class: 'high', idempotency: 'natural_key', dry_run: 'unsupported' },
  post_inventory_journal: { side_effect_class: 'external_ledger', risk_class: 'high', idempotency: 'natural_key', dry_run: 'supported' },
  // Team-screen recede (2026-08-14) — the standing-authority pair, registered
  // past the CLOSED manifest so both meet the full bar. Idempotency verified,
  // not guessed: the grant id derives from (firm, client, domain, action,
  // scope) with on-conflict-update (buildActionAuthorityGrantId), and a
  // re-revoke reports skipped through the same id. risk high: these verbs
  // change what an AI teammate may do without asking.
  approve_role_grant: { side_effect_class: 'internal_state', risk_class: 'high', idempotency: 'natural_key', dry_run: 'unsupported' },
  revoke_role_grant: { side_effect_class: 'internal_state', risk_class: 'high', idempotency: 'natural_key', dry_run: 'unsupported' },
  // G1(a) (godmode build-spec PR-8) — registered past the CLOSED manifest, so both
  // meet the full bar (declared schemas, verified idempotency, named verifier,
  // shadow receipt, eval scenario). Idempotency verified, not guessed:
  //   draft_evidence_request — the writer's F-19 id-determinism (same state →
  //     same request id → `on conflict (id)` collapse), unit-pinned;
  //   mark_immaterial — the payload verdict is a pure per-document overwrite
  //     (same command → same end state; the document id is the natural key),
  //     behind the spine's applied-status replay gate.
  draft_evidence_request: { side_effect_class: 'client_visible', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  mark_immaterial: { side_effect_class: 'internal_state', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  // G1c (godmode build-spec PR-10) — registered past the CLOSED manifest, so
  // both meet the full bar. Idempotency verified, not guessed:
  //   forget_fact — the deterministic fact id is the natural key; the writer
  //     flips status ONLY where status='active' (a replay is a reported skip,
  //     never a second mutation), behind the spine's applied-status gate;
  //   retire_rule — the rule id is the natural key; the writer re-verifies
  //     the prior status under its own row lock and 409s any non-retirable
  //     state, so a replay cannot double-apply.
  forget_fact: { side_effect_class: 'governed_memory', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  retire_rule: { side_effect_class: 'governed_memory', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  // G1b (godmode build-spec PR-9) — registered past the CLOSED manifest, so
  // both meet the full bar. Idempotency verified, not guessed:
  //   cancel_ask — the ask id is the natural key; the writer flips status ONLY
  //     from draft/open under a row lock, so a replay is a reported skip and
  //     never a second cancellation;
  //   resend_ask — the natural key is (ask id, last successful send): the
  //     writer REFUSES a resend whose ask genuinely reached the owner within
  //     RESEND_MIN_INTERVAL_MS, so a replay is a reported skip rather than a
  //     second nudge. This is a real guard, not a tidier label — the closed
  //     manifest refused an idempotency gap here, and the honest way to satisfy
  //     it was to make the outbound verb replay-safe.
  cancel_ask: { side_effect_class: 'client_visible', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  resend_ask: { side_effect_class: 'client_visible', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' },
  // G1b's §7.2 half (2026-08-14). Idempotency verified, not guessed:
  //   amend_ask — the natural key is (ask id, amendment text): the writer
  //     serializes on the row lock and only OPEN asks amend, so a replay
  //     appends a visibly duplicate amendment block rather than corrupting
  //     state — and the MAX_EVIDENCE_REQUEST_AMENDMENTS cap bounds even a
  //     pathological replay loop to a reported skip.
  amend_ask: { side_effect_class: 'client_visible', risk_class: 'medium', idempotency: 'natural_key', dry_run: 'unsupported' }
});

// Declared (closed) schemas, named execution verifiers, and eval scenarios for
// the capabilities that meet the full bar — every other verb rides the closed
// legacy-gap manifest until upgraded. Keyed by verb so the pack derivation
// stays one expression.
const DECLARED_SCHEMAS = deepFreeze({
  resolve_match_group: {
    input: {
      type: 'object', additionalProperties: false, required: ['match_pairs', 'reason'],
      properties: {
        match_pairs: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['transaction_id', 'document_id'],
            properties: { transaction_id: { type: 'string' }, document_id: { type: 'string' } }
          }
        },
        reason: { type: 'string' }
      }
    },
    output: {
      type: 'object', additionalProperties: false,
      required: ['pairings', 'retired_match_ids', 'reconciled_count', 'consequence'],
      properties: {
        pairings: { type: 'array' },
        retired_match_ids: { type: 'array', items: { type: 'string' } },
        reconciled_count: { type: 'number' },
        consequence: { type: 'string' }
      }
    }
  },
  record_mileage: {
    input: { type: 'object', additionalProperties: false, required: ['miles', 'purpose', 'date', 'confidence'], properties: { miles: { type: 'number' }, purpose: { type: 'string' }, date: { type: ['string', 'null'] }, confidence: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['status', 'ledger_journal_id', 'consequence'], properties: { status: { type: 'string' }, ledger_journal_id: { type: ['string', 'null'] }, consequence: { type: ['string', 'null'] } } }
  },
  draft_evidence_request: {
    input: { type: 'object', additionalProperties: false, required: ['question', 'recipient', 'reason'], properties: { question: { type: 'string' }, recipient: { type: ['string', 'null'], enum: ['customer', 'vendor', 'client_owner', null] }, reason: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['evidence_request_id', 'consequence'], properties: { evidence_request_id: { type: ['string', 'null'] }, consequence: { type: 'string' } } }
  },
  mark_immaterial: {
    input: { type: 'object', additionalProperties: false, required: ['reason', 'threshold_amount'], properties: { reason: { type: 'string' }, threshold_amount: { type: ['number', 'null'] } } },
    output: { type: 'object', additionalProperties: false, required: ['document_id', 'verdict', 'consequence', 'preflight'], properties: { document_id: { type: 'string' }, verdict: { type: 'string', enum: ['immaterial'] }, consequence: { type: 'string' }, preflight: { type: 'object' } } }
  },
  forget_fact: {
    input: { type: 'object', additionalProperties: false, required: ['fact_id', 'reason'], properties: { fact_id: { type: 'string' }, reason: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['fact_id', 'status', 'consequence'], properties: { fact_id: { type: 'string' }, status: { type: 'string', enum: ['dismissed'] }, consequence: { type: 'string' } } }
  },
  retire_rule: {
    input: { type: 'object', additionalProperties: false, required: ['rule_id', 'reason'], properties: { rule_id: { type: 'string' }, reason: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['rule_id', 'prior_status', 'status', 'consequence'], properties: { rule_id: { type: 'string' }, prior_status: { type: 'string' }, status: { type: 'string', enum: ['retired'] }, consequence: { type: 'string' } } }
  },
  // accept_match — the affirmative twin of reject_match (2026-08-25). The
  // output REQUIRES from_status 'suggested' + consequence: a confirm that
  // cannot show it acted on a SUGGESTED match (never a double-confirm) may
  // not report success.
  accept_match: {
    input: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string' }, document_id: { type: ['string', 'null'] } } },
    output: { type: 'object', additionalProperties: false, required: ['match_id', 'from_status', 'confirmed', 'consequence'], properties: { match_id: { type: 'string' }, from_status: { type: 'string', enum: ['suggested'] }, matched_object_id: { type: ['string', 'null'] }, confirmed: { type: 'boolean' }, consequence: { type: 'string' } } }
  },
  // G1b. cancel_ask's output REQUIRES leaves_line_hanging: the two-terminal-states
  // consequence is part of the declared contract, not an optional extra a caller
  // may drop. resend_ask's REQUIRES delivered + send_count, so "nothing actually
  // left" can never be reported as a bare success.
  cancel_ask: {
    input: { type: 'object', additionalProperties: false, required: ['ask_id', 'reason'], properties: { ask_id: { type: 'string' }, reason: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['ask_id', 'prior_status', 'status', 'leaves_line_hanging', 'consequence'], properties: { ask_id: { type: 'string' }, prior_status: { type: 'string' }, status: { type: 'string', enum: ['cancelled'] }, leaves_line_hanging: { type: ['boolean', 'null'] }, consequence: { type: 'string' } } }
  },
  resend_ask: {
    input: { type: 'object', additionalProperties: false, required: ['ask_id', 'reason'], properties: { ask_id: { type: 'string' }, reason: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['ask_id', 'delivered', 'send_count', 'consequence'], properties: { ask_id: { type: 'string' }, delivered: { type: 'boolean' }, send_count: { type: 'number' }, consequence: { type: 'string' } } }
  },
  // §7.2 (2026-08-14). amend_ask's output REQUIRES prior_question: the
  // no-silent-edit shape is part of the declared contract — an amendment
  // that cannot show what the question USED to say may not report success.
  amend_ask: {
    input: { type: 'object', additionalProperties: false, required: ['ask_id', 'amendment_text', 'reason'], properties: { ask_id: { type: 'string' }, amendment_text: { type: 'string' }, reason: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['ask_id', 'prior_question', 'amendment_count', 'consequence'], properties: { ask_id: { type: 'string' }, prior_question: { type: 'string' }, amendment_count: { type: 'number' }, consequence: { type: 'string' } } }
  },
  // Team-screen recede: the target role + shape DERIVE server-side from
  // grant_action (the unique claiming role), so the declared input carries no
  // role id — the model cannot mis-aim a grant. The review-after bound is set
  // server-side; the output reports it so the receipt shows the time bound.
  approve_role_grant: {
    input: { type: 'object', additionalProperties: false, required: ['grant_action', 'grant_scope_key', 'grant_ceiling', 'grant_currency', 'reason'], properties: { grant_action: { type: 'string' }, grant_scope_key: { type: 'string' }, grant_ceiling: { type: 'number' }, grant_currency: { type: 'string' }, reason: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['grant_id', 'role_id', 'grant_action', 'scope_key', 'amount_ceiling', 'currency', 'review_after'], properties: { grant_id: { type: 'string' }, role_id: { type: 'string' }, grant_action: { type: 'string' }, scope_key: { type: 'string' }, amount_ceiling: { type: 'number' }, currency: { type: 'string' }, review_after: { type: 'string' } } }
  },
  revoke_role_grant: {
    input: { type: 'object', additionalProperties: false, required: ['grant_id', 'reason'], properties: { grant_id: { type: 'string' }, reason: { type: 'string' } } },
    output: { type: 'object', additionalProperties: false, required: ['grant_id', 'role_id'], properties: { grant_id: { type: 'string' }, role_id: { type: ['string', 'null'] } } }
  }
});

const EXECUTION_VERIFIERS = deepFreeze({
  record_mileage: 'ledger_journal_posted_and_balanced',
  draft_evidence_request: 'open_evidence_request_exists_for_document',
  mark_immaterial: 'document_payload_immaterial_verdict_persisted',
  forget_fact: 'firm_fact_status_dismissed_persisted',
  retire_rule: 'client_rule_status_retired_persisted',
  cancel_ask: 'client_evidence_request_status_cancelled_persisted',
  // Not "the fan-out returned" — the deliverers bump send_count ONLY on a
  // genuinely successful send, so the increment is the one signal that
  // distinguishes a real re-delivery from a dark channel.
  resend_ask: 'client_evidence_request_send_count_incremented',
  // The composite question + the amendments array are one persisted write —
  // the question column changing WITHOUT the structured amendment record
  // would be exactly the silent edit this verb exists to prevent.
  amend_ask: 'client_evidence_request_question_amended_with_history_persisted',
  // The grant row IS the verdict: active-with-role-provenance for a mint,
  // status revoked for a withdrawal — both readable from
  // action_authority_grants alone (render the persisted verdict).
  // The confirmed match row + the cascaded transaction are one persisted
  // outcome — a confirm whose bank line did not settle is not a success.
  accept_match: 'reconciliation_match_status_confirmed_and_line_reconciled_persisted',
  resolve_match_group: 'every_selected_match_confirmed_every_line_reconciled_and_crossed_suggestions_rejected_in_one_transaction',
  approve_role_grant: 'action_authority_grant_active_with_role_provenance_persisted',
  revoke_role_grant: 'action_authority_grant_status_revoked_persisted'
});

const EVAL_SCENARIO_NAMES = deepFreeze({
  record_mileage: ['us_owner_stated_business_mileage_books_balanced_journal'],
  draft_evidence_request: ['doc_missing_artifact_ask_minted_once_and_deduped_on_replay'],
  mark_immaterial: ['small_clean_doc_marked_immaterial_and_material_doc_refused_by_preflight'],
  forget_fact: ['stale_fact_stopped_via_chat_never_retrieved_again_and_replay_reports_skip'],
  retire_rule: ['active_rule_retired_via_chat_stops_matching_and_replay_refused'],
  cancel_ask: [
    'moot_ask_cancelled_via_chat_frees_the_anchor_and_receipt_reports_line_left_hanging',
    'answered_ask_refused_by_writer_and_reply_points_at_correcting_the_answer'
  ],
  resend_ask: [
    'unanswered_open_ask_resent_on_existing_channels_bumps_send_count_and_mints_no_second_ask',
    'resend_with_every_channel_dark_reports_not_delivered_and_stays_proposed',
    'resend_replayed_within_the_window_is_refused_and_the_owner_is_nudged_once'
  ],
  amend_ask: [
    'sent_ask_amended_keeps_original_visible_and_records_the_structured_amendment',
    'draft_and_answered_asks_refuse_amendment_and_reply_names_the_right_path'
  ],
  accept_match: [
    'owner_confirms_suggested_match_in_chat_and_the_line_settles_reconciled',
    'already_settled_match_or_stale_document_guard_refused_never_double_confirmed'
  ],
  resolve_match_group: [
    'distinct_same_amount_receipts_pair_by_unique_dates_and_apply_atomically',
    'stale_or_incomplete_collision_group_refuses_without_partial_reconciliation'
  ],
  approve_role_grant: [
    'owner_delegates_reminder_sends_in_chat_grant_minted_ceilinged_and_time_bounded',
    'grant_outside_role_leash_or_on_unhired_role_refused_by_writer'
  ],
  revoke_role_grant: [
    'owner_revokes_standing_grant_in_chat_teammate_returns_to_asking',
    'revoking_unknown_or_already_revoked_grant_reports_skipped_never_silent'
  ]
});

export const financeCapabilityPack = () =>
  deepFreeze(ACCOUNTING_MUTATION_REGISTRY.map((row) => {
    const overlay = FINANCE_OVERLAY[row.verb];
    if (!overlay) throw new Error(`financeCapabilityPack: no overlay for registry verb "${row.verb}"`);
    return {
      capability: `finance.${row.verb}.v1`,
      domain: 'finance',
      verb: row.verb,
      version: 1,
      input_schema: DECLARED_SCHEMAS[row.verb]?.input ?? null,
      output_schema: DECLARED_SCHEMAS[row.verb]?.output ?? null,
      schema_status: DECLARED_SCHEMAS[row.verb] ? 'declared' : 'legacy_untyped',
      access: 'write',
      side_effect_class: overlay.side_effect_class,
      risk_class: overlay.risk_class,
      reversibility: row.reversibility,
      dry_run: overlay.dry_run,
      idempotency: overlay.idempotency,
      // PR-13: the recorded honest replay posture. Required (validator-enforced)
      // whenever a write capability declares idempotency 'none' — a bare 'none'
      // with no recorded reason is the sweep's refused state.
      idempotency_note: overlay.idempotency_note ?? null,
      // Surfaces are NOT authority (Kari amendment #6): the authority block carries what the
      // principal must be; entry-point exposure lives in legacy_entrypoint_bindings below and
      // disappears when the compatibility exports flip.
      authority_requirements: {
        autonomy_class: row.autonomyClass,
        required_capability_class: requiredCapabilityForAction(row.verb),
        grant_required: 'none'
      },
      legacy_entrypoint_bindings: { surfaces: [...row.surfaces] },
      executor: row.writer,
      // Verifies THE ACTION OCCURRED — business-outcome verification belongs to the plan /
      // workflow definition (design §5a: command success ≠ outcome success). None of the
      // retrofit verbs names one yet (manifest gap).
      execution_verifier: EXECUTION_VERIFIERS[row.verb] ?? null,
      // Three separate coverage dimensions, each 1:1 from its registry column — one collapsed
      // field would conceal audit-live-but-receipt-missing combinations.
      audit_record: row.emitsAudit,
      execution_receipt: row.emitsApplyReceipt,
      preflight: row.preflightToday,
      // Required non-null when risk ≥ high AND dry_run is unsupported.
      preflight_alternative:
        row.verb === 'record_mileage'
          ? 'deterministic mileage rate + materiality ceiling + period-lock checks + balanced journal + apply receipt'
          : row.verb === 'approve_role_grant'
            ? 'roleEmployment writer guards: owner actor + active hire + shape offered + authority ⊆ leash + mandatory time bound + store ceiling/currency rules, all in one refusing transaction'
            : row.verb === 'revoke_role_grant'
              ? 'conservative-direction writer: owner actor required; an unknown/already-revoked grant reports skipped, never a forced flip'
              : null,
      eval_scenarios: EVAL_SCENARIO_NAMES[row.verb] ?? []
    };
  }));

// ── Validation (the deterministic contract — addendum §3/§9) ─────────────────────

const isClosedJsonSchema = (schema) =>
  schema != null && typeof schema === 'object' && schema.additionalProperties === false;

// One entry → a list of contract violations (empty = valid). `legacyManifest` gates the
// no-new-unsafe-gaps rule: outside the manifest a write capability may not ship with
// legacy_untyped schemas, no declared idempotency, no execution verifier, no execution
// receipt, or an empty eval suite.
export const validateCapabilityEntry = (entry, { legacyManifest = LEGACY_CAPABILITY_GAP_MANIFEST } = {}) => {
  const errors = [];
  const err = (msg) => errors.push(msg);
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  const id = entry.capability;

  if (typeof id !== 'string' || !CAPABILITY_ID_PATTERN.test(id)) {
    err(`capability id "${id}" fails the domain.verb.vN grammar`);
  } else if (id !== `${entry.domain}.${entry.verb}.v${entry.version}`) {
    err(`capability id "${id}" does not recompose from domain/verb/version`);
  }

  if (!SCHEMA_STATUSES.includes(entry.schema_status)) err(`${id}: schema_status "${entry.schema_status}"`);
  if (entry.schema_status === 'declared') {
    if (!isClosedJsonSchema(entry.input_schema)) err(`${id}: declared input_schema must be a CLOSED JSON schema (additionalProperties: false)`);
    if (!isClosedJsonSchema(entry.output_schema)) err(`${id}: declared output_schema must be a CLOSED JSON schema (additionalProperties: false)`);
  } else if (entry.input_schema !== null || entry.output_schema !== null) {
    err(`${id}: legacy_untyped entries carry null schemas, never partial ones`);
  }

  if (!CAPABILITY_ACCESS.includes(entry.access)) err(`${id}: access "${entry.access}"`);
  if (!SIDE_EFFECT_CLASSES.includes(entry.side_effect_class)) err(`${id}: side_effect_class "${entry.side_effect_class}"`);
  if (!RISK_CLASSES.includes(entry.risk_class)) err(`${id}: risk_class "${entry.risk_class}"`);

  const floor = SIDE_EFFECT_RISK_FLOORS[entry.side_effect_class];
  if (floor && RISK_CLASSES.includes(entry.risk_class) && riskRank(entry.risk_class) < riskRank(floor)) {
    err(`${id}: risk_class "${entry.risk_class}" is below the "${entry.side_effect_class}" floor "${floor}"`);
  }

  if (entry.reversibility !== null && !REVERSIBILITY_CLASSES.includes(entry.reversibility)) {
    err(`${id}: reversibility "${entry.reversibility}"`);
  }
  if (!DRY_RUN_STATES.includes(entry.dry_run)) err(`${id}: dry_run "${entry.dry_run}"`);
  if (!IDEMPOTENCY_KINDS.includes(entry.idempotency)) err(`${id}: idempotency "${entry.idempotency}"`);
  // PR-13: no verb keeps a BARE 'none'. A write capability declaring no
  // idempotency guarantee must record its honest replay posture — what
  // actually happens on a crash-between-writer-and-stamp replay and why it
  // is bounded. (The manifest sanctions the GAP existing; the note is the
  // recorded reason. Both are required for 'none' to rest.)
  if (
    entry.access === 'write' && entry.idempotency === 'none' &&
    (typeof entry.idempotency_note !== 'string' || !entry.idempotency_note.trim())
  ) {
    err(`${id}: idempotency 'none' requires a recorded idempotency_note (the honest replay posture) — a bare 'none' is refused`);
  }

  const auth = entry.authority_requirements;
  if (!auth || typeof auth !== 'object') {
    err(`${id}: missing authority_requirements`);
  } else {
    if (!AUTONOMY_CLASSES.includes(auth.autonomy_class)) err(`${id}: autonomy_class "${auth.autonomy_class}"`);
    if (!CAPABILITY_CLASSES.includes(auth.required_capability_class)) err(`${id}: required_capability_class "${auth.required_capability_class}"`);
    if (!GRANT_REQUIREMENTS.includes(auth.grant_required)) err(`${id}: grant_required "${auth.grant_required}"`);
    if ('surfaces' in auth) err(`${id}: surfaces are NOT authority — move them to legacy_entrypoint_bindings`);
  }

  const bindings = entry.legacy_entrypoint_bindings;
  if (!bindings || !Array.isArray(bindings.surfaces)) err(`${id}: legacy_entrypoint_bindings.surfaces must be an array`);

  if (typeof entry.executor !== 'string' || !entry.executor) err(`${id}: missing executor`);
  if (entry.execution_verifier !== null && (typeof entry.execution_verifier !== 'string' || !entry.execution_verifier)) {
    err(`${id}: execution_verifier must be a named check or null`);
  }
  if (!PRESENCE_STATES.includes(entry.audit_record)) err(`${id}: audit_record "${entry.audit_record}"`);
  if (!RECEIPT_STATES.includes(entry.execution_receipt)) err(`${id}: execution_receipt "${entry.execution_receipt}"`);
  if (!RECEIPT_STATES.includes(entry.preflight)) err(`${id}: preflight "${entry.preflight}"`);
  if (!Array.isArray(entry.eval_scenarios)) err(`${id}: eval_scenarios must be an array`);

  // High-impact without dry-run needs a named deterministic alternative (addendum §3).
  if (
    RISK_CLASSES.includes(entry.risk_class) && riskRank(entry.risk_class) >= riskRank('high') &&
    entry.dry_run === 'unsupported' &&
    (typeof entry.preflight_alternative !== 'string' || !entry.preflight_alternative)
  ) {
    err(`${id}: risk ≥ high with dry_run unsupported requires a named preflight/consequence-diff alternative`);
  }

  // No new unsafe gaps (Kari amendment #6): the manifest is the ONLY door, and it is closed.
  if (entry.access === 'write') {
    const allowedGaps = legacyManifest?.[id] || [];
    const gapViolations = [
      [entry.schema_status === 'legacy_untyped', 'legacy_untyped'],
      [entry.idempotency === 'none', 'idempotency_none'],
      [entry.execution_verifier === null, 'execution_verifier_missing'],
      [entry.execution_receipt === 'none', 'execution_receipt_none'],
      [entry.eval_scenarios.length === 0, 'eval_scenarios_empty']
    ];
    for (const [present, gapKind] of gapViolations) {
      if (present && !allowedGaps.includes(gapKind)) {
        err(`${id}: gap "${gapKind}" is not sanctioned by the closed legacy-gap manifest`);
      }
    }
  }

  return errors;
};

// ── Registry assembly ────────────────────────────────────────────────────────────

export const buildCapabilityRegistry = (packs, { legacyManifest = LEGACY_CAPABILITY_GAP_MANIFEST } = {}) => {
  const capabilities = packs.flat();
  const seen = new Set();
  for (const entry of capabilities) {
    const errors = validateCapabilityEntry(entry, { legacyManifest });
    if (errors.length) throw new Error(`capability registry rejected "${entry?.capability}":\n  ${errors.join('\n  ')}`);
    if (seen.has(entry.capability)) throw new Error(`duplicate capability id "${entry.capability}"`);
    seen.add(entry.capability);
  }
  return deepFreeze([...capabilities]);
};

// The assembled registry: finance (the Slice-1 retrofit) + memory (Slice 2a — dark,
// uncalled, no legacy exemptions; see memoryCapabilityPack.js) + knowledge (K1-4 — the
// sourced-knowledge retrieval strategy, uncalled until K1-5 wires it). Import is lazy-free
// and cycle-free: the memory pack imports only memoryModel.js, the knowledge pack only
// knowledgeRetrieval.js.
import { memoryCapabilityPack } from './memoryCapabilityPack.js';
import { knowledgeCapabilityPack } from './knowledgeCapabilityPack.js';

export const CAPABILITY_REGISTRY = buildCapabilityRegistry([
  financeCapabilityPack(),
  memoryCapabilityPack(),
  knowledgeCapabilityPack()
]);

export const findCapability = (capabilityId, registry = CAPABILITY_REGISTRY) =>
  registry.find((e) => e.capability === capabilityId) || null;

export const isRegisteredCapability = (capabilityId, registry = CAPABILITY_REGISTRY) =>
  registry.some((e) => e.capability === capabilityId);

// The honest gap surface: ACTUAL gaps computed from the rows (never trusted from the
// manifest), so the contract test can assert manifest ↔ reality equality both ways.
export const capabilityCoverageGaps = (registry = CAPABILITY_REGISTRY) =>
  registry
    .map((e) => {
      const gaps = [];
      const isWrite = e.access === 'write';
      if (e.schema_status === 'legacy_untyped') gaps.push('legacy_untyped');
      // Idempotency, verification, and receipts are WRITE concerns (mirrors the lint in
      // validateCapabilityEntry): a read is its own verification and has nothing to replay.
      if (isWrite && e.idempotency === 'none') gaps.push('idempotency_none');
      if (isWrite && e.execution_verifier === null) gaps.push('execution_verifier_missing');
      if (isWrite && e.execution_receipt === 'none') gaps.push('execution_receipt_none');
      if (Array.isArray(e.eval_scenarios) && e.eval_scenarios.length === 0) gaps.push('eval_scenarios_empty');
      return { capability: e.capability, gaps };
    })
    .filter((g) => g.gaps.length > 0);

// ── Canonical snapshot + fingerprint (addendum §2) ───────────────────────────────
//
// The fingerprint proves difference; the SNAPSHOT makes history reproducible — a receipt
// pinning a fingerprint must be resolvable to the full registry it ran under. The canonical
// form sorts capabilities by id and object keys lexicographically, so key order can never
// perturb the hash. Persistence (content-addressed insert-once, the config_snapshots
// pattern) wires in Slice 1c with the first consumer; this leaf stays DB-free.

const canonicalize = (node) => {
  if (Array.isArray(node)) return node.map(canonicalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = canonicalize(node[key]);
    return out;
  }
  return node;
};

export const canonicalCapabilityRegistrySnapshot = (registry = CAPABILITY_REGISTRY) =>
  canonicalize([...registry].sort((a, b) => a.capability.localeCompare(b.capability)));

export const capabilityRegistryFingerprint = (registry = CAPABILITY_REGISTRY) =>
  `capreg-${createHash('sha256').update(JSON.stringify(canonicalCapabilityRegistrySnapshot(registry))).digest('hex')}`;
