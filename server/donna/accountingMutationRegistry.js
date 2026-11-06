// Donna — accounting mutation registry (Accounting Runtime Hardening, Slice A).
//
// A DECLARATIVE, dependency-free inventory of every chat/drawer verb that mutates
// bookkeeping state, and how it behaves TODAY. This is the map the hardening arc
// builds on (docs/donna-accounting-runtime-hardening-plan.md §4): one row per
// mutating verb, naming the single existing writer it routes through (INV-1 — the
// grammar is a router, never a second accounting backend), the tables it touches,
// its reversibility class, its V1-autonomy class, and the HONEST current status of
// its actor attribution / audit / apply-receipt / preflight coverage.
//
// Slice A ships this as a living inventory + an invariant-test surface ONLY. Nothing
// routes through it yet; later slices wire the live apply paths onto it. Its value
// now: (1) every future agent inherits a verified map instead of re-deriving it, and
// (2) the test fails the moment a chat surface adds an appliable verb without a
// registry entry — so the inventory can't silently drift out of date.
//
// Pure leaf: imports ONLY operatorContract.js (itself import-free) so this module
// can be required anywhere without widening an import cycle. The verb→writer map was
// VERIFIED against the live dispatch this session (feedChatProposalShadow.VERB_WRITER;
// api.js transaction-chat apply 4769-5699; document-chat apply 4187-4243; feed apply
// 6099-6190) — not guessed (the lead lesson).

import { REVERSIBILITY_CLASSES } from './operatorContract.js';

// ── Controlled vocabularies (the test validates every entry against these) ──────

// V1-autonomy class (contract §7 boundary): whether a verb may run autonomously.
// 'workflow' may; the rest require a human authority + review mode. This is a
// DIFFERENT axis from operatorContract.AUTONOMY_FORBIDDEN_VERBS (which is the
// untrusted-SOURCE boundary — what client/OCR text may never invoke). Don't conflate.
export const AUTONOMY_CLASSES = Object.freeze([
  'accounting',   // mutates accounting/coding/match state — forbidden autonomously
  'memory',       // mints/edits active memory — forbidden autonomously
  'owner_ask',    // client-visible ask — the SEND is forbidden autonomously
  'remedial',     // re-queues a workflow/system op — separately guarded + counted (INV-5)
  'authority',    // mints/withdraws standing authority — forbidden autonomously (INV-S10: only the principal delegates)
  'workflow'      // pure workflow state — allowed autonomously
]);

// Which of the two terminal convergence states (CLAUDE.md FIRST principle) a verb can
// move a row toward, plus the non-terminal transitions. 'reopens' = can regress a
// prior terminal (INV-4 in reverse); 'workflow_only' = no direct convergence effect.
export const CONVERGENCE_IMPACTS = Object.freeze([
  'auto_reconciled',
  'on_owner',
  'reopens',
  'workflow_only'
]);

// Honest tri-state for "does this emit X today" — the inventory's whole point is to
// surface the gaps (CLAUDE.md: "'nothing silent' is only ~70% true today").
export const ACTOR_STATUSES = Object.freeze(['threaded', 'partial', 'missing', 'open']);
export const PRESENCE_STATES = Object.freeze(['yes', 'gap', 'unknown']);
// 'live' (I4·posting P5) — a REAL apply-receipt / real deterministic preflight gating an
// actual post, not a shadow-feed mirror. The inventory executor writes the canonical
// ApplyReceipt (proposalStore.persistApplyReceipt) and runs runDeterministicPreflight as a
// gate, so its honest state is 'live', not 'shadow_feed'.
export const RECEIPT_STATES = Object.freeze(['shadow_feed', 'live', 'none']);

// ── The registry ───────────────────────────────────────────────────────────────

export const ACCOUNTING_MUTATION_REGISTRY = Object.freeze([
  {
    verb: 'apply_category',
    surfaces: ['feed_chat', 'transaction_chat', 'drawer'],
    writer: 'updateTransactionReviewItemInDb',     // (+ postLedgerTransactionInDb on post)
    mutates: ['transaction_review_queue', 'transactions', 'client_rules?'],
    reversibility: 'recode_before_posting',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['auto_reconciled', 'on_owner']
  },
  {
    verb: 'sync_to_accounting',
    // transaction_chat added 2026-08-16 (Kari's dated call — the "not on
    // this surface" fix): the single-row guarded form; same writer, the
    // apply re-verifies post-accepted-only at write time.
    surfaces: ['feed_chat', 'transaction_chat'],
    writer: 'postLedgerTransactionInDb',
    mutates: ['ledger_journals', 'ledger_lines', 'transactions', 'xero_writeback_mirrors', 'qbo_journal_mirrors'],
    reversibility: 'irreversible_external',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['auto_reconciled']
  },
  {
    verb: 'link_transaction',
    surfaces: ['document_chat'],
    writer: 'createManualReconciliationMatchInDb',
    mutates: ['reconciliation_matches', 'transactions', 'documents', 'transaction_review_queue'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',      // #724 closed gap #1: doc-chat threads the spine-attributed actorId into the writer
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',  // Slice F: document-chat apply hook now mirrors the receipt in shadow
    preflightToday: 'shadow_feed',     // Slice F: deterministic preflight runs in the shadow hook
    convergenceImpact: ['auto_reconciled']
  },
  {
    verb: 'link_document',
    surfaces: ['transaction_chat'],
    writer: 'createManualReconciliationMatchInDb',
    mutates: ['reconciliation_matches', 'transactions', 'documents', 'transaction_review_queue'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',      // #724 closed gap #1: txn-chat threads the spine-attributed actorId into the writer
    emitsAudit: 'yes',
    emitsApplyReceipt: 'none',
    preflightToday: 'none',
    convergenceImpact: ['auto_reconciled']
  },
  {
    verb: 'resolve_match_group',
    surfaces: ['transaction_chat'],
    writer: 'createManualReconciliationMatchInDb',
    mutates: ['reconciliation_matches', 'transactions', 'documents', 'transaction_review_queue'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'none',
    convergenceImpact: ['auto_reconciled']
  },
  {
    verb: 'reject_match',
    surfaces: ['transaction_chat'],
    writer: 'updateReconciliationMatchInDb',
    mutates: ['reconciliation_matches'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'none',
    preflightToday: 'none',
    convergenceImpact: ['reopens', 'on_owner']
  },
  {
    // accept_match — the affirmative twin of reject_match (Kari, 2026-08-25:
    // "yea this is a match, reconcile away" compiled to apply_category and the
    // suggested match rested in Open — the grammar could unlink but not
    // confirm). Confirming cascades the bank line to reconciled inside the
    // writer, and the writer's confirmed branch also mints the cross-entity
    // learned name when the guard had capped the match.
    verb: 'accept_match',
    surfaces: ['transaction_chat'],
    writer: 'updateReconciliationMatchInDb',
    mutates: ['reconciliation_matches', 'transactions'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed', // the transaction-chat apply hook mirrors the receipt (onTransactionChatActionApplied)
    preflightToday: 'none',
    convergenceImpact: ['auto_reconciled']
  },
  {
    verb: 'correct_document_field',
    surfaces: ['transaction_chat', 'document_chat'],
    writer: 'recordDocumentCorrectionInDb',
    mutates: ['document_corrections', 'documents'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'partial',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'none',
    preflightToday: 'none',
    convergenceImpact: ['reopens']
  },
  {
    verb: 'recode_decided',
    surfaces: ['transaction_chat', 'drawer'],
    writer: 'updateTransactionReviewItemInDb',     // guarded; re-verifies the row is decided (INV-4)
    mutates: ['transaction_review_queue', 'transactions'],
    reversibility: 'recode_before_posting',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'none',
    preflightToday: 'none',
    convergenceImpact: ['auto_reconciled']
  },
  {
    verb: 'mark_personal',
    surfaces: ['transaction_chat'],
    writer: 'updateTransactionReviewItemInDb',
    mutates: ['transaction_review_queue', 'transactions'],
    reversibility: 'recode_before_posting',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'none',
    preflightToday: 'none',
    convergenceImpact: ['auto_reconciled']
  },
  {
    verb: 'mark_evidence_owed',
    surfaces: ['feed_chat'],
    writer: 'setTransactionAiEvidenceRequiredInDb',
    mutates: ['transactions'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'owner_ask',
    requiresActor: true,
    actorStatus: 'threaded',      // #4 spine: dispatcher threads the spine-attributed actorId into the writer's audit
    emitsAudit: 'yes',            // audit row now carries actor_id (was actor-less — the 'gap')
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['on_owner']
  },
  {
    verb: 'ask_client',
    surfaces: ['feed_chat', 'transaction_chat'],
    writer: 'createClientEvidenceRequestInDb',
    mutates: ['client_evidence_requests'],
    reversibility: null,          // an owner ask, not a posted-accounting mutation
    autonomyClass: 'owner_ask',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['on_owner']
  },
  {
    verb: 'leave_review_note',
    surfaces: ['feed_chat', 'transaction_chat', 'document_chat'],
    writer: 'updateTransactionReviewItemInDb',     // (+ updateDocumentInDb on document_chat — a doc note lands on the document's payload, G1(a))
    mutates: ['transaction_review_queue', 'documents'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'workflow',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']
  },
  {
    // G1(a) (godmode build-spec PR-8): the doc-anchored owner ask. The
    // writer's F-19 id-determinism (same state → same request id →
    // `on conflict (id)` collapse) is a real natural-key idempotency
    // guarantee, unit-pinned in its own suite.
    verb: 'draft_evidence_request',
    surfaces: ['document_chat'],
    writer: 'createClientEvidenceRequestInDb',
    mutates: ['client_evidence_requests'],
    reversibility: null,          // an owner ask, not a posted-accounting mutation
    autonomyClass: 'owner_ask',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',  // document-object card via the doc-chat apply hook (G1a)
    preflightToday: 'shadow_feed',
    convergenceImpact: ['on_owner']
  },
  {
    // G1(a): the immateriality VERDICT on the document's payload (the
    // producer-verdict house pattern), gated LIVE by the deterministic
    // materiality preflight (evaluateMarkImmaterialPreflight — blocks on
    // unreadable amount / ceiling / stated threshold / tax / red flags
    // BEFORE the writer runs).
    verb: 'mark_immaterial',
    surfaces: ['document_chat'],
    writer: 'updateDocumentInDb',
    mutates: ['documents'],
    reversibility: 'reversible_via_adjustment',   // clearing the payload verdict restores the prior state
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',  // document-object card via the doc-chat apply hook (G1a)
    preflightToday: 'live',            // the deterministic gate refuses pre-apply (422, stays proposed)
    convergenceImpact: ['auto_reconciled']
  },
  {
    verb: 'remember_merchant',
    surfaces: ['feed_chat', 'transaction_chat'],
    writer: 'saveMerchantRuleForPayload',
    mutates: ['merchant rules', 'merchant_signal_events', 'merchant_signal_rollup'],
    reversibility: null,          // memory, not posted-accounting state
    autonomyClass: 'memory',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',            // #4 audit half CLOSED the mint gap: saveMerchantRuleForPayload
                                  // emits client_rule.merchant_rule_saved inside the mint's own
                                  // transaction (audit-as-precondition), actor threaded from the spine
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']
  },
  {
    verb: 'remember_fact',
    surfaces: ['feed_chat'],
    writer: 'saveFirmFact',
    mutates: ['firm_facts'],
    reversibility: null,
    autonomyClass: 'memory',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',            // verified (#4 audit half): saveFirmFact emits firm_fact.created on
                                  // genuine insert (firmFacts.js); an idempotent re-assert only merges
                                  // provenance and deliberately does not spam the trail
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']
  },
  {
    // G1c (godmode build-spec PR-10): "stop using" — the inverse of
    // remember_fact. Routes to the ONE dismiss tombstone writer (the same
    // writer the settings governance route uses), which emits
    // `firm_fact.dismissed` in-transaction with the actor threaded. The
    // deterministic fact id is the natural key; a replay on an
    // already-inactive fact reports skipped (never a forced flip), behind
    // the spine's applied-status replay gate.
    verb: 'forget_fact',
    surfaces: ['feed_chat'],
    writer: 'dismissFirmFact',
    mutates: ['firm_facts'],
    reversibility: null,          // memory governance, not posted-accounting state
    autonomyClass: 'memory',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',  // firm_fact-object card via the feed apply hook (G1c)
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']
  },
  {
    // G1c: the inverse of remember_merchant — retire ONE active rule so it
    // stops matching future lines. Routes to the EXISTING rule-status
    // writer's explicit active→retired transition (allowActiveRetire — the
    // "later PR" its own comment named; INV-1, no new writer), which emits
    // `client_rule.retired` with the actor in its own transaction and
    // re-verifies the prior status under its lock at write time (INV-4).
    verb: 'retire_rule',
    surfaces: ['feed_chat'],
    writer: 'updateClientRuleStatusInDb',
    mutates: ['client_rules'],
    reversibility: null,          // memory governance, not posted-accounting state
    autonomyClass: 'memory',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',  // client_rule-object card via the feed apply hook (G1c)
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']
  },
  {
    // G1b (godmode build-spec PR-9): close ONE live owner ask. The writer is
    // NEW because `'cancelled'` was a dead enum value — migration 009's CHECK
    // always admitted it and two readers (askIdentity's anchor rule, the
    // convergence projection) already depended on its meaning, but nothing
    // ever wrote it. Refuses an already-ANSWERED ask (the owner did their
    // part; disputing an answer is a different verb) and emits
    // `evidence_request.cancelled` in-transaction with the actor. The apply
    // receipt carries `leaves_line_hanging`: cancelling takes a line OFF the
    // owner without auto-reconciling it, which the two-terminal-states rail
    // says must be surfaced, not glossed as done.
    verb: 'cancel_ask',
    surfaces: ['feed_chat', 'transaction_chat'],
    writer: 'cancelClientEvidenceRequestInDb',
    mutates: ['client_evidence_requests'],
    reversibility: null,          // owner-ask workflow state, not posted-accounting state
    autonomyClass: 'owner_ask',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',  // client_evidence_request-object card (G1b)
    preflightToday: 'shadow_feed',
    // 'reopens' is the precise word and the registry already had it: a cancel
    // REGRESSES the line's prior terminal (it was resting on_owner) without
    // reaching the other one, which is why the apply receipt has to say so.
    convergenceImpact: ['reopens']
  },
  {
    // G1b's §7.2 half (Kari's dated call, 2026-08-14 — the recommended
    // no-silent-edit shape): amend ONE already-SENT owner ask. The writer
    // preserves the original as the head of the composite question and
    // appends the marked amendment (structured history in
    // request_payload.amendments; `evidence_request.amended` audited
    // in-transaction). Only OPEN asks amend: a draft is edited in the asks
    // tab (edit_ask, the pre-send verb, deliberately unbuilt), an answered
    // ask is history. Amending never re-delivers by itself — resend_ask is
    // the outbound verb, one consequence per verb.
    verb: 'amend_ask',
    surfaces: ['feed_chat', 'transaction_chat'],
    writer: 'amendClientEvidenceRequestInDb',
    mutates: ['client_evidence_requests'],
    reversibility: null,          // the original is preserved IN the row; nothing to reverse to
    autonomyClass: 'owner_ask',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    // An amendment neither settles nor reopens the line — the ask stays
    // open on the owner; only its wording changes (toward answerable).
    convergenceImpact: ['workflow_only']
  },
  {
    // G1b: re-deliver ONE already-open owner ask. NO new writer (INV-1) —
    // routes to deliverEvidenceAsksOnAllChannels, the SAME one ask fan-out
    // ask_client uses, which is also what makes minting a duplicate ask on one
    // anchor structurally impossible (the KUILI rule). The fan-out never wrote
    // audit_events, so the orchestrator adds the operator-attributed
    // `evidence_request.resent`. send_count is bumped by the deliverers ONLY on
    // a genuinely successful send, so its delta is a real execution verifier:
    // no delta ⇒ nothing left ⇒ the action stays proposed.
    verb: 'resend_ask',
    surfaces: ['feed_chat', 'transaction_chat'],
    writer: 'deliverEvidenceAsksOnAllChannels',
    mutates: ['client_evidence_requests'],  // send_count / last_sent_at via the 108 bump rail
    reversibility: null,          // an outbound message cannot be unsent
    autonomyClass: 'owner_ask',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']   // the line was already on the owner and stays there
  },
  {
    verb: 'retry_parse',
    surfaces: ['feed_chat', 'transaction_chat'],
    writer: 'retryParseRunsInDb',
    mutates: ['documents'],       // parse_status re-queue
    reversibility: null,          // remedial, not posted-accounting state
    autonomyClass: 'remedial',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'shadow_feed',
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']
  },
  {
    // The OWNER's one verb (client-portal chat, Slice 2): a confirm-gated
    // chat answer to an open evidence request, routed onto the SAME
    // resolve → recode writer an upload reply uses (one terminal, third
    // door — two-terminal-states applied to the owner surface).
    verb: 'answer_evidence_request',
    surfaces: ['client_chat'],
    writer: 'resolveClientEvidenceRequestInDb',
    mutates: ['client_evidence_requests', 'transaction_review_queue', 'transactions'],
    reversibility: 'recode_before_posting',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'none',
    preflightToday: 'none',
    convergenceImpact: ['auto_reconciled']
  },

  {
    // Owner-stated mileage from Telegram/client chat. The grammar routes to one
    // named writer, which posts only after deterministic distance/purpose/rate,
    // materiality, chart-account resolution, balanced-entry, period-lock, audit, and receipt checks pass.
    verb: 'record_mileage',
    surfaces: ['client_chat'],
    writer: 'recordOwnerMileageExpenseInDb',
    mutates: ['ledger_journals', 'ledger_lines', 'ledger_accounts', 'audit_events', 'apply_receipts'],
    reversibility: 'reversible_via_adjustment',
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',
    emitsApplyReceipt: 'live',
    preflightToday: 'live',
    convergenceImpact: ['auto_reconciled', 'on_owner']
  },
  {
    // I4·posting P5 — the inventory ledger writer. NOT a chat/drawer verb: like reverse_apply
    // it is a privileged EXECUTOR operation (loop/valuation-driven — postingDb.js), inventoried
    // here so INV-1's writer allowlist governs it and its coverage is honest, not silent. It
    // routes every ledger write through the ONE gateway (ledgerPostingGateway → the shared
    // __writeLedgerJournalRows insert) — never a second accounting backend. Capability: founder-
    // only (operatorCapability.FOUNDER_ONLY_ACTIONS), same posture as reverse_apply. Fully
    // covered from birth (real actor, real audit, real receipt, real preflight) — the flag stays
    // dark until P5–P7 land together, but the code path emits all four as preconditions.
    verb: 'post_inventory_journal',
    surfaces: ['inventory_executor'],
    writer: 'postInventoryJournalFromDb',
    mutates: [
      'ledger_journals', 'ledger_lines', 'inventory_posting_attempts', 'inventory_posting_journals',
      'inventory_journal_allocations', 'apply_receipts', 'audit_events'
    ],
    reversibility: 'reversible_via_adjustment', // §5-G: exact persisted-journal reversal into an open period
    autonomyClass: 'accounting',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',            // inventory.journal_posted, audit-as-precondition in the post txn
    emitsApplyReceipt: 'live',    // canonical ApplyReceipt via proposalStore.persistApplyReceipt
    preflightToday: 'live',       // runDeterministicPreflight gates the real post (journal_balances / period_not_locked)
    convergenceImpact: ['auto_reconciled', 'on_owner'] // POSTED (accounted-and-controlled) or routed to a §12 waiter
  },
  {
    // Team-screen recede (Kari, 2026-08-14): the owner's standing-authority
    // acts moved into chat. Routes to the S2 roleEmployment writer, which
    // re-verifies owner actor / active hire / shape offered / authority ⊆
    // leash / time bound in its own transaction (INV-S10). Founder-only on
    // the capability ladder, and the writer refuses any non-owner actor.
    verb: 'approve_role_grant',
    surfaces: ['feed_chat'],
    writer: 'approveRoleGrant',
    mutates: ['action_authority_grants', 'audit_events'],
    reversibility: 'reversible_via_adjustment', // revokeRoleGrant is the exact inverse
    autonomyClass: 'authority',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',            // role.grant_approved, in the writer's own transaction
    emitsApplyReceipt: 'shadow_feed', // the feed apply's shadow hook mirrors every applied command
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']
  },
  {
    verb: 'revoke_role_grant',
    surfaces: ['feed_chat'],
    writer: 'revokeRoleGrant',
    mutates: ['action_authority_grants', 'audit_events'],
    reversibility: 'reversible_via_adjustment', // re-approve restores; revoke itself is the conservative direction
    autonomyClass: 'authority',
    requiresActor: true,
    actorStatus: 'threaded',
    emitsAudit: 'yes',            // role.grant_revoked, in the writer's own transaction
    emitsApplyReceipt: 'shadow_feed', // same shadow mirror as every feed-applied command
    preflightToday: 'shadow_feed',
    convergenceImpact: ['workflow_only']
  }
]);

// The set of existing named writers a registered verb may route to (INV-1). A verb
// whose writer is not in this allowlist is a bug — it would mean a new accounting
// backend snuck in. Verified present in server/donna/firmDb.js this session.
export const KNOWN_WRITERS = Object.freeze([
  'updateTransactionReviewItemInDb',
  'postLedgerTransactionInDb',
  'createManualReconciliationMatchInDb',
  'updateReconciliationMatchInDb',
  'recordDocumentCorrectionInDb',
  'setTransactionAiEvidenceRequiredInDb',
  'createClientEvidenceRequestInDb',
  'updateDocumentInDb',
  'saveMerchantRuleForPayload',
  'saveFirmFact',
  // G1c: the dismiss tombstone (firmFacts.js) and the rule-status writer
  // (firmDb.js) — both pre-existing writers, newly ROUTED from chat.
  'dismissFirmFact',
  'updateClientRuleStatusInDb',
  'retryParseRunsInDb',
  'resolveClientEvidenceRequestInDb',
  // G1b: the ask-lifecycle pair (firmDb.js). cancelClientEvidenceRequestInDb is
  // NEW — 'cancelled' was a dead enum value nothing ever wrote (plan §5 G1b
  // audit) — and sits beside the resolve/accept/reject writers it mirrors.
  // deliverEvidenceAsksOnAllChannels is the PRE-EXISTING one ask fan-out,
  // newly routed from chat for resend_ask; routing resend to the deliverer
  // rather than the ask CREATOR is what makes a duplicate ask on one anchor
  // structurally impossible (the KUILI rule).
  'cancelClientEvidenceRequestInDb',
  'amendClientEvidenceRequestInDb',
  'deliverEvidenceAsksOnAllChannels',
  'recordOwnerMileageExpenseInDb',
  // I4·posting P5 — the inventory executor's begins→commits entry point. Routes through the
  // ONE ledger gateway (INV-1), never a second backend; lives in server/donna/inventory/postingDb.js.
  'postInventoryJournalFromDb',
  // Team-screen recede: the S2 employment-contract writers (roles/roleEmployment.js),
  // pre-existing since S2 (the roster routes ran them first), newly ROUTED from chat.
  'approveRoleGrant',
  'revokeRoleGrant'
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

export const registryVerbs = () => ACCOUNTING_MUTATION_REGISTRY.map((e) => e.verb);

export const findMutationEntry = (verb) =>
  ACCOUNTING_MUTATION_REGISTRY.find((e) => e.verb === verb) || null;

// Verbs that mutate ACCOUNTING state (the strict-review population) — the ones that
// must never run autonomously and must always carry an actor + a consequence diff.
export const accountingMutationVerbs = () =>
  ACCOUNTING_MUTATION_REGISTRY.filter((e) => e.autonomyClass === 'accounting').map((e) => e.verb);

// The honest gap list — verbs whose actor/audit/receipt coverage is not yet complete.
// Drives the hardening arc's definition-of-done; shrinks to empty as slices land.
export const mutationCoverageGaps = () =>
  ACCOUNTING_MUTATION_REGISTRY.filter(
    (e) =>
      e.actorStatus !== 'threaded' ||
      e.emitsAudit !== 'yes' ||
      e.emitsApplyReceipt === 'none'
  ).map((e) => ({
    verb: e.verb,
    actorStatus: e.actorStatus,
    emitsAudit: e.emitsAudit,
    emitsApplyReceipt: e.emitsApplyReceipt
  }));

export { REVERSIBILITY_CLASSES };
