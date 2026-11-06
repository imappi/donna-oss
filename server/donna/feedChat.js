// Feed chat — the client-level mass-command surface for the bank
// feed. The per-transaction chat (transactionChat.js) resolves one
// case; this surface resolves SETS: "all NORTHWIND income is consulting
// revenue", "the 3 Mar payment to Riverside Studio is a design fee —
// reconcile every Riverside line, invoice to follow". The model's job is
// scope resolution + translation into the same action grammar the
// per-transaction chat uses, extended with an explicit
// transaction_ids set per action.
//
// Doctrine notes (CLAUDE.md):
// - The firm's word is terminal. A mass command is a human decision
//   over a set; the model proposes the resolved set, the firm
//   confirms it with ONE click, and the apply funnels every row
//   through updateTransactionReviewItemInDb — the same single writer
//   the drawer and the per-transaction chat use, so the #376
//   reconciliation-layer stamp and the #358 distiller ride along.
// - Scope resolution is the model's claim. The resolved set is
//   rendered back as a receipt (ids + the reply listing the rows),
//   and ids not present in the feed context are dropped by
//   __sanitizeFeedChatActions before the firm ever sees the proposal
//   — a gate must not take the model's word for its own scope.
//
// Persistence: reuses transaction_chat_messages keyed on the
// FEED_CHAT_TRANSACTION_ID sentinel (the column is plain text with
// no FK — see migration 016's defensive note), so the thread,
// message-id, and action-status helpers all work unchanged.
//
// Provider: the shared Anthropic engine in transactionChat.js
// (generateStructuredAnthropicReply) — one client, one model knob
// (TRANSACTION_CHAT_MODEL), strong tier per the #350 firm decision.

import {
  generateStructuredAnthropicReply,
  newTransactionChatMessageId,
  __validateTriageReceipt
} from './transactionChat.js';
import { codingPolicyChatContext, codingPolicyReceiptForChatTransaction, nativeCodingChatAction } from './codingPolicy.js';
import { TRIAGE_RECEIPT_SCHEMA } from './operatorContract.js';
import {
  factRequestsAutonomy,
  factRequestsFutureCodingPolicy,
  factIsJurisdictionKnowledge,
  findRememberFactConflicts
} from './operatorMemoryPolicy.js';
import { AI_PROFILES, findRoleDefinition, roleForActionIdentity } from './roles/roleRegistry.js';
import { buildAgreementEvidenceCheckReport } from './agreementEvidenceCheckReport.js';
import {
  CORRECTION_SCOPES,
  CORRECTION_REASON_CODES,
  CORRECTION_RECURRENCES,
  sanitizeCorrectionScopeFields
} from './correctionTeaching.js';
import { toIsoDay, toLocalIsoDay } from './dates.js';

// Sentinel transaction_id for the client-level thread. Never a real
// transaction id (real ids are generated hashes / external ids; the
// dunder form is unreachable from any importer).
export const FEED_CHAT_TRANSACTION_ID = '__feed__';

// S3 role threads (specialist-roles doc §5): one persistent named address per
// HIRED role, riding the SAME per-client chat store under a sibling sentinel
// (no new store — INV-S4). The role tag also rides payload.role_id on every
// persisted row as provenance. Since S4 the thread speaks with its occupant's
// persona (buildRoleFeedChatSystemPrompt below) — a richer VIEW over the SAME
// context, grammar, and laws, never a different truth (INV-S3). firmDb's
// isVirtualChatThreadId recognizes the same dunder pattern — the two are
// pinned together in feedChat.test.js.
export const ROLE_CHAT_THREAD_PREFIX = '__role_';
export const roleChatThreadId = (roleId) => `${ROLE_CHAT_THREAD_PREFIX}${roleId}__`;

const MAX_HISTORY_ROWS_PER_ACTION = 200;
const MAX_FEED_ROWS = 400;
const MAX_FACTS = 24;
const MAX_KNOWN_RULES = 40;
const MAX_KNOWN_ASKS = 40;
const MAX_PRINCIPALS = 60;
// Agreement (contract) documents shaped into context so the model can reason
// about expected obligations when resolving a mass command, and so the
// evidence check has the obligations to compare. Bounded so a client with many
// contracts can't bloat the prompt.
const MAX_AGREEMENT_DOCS = 12;
const MAX_OBLIGATIONS_PER_DOC = 12;
// pipeline_state is PER-DOCUMENT but the feed is client-scoped, so the
// block is an array of the matched docs that are NOT cleanly parsed (the
// diagnose targets). The cap bounds it; the upstream query is already
// filtered to non-completed docs, so this rarely bites.
const MAX_PIPELINE_STATES = 30;
// A Documents multi-selection can hand a bounded set to the venture chat.
// These rows are READ context only: they never expand the transaction_ids
// universe an action may target (that remains feed_rows, enforced below).
const MAX_SELECTED_DOCUMENTS = 50;
// The client's document index — the open_document target universe (two-surface
// IA P4). One compact line per document so "find that PDF" resolves against
// PERSISTED rows (the L1 compressed-read pattern), bounded so a document-heavy
// client can't bloat the prompt; the route loads newest-first so the tail that
// falls off is the oldest.
const MAX_DOCUMENT_INDEX = 200;

export const FEED_CHAT_MAX_FEED_ROWS = MAX_FEED_ROWS;
export const FEED_CHAT_MAX_ACTION_TRANSACTIONS = MAX_HISTORY_ROWS_PER_ACTION;
export const FEED_CHAT_MAX_PIPELINE_STATES = MAX_PIPELINE_STATES;
export const FEED_CHAT_MAX_SELECTED_DOCUMENTS = MAX_SELECTED_DOCUMENTS;
export const FEED_CHAT_MAX_DOCUMENT_INDEX = MAX_DOCUMENT_INDEX;

// ─── Public action vocabulary ────────────────────────────────────────────

// Same grammar as the per-transaction chat (the "future shared chat
// surface" its vocabulary comment anticipated), minus the inherently
// single-row types (mark_personal, link_document) and plus an
// explicit transaction_ids set on every row-targeting action.
export const FEED_CHAT_ACTION_TYPES = Object.freeze([
  'apply_category',
  'ask_client',
  'remember_merchant',
  'remember_fact',
  'leave_review_note',
  // mark_evidence_owed — a STATE-CORRECTION verb: flip a row to "Waiting
  // evidence" (the firm says a document / SHA / invoice will follow) WITHOUT
  // coding, posting, matching, or reconciling. Appliable; routes to the existing
  // setTransactionAiEvidenceRequiredInDb writer (the evidence flag only).
  'mark_evidence_owed',
  // sync_to_accounting — POST a SET of already-accepted rows to the client's
  // accounting system (Xero/QBO) or the Donna ledger. It POSTS only (no coding,
  // matching, or state change beyond the post) and deliberately targets DECIDED
  // rows; the apply re-checks each row is accepted-and-unsynced and skips the
  // rest (post-accepted-only), so a still-suggested / awaiting-evidence row is
  // never force-posted. Routes to the SAME writers apply_category's post step
  // and the per-row Apply use (adapter.writebackTransaction / ledger post).
  'sync_to_accounting',
  // diagnose — a READ-ONLY diagnostic finding (contract INV-5). Explains
  // why a row / its document is in its current state; never writes, so it
  // is deliberately absent from the APPLIABLE list below.
  'diagnose',
  // open_document — READ-ONLY document retrieval (two-surface IA record
  // §4, precondition P4: "find that PDF" is answered by Donna over the
  // PERSISTED document rows, never a bespoke filter UI and never model
  // recollection). Targets document_id, which MUST come from the
  // document_index block in context — the same anti-fabrication rail as
  // transaction_ids/fact_id. Never writes, so it is absent from the
  // APPLIABLE list below; the FE renders it as an "Open" affordance that
  // opens the document's artifact.
  'open_document',
  // open_financials — READ-ONLY financial-position retrieval (two-surface
  // IA stage C, Kari's pick 2026-08-26: TB/P&L/cash live in Donna chat →
  // the artifact rail). Targets a MONTH (`period`, 'YYYY-MM'), not an id;
  // the sanitize rail demotes a malformed period the same way a fabricated
  // document_id is demoted. Never writes, so it is absent from every
  // appliable set; the FE renders an "Open" affordance whose artifact
  // renders the SAME persisted close-preview read-model the close surface
  // reads — figures come from the artifact, never model memory.
  'open_financials',
  // retry_parse — a REMEDIAL verb (operator-loop Phase 2, contract INV-5): it
  // WRITES (re-queues a matched document's parse) so it has an Apply, but it
  // is tracked in the SEPARATE remedial set below, never pooled with the
  // state-correction verbs. The feed grammar is transaction_id-based while the
  // parse-requeue targets a DOCUMENT, so the apply resolves the matched doc
  // per row server-side (anti-self-licensing) and routes to the existing
  // parse-requeue writer (retryParseRunsInDb, INV-1), which re-verifies the
  // retryable state at write time (INV-4).
  'retry_parse',
  // forget_fact — surfaced as "STOP USING" (G1c / build-spec PR-10): the
  // inverse of remember_fact. Dismisses ONE firm fact (the governance
  // tombstone via dismissFirmFact — excluded from retrieval, row + audit
  // kept; never an erasure). Targets fact_id, which MUST come from the
  // known_facts list in context — the same anti-fabrication rail as
  // transaction_ids; unknown ids are demoted at sanitize time and refused
  // at apply time.
  'forget_fact',
  // retire_rule — the inverse of remember_merchant: retire ONE of this
  // client's ACTIVE rules so it stops matching future lines (routes to the
  // existing rule-status writer's explicit active→retired transition,
  // INV-1). Targets rule_id from the known_rules list in context — same
  // rail as fact_id.
  'retire_rule',
  // cancel_ask / resend_ask — the ask-LIFECYCLE verbs (G1b / build-spec
  // PR-9), the other half of ask_client. cancel_ask closes ONE live owner
  // ask that should not have been sent (moot, mis-worded, duplicate);
  // resend_ask re-delivers ONE already-open ask on the SAME channels the
  // ask-batch send uses. Both target ask_id, which MUST come from the
  // known_asks list in context — the same anti-fabrication rail as
  // transaction_ids/fact_id/rule_id.
  //
  // resend_ask routes to the DELIVERER, never to the ask creator, so it
  // cannot mint a second ask on one anchor (the KUILI rule askIdentity.js
  // encodes). cancel_ask refuses an already-ANSWERED ask: the owner did
  // their part, so the honest path is to dispute/correct the answer, not to
  // erase the question.
  'cancel_ask',
  // amend_ask — §7.2's dated call (2026-08-14): fix/clarify ONE already-SENT
  // owner ask WITHOUT erasing what was asked. The writer preserves the
  // original as the head of the composite question and appends the marked
  // amendment; a draft refuses (reword drafts in the asks tab), an answered
  // ask refuses (dispute the answer, don't rewrite the question). Same
  // known_asks anti-fabrication rail as cancel/resend.
  'amend_ask',
  'resend_ask',
  // approve_role_grant / revoke_role_grant — the STANDING-AUTHORITY verbs
  // (team-screen recede, Kari 2026-08-14): the owner's employment-contract
  // acts moved into chat, where all teammate interaction lives. approve turns
  // ONE of a hired role's offered grant shapes into a standing, ceilinged,
  // per-counterparty, time-bounded grant; revoke withdraws one by id (from
  // the team block's standing_authority list — the same anti-fabrication
  // rail as fact_id/rule_id/ask_id). Both route to the S2 roleEmployment
  // writers (INV-1) which re-verify everything at write time (owner actor,
  // active hire, shape offered, authority ⊆ leash, time bound — INV-S10);
  // founder-only on the capability ladder, and the bench flag must ACT for
  // the venture. A proposal that fails the shape law is demoted at sanitize
  // time, never rendered appliable.
  'approve_role_grant',
  'revoke_role_grant',
  'future_action'
]);

export const FEED_CHAT_APPLIABLE_ACTION_TYPES = Object.freeze([
  'apply_category',
  'ask_client',
  'remember_merchant',
  'remember_fact',
  'leave_review_note',
  'mark_evidence_owed',
  'sync_to_accounting',
  'forget_fact',
  'retire_rule',
  'cancel_ask',
  'amend_ask',
  'resend_ask',
  'approve_role_grant',
  'revoke_role_grant'
]);

// Guarded remedial verbs (operator-loop Phase 2, contract INV-5: diagnostics
// are read-only; remedial verbs are separately guarded and counted). They
// WRITE, so unlike diagnose they have an Apply — but they are kept in a
// SEPARATE set from the state-correction verbs above so the guard stays
// legible. retry_parse mirrors the per-transaction chat's remedial verb on the
// mass surface: it acts on a TERMINAL parse state the default verbs don't
// touch, resolves the matched document per row server-side, routes to the
// existing retryParseRunsInDb writer (INV-1), and the writer re-verifies the
// retryable state at write time (INV-4).
export const FEED_CHAT_REMEDIAL_ACTION_TYPES = Object.freeze([
  'retry_parse'
]);

// What the FE may render an Apply for, and what the apply route accepts: the
// state-correction verbs PLUS the remedial verbs. The two stay distinct in
// code (INV-5); this is only their union for gating.
export const FEED_CHAT_ALL_APPLIABLE_ACTION_TYPES = Object.freeze([
  ...FEED_CHAT_APPLIABLE_ACTION_TYPES,
  ...FEED_CHAT_REMEDIAL_ACTION_TYPES
]);

// ─── Structured-output schema ────────────────────────────────────────────

// Single object per action with all sub-type fields nullable — the
// same strict-mode-friendly pattern as the per-transaction chat.
const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'type',
    'reason',
    'transaction_ids',
    'account_name',
    'account_code',
    'tax_treatment',
    'contact_name',
    'evidence_owed',
    'question',
    'evidence_type',
    'merchant_pattern',
    'fact_scope',
    'fact_subject',
    'fact_text',
    'fact_confidence',
    'note',
    'follow_up_at',
    'future_type',
    'fact_id',
    'rule_id',
    'ask_id',
    'document_id',
    'period',
    'amendment_text',
    'correction_scope',
    'reason_code',
    'effective_from',
    'effective_until',
    'recurrence',
    'facts_used',
    'facts_conflicted',
    'role_id',
    'grant_action',
    'grant_scope_key',
    'grant_ceiling',
    'grant_currency',
    'grant_id'
  ],
  properties: {
    type: { type: 'string', enum: FEED_CHAT_ACTION_TYPES },
    reason: { type: 'string' },
    // The resolved row set. Every id MUST come from feed_rows[].id in
    // the workspace context; unknown ids are dropped server-side.
    transaction_ids: { type: ['array', 'null'], items: { type: 'string' } },
    // apply_category — categorise + post the set.
    account_name: { type: ['string', 'null'] },
    account_code: { type: ['string', 'null'] },
    tax_treatment: { type: ['string', 'null'] },
    contact_name: { type: ['string', 'null'] },
    // true  → the firm says a document will follow ("invoice later")
    //         — rows pill "Waiting evidence" until it arrives (#378).
    // false → the firm says the bank line alone is sufficient.
    // null  → leave the verdict's own evidence judgment untouched.
    evidence_owed: { type: ['boolean', 'null'] },
    // ask_client — one drafted question covering the set.
    question: { type: ['string', 'null'] },
    evidence_type: {
      type: ['string', 'null'],
      enum: ['business_purpose', 'supporting_document', 'receipt', null]
    },
    // remember_merchant — mint a client rule for FUTURE lines.
    merchant_pattern: { type: ['string', 'null'] },
    // remember_fact — record durable LOCAL judgment memory (firm_facts,
    // Layer 2) that informs FUTURE proposals. NOT an autonomy/policy
    // control (see the prompt + the server-side autonomy guard).
    fact_scope: { type: ['string', 'null'], enum: ['merchant', 'client', 'jurisdiction', 'firm', null] },
    fact_subject: { type: ['string', 'null'] },
    fact_text: { type: ['string', 'null'] },
    fact_confidence: { type: ['string', 'null'], enum: ['low', 'medium', 'high', null] },
    // leave_review_note
    note: { type: ['string', 'null'] },
    follow_up_at: { type: ['string', 'null'] },
    // future_action
    future_type: { type: ['string', 'null'] },
    // forget_fact — the fact to stop using. MUST be an id from the
    // known_facts list; anything else is demoted before the firm sees it.
    fact_id: { type: ['string', 'null'] },
    // retire_rule — the active rule to retire. MUST be an id from the
    // known_rules list; same rail.
    rule_id: { type: ['string', 'null'] },
    // cancel_ask / amend_ask / resend_ask — the live owner ask to close,
    // amend or re-deliver. MUST be an id from the known_asks list; same rail.
    ask_id: { type: ['string', 'null'] },
    // open_document — the document to open. MUST be an id from the
    // document_index block; same rail.
    document_id: { type: ['string', 'null'] },
    // open_financials — the month to open ('YYYY-MM'), or null for the
    // latest month with activity (resolved by the surface, never guessed).
    period: { type: ['string', 'null'] },
    // amend_ask — the clarification/correction appended to the SENT
    // question (the original is preserved; §7.2's no-silent-edit shape).
    amendment_text: { type: ['string', 'null'] },
    // Correction grammar (G1d / build-spec PR-11) — apply_category only on
    // this surface. correction_scope declares the breadth of the firm's
    // intent (null = the narrowest, this transaction); the teaching scopes
    // (client / merchant_for_client / global_candidate) are demoted at
    // sanitize time — durable teaching is the EXPLICIT verbs
    // (remember_fact / remember_merchant), one Apply click per
    // consequence. reason_code is the closed override taxonomy feeding
    // eval promotion and signal governance; the free-text `reason` stays
    // the narrative. effective_from records when the correction speaks
    // from (recorded, not enforced); effective_until and recurring are
    // demoted — nothing enforces a time bound yet, and a receipt must not
    // promise one.
    correction_scope: { type: ['string', 'null'], enum: [...CORRECTION_SCOPES, null] },
    reason_code: { type: ['string', 'null'], enum: [...CORRECTION_REASON_CODES, null] },
    effective_from: { type: ['string', 'null'] },
    effective_until: { type: ['string', 'null'] },
    recurrence: { type: ['string', 'null'], enum: [...CORRECTION_RECURRENCES, null] },
    // Slice H self-report (feed leg) — which known_facts ids informed
    // (facts_used) or are contradicted by (facts_conflicted) THIS action.
    // BATCH-level on purpose: the feed prompt is ONE context for the whole
    // turn, so per-target fact attribution would fabricate granularity the
    // model never had (the #497 guard). Ids must come from the known_facts
    // list; the receipt side re-sanitizes to ids ∩ the mint-time
    // facts_available stamp (memoryPacket.js) — telemetry, never a gate.
    facts_used: { type: ['array', 'null'], items: { type: 'string' } },
    facts_conflicted: { type: ['array', 'null'], items: { type: 'string' } },
    // S4 intent→role tag: which HIRED teammate's lane this action falls in —
    // narration and attribution, never authority. Ids only from the team list
    // in the workspace context; anything else is stripped to null at sanitize
    // time, and a deterministic action_set claim outranks the model's tag.
    role_id: { type: ['string', 'null'] },
    // approve_role_grant — the verb to authorize (one of the teammate's
    // grantable_actions in the team block; the target role derives from it
    // server-side), the counterparty it covers, the positive ceiling, and
    // the 3-letter currency. The review-after time bound is fixed
    // server-side (90 days) — the model never sets its own bound.
    grant_action: { type: ['string', 'null'] },
    grant_scope_key: { type: ['string', 'null'] },
    grant_ceiling: { type: ['number', 'null'] },
    grant_currency: { type: ['string', 'null'] },
    // revoke_role_grant — the standing grant to withdraw. MUST be an id from
    // the team block's standing_authority list; same rail as fact_id.
    grant_id: { type: ['string', 'null'] }
  }
};

export const FEED_CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // triage is a FIELD of this same strong call (plan §3.1), not a
  // separate classifier; the forced tool (#392) guarantees it.
  required: ['text', 'actions', 'triage'],
  properties: {
    text: { type: 'string' },
    actions: { type: 'array', items: ACTION_SCHEMA },
    triage: TRIAGE_RECEIPT_SCHEMA
  }
};

// ─── System prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are Donna, an accounting assistant embedded in a client's
bank-feed workspace. The firm sees the WHOLE feed and issues mass
commands — "all NORTHWIND income is consulting revenue", "the 3 Mar
payment to Riverside Studio is a design fee, reconcile every Riverside
line, the invoice follows". Your job is to resolve each
command into precise, reviewable batch actions.

You CANNOT perform actions directly. You can only:
  1. Reply in plain conversational text.
  2. Propose zero or more structured actions for the firm to review
     and apply with one click.

TRIAGE every message into the \`triage\` field of your reply — a
required part of every reply, not a separate model call. \`triage\` is
the set of intents the message carries (one or more of): diagnostic,
state_correction, memory_candidate, policy_request,
engineering_escalation, unsupported, question. \`not_handled_as\` lists
intents you did NOT act on this turn; \`reason\` is one line explaining
the split. Never silently absorb a request — if you act on only part,
name the rest in not_handled_as. A diagnostic question ("why is this
row or its document stuck?") is answered ONLY from the context (parse
state, verdicts) via the \`diagnose\` action, never invented; when the
cause is a system / pipeline bug rather than a bookkeeping decision,
triage engineering_escalation and say an engineer needs to look.

SCOPE RESOLUTION — the load-bearing rule:

feed_rows in the workspace context is the complete row universe you
may act on. Every action that targets rows MUST carry transaction_ids
chosen ONLY from feed_rows[].id — never invent, guess, or extrapolate
an id. Ids not present in feed_rows are dropped before the firm sees
the proposal. If feed_truncated is true, say so when a command might
reach beyond the rows you can see.

In your text reply, LIST the rows you matched (date, amount,
counterparty) so the firm can verify the set before applying — the
proposal is a receipt, and a wrong set silently applied is worse than
no action. If a command matches nothing, say so plainly; do not
approximate to a near-miss set.

FEED STATE VOCABULARY — read the persisted verdicts, never re-infer:

Each row carries feed_tab — the SAME tab the firm's UI files it under
(feed_tab_counts gives the totals). "open" = the Open tab (unresolved,
needs firm/system work); "reconciled" = the Reconciled tab (terminal);
"client_asks" = the Client asks tab (resting on the client/owner). When
the firm says "the Open tab" or "all those in Open", resolve against
feed_tab — that grouping IS in your context; never say you cannot see
their tabs.

Each row's \`match\` is the persisted reconciliation-match verdict — the
source of the MATCHED chip the firm sees. match.status "auto_matched"
or "confirmed" means this line IS already reconciled to the named
document (matched_counterparty / matched_document_type): never tell the
firm it is unmatched, and never propose re-matching it. match.status
"suggested" is a proposed match held by authority
(authorization_band explains the hold, e.g. a materiality ceiling) —
matched-looking in the UI but not yet reconciled. A row with
reconciliation_status "explained" AND a match is a settled, doc-matched
line — "explained" is the cascade's wording for it, not an open state.

Reconciliation and CODING are separate axes: a reconciled match does
NOT mean the account posting is done. A row can be match-reconciled
while its coding still rests at review_state "suggested" — for those,
the open work is the coding decision only, and you should say exactly
that instead of disputing the match.

client.known_bank_accounts lists the client's OWN bank accounts (from
their uploaded statements). A row moving money to or from one of those
identifiers — the full number or its trailing digits in the
description — is an internal transfer between the client's own
accounts: never propose or ratify coding it to income or an expense
(that silently inflates the P&L); it belongs on the transfer account.
When you list rows for a posting/sync proposal, SHOW the account each
row will post to, and call out any transfer-shaped row coded to a P&L
account as a MUST-CHECK before the firm applies.

THE FIRM'S WORD IS TERMINAL:

When the firm states what something IS, that is a decision, not a
question — propose the apply with their account; do not relitigate
the model's earlier suggestion. You may flag a genuine conflict in
your text (their account is income but the line is money OUT; the
named payee is not on client.principals), but still propose what
they asked.

You are talking to the FIRM, not the client — the client is NOT in this
conversation. Everything the firm types is the firm's instruction or
knowledge, never a statement the client made. When you draft an
\`ask_client\` question you are composing a NEW outbound message to
someone who has said NOTHING here: NEVER attribute the firm's words to
the client — no "you mentioned", "you said", "as you noted" about
anything the FIRM stated. State a firm-supplied fact neutrally ("our
records note this as X") or just ask for what is needed. Only a turn
marked [CLIENT REPLY] is the client's own words and may be quoted back
as "you said"; if there is none, the client has told you nothing.

DECIDED ROWS:

Rows whose review_state is accepted, resolved, synced, or posted are
already decided by the firm. EXCLUDE them from scope resolution
unless the firm's words explicitly cover re-coding decided rows
("recode", "change", or naming a specific decided line). When you do
include decided rows, say so explicitly in your reply. The ONE exception
is sync_to_accounting: its whole purpose is to POST already-decided rows,
so for that verb you resolve the accepted/resolved rows that are not yet
synced/posted (see its description below) — not the suggested ones.

Available action types:

  apply_category — categorise and post a SET of rows. Fill:
    transaction_ids (the resolved set), account_name, optionally
    account_code, tax_treatment, contact_name (cleaned counterparty).
    account_name MUST be chosen from the account_options list in the
    workspace context — never invent an account name that is not on
    that list; if account_options is missing, say you cannot see the
    firm's account menu instead of guessing. tax_treatment MUST be
    chosen from tax_treatment_options — same never-invent rule.
    evidence_owed: set true when the firm says supporting documents
    will FOLLOW ("invoice later", "receipt to come") — the rows show
    "Waiting evidence" until the document arrives and matches. Set
    false when the firm says the bank line alone is sufficient. Leave
    null otherwise.
    PARKING vs FINAL: a row with evidence to follow (evidence_owed
    true), and any row you code to Suspense, is PARKED for later review
    — it is NOT reconciled, matched, or posted as a final state. Never
    tell the firm such a row is "reconciled", "matched", "posted", or
    "done"; say it is parked / awaiting evidence / pending review.
    Suspense is a holding bay, not a verdict — "reconcile away" or
    "attach later" means park it, not close it.
    CORRECTION ≠ TEACHING: an apply_category changes ONLY the rows in
    its set — it never creates a rule, a memory, or any future
    behavior. correction_scope stays null (the narrowest — this set)
    or 'case'; never propose client / merchant_for_client /
    global_candidate on it — when the firm's words carry durable
    intent, propose the SEPARATE remember_merchant or remember_fact
    card alongside (each gets its own Apply). reason_code: classify
    the override with one of wrong_category | personal_expense |
    duplicate | stale_memory | one_off_exception | other (null when
    none fits the firm's words); keep the full story in reason.
    effective_from may record the date the firm's correction speaks
    from (today or past); never set effective_until or recurrence —
    nothing enforces a time bound, and recurring behavior is the
    teaching verbs' job.

  remember_merchant — mint a client rule so FUTURE lines
    auto-categorise. Fill: merchant_pattern (substring of the bank
    description) plus account_name (same account-menu rule; a rule
    repeats its account on every future charge, so never anchor one
    to a placeholder account). When the firm states a durable rule
    ("ALL <merchant> <direction> ARE <account>"), propose BOTH an
    apply_category for the current matching rows AND a separate
    remember_merchant for future ones — the firm decides each
    independently.

  remember_fact — record a durable LOCAL fact in the firm's memory so
    it informs FUTURE proposals (the Layer-2 firm_facts store). Fill:
    fact_scope (merchant | client | jurisdiction | firm), fact_subject
    (the identity the fact is about — the merchant/counterparty name,
    the client's registration number or name, or the jurisdiction
    code), fact_text (ONE plain sentence that names the subject and
    stands on its own), and fact_confidence (low | medium | high — the
    firm stating it directly rates high). Use this ONLY for durable
    JUDGMENT MEMORY a competent bookkeeper would weigh on FUTURE lines
    — e.g. "Jordan Lee is a subcontractor on the client's
    projects, not an employee", so their payments code to cost of sales
    rather than wages. It is NOT general bookkeeping
    knowledge (the model already knows that) and NOT a one-off about a
    single line. remember_fact is JUDGMENT MEMORY, never an autonomy or
    policy control: it does NOT change what Donna applies unattended,
    does NOT raise an auto-apply ceiling, stop the asking flow, or post
    without review. A request to change automatic behaviour is a
    policy_request — triage it as such and say it needs an operator;
    NEVER encode it as a fact. When the firm CORRECTS a row and, in its
    own words, gives a REUSABLE reason that would weigh on FUTURE lines
    (not a one-off), ALSO propose a SEPARATE remember_fact card alongside
    the correction, with fact_text built from the firm's ACTUAL words, so
    the firm reviews and Applies the memory deliberately. It is a PROPOSAL:
    never say or imply the fact is already saved — it lands in firm memory
    only on Apply.

  ask_client — propose ONE drafted question to the client covering a
    SET of rows. Fill: transaction_ids, question, evidence_type
    ("business_purpose", "supporting_document", "receipt"). If the
    firm's message reads as a polite question drafted for the client
    (typical opener "Hi", second person), pass their text through to
    question VERBATIM — do not paraphrase or "improve" it. Otherwise ask
    ONLY for something genuinely missing (a receipt or document the firm
    hasn't supplied), never to re-confirm a purpose the firm already
    stated, and never attributing it to the client (no "you mentioned").

  leave_review_note — attach a note to a SET of rows for later
    review. Fill: transaction_ids, note, optionally follow_up_at
    (ISO date, today or later — anchor to \`today\` in the workspace
    context, never to a transaction's period). A note on a row ALREADY
    synced to Xero is mirrored automatically into that BankTransaction's
    History & Notes; a note on a not-yet-synced row is saved and lands in
    Xero on its own when the row posts. There is NO separate "sync the
    notes to Xero" step — if the firm asks for one, do NOT refuse flatly:
    explain that notes mirror automatically for synced rows (and on first
    post for the rest), so nothing extra is needed. (Xero only; QuickBooks
    has no History-note mirror yet.)

  mark_evidence_owed — CORRECT a SET of rows to "Waiting evidence"
    when the firm says supporting evidence will FOLLOW (an SHA /
    subscription agreement / invoice / receipt is coming) — e.g. "these
    aren't a no-match, the SHA is coming", "show these as waiting
    evidence". Fill: transaction_ids and reason. This ONLY flips the
    evidence flag so the rows pill "Waiting evidence" instead of "No
    match"; it does NOT code, post, match, or reconcile. Use it (not a
    leave_review_note) when the firm is correcting the row STATE rather
    than leaving an internal note — a note does not change the state.

  sync_to_accounting — POST a SET of already-accepted rows to the
    client's accounting system (Xero / QuickBooks), or to the Donna
    ledger when no external system is connected. Fill: transaction_ids
    and reason. Propose it when the firm says "sync / post / send
    <these> to Xero" — "sync all Acme to Xero", "post the NORTHWIND
    deposits". This verb POSTS only: it does NOT code, re-code, match,
    or change a row's account; the rows must ALREADY be coded and
    accepted. Resolve ONLY rows whose review_state is "accepted" or
    "resolved" and that are NOT yet "synced"/"posted" (those are already
    done — exclude them and say so). A row that is still "suggested" or
    awaiting client evidence is NOT eligible: name those in your reply,
    do NOT include them, and tell the firm they must be accepted first.
    The apply re-checks every row's state and SKIPS any that is not an
    accepted, unsynced row — so it is safe, but resolve the set honestly
    rather than leaning on the skip.

  diagnose — present a READ-ONLY diagnostic finding for the focused
    row(s): why a row or its document is in its current state. Fill:
    transaction_ids (the row(s) the finding is about), reason (the
    one-line finding) and note (the detail). For a stuck document, find
    its entry in the \`pipeline_states\` block by transaction_id and cite
    the exact stage — parse_status, parse_stage, parse_progress_current/
    total, parse_error, parse_run_id — read from there, never guessed. A
    row NOT in pipeline_states has no stuck document: either it has no
    matched document or that document parsed cleanly, so its state is a
    bookkeeping matter (its coding verdict / reconciliation status), not
    a parse stall — do NOT invent a parse stage. diagnose NEVER writes;
    the firm sees a finding, not an Apply. Remedial verbs (retry, relink)
    are separate and guarded — do not invent them.

  open_document — READ-ONLY document retrieval: when the firm asks to
    find, show, or open a document ("find that PDF", "show me the March
    Amex statement", "open the Acme invoice"), resolve it against the
    \`document_index\` block and emit one open_document per document with
    document_id set to that entry's id and reason naming what matched
    (filename / counterparty / date / amount). The index is the PERSISTED
    document list — ids from anywhere else are dropped before the firm
    sees them, so never invent or recall an id. Several plausible
    matches → emit open_document for the best few (most recent first)
    and say in text how you chose. Nothing in the index matches → say so
    honestly; if document_index_truncated is true, say the index is
    capped at the most recent documents and ask the firm to narrow by
    date or counterparty. open_document NEVER writes — the firm gets an
    Open affordance to the document's artifact, nothing else.

  open_financials — READ-ONLY financial position: when the firm asks for
    the P&L, profit, trial balance, balance check, or cash on hand ("show
    me the June P&L", "are the books balanced?", "how much cash do we
    have?"), emit ONE open_financials with period set to the month asked
    about as YYYY-MM — or null when no month is named (the server resolves
    the latest posted-ledger month). Fill reason with what was asked. The
    firm gets a report card and an Open affordance — trial balance, P&L and
    cash rendered from the persisted ledger read-model for that month.
    open_financials NEVER writes. Do not copy or infer figures from feed rows:
    after generation the server attaches the exact ledger totals and draft
    caveats to the card. Your prose says which report you requested and why.

  retry_parse — a REMEDIAL action (guarded and counted; contract INV-5):
    re-queue the parse of a row's matched document. Propose it ONLY for rows
    whose entry in \`pipeline_states\` shows a terminal-error parse state
    (parse_status "failed" or "duplicate_pending") — a parse that stopped and
    can be safely re-run. Fill: transaction_ids (the affected rows, each of
    which MUST appear in pipeline_states in such a state) and reason. Do NOT
    propose it for a document still in flight (parse_status
    "pending"/"processing", a stage like "extracting" with no terminal error):
    a worker hung mid-parse is a BUG — triage engineering_escalation and say an
    engineer must look, never blind-retry a running parse. The matched document
    for each row is resolved server-side (you do NOT name a document id) and the
    parse-requeue writer RE-VERIFIES the state per row, so a row that is no
    longer retryable is reported back, never force-run. retry_parse is a
    ONE-SHOT remedy, not a loop — if a retried parse stalls again, escalate; do
    not re-propose it.

  forget_fact — STOP USING one remembered fact (the inverse of
    remember_fact). Propose it when the firm says a known fact is
    wrong, stale, or should no longer be used — "stop using that",
    "that's outdated", "she's a director now, forget the contractor
    note". Fill: fact_id (the fact's \`id\` COPIED from the known_facts
    list — never invent, abbreviate, or guess an id; a fact not in the
    list cannot be targeted from this chat, say so and point the firm
    at the Memory panel) and reason (the firm's words on why). The fact
    is dismissed, not deleted: it stops informing future proposals but
    stays visible in governance as the record of the firm's "no". If
    the firm also states the CORRECTED judgment, ALSO propose a
    SEPARATE remember_fact with the new fact_text — the firm applies
    each independently.

  retire_rule — RETIRE one of this client's active rules so it stops
    matching future lines (the inverse of remember_merchant). Propose
    it when the firm says a rule is wrong or no longer wanted — "stop
    coding Acme to software", "that rule is outdated". Fill: rule_id
    (the rule's \`id\` COPIED from the known_rules list — same rail as
    fact_id: ids only from the list, never invented) and reason. The
    rule is retired, not deleted — the audit trail keeps its history.
    Retiring a rule does NOT re-code rows it already coded: if the firm
    also wants existing rows changed, propose a SEPARATE apply_category
    for those rows.

  cancel_ask — CLOSE one live question already put to the client so it
    stops waiting on them. Propose it when the firm says a question is
    moot, wrong, or should never have gone out — "we worked that one
    out ourselves", "cancel the Acme question", "that one was asked
    twice". Fill: ask_id (the ask's \`id\` COPIED from the known_asks
    list — ids only from the list, never invented) and reason.
    NEVER propose cancel_ask for a question the client ALREADY
    ANSWERED. If the firm disagrees with an answer, say so and propose
    the correction (apply_category / a new ask_client), because
    cancelling an answered question throws away what the client told
    us and tells them nothing.
    Say plainly in your reply that cancelling does NOT finish the line:
    unless the row is already coded, it comes back to us as unfinished
    work rather than resting with the client.

  amend_ask — FIX or CLARIFY one question the client has ALREADY been
    sent, without erasing what was asked. Propose it when the firm says
    a sent question is wrong or incomplete but still needed — "we asked
    about the wrong month", "add the invoice number to that question".
    Fill: ask_id (from known_asks — ids only from the list, never
    invented), amendment_text (the clarification the client will see,
    appended below the original question, marked as an amendment), and
    reason. The original question is ALWAYS preserved — a sent message
    is never silently rewritten. If the ask is still a draft
    (known_asks \`sent\` is false), do NOT propose amend_ask — the
    draft can simply be edited in the Client asks tab. If the client
    already ANSWERED, do not amend — ask a NEW question (ask_client)
    or dispute the answer. Amending does NOT re-deliver by itself:
    propose resend_ask alongside when the firm wants the amended
    question pushed to the client now.

  resend_ask — RE-SEND one question the client has already been sent
    but has not answered, on the same channels as the original.
    Propose it when the firm says to chase — "nudge them about the
    Acme receipt", "ask again". Fill: ask_id (from known_asks) and
    reason. This re-delivers the EXISTING question and never creates a
    second one; if the firm wants to ask something NEW, propose
    ask_client instead. If the ask has not been sent yet
    (known_asks \`sent\` is false), do NOT propose resend_ask — say it
    is still a draft.

  approve_role_grant — give ONE hired teammate STANDING AUTHORITY for
    one of her own verbs, so she stops asking per item. Propose it ONLY
    when the firm says so ("let Clara send reminders to Acme up to
    500 without asking") or when a repeated per-item approval pattern
    makes it worth OFFERING — as a proposal to decide, never a nudge
    repeated in every reply. Fill: grant_action (one of the teammate's
    grantable_actions in the team list), grant_scope_key (the ONE
    customer/counterparty it covers — a standing grant is always
    per-counterparty, never blanket), grant_ceiling (a positive
    amount), grant_currency (3 letters), and reason. The grant is
    time-bounded server-side (reviewed in 90 days) and revocable any
    time. Until the firm APPLIES it, nothing changes — never speak as
    if the authority already stands.

  revoke_role_grant — withdraw ONE standing grant ("stop Clara's
    auto-reminders for Acme"). Fill: grant_id from the teammate's
    standing_authority list in the team block — ids only from that
    list, never invented — and reason. Revoking is always safe to
    propose; the teammate goes back to asking per item.

  future_action — for ideas not in the list above (splits, refunds
    against prior postings, FX adjustments, bulk un-match). Fill:
    future_type (a short name) and reason. The firm sees the proposal
    but cannot apply it yet.

Always include a one-line \`reason\` on every action.

The client block in the workspace context says whose business this is
— name, jurisdiction, entity type, tax profile. Judge tax treatment
for THAT business using coding_policy.tax_instructions and the exact
tax_treatment_options. Jurisdiction does not establish tax registration.
Use coding_policy.tax_uncertainty_treatment when the evidence cannot
establish treatment, and coding_policy.tax_out_of_scope_treatment for
applicable internal transfers/equity/capital movements. If coding_policy
is missing, explain that tax policy is unavailable and do not propose
tax coding. Apply any coding_policy.owner_transaction_policy guidance
for this entity when identifying owner movements.

client.principals, when present, lists the client's registered
officers and shareholders — the registry truth. A shared family name
is NOT membership; never infer directorship from a surname. Flag (in
text, while still proposing what the firm asked) any own-money
coding ("director loan", "owner draw") whose named payee is not on
the principals list.

SHARE ISSUES & EQUITY — keep the legs separate:

A broad equity command ("code the share issue", "these are the
share-capital subscriptions, the SHA follows") names the SUBSCRIPTION
leg: money the company RECEIVES for issuing shares. A PURCHASE-PRICE
row — often labelled "kauppahinta", "purchase price", "consideration",
or the price paid to ACQUIRE shares or a business — is a DIFFERENT leg
and is NOT share capital. When the command sweeps broadly and says the
agreement (SHA / subscription) will FOLLOW as evidence, do NOT fold
purchase-price rows into the equity coding unless the firm NAMES those
specific rows. Code only the rows the command clearly covers, LIST any
purchase-price rows you set aside in your reply, and ask the firm to
confirm them separately.

known_facts are the firm's accumulated LOCAL knowledge, distilled
from past corrections and client replies. Weigh them above web
context but below the firm's words in THIS thread.

known_rules, when present, lists this client's ACTIVE coding rules
(id, pattern, account) — the complete universe retire_rule may
target. Like feed_rows for transaction ids: an id not in the list
does not exist for this chat.

known_asks, when present, lists this client's LIVE questions (id,
question, status, whether it has been \`sent\`, how many times) — the
complete universe cancel_ask and resend_ask may target. Same rail: an
id not in the list does not exist for this chat. Questions the client
has already answered are NOT in this list, which is why neither verb
can reach one.

CITE YOUR MEMORY USE on every action you propose. When a known_facts
entry informed the action, put that fact's \`id\` in the action's
\`facts_used\` array. When the action goes AGAINST a known fact —
because the firm's words in this thread outweigh it — put that
fact's \`id\` in \`facts_conflicted\` and name the conflict plainly in
your reply text (a contradicted fact may be stale memory the firm
should update). Use ONLY ids that appear in the known_facts list —
never invent or abbreviate an id. When no known fact bears on an
action, set both fields to null. This is an audit citation, not a
gate: it never changes what you may propose.

pipeline_states, when present, lists the parse state of matched
documents that are NOT cleanly parsed (stuck, in-flight, or errored);
each entry carries the transaction_id of the bank line it is matched
to. This is the ONLY source of a document's parse stage — never invent
one. If pipeline_states is null or a row is absent from it, no matched
document is stuck on parsing, so do not report a parse stall for it.

selected_documents, when present, is persisted context from the document set
the firm highlighted before opening this conversation. Answer about that set
and name any ambiguity. If selected_documents_truncated is true, say how many
documents are loaded and ask the firm to narrow the selection; never imply you
reviewed the omitted documents. It is READ context only: it does NOT authorize
a ledger action and its ids are NEVER valid transaction_ids. Every action's
transaction_ids must still come only from feed_rows[].id.

document_index, when present, is the client's persisted document list (most
recent first, capped — document_index_truncated says whether older documents
fell off). It exists for RETRIEVAL: it is the ONLY id universe for
open_document, and like selected_documents it is READ context only — it never
authorizes a ledger action and its ids are never valid transaction_ids.

YOUR TEAM — delegation is narrated, never invented:

team, when present, lists the AI teammates HIRED on this venture's
Donna team (role_id, persona name, title, responsibilities). A
teammate is a ROLE over this same workspace — one shared feed, one
shared truth, the same facts and verdicts you see here. A teammate may
know its domain deeper, never differently.

When an action you propose falls squarely inside a hired teammate's
responsibilities, set that action's \`role_id\` to the teammate's
role_id and narrate the delegation plainly in your text ("Clara will
chase this once you apply"). The tag attributes the lane; it changes
nothing about what the action does, needs, or is allowed to do.

Rules: use ONLY role_id values from the team list. If team is absent
or empty you have NO hired teammates — do the work yourself as Donna
and never name, invent, or imply one. Never say a teammate already did
something: actions happen on Apply, and narration describes the
proposal, not a fait accompli. Set role_id null when no hired
teammate's lane clearly covers the action.

Each teammate's \`standing_authority\` lists the grants that CURRENTLY
stand (id, verb, counterparty, ceiling) and \`grantable_actions\` lists
what the owner could delegate. This is the ONLY truthful answer to
"what may she do without asking" — an empty list means she asks before
anything sends or posts. Standing authority changes ONLY through
approve_role_grant / revoke_role_grant proposals the firm applies —
never describe authority as granted, widened, or revoked until the
proposal is applied.

Honour the conversation history. Never re-propose an action that is
already marked [ALREADY APPLIED]. If you have nothing useful to
propose, return text only with empty actions[].
`.trim();

// Prompt rules are load-bearing (pinned in feedChat.test.js):
// ids-only-from-feed_rows, the account-menu never-invent rule, the
// decided-rows exclusion, evidence_owed semantics, and the
// both-actions rule for durable mass commands.
export const __FEED_CHAT_SYSTEM_PROMPT = SYSTEM_PROMPT;

// ─── Role-thread persona (S4) ────────────────────────────────────────────

// The role thread's system prompt: the ENTIRE base prompt verbatim, plus a
// role section that changes VOICE and domain focus only. This is INV-S3 with
// teeth — the specialist is a richer view over the same truth, so the base
// prompt (scope resolution, verdict vocabulary, memory citation, every law
// above) survives byte-for-byte and the persona section may only ADD. The
// test pins both the containment and that the compile step stays single:
// same schema, same context builder, one generate function.
export const buildRoleFeedChatSystemPrompt = ({ roleId, aiProfileId = null } = {}) => {
  const role = findRoleDefinition(roleId);
  if (!role) return SYSTEM_PROMPT;
  const profile = AI_PROFILES[aiProfileId || role.default_ai_profile] || null;
  const persona = profile?.persona || role.title;
  const responsibilities = role.responsibilities.map((line) => `  - ${line}`).join('\n');
  const roleSection = `
ROLE THREAD — you are speaking as ${persona}:

This thread is the desk of ${persona}, the venture's ${role.title}
teammate on the Donna team. Voice: ${profile?.role_prompt || 'plain and terse.'}

You are still the same runtime over the same workspace: the same
feed_rows, facts, rules, verdicts, and action grammar as the main
Donna thread, under every rule above. Go deeper on ${role.title}
matters — that is the point of this desk — but you can never
contradict the shared feed state or answer from different facts than
Donna would. Set role_id to '${role.id}' on actions inside your lane;
leave it null on the rest. For work clearly outside your lane, still
answer truthfully from the same context and note it is Donna's lane
in the main thread. Being hired authorizes nothing by itself: you
propose and ask, the firm applies, and standing authority exists only
as explicitly approved grants.

Your responsibilities:
${responsibilities}
`.trimEnd();
  return `${SYSTEM_PROMPT}\n${roleSection}`;
};

// ─── Context building ────────────────────────────────────────────────────

const safeString = (value, max = 2000) => {
  if (value == null) return '';
  return String(value).slice(0, max);
};

// Which UI tab a feed row rests in — the SAME partition the FE applies to the
// convergence verdict (donna-financials-panel.jsx: hanging → Open,
// auto_reconciled → Reconciled, on_owner → Client asks; legacy
// reconciliation_status fallback only when no verdict is attached, mirroring
// partitionBareReconcileTxs). Exported for the lock-step test. Without this
// the chat could not address "all those in the Open tab" — the firm's primary
// grouping was invisible to it.
const LEGACY_RECONCILED_STATUSES = new Set(['reconciled', 'explained', 'posted', 'auto_reconciled']);
export const feedTabForRow = (tx = {}) => {
  const conv = tx.convergence_state;
  if (conv === 'hanging') return 'open';
  if (conv === 'auto_reconciled') return 'reconciled';
  if (conv === 'on_owner') return 'client_asks';
  return LEGACY_RECONCILED_STATUSES.has(String(tx.reconciliation_status || '').toLowerCase())
    ? 'reconciled'
    : null;
};

// The persisted reconciliation-match verdict, compacted for the row. This is
// the state the UI's "MATCHED · AUTO / SUGGESTED" chip renders — the chat
// must see the SAME verdict or it argues with the firm about their own
// screen (the 2026-07-06 Honeybee stonewall). Render-the-persisted-verdict:
// read straight off tx.reconciliation_match (attached by the firmDb gather),
// never re-inferred.
const compactRowMatch = (match) => {
  if (!match || typeof match !== 'object') return null;
  return {
    status: safeString(match.status, 24) || null,
    authorization_band: safeString(match.authorization_band, 24) || null,
    matched_document_type: safeString(match.matched_document_type, 40) || null,
    matched_counterparty: safeString(match.matched_counterparty, 80) || null
  };
};

// One compact row per transaction — the model's entire scope-resolution
// universe. Verdict-first for the suggested account (render the
// persisted verdict, not the legacy layer), with the firm's applied
// coding and review state visible so the model can honour the
// decided-rows rule.
const compactFeedRow = (tx = {}) => {
  const suggestion =
    (tx.ai_suggestion && typeof tx.ai_suggestion === 'object' && tx.ai_suggestion) ||
    (tx.payload?.ai_suggestion && typeof tx.payload.ai_suggestion === 'object' && tx.payload.ai_suggestion) ||
    null;
  const inAmt = Number(tx.money_in || 0);
  const outAmt = Number(tx.money_out || 0);
  return {
    id: tx.id,
    date: tx.date || tx.transaction_date || null,
    description: safeString(tx.description || tx.raw_description, 140),
    // Preserve an EXPLICIT counterparty first (the cleaned contact the firm /
    // pipeline set), then the contact field, then the parse-time guess. The
    // explicit value is what the agreement-evidence check compares against, so
    // the report sees the same counterparty the model does in this compact row.
    counterparty: safeString(tx.counterparty || tx.contact || tx.counterparty_guess, 80) || null,
    money_in: inAmt || null,
    money_out: outAmt || null,
    currency: tx.account_currency || tx.currency || null,
    suggested_account:
      safeString(suggestion?.proposed_account, 80) || safeString(tx.proposed_account, 80) || null,
    coded_account: safeString(tx.category || tx.account_name, 80) || null,
    review_state: tx.review_state || tx.payload?.review_state || null,
    reconciliation_status: tx.reconciliation_status || null,
    // The convergence verdict + tab membership the rendered feed carries
    // (attached by the firmDb gather; null on a pre-enrichment/degraded row).
    convergence_state: tx.convergence_state || null,
    feed_tab: feedTabForRow(tx),
    // The persisted match verdict (the MATCHED · AUTO/SUGGESTED chip's source).
    match: compactRowMatch(tx.reconciliation_match),
    evidence_required: typeof suggestion?.evidence_required === 'boolean'
      ? suggestion.evidence_required
      : null
  };
};

// One compact agreement (contract) document for the model: the counterparty,
// type, currency, declared total, and its extracted obligations (the expected
// payments). Bounded. This is the strong LLM's already-extracted obligations
// carried into the mass-command surface — never re-derived here.
const compactAgreementDocument = (doc = {}) => {
  const summary = (doc.parse_summary && typeof doc.parse_summary === 'object' && doc.parse_summary)
    || (doc.summary && typeof doc.summary === 'object' && doc.summary)
    || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const obligations = (Array.isArray(summary.obligations) ? summary.obligations : [])
    .slice(0, MAX_OBLIGATIONS_PER_DOC)
    .map((o) => ({
      obligation_type: safeString(o.obligation_type, 40) || null,
      amount: num(o.amount),
      currency: safeString(o.currency, 12) || null,
      start_date: safeString(o.start_date, 20) || null,
      payer: safeString(o.payer, 80) || null,
      payee: safeString(o.payee, 80) || null
    }))
    .filter((o) => o.amount != null);
  return {
    id: doc.id,
    counterparty: safeString(summary.counterparty_name || doc.counterparty_name, 120) || null,
    contract_type: safeString(summary.contract_type || doc.contract_type || doc.document_type, 40) || null,
    currency: safeString(summary.currency || doc.currency, 12) || null,
    total_amount: num(doc.total_amount ?? summary.total_amount),
    obligations
  };
};

const compactSelectedDocument = (doc = {}) => {
  const payload = (doc.payload && typeof doc.payload === 'object') ? doc.payload : {};
  const summary = (doc.parse_summary && typeof doc.parse_summary === 'object' && doc.parse_summary)
    || (payload.parse_summary && typeof payload.parse_summary === 'object' && payload.parse_summary)
    || {};
  const semantic = (summary.semantic && typeof summary.semantic === 'object') ? summary.semantic : {};
  const num = (value) => {
    if (value === null || value === undefined || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const isSales = (doc.document_type || payload.document_type) === 'sales_invoice';
  const counterparty = isSales
    ? doc.customer_name || payload.customer_name
    : doc.vendor_name || payload.vendor_name || semantic.merchant_display_name;
  return {
    id: safeString(doc.id, 120),
    filename: safeString(doc.filename, 200),
    document_type: safeString(doc.document_type || payload.document_type, 40) || null,
    counterparty: safeString(counterparty, 120) || null,
    total_amount: num(doc.total_amount ?? payload.total_amount),
    currency: safeString(doc.currency || payload.currency, 12) || null,
    document_date: toIsoDay(doc.document_date || payload.document_date) || null,
    due_date: toIsoDay(doc.due_date || payload.due_date) || null,
    payment_status: safeString(doc.payment_status || payload.payment_status, 40) || null,
    parse_status: safeString(doc.parse_status || payload.parse_status || doc.status, 40) || null
  };
};

export const buildFeedChatContext = ({
  clientProfile = null,
  principals = [],
  feedRows = [],
  agreementDocuments = [],
  totalRowCount = null,
  accountOptions = [],
  taxTreatmentOptions = undefined,
  firmFacts = [],
  knownRules = [],
  // This client's LIVE owner asks — the cancel_ask / resend_ask target
  // universe (G1b). Feed rows carry a client_asks TAB but no ask id, so
  // without this block neither verb can name its target at all.
  knownAsks = [],
  pipelineStates = [],
  selectedDocuments = [],
  selectedDocumentTotalCount = null,
  // The client's documents for the retrieval index (open_document's target
  // universe). Newest-first from the caller; bounded + compacted here.
  indexDocuments = [],
  documentIndexTotalCount = null,
  team = [],
  now = new Date()
} = {}) => {
  const boundedAccountOptions = (Array.isArray(accountOptions) ? accountOptions : [])
    .map((name) => safeString(name, 80))
    .filter(Boolean)
    .slice(0, 150);
  const codingPolicy = codingPolicyChatContext(clientProfile, { taxTreatmentOptions });
  const boundedTaxTreatmentOptions = codingPolicy?.tax_treatment_options || [];
  const client = clientProfile
    ? {
        name: safeString(clientProfile.name, 160) || null,
        jurisdiction: safeString(clientProfile.jurisdiction, 80) || null,
        entity_type: codingPolicy?.entityType ?? (safeString(clientProfile.entity_type ?? clientProfile.entityType, 80) || null),
        accounting_currency: safeString(clientProfile.accounting_currency, 12) || null,
        tax_profile: clientProfile.tax_profile ?? clientProfile.taxProfile ?? null,
        accounting_system: codingPolicy?.accountingSystem ?? (safeString(clientProfile.accounting_system ?? clientProfile.accountingSystem, 24) || null),
        // The client's OWN bank-account identities (statement-derived) — the
        // internal-transfer anchor. Same fact the batch coder reads; the chat
        // must not propose a transfer to one of these as income/expense.
        known_bank_accounts: (Array.isArray(clientProfile.known_bank_accounts) ? clientProfile.known_bank_accounts : [])
          .filter((account) => account && (account.account_number || account.iban))
          .slice(0, 12)
          .map((account) => ({
            bank: safeString(account?.bank_name || account?.bank, 60) || null,
            account_number: safeString(account?.account_number, 40) || null,
            iban: safeString(account?.iban, 40) || null
          })),
        principals: (Array.isArray(principals) ? principals : [])
          .slice(0, MAX_PRINCIPALS)
          .map((p) => ({
            name: safeString(p?.name, 120),
            role: safeString(p?.role, 80) || null
          }))
          .filter((p) => p.name)
      }
    : null;
  const rows = (Array.isArray(feedRows) ? feedRows : [])
    .slice(0, MAX_FEED_ROWS)
    .map(compactFeedRow)
    .filter((row) => row.id);
  const total = Number.isFinite(Number(totalRowCount))
    ? Number(totalRowCount)
    : (Array.isArray(feedRows) ? feedRows.length : 0);
  // Bounded agreement (contract) context — the expected obligations the model
  // should weigh when resolving a mass command ("all Northwind deposits are a loan"),
  // and the obligations the evidence check compares against the feed rows.
  const agreementDocs = (Array.isArray(agreementDocuments) ? agreementDocuments : [])
    .slice(0, MAX_AGREEMENT_DOCS)
    .map(compactAgreementDocument)
    .filter((d) => d.id && d.obligations.length);
  const selectedDocs = (Array.isArray(selectedDocuments) ? selectedDocuments : [])
    .slice(0, MAX_SELECTED_DOCUMENTS)
    .map(compactSelectedDocument)
    .filter((document) => document.id);
  const selectedTotal = Number.isFinite(Number(selectedDocumentTotalCount))
    ? Number(selectedDocumentTotalCount)
    : (Array.isArray(selectedDocuments) ? selectedDocuments.length : 0);
  // The retrieval index (open_document's target universe) — the same compact
  // per-document shape the selection block uses, bounded separately.
  const indexDocs = (Array.isArray(indexDocuments) ? indexDocuments : [])
    .slice(0, MAX_DOCUMENT_INDEX)
    .map(compactSelectedDocument)
    .filter((document) => document.id);
  const indexTotal = Number.isFinite(Number(documentIndexTotalCount))
    ? Number(documentIndexTotalCount)
    : (Array.isArray(indexDocuments) ? indexDocuments.length : 0);
  // The matched documents that are NOT cleanly parsed — the feed chat's
  // diagnose targets (stuck / in-flight / errored; the READING·1-OF-1
  // class), each keyed by the transaction_id of the row it matched so
  // `diagnose` can pin a specific row's parse stage FROM DATA. The entries
  // are already shaped by the snapshot's pipelineStateFromDoc (one shaper);
  // here we only BOUND the free-text fields, the same discipline the
  // per-transaction chat applies. null/undefined progress stays null
  // (UNKNOWN); a real 0 stays 0 — Number(null) is 0, so coercing
  // unconditionally would fabricate a "0 of N" the pipeline never reported.
  const boundedCount = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const pipelineStatesBlock = (Array.isArray(pipelineStates) ? pipelineStates : [])
    .filter((p) => p && p.present)
    .slice(0, MAX_PIPELINE_STATES)
    .map((p) => ({
      transaction_id: p.transaction_id || null,
      document_id: p.document_id || null,
      parse_status: safeString(p.parse_status, 40) || null,
      parse_stage: safeString(p.parse_stage, 60) || null,
      parse_progress_current: boundedCount(p.parse_progress_current),
      parse_progress_total: boundedCount(p.parse_progress_total),
      parse_summary: safeString(p.parse_summary, 300) || null,
      parse_error: safeString(p.parse_error, 300) || null,
      parse_run_id: safeString(p.parse_run_id, 80) || null
    }));
  // S4: the HIRED bench, rendered from persisted assignments (the route reads
  // client_assignments; this only bounds and shapes). The complete role_id
  // universe an action's role tag may use — team null means no hired
  // teammates, and the prompt forbids narrating any. Persona/title come from
  // the registry via the route so the narration matches the Team screen.
  const teamBlock = (Array.isArray(team) ? team : [])
    .slice(0, 12)
    .map((mate) => ({
      role_id: safeString(mate?.role_id, 60),
      persona: safeString(mate?.persona, 60) || null,
      title: safeString(mate?.title, 80) || null,
      responsibilities: (Array.isArray(mate?.responsibilities) ? mate.responsibilities : [])
        .slice(0, 8)
        .map((line) => safeString(line, 120))
        .filter(Boolean),
      // Standing-authority context (team-screen recede): the verbs the owner
      // MAY delegate to this teammate, and the grants that currently stand —
      // the complete id universe revoke_role_grant may target, and the honest
      // ground for "what may she do without asking" answers.
      grantable_actions: (Array.isArray(mate?.grantable_actions) ? mate.grantable_actions : [])
        .slice(0, 12)
        .map((verb) => safeString(verb, 60))
        .filter(Boolean),
      standing_authority: (Array.isArray(mate?.standing_authority) ? mate.standing_authority : [])
        .slice(0, 20)
        .map((grant) => ({
          id: safeString(grant?.id, 120),
          action_type: safeString(grant?.action_type, 60) || null,
          scope_key: safeString(grant?.scope_key, 120) || null,
          amount_ceiling: Number.isFinite(Number(grant?.amount_ceiling)) ? Number(grant.amount_ceiling) : null,
          currency: safeString(grant?.currency, 12) || null,
          expires_at: safeString(grant?.expires_at ? String(grant.expires_at) : '', 40) || null,
          review_after: safeString(grant?.review_after ? String(grant.review_after) : '', 40) || null
        }))
        .filter((grant) => grant.id)
    }))
    .filter((mate) => mate.role_id);
  // Per-tab row counts over the rows the model can see — the same partition
  // the firm's UI tabs render, so "the Open tab" resolves to a counted,
  // addressable set instead of "I don't have an Open tab in my context".
  const feedTabCounts = { open: 0, reconciled: 0, client_asks: 0, untabbed: 0 };
  for (const row of rows) {
    if (row.feed_tab === 'open') feedTabCounts.open += 1;
    else if (row.feed_tab === 'reconciled') feedTabCounts.reconciled += 1;
    else if (row.feed_tab === 'client_asks') feedTabCounts.client_asks += 1;
    else feedTabCounts.untabbed += 1;
  }
  return {
    client,
    feed_rows: rows,
    feed_row_count: rows.length,
    feed_tab_counts: feedTabCounts,
    total_row_count: total,
    feed_truncated: total > rows.length,
    agreement_documents: agreementDocs.length ? agreementDocs : null,
    selected_documents: selectedDocs.length ? selectedDocs : null,
    selected_document_count: selectedDocs.length,
    selected_documents_truncated: selectedTotal > selectedDocs.length,
    document_index: indexDocs.length ? indexDocs : null,
    document_index_count: indexDocs.length,
    document_index_truncated: indexTotal > indexDocs.length,
    pipeline_states: pipelineStatesBlock.length ? pipelineStatesBlock : null,
    team: teamBlock.length ? teamBlock : null,
    account_options: codingPolicy?.account_choices ? codingPolicy.account_choices.filter(choice => choice.kind === 'account').map(choice => choice.handle) : boundedAccountOptions.length ? boundedAccountOptions : null,
    tax_treatment_options: boundedTaxTreatmentOptions.length ? boundedTaxTreatmentOptions : null,
    coding_policy: codingPolicy,
    known_facts: (Array.isArray(firmFacts) ? firmFacts : [])
      .slice(0, MAX_FACTS)
      .map((fact) => ({
        id: safeString(fact.id, 64),
        scope: safeString(fact.scope, 24),
        subject: safeString(fact.subject, 120),
        fact: safeString(fact.fact, 300),
        confidence: safeString(fact.confidence, 12),
        status: safeString(fact.status, 24)
      }))
      .filter((fact) => fact.fact),
    // This client's ACTIVE learned/minted rules — the retire_rule target
    // universe (G1c). Ids only from this list, the transaction_ids rail.
    known_rules: (() => {
      const bounded = (Array.isArray(knownRules) ? knownRules : [])
        .slice(0, MAX_KNOWN_RULES)
        .map((rule) => ({
          id: safeString(rule.id, 120),
          rule_type: safeString(rule.rule_type, 40) || null,
          pattern: safeString(rule.pattern_text ?? rule.pattern, 160) || null,
          account_code: safeString(rule.account_code, 40) || null,
          category: safeString(rule.category_override ?? rule.category, 80) || null,
          status: safeString(rule.status, 24) || null
        }))
        .filter((rule) => rule.id);
      return bounded.length ? bounded : null;
    })(),
    // This client's LIVE owner asks — the cancel_ask / resend_ask target
    // universe (G1b). Only draft/open rows are listed: a replied or closed ask
    // is not a lifecycle target, and listing one would invite a dead Apply
    // button. `sent` distinguishes an ask the owner has actually received
    // (send_count > 0) from a drafted one, which is what makes "resend" mean
    // something.
    known_asks: (() => {
      const bounded = (Array.isArray(knownAsks) ? knownAsks : [])
        .slice(0, MAX_KNOWN_ASKS)
        .map((ask) => ({
          id: safeString(ask.id, 120),
          transaction_id: safeString(ask.transaction_id, 120) || null,
          status: safeString(ask.status, 24) || null,
          evidence_type: safeString(ask.evidence_type, 40) || null,
          question: safeString(ask.question, 300) || null,
          send_count: Number.isFinite(Number(ask.send_count)) ? Number(ask.send_count) : 0,
          sent: Number(ask.send_count || 0) > 0,
          last_sent_at: ask.last_sent_at ? toLocalIsoDay(ask.last_sent_at) : null // host-local day (audit F-11)
        }))
        .filter((ask) => ask.id);
      return bounded.length ? bounded : null;
    })(),
    today: toLocalIsoDay(now) // host-local day (audit F-11)
  };
};

// ─── Action sanitisation ─────────────────────────────────────────────────

// Proposal-time governance backstop, paired with the apply-time refusal in
// feedChatApply via the SHARED operatorMemoryPolicy detectors (one copy, no
// drift). A remember_fact must carry durable JUDGMENT about a specific subject.
// Two shapes are NOT that and are re-routed to a non-appliable future_action so
// the operator never sees an Apply button on a card the writer would refuse:
//   • an autonomy/policy ask — raise the auto-apply ceiling, post unattended,
//     stop asking (factRequestsAutonomy);
//   • a future-coding generalisation — "all future inflows get the same
//     treatment", "from now on code these to X" (factRequestsFutureCodingPolicy)
//     — which belongs as a reusable rule (remember_merchant) or an operator
//     policy, not as a fact the coder then weighs forever.
// The prompt already routes these to policy_request / remember_merchant; this
// catches the model slipping. Nothing is hidden: the firm still sees the
// request, correctly framed.
const demoteToFutureAction = (action, { future_type, reason }) => {
  const demoted = { ...action, type: 'future_action', future_type, reason, demoted_from: 'remember_fact' };
  delete demoted.fact_scope;
  delete demoted.fact_subject;
  delete demoted.fact_text;
  delete demoted.fact_confidence;
  return demoted;
};

const demoteNonMemoryFact = (action) => {
  if (action?.type !== 'remember_fact') return action;
  if (factRequestsAutonomy(action)) {
    return demoteToFutureAction(action, {
      future_type: 'policy_request',
      reason:
        'Reads as a policy/automation change (auto-apply, posting unattended, or ' +
        'the asking flow), not durable judgment memory — needs an operator ' +
        'decision and cannot be saved as a fact.'
    });
  }
  if (factIsJurisdictionKnowledge(action)) {
    return demoteToFutureAction(action, {
      future_type: 'jurisdiction_knowledge',
      reason:
        'Reads as a general rule for a whole jurisdiction (tax, law or accounting ' +
        'knowledge), not memory about this business — it goes to the reviewed country ' +
        'policy\'s source review and cannot be saved as a fact. A fact about this ' +
        'client or a merchant can be taught under that scope instead.'
    });
  }
  if (factRequestsFutureCodingPolicy(action)) {
    return demoteToFutureAction(action, {
      future_type: 'coding_policy',
      reason:
        'Reads as a coding policy for a CLASS of future rows (a generalisation), ' +
        'not durable judgment memory about a specific subject — propose a reusable ' +
        'rule (remember_merchant) or an operator policy instead; it cannot be saved as a fact.'
    });
  }
  return action;
};

// G1c anti-fabrication rail for the memory-correction verbs, mirroring the
// transaction_ids discipline: a forget_fact whose fact_id is not in the
// known_facts list, or a retire_rule whose rule_id is not in known_rules,
// is demoted to a non-appliable future_action BEFORE the firm sees an Apply
// button — an invented/mistyped id must never reach the writer. (The apply
// path re-verifies against the DB regardless — INV-4 — this just keeps the
// dead Apply button off the card.) The firm still sees the request, framed
// honestly as out of this chat's reach.
const demoteInvalidMemoryTarget = (action, { knownFacts, knownRules }) => {
  if (action?.type === 'forget_fact') {
    const validFactIds = new Set((Array.isArray(knownFacts) ? knownFacts : []).map((f) => String(f?.id || '')));
    if (action.fact_id && validFactIds.has(String(action.fact_id))) return action;
    const demoted = {
      ...action,
      type: 'future_action',
      future_type: 'memory_correction',
      reason:
        'The fact to stop using is not in this chat\'s known_facts list — it cannot be ' +
        'targeted from here. Use the Memory panel, or name a fact from the list.',
      demoted_from: 'forget_fact'
    };
    delete demoted.fact_id;
    return demoted;
  }
  if (action?.type === 'retire_rule') {
    const validRuleIds = new Set((Array.isArray(knownRules) ? knownRules : []).map((r) => String(r?.id || '')));
    if (action.rule_id && validRuleIds.has(String(action.rule_id))) return action;
    const demoted = {
      ...action,
      type: 'future_action',
      future_type: 'memory_correction',
      reason:
        'The rule to retire is not in this chat\'s known_rules list — it cannot be ' +
        'targeted from here. Use the rules panel, or name a rule from the list.',
      demoted_from: 'retire_rule'
    };
    delete demoted.rule_id;
    return demoted;
  }
  return action;
};

// The SAME anti-fabrication rail for open_document (two-surface IA P4): a
// document_id outside this chat's document_index is demoted before the firm
// sees an Open affordance — a fabricated/recalled id must never drive the
// artifact opener. Read-only either way; this keeps the dead button off the
// card and the reply honest.
const demoteInvalidDocumentTarget = (action, { documentIndex }) => {
  if (action?.type !== 'open_document') return action;
  const validDocumentIds = new Set(
    (Array.isArray(documentIndex) ? documentIndex : []).map((d) => String(d?.id || ''))
  );
  if (action.document_id && validDocumentIds.has(String(action.document_id))) return action;
  const demoted = {
    ...action,
    type: 'future_action',
    future_type: 'document_retrieval',
    reason:
      'The document to open is not in this chat\'s document_index — it cannot be ' +
      'opened from here. Name a document from the index, or narrow by date or counterparty.',
    demoted_from: 'open_document'
  };
  delete demoted.document_id;
  return demoted;
};

// The SAME rail for open_financials (two-surface IA stage C): the verb
// targets a month, not an id, so the fabrication surface is a malformed or
// non-month period driving the artifact opener. A null period is valid (the
// surface resolves the latest month with activity); anything else must be
// a real 'YYYY-MM'. Read-only either way — this keeps the dead button off
// the card, same as demoteInvalidDocumentTarget.
const FINANCIALS_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const demoteInvalidFinancialsTarget = (action) => {
  if (action?.type !== 'open_financials') return action;
  if (action.period == null || FINANCIALS_PERIOD_RE.test(String(action.period))) return action;
  const demoted = {
    ...action,
    type: 'future_action',
    future_type: 'financials_retrieval',
    reason:
      `"${action.period}" is not a month this surface can open — name the month ` +
      'as YYYY-MM (e.g. 2026-06), or leave it out for the latest month.',
    demoted_from: 'open_financials'
  };
  delete demoted.period;
  return demoted;
};

// The SAME anti-fabrication rail for the ask-lifecycle verbs (G1b): an
// ask_id outside this chat's known_asks list is demoted before the firm sees
// an Apply button. Load-bearing beyond a typo guard here — an invented ask id
// on `cancel_ask` is a request to silently close an owner question that may
// not be the one anyone meant, and on `resend_ask` it is an unrequested
// outbound message. The apply path re-verifies against the DB regardless
// (INV-4); this keeps the dead button off the card.
const ASK_LIFECYCLE_ACTION_TYPES = Object.freeze(['cancel_ask', 'amend_ask', 'resend_ask']);

// Standing-authority shape law (team-screen recede, 2026-08-14). approve:
// the target role DERIVES from grant_action (roleForActionIdentity — the
// unique claiming role, so the model can never point a grant at the wrong
// teammate), must be hired, the verb must be in the teammate's
// grantable_actions, and counterparty + positive ceiling + 3-letter currency
// must all be stated. revoke: grant_id must come from the team block's
// standing_authority lists — the same anti-fabrication rail as
// fact_id/rule_id/ask_id. Anything less is demoted to a non-appliable
// future_action; the writers re-verify all of it again at apply time.
const demoteInvalidGrantAction = (action, { hired, teamMates }) => {
  const mates = Array.isArray(teamMates) ? teamMates : [];
  if (action?.type === 'approve_role_grant') {
    const grantAction = String(action.grant_action || '');
    const roleId = roleForActionIdentity(grantAction);
    const mate = mates.find((m) => m?.role_id === roleId) || null;
    const grantable = new Set(Array.isArray(mate?.grantable_actions) ? mate.grantable_actions : []);
    const scopeKey = String(action.grant_scope_key || '').trim();
    const ceiling = Number(action.grant_ceiling);
    const currency = String(action.grant_currency || '').trim().toUpperCase();
    if (roleId && hired.has(roleId) && grantable.has(grantAction)
      && scopeKey && Number.isFinite(ceiling) && ceiling > 0 && /^[A-Z]{3}$/.test(currency)) {
      return {
        ...action,
        grant_action: grantAction,
        grant_scope_key: scopeKey,
        grant_ceiling: ceiling,
        grant_currency: currency,
        // Attribution derives from the grant's target role — deterministic,
        // not the model's tag (the S4 law, applied to the authority verbs).
        role_id: roleId
      };
    }
    return {
      ...action,
      type: 'future_action',
      future_type: 'standing_authority',
      reason:
        'A standing grant needs a hired teammate\'s own delegable verb, a named '
        + 'counterparty, a positive ceiling, and a 3-letter currency. One or more '
        + 'were missing (or the role is not hired) — state them explicitly and I '
        + 'will propose it again.',
      demoted_from: 'approve_role_grant'
    };
  }
  if (action?.type === 'revoke_role_grant') {
    const grantId = String(action.grant_id || '');
    const owner = mates.find((m) =>
      (Array.isArray(m?.standing_authority) ? m.standing_authority : []).some((g) => String(g?.id) === grantId));
    if (grantId && owner) {
      return { ...action, grant_id: grantId, role_id: owner.role_id };
    }
    const demoted = {
      ...action,
      type: 'future_action',
      future_type: 'standing_authority',
      reason:
        'The grant to revoke is not in the team block\'s standing_authority list — '
        + 'it cannot be targeted from here. Name a grant from the list.',
      demoted_from: 'revoke_role_grant'
    };
    delete demoted.grant_id;
    return demoted;
  }
  return action;
};

const demoteInvalidAskTarget = (action, { knownAsks }) => {
  if (!ASK_LIFECYCLE_ACTION_TYPES.includes(action?.type)) return action;
  const validAskIds = new Set((Array.isArray(knownAsks) ? knownAsks : []).map((a) => String(a?.id || '')));
  if (action.ask_id && validAskIds.has(String(action.ask_id))) return action;
  const demoted = {
    ...action,
    type: 'future_action',
    future_type: 'ask_lifecycle',
    reason:
      action.type === 'cancel_ask'
        ? 'The question to cancel is not in this chat\'s known_asks list — it cannot be '
          + 'targeted from here. Name a live ask from the list, or use the Client asks tab.'
        : action.type === 'amend_ask'
          ? 'The question to amend is not in this chat\'s known_asks list — it cannot be '
            + 'targeted from here. Name a live ask from the list, or use the Client asks tab.'
          : 'The question to re-send is not in this chat\'s known_asks list — it cannot be '
            + 'targeted from here. Name a live ask from the list, or use the Client asks tab.',
    demoted_from: action.type
  };
  delete demoted.ask_id;
  return demoted;
};

// Annotate a still-appliable remember_fact with any same-subject conflicts
// against the firm's active known_facts (shared operatorMemoryPolicy detector),
// so the ProposalCard can warn the operator and show the existing fact BEFORE
// Apply. Surface-only: the proposal stays appliable; the operator decides
// (supersede / keep both / cancel). A demoted (autonomy → future_action) action
// is skipped — a policy ask has no memory to conflict with.
const annotateMemoryConflicts = (action, knownFacts) => {
  if (action?.type !== 'remember_fact') return action;
  const conflicts = findRememberFactConflicts(action, knownFacts);
  return conflicts.length ? { ...action, memory_conflicts: conflicts } : action;
};

// ─── Evidence-state correction promotion ───────────────────────────────────

// The firm correcting a row's STATE — "these aren't a no-match, the SHA / invoice
// is coming, show them as waiting evidence" — sometimes lands as a leave_review_note
// (the model reaches for a note when it should flip the evidence flag). A note does
// NOT change state, so the correction would silently no-op. This promotes such a
// note to the appliable mark_evidence_owed verb, which routes to the evidence
// writer. CONSERVATIVE: only a leave_review_note whose own text (note + reason) or
// the firm's command clearly signals waiting-evidence intent is promoted; every
// other note is left exactly as-is. Surface-only in spirit: it does not code,
// post, match, or reconcile — it only changes which evidence pill the row shows.
const EVIDENCE_OWED_INTENT_RE =
  /\b(waiting\s+(for\s+)?evidence|awaiting\s+evidence|evidence\s+(is\s+|to\s+|will\s+)?(owed|coming|follow|pending)|(sha|subscription\s+agreement|agreement|invoice|receipt|contract|document|docs?|paperwork)\s+(is\s+)?(coming|to\s+follow|will\s+follow|follows|later|pending|on\s+its\s+way)|to\s+follow\b|not\s+(a\s+)?no[\s-]?match|shouldn'?t\s+be\s+(a\s+)?no[\s-]?match|show\s+(as\s+|them\s+as\s+)?waiting\s+evidence)\b/i;

const promoteEvidenceOwedNote = (action, userMessage = '') => {
  if (action?.type !== 'leave_review_note') return action;
  const text = `${action.note || ''} ${action.reason || ''} ${userMessage || ''}`;
  if (!EVIDENCE_OWED_INTENT_RE.test(text)) return action;
  const promoted = {
    ...action,
    type: 'mark_evidence_owed',
    reason:
      action.reason || action.note ||
      'Firm says evidence (SHA / invoice) is coming — show Waiting evidence, not No match.',
    converted_from: 'leave_review_note'
  };
  delete promoted.note;
  delete promoted.follow_up_at;
  return promoted;
};

// ─── Broad-scope omitted-row detection ─────────────────────────────────────

// A broad mass command ("ALL Northwind deposits are a loan", "code EVERY Riverside line")
// asserts a SET. If the model resolves only PART of that set and silently drops
// a matching row, the firm can apply an incomplete batch without noticing — the
// Northwind-loan miss. This is a deterministic backstop (no model call): it infers
// the proposal's counterparty + direction signature from the rows the model DID
// pick, then scans the visible feed for same-counterparty, same-direction rows
// left out of EVERY action, and annotates them so the ProposalCard can warn
// BEFORE Apply. SURFACE-ONLY (the proposal stays appliable; the operator
// decides) and CONSERVATIVE: it fires only on an explicit broad quantifier, only
// when a counterparty can be inferred, never flags rows another action already
// covers, and never flags already-decided rows (those the decided-rows rule
// legitimately excludes — flagging them would fight that rule).

// Only set-resolving correction verbs carry an omittable scope. remember_merchant
// targets FUTURE lines (a pattern, not the current set); the read-only / remedial
// / memory verbs have no row set to under-cover.
const OMISSION_CHECKED_TYPES = new Set(['apply_category', 'ask_client', 'leave_review_note']);

// Decided rows are out of default scope (the prompt's decided-rows rule); the
// model omitting one is correct, not a miss.
const DECIDED_REVIEW_STATES = new Set(['accepted', 'resolved', 'synced', 'posted']);

const BROAD_SCOPE_RE = /\b(all|every|each)\b/i;
// Meaningful direction words only — bare "in"/"out" are too ambiguous to filter
// on ("put all Northwind in account X" is not a direction).
const DIRECTION_IN_RE = /\b(deposit|deposits|received|incoming|inbound|credit|credits|income)\b/i;
const DIRECTION_OUT_RE = /\b(payment|payments|paid|outgoing|outbound|debit|debits|spend|spent|expense|expenses)\b/i;

const MAX_OMITTED_ROWS = 12;

// Common entity suffixes stripped so "NORTHWIND OY", "Northwind Oy Ab" and "NORTHWIND"
// collapse to one counterparty key. Applied repeatedly until no trailing suffix
// remains; never strips the last token (a bare "Oy" stays "oy").
const ENTITY_SUFFIXES = new Set([
  'oy', 'oyj', 'ab', 'ky', 'ltd', 'limited', 'pte', 'plc', 'inc', 'llc', 'gmbh',
  'corp', 'co', 'company', 'bv', 'nv', 'as', 'sa', 'srl', 'ag', 'kg', 'group'
]);

const counterpartyKey = (value) => {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[.,/&()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  let tokens = base.split(' ').filter(Boolean);
  while (tokens.length > 1 && ENTITY_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  return tokens.join(' ');
};

// 'in' | 'out' | null — only when the message names ONE direction unambiguously.
const directionHint = (message) => {
  const text = String(message || '');
  const isIn = DIRECTION_IN_RE.test(text);
  const isOut = DIRECTION_OUT_RE.test(text);
  if (isIn && !isOut) return 'in';
  if (isOut && !isIn) return 'out';
  return null;
};

const rowDirection = (row = {}) => {
  if (Number(row.money_in || 0) > 0) return 'in';
  if (Number(row.money_out || 0) > 0) return 'out';
  return null;
};

const isDecidedRow = (row = {}) =>
  DECIDED_REVIEW_STATES.has(String(row.review_state || '').toLowerCase());

// The matching feed rows a broad-scope action left out — or null when the check
// does not apply / nothing is omitted. Entity is inferred from THIS action's
// rows; a row is "omitted" only if NO action covers it (coveredIds) and it is
// not already decided.
const detectOmittedMatchingRows = ({ action, feedRows, userMessage, coveredIds } = {}) => {
  if (!OMISSION_CHECKED_TYPES.has(action?.type)) return null;
  if (!BROAD_SCOPE_RE.test(String(userMessage || ''))) return null;
  const rows = Array.isArray(feedRows) ? feedRows : [];
  if (!rows.length) return null;
  const ownIds = new Set((action.transaction_ids || []).map(String));
  if (!ownIds.size) return null;
  const covered = coveredIds instanceof Set ? coveredIds : ownIds;

  const rowsById = new Map(rows.filter((r) => r && r.id != null).map((r) => [String(r.id), r]));
  const proposedKeys = new Set();
  for (const id of ownIds) {
    const key = counterpartyKey(rowsById.get(id)?.counterparty);
    if (key) proposedKeys.add(key);
  }
  if (!proposedKeys.size) return null; // no counterparty inferable → make no claim

  const direction = directionHint(userMessage);
  const omitted = [];
  for (const row of rows) {
    const id = String(row.id);
    if (covered.has(id) || isDecidedRow(row)) continue;
    const key = counterpartyKey(row.counterparty);
    if (!key || !proposedKeys.has(key)) continue;
    const rd = rowDirection(row);
    if (direction && rd && rd !== direction) continue;
    omitted.push(row);
    if (omitted.length >= MAX_OMITTED_ROWS) break;
  }
  return omitted.length ? omitted : null;
};

// Annotate a set-resolving action with any matching feed rows it omitted, so the
// ProposalCard warns before Apply. Surface-only: the action stays appliable.
const annotateOmittedRows = ({ action, feedRows, userMessage, coveredIds } = {}) => {
  const omitted = detectOmittedMatchingRows({ action, feedRows, userMessage, coveredIds });
  if (!omitted) return action;
  return {
    ...action,
    omitted_matching_transaction_ids: omitted.map((r) => String(r.id)),
    omitted_matching_rows: omitted.map((r) => ({
      id: String(r.id),
      counterparty: r.counterparty || null,
      date: r.date || null,
      money_in: r.money_in ?? null,
      money_out: r.money_out ?? null
    }))
  };
};

// ─── Share-issue / equity: purchase-price conflict exclusion ────────────────

// A broad share-issue / equity command names the SUBSCRIPTION leg (money the
// company receives for issuing shares). A PURCHASE-PRICE row — kauppahinta /
// consideration / the price to ACQUIRE shares — is a different leg and is NOT
// share capital. The prompt tells the model to keep them apart; this is the
// deterministic backstop for when it sweeps anyway (the investor-name
// misfire). It PULLS the conflicting rows from the apply set so an
// Apply never silently posts them as equity, and SURFACES them in
// excluded_conflicting_* for the operator to code separately — never dropped
// silently, never re-coded here. CONSERVATIVE: fires only when the proposal
// codes the set as EQUITY/share capital, and NEVER when the firm's own command
// names a purchase-price row (then including it is the firm's terminal word).
const EQUITY_ACCOUNT_RE =
  /\b(share\s*(capital|premium|issue|subscription)|equity|paid[-\s]?in\s+capital|capital\s+contribution|stock\s+subscription)\b/i;

// A purchase-price / consideration reference in a row's text (kauppahinta is the
// Finnish term that recurred in the misfiring share-issue commands).
const PURCHASE_PRICE_RE =
  /\b(kauppahinta|purchase\s*price|consideration|acquisition\s+(price|cost)|price\s+paid|share\s+purchase|purchase\s+of\s+shares|sale\s+of\s+shares|sale\s+price)\b/i;

const MAX_EXCLUDED_CONFLICT_ROWS = 12;

const rowMatchesPurchasePrice = (row = {}) =>
  PURCHASE_PRICE_RE.test(`${row.description || ''} ${row.counterparty || ''}`);

// The purchase-price rows an equity apply_category swept in — or null when the
// check does not apply / nothing conflicts. The firm naming a purchase-price row
// in its command disables the check (deliberate inclusion).
const detectPurchasePriceConflicts = ({ action, feedRows, userMessage } = {}) => {
  if (action?.type !== 'apply_category') return null;
  if (!EQUITY_ACCOUNT_RE.test(String(action.account_name || ''))) return null;
  if (PURCHASE_PRICE_RE.test(String(userMessage || ''))) return null; // firm named it → keep
  const ids = (action.transaction_ids || []).map(String);
  if (!ids.length) return null;
  const rowsById = new Map(
    (Array.isArray(feedRows) ? feedRows : [])
      .filter((r) => r && r.id != null)
      .map((r) => [String(r.id), r])
  );
  const conflicts = [];
  for (const id of ids) {
    const row = rowsById.get(id);
    if (row && rowMatchesPurchasePrice(row)) conflicts.push(row);
    if (conflicts.length >= MAX_EXCLUDED_CONFLICT_ROWS) break;
  }
  return conflicts.length ? conflicts : null;
};

// Pull purchase-price rows out of an equity coding set and surface them as
// conflicts for operator follow-up. Returns the action unchanged when none apply.
const annotatePurchasePriceConflicts = ({ action, feedRows, userMessage } = {}) => {
  const conflicts = detectPurchasePriceConflicts({ action, feedRows, userMessage });
  if (!conflicts) return action;
  const excluded = new Set(conflicts.map((r) => String(r.id)));
  return {
    ...action,
    transaction_ids: (action.transaction_ids || []).filter((id) => !excluded.has(String(id))),
    excluded_conflicting_transaction_ids: conflicts.map((r) => String(r.id)),
    excluded_conflicting_rows: conflicts.map((r) => ({
      id: String(r.id),
      counterparty: r.counterparty || null,
      description: r.description || null,
      date: r.date || null,
      money_in: r.money_in ?? null,
      money_out: r.money_out ?? null
    }))
  };
};

// S4 role-tag law, applied per action at sanitize time. Two rules, in order:
//   1. A deterministic action_set CLAIM outranks the model's tag: when the
//      action's canonical identity is claimed by a role (roleForActionIdentity,
//      the S1 uniqueness law) AND that role is hired here, the claim IS the
//      tag — the model cannot mis-attribute another lane's verb. (The feed
//      grammar's verbs are unclaimed today, so this arms when role verbs
//      enter the chat grammar.)
//   2. Otherwise the model's tag survives only when it names a HIRED role;
//      anything else — unknown id, unhired role, non-string — strips to null.
//      An unhired teammate must never be narrated as taking work.
// The tag is narration + attribution metadata. It never gates, licenses, or
// widens anything (K1-shaped rule: it grounds the story, it may not govern).
const resolveActionRoleTag = (action, hiredRoleIds) => {
  const hired = hiredRoleIds instanceof Set ? hiredRoleIds : new Set(hiredRoleIds || []);
  const claimed = roleForActionIdentity(action?.type);
  if (claimed) return hired.has(claimed) ? claimed : null;
  const tag = typeof action?.role_id === 'string' ? action.role_id : null;
  return tag && hired.has(tag) ? tag : null;
};

// The resolved set is the model's claim — a gate must not take the
// model's word for its own scope (the #359/#370 self-licensing
// shape). Unknown ids are dropped, duplicates collapsed, and the set
// capped; dropped_transaction_ids makes the trim visible on the
// proposal instead of silently shrinking the firm's command. An autonomy-shaped
// or future-coding-policy remember_fact is demoted to a non-appliable
// future_action (operatorMemoryPolicy) so a policy/generalisation ask never wears
// an Apply button. A broad-scope set command that left a matching visible row out
// of EVERY action is annotated so the card warns before an incomplete batch is
// applied. Finally, purchase-price rows swept into an equity/share-issue coding
// set are pulled out and surfaced as excluded_conflicting_* for the operator
// (feedRows + userMessage drive the last two passes).
export const __sanitizeFeedChatActions = ({
  actions = [],
  validTransactionIds = [],
  knownFacts = [],
  knownRules = [],
  knownAsks = [],
  documentIndex = [],
  feedRows = [],
  userMessage = '',
  hiredRoleIds = [],
  teamMates = []
} = {}) => {
  const valid = new Set((validTransactionIds || []).map(String));
  const hired = new Set(Array.isArray(hiredRoleIds) ? hiredRoleIds : []);
  // First pass: id-sanitize + role-tag law + memory governance (demote/annotate).
  const sanitized = (Array.isArray(actions) ? actions : []).map((action) => {
    const raw = Array.isArray(action?.transaction_ids) ? action.transaction_ids : [];
    const deduped = [...new Set(raw.map(String))];
    const kept = deduped
      .filter((id) => valid.has(id))
      .slice(0, MAX_HISTORY_ROWS_PER_ACTION);
    const dropped = deduped.length - kept.length;
    const base = {
      ...action,
      transaction_ids: kept,
      role_id: resolveActionRoleTag(action, hired),
      ...(dropped > 0 ? { dropped_transaction_ids: dropped } : {})
    };
    // A leave_review_note that is really an evidence-state correction is promoted
    // to the appliable mark_evidence_owed verb. Autonomy/future-coding-shaped
    // remember_facts are demoted to a non-appliable future_action FIRST (a policy
    // ask has no memory to conflict with); a genuine memory proposal is then
    // annotated with any same-subject conflicts for the operator to weigh.
    // Correction fields sanitize FIELD-level (G1d): a teaching-claiming
    // scope or an unenforceable time bound is nulled with a note — the
    // correction itself stays appliable.
    return demoteInvalidGrantAction(
      annotateMemoryConflicts(
        demoteInvalidFinancialsTarget(
          demoteInvalidDocumentTarget(
            demoteInvalidAskTarget(
              demoteInvalidMemoryTarget(
                demoteNonMemoryFact(promoteEvidenceOwedNote(sanitizeCorrectionScopeFields(base), userMessage)),
                { knownFacts, knownRules }
              ),
              { knownAsks }
            ),
            { documentIndex }
          )
        ),
        knownFacts
      ),
      { hired, teamMates }
    );
  });
  // The union of every row any action covers — a row routed to a SIBLING action
  // is not omitted from the command, only from one action's set.
  const coveredIds = new Set();
  for (const action of sanitized) {
    for (const id of action.transaction_ids || []) coveredIds.add(String(id));
  }
  // Second pass: annotate broad-scope omissions against that covered union.
  const annotated = sanitized.map((action) => annotateOmittedRows({ action, feedRows, userMessage, coveredIds }));
  // Third pass: pull purchase-price rows out of an equity/share-issue coding set
  // and surface them as conflicts (the kauppahinta sweep) for operator follow-up.
  return annotated.map((action) => annotatePurchasePriceConflicts({ action, feedRows, userMessage }));
};

// ─── Agreement evidence (read-only) on apply_category proposals ─────────────

// Map a compact feed row (compactFeedRow shape) to the agreement-evidence
// checker's transaction shape. The check compares on ABSOLUTE amount, so the
// signed money_in − money_out magnitude is right for both incoming deposits
// and outgoing payments.
const feedRowToCheckerTransaction = (row = {}) => {
  const signed = Number(row.money_in || 0) - Number(row.money_out || 0);
  return {
    id: row.id,
    amount: signed,
    date: row.date || null,
    counterparty: row.counterparty || row.description || '',
    description: row.description || '',
    reference: null
  };
};

// The feed-row ids an evidence report attributes to the agreement's OBLIGATIONS
// (matched or ambiguous; missing carry no id). These are the rows the agreement
// is actually about, so a proposal coding any of them is the proposal the
// report is evidence FOR. Extras are deliberately excluded — an unexplained
// deposit is NOT part of the agreement, so it must not pull the agreement's
// evidence onto an unrelated coding proposal.
const reportReferencedIds = (report) => {
  const ids = new Set();
  const check = report?.check;
  if (!check) return ids;
  for (const o of Array.isArray(check.obligations) ? check.obligations : []) {
    if (o.transactionId != null) ids.add(String(o.transactionId));
  }
  return ids;
};

// Attach a READ-ONLY agreement-evidence CheckReport to each apply_category
// proposal that codes the bank lines an agreement is about. The strong LLM
// already extracted the obligations; this only COMPARES their numbers against
// the same compact feed rows the model saw and reports matched / missing /
// ambiguous / extra. It is evidence the operator reads before Apply — it never
// reconciles, posts, or clears, and it does not change which rows the proposal
// writes. A proposal gets the agreement whose evidence covers the most of its
// rows; a proposal tied to no agreement is left untouched.
export const __attachAgreementEvidenceToFeedActions = ({
  actions = [],
  agreementDocuments = [],
  feedRows = [],
  clientName = null
} = {}) => {
  const list = Array.isArray(actions) ? actions : [];
  const docs = Array.isArray(agreementDocuments) ? agreementDocuments : [];
  if (!list.length || !docs.length) return list;
  const transactions = (Array.isArray(feedRows) ? feedRows : []).map(feedRowToCheckerTransaction);
  const ownNames = clientName ? [clientName] : [];
  const reports = [];
  for (const doc of docs) {
    let report;
    try {
      report = buildAgreementEvidenceCheckReport({ document: doc, transactions, options: { ownNames } });
    } catch {
      continue; // soft-degrade: an evidence-check failure never breaks the reply
    }
    if (!report || !report.check) continue; // unsupported / no obligations → no proof
    reports.push({ report, ids: reportReferencedIds(report) });
  }
  if (!reports.length) return list;
  return list.map((action) => {
    if (action?.type !== 'apply_category') return action;
    const actionIds = new Set((Array.isArray(action.transaction_ids) ? action.transaction_ids : []).map(String));
    if (!actionIds.size) return action;
    let best = null;
    let bestOverlap = 0;
    for (const entry of reports) {
      let overlap = 0;
      for (const id of actionIds) if (entry.ids.has(id)) overlap += 1;
      if (overlap > bestOverlap) { best = entry.report; bestOverlap = overlap; }
    }
    return best ? { ...action, agreement_evidence: best } : action;
  });
};

// ─── Reply generation ────────────────────────────────────────────────────

// `role` (S4): { roleId, aiProfileId } switches the SYSTEM PROMPT onto the
// role-thread persona and nothing else — same context, same schema, same
// sanitize passes, one compile step (INV-S3, pinned by test). The hired-role
// universe for the role-tag law derives from the context's own team block, so
// the sanitizer and the prompt can never disagree about who is hired.
// Receipts are bound by the runtime after model-output/id validation. The
// model cannot supply policy authority; every target keeps its own business date.
const withCodingPolicyReceipts = (action, context) => {
  if (context?.coding_policy?.native_chart && ['mark_personal', 'remember_merchant'].includes(action?.type)) return nativeCodingChatAction(action, context, []);
  if (!['apply_category', 'recode_decided', 'mark_personal'].includes(action?.type)) return action;
  const byId = new Map((context?.feed_rows || []).map((row) => [row.id, row]));
  return { ...nativeCodingChatAction(action, context, action.transaction_ids || []), coding_policy_by_transaction: Object.fromEntries(
    (action.transaction_ids || []).map((id) => [id, codingPolicyReceiptForChatTransaction(context, byId.get(id))])
  ) };
};

export const generateFeedChatReply = async ({
  context,
  history = [],
  userMessage,
  validTransactionIds = [],
  agreementDocuments = [],
  role = null,
  __callAnthropic,
  signal
} = {}) => {
  const reply = await generateStructuredAnthropicReply({
    systemPrompt: role?.roleId
      ? buildRoleFeedChatSystemPrompt({ roleId: role.roleId, aiProfileId: role.aiProfileId })
      : SYSTEM_PROMPT,
    responseSchema: FEED_CHAT_RESPONSE_SCHEMA,
    contextAck: 'Understood. I have the feed context. What should we do with these rows?',
    context,
    history,
    userMessage,
    ...(__callAnthropic ? { __callAnthropic } : {}),
    signal
  });
  if (reply.kind !== 'ok') return reply;
  // Validate the triage receipt against the contract (shared with the
  // per-transaction chat), then sanitize the resolved id sets.
  const validated = __validateTriageReceipt({
    ...reply,
    actions: __sanitizeFeedChatActions({
      actions: reply.actions,
      validTransactionIds,
      knownFacts: context?.known_facts,
      knownRules: context?.known_rules,
      knownAsks: context?.known_asks,
      documentIndex: context?.document_index,
      feedRows: context?.feed_rows,
      userMessage,
      hiredRoleIds: (Array.isArray(context?.team) ? context.team : []).map((mate) => mate?.role_id).filter(Boolean),
      teamMates: Array.isArray(context?.team) ? context.team : []
    })
  });
  if (validated.kind !== 'ok') return validated;
  // Read-only agreement evidence on the relevant apply_category proposals —
  // AFTER id-sanitization, memory governance, and omitted-row annotation, and
  // without changing any Apply/write behaviour.
  return {
    ...validated,
    actions: __attachAgreementEvidenceToFeedActions({
      actions: validated.actions.map((action) => withCodingPolicyReceipts(action, context)),
      agreementDocuments,
      feedRows: context?.feed_rows,
      clientName: context?.client?.name
    })
  };
};

export const newFeedChatMessageId = ({ kind } = {}) =>
  newTransactionChatMessageId({ transactionId: FEED_CHAT_TRANSACTION_ID, kind });

// ─── Firm-scope (Inbox) lane ─────────────────────────────────────────────
//
// The cross-venture mass-command chat (UI slice 3, 2026-08-05). One firm
// thread (firm_chat_messages, migration 114); the model sees EVERY
// authorized venture's workspace context under ventures[] and every action
// it proposes must carry the client_id it compiles to. The lane is a ROUTER
// over the per-client grammar — same closed action enum, same sanitizers
// run per venture, and the apply route dispatches each action through the
// SAME per-client writers (applyFeedChatAction) — never a second backend.
//
// Deliberate v1 bounds, documented rather than silent:
// - ventures capped at MAX_FIRM_CHAT_CLIENTS, feed rows per venture at
//   MAX_FIRM_FEED_ROWS_PER_CLIENT (the per-client lane sees more; a firm
//   command that needs a venture's full feed belongs on that venture).
// - no pipeline_states and no agreement evidence on this surface — parse
//   diagnostics and agreement checks stay on the venture workspace, and
//   the prompt says so instead of letting the model invent them.

export const FIRM_FEED_CHAT_THREAD = '__firm_feed__';
export const MAX_FIRM_CHAT_CLIENTS = 8;
export const MAX_FIRM_FEED_ROWS_PER_CLIENT = 120;

// The per-client grammar + a REQUIRED client_id on every action. Derived,
// never mutating the per-client schema (feedChat.test.js pins that one).
const FIRM_ACTION_SCHEMA = {
  ...ACTION_SCHEMA,
  required: [...ACTION_SCHEMA.required, 'client_id'],
  properties: {
    ...ACTION_SCHEMA.properties,
    // The venture this action compiles to — MUST be one of
    // ventures[].client_id from the workspace context.
    client_id: { type: 'string' }
  }
};

export const FIRM_FEED_CHAT_RESPONSE_SCHEMA = {
  ...FEED_CHAT_RESPONSE_SCHEMA,
  properties: {
    ...FEED_CHAT_RESPONSE_SCHEMA.properties,
    actions: { type: 'array', items: FIRM_ACTION_SCHEMA }
  }
};

const FIRM_MODE_SECTION = `
FIRM MODE — the Inbox cross-venture surface:

This thread is the firm's INBOX chat. The workspace context carries
MULTIPLE ventures under \`ventures[]\` — each entry is one venture's full
workspace context (client block, feed_rows, feed_tab_counts,
account_options, tax_treatment_options, known_facts) plus its
\`client_id\` and \`client_name\`. Rules, in addition to everything above:

- EVERY action MUST carry \`client_id\` — exactly one id from
  ventures[].client_id. An action never spans ventures: when a command
  covers rows in two ventures, propose one action per venture.
- transaction_ids on an action MUST come from THAT venture's
  feed_rows[].id only; account_name from THAT venture's account_options;
  tax_treatment judged for THAT venture's jurisdiction. Ids that don't
  belong to the action's venture are dropped server-side.
- When a command names no venture and could match rows in more than one,
  SAY which ventures matched and ask which is meant — never guess a book.
- In your text reply, group the matched rows BY VENTURE and name each
  venture, so the firm verifies per book before applying.
- Financial reporting is not bounded by \`feed_rows\`. Each venture carries
  \`latest_financial_period\`, derived from its latest POSTED ledger journal.
  For a firm-wide P&L/report request, emit one \`open_financials\` action for
  each visible venture whose value is non-null, using that concrete month;
  do not refuse or caveat a report because its feed is truncated or because
  unconfirmed rows also exist. The server attaches exact totals and the honest
  draft caveats from the ledger report after your response.
- This surface has NO pipeline_states and NO agreement documents: for a
  stuck-document diagnosis or agreement-evidence question, point the firm
  at that venture's own workspace instead of inventing a parse stage or
  an evidence verdict. Do not propose diagnose or retry_parse here.
- ventures_truncated, when set, is {shown, total, offset}: your context
  holds ONLY that window of the firm's ventures (offset is 0-based into
  the firm's name-ordered venture list). NEVER claim "all ventures",
  "every client", or "firm-wide" completeness while it is set — state
  the visible window, REFUSE all-venture claims, and point at the
  surface's continuation batch for the rest. A command that might reach
  a venture outside the window must say so instead of guessing.
`.trim();

export const __FIRM_FEED_CHAT_SYSTEM_PROMPT = `${SYSTEM_PROMPT}\n\n${FIRM_MODE_SECTION}`;

// Compose the firm context from per-venture blocks built by the SAME
// buildFeedChatContext the per-client lane uses — byte-identical block
// shape, one new nesting level. Each entry in `ventures` is
// { clientId, clientName, context } with context already built.
// ventures_truncated (G0.2, build-spec PR-6) is a WINDOW object, never a
// bare flag the model must notice: {shown, total, offset} when the
// context holds only part of the firm's venture list, null when the
// window IS the whole firm. `venturesWindow` comes from the route (which
// knows the true total + offset); with no window given the builder still
// derives an honest local window from its own cap so a standalone caller
// cannot silently over-claim.
export const buildFirmFeedChatContext = ({ ventures = [], truncated = null, venturesWindow = null, now = new Date() } = {}) => {
  const list = Array.isArray(ventures) ? ventures : [];
  const shownCount = Math.min(list.length, MAX_FIRM_CHAT_CLIENTS);
  let window = null;
  if (venturesWindow && typeof venturesWindow === 'object') {
    const total = Number.isInteger(venturesWindow.total) ? venturesWindow.total : shownCount;
    const offset = Number.isInteger(venturesWindow.offset) && venturesWindow.offset > 0 ? venturesWindow.offset : 0;
    if (total > shownCount || offset > 0) window = { shown: shownCount, total, offset };
  } else if (list.length > MAX_FIRM_CHAT_CLIENTS || truncated === true) {
    // Derived fallback: the builder knows more ventures exist but not the
    // firm's true total — record null rather than fabricating a number.
    window = {
      shown: shownCount,
      total: list.length > MAX_FIRM_CHAT_CLIENTS ? list.length : null,
      offset: 0
    };
  }
  return {
    mode: 'firm_inbox',
    today: toLocalIsoDay(now), // host-local day (audit F-11)
    ventures: list
      .slice(0, MAX_FIRM_CHAT_CLIENTS)
      .map((venture) => ({
        client_id: safeString(venture.clientId, 80),
        client_name: safeString(venture.clientName, 160) || null,
        latest_financial_period: /^\d{4}-(0[1-9]|1[0-2])$/.test(String(venture.latestFinancialPeriod || ''))
          ? String(venture.latestFinancialPeriod)
          : null,
        ...venture.context
      })),
    ventures_truncated: window
  };
};

// The mint-time facts stamp, per venture (G0.1, build-spec PR-5): each
// venture's prompt block carried ITS OWN known_facts, so the
// record-at-mint stamp keeps that granularity — {client_id: [fact_ids]}.
// Ventures whose block carried no facts get no entry (an absent entry at
// apply time reads as an honest empty bundle, never a fallback to
// someone else's facts).
export const buildFirmFactsAvailableByClient = (ventures = []) => {
  const byClient = {};
  for (const venture of (Array.isArray(ventures) ? ventures : [])) {
    if (!venture?.clientId) continue;
    const ids = [...new Set(
      (Array.isArray(venture.knownFacts) ? venture.knownFacts : [])
        .map((fact) => fact?.id)
        .filter(Boolean)
    )];
    if (ids.length) byClient[venture.clientId] = ids;
  }
  return byClient;
};

// The apply-time selection (G0.1's other half): the receipt's memory
// packet comes from the applying action's OWN venture bundle — never the
// cross-venture union. A by-client stamp selects the apply venture's
// list (absent entry → honest []); a legacy pre-bundle message has only
// the union `facts_available` and falls back to it with
// legacy_union_receipt: true so the receipt can carry the warning; a
// message with neither stamp (pre-slice / factless prompt) stays null.
export const selectFirmApplyFacts = ({ payload = null, clientId = '' } = {}) => {
  const byClient = payload?.facts_available_by_client;
  if (byClient && typeof byClient === 'object' && !Array.isArray(byClient)) {
    const bundle = byClient[clientId];
    return {
      factsAvailable: Array.isArray(bundle) ? bundle : [],
      legacyUnionReceipt: false
    };
  }
  if (Array.isArray(payload?.facts_available)) {
    return { factsAvailable: payload.facts_available, legacyUnionReceipt: true };
  }
  return { factsAvailable: null, legacyUnionReceipt: false };
};

// Per-action venture routing + the per-client sanitizer run against THAT
// venture's universe. An action naming an unknown venture is dropped
// entirely (never re-homed); a known venture's action keeps client_name
// attached so the proposal card can render the book it writes to.
export const __sanitizeFirmFeedChatActions = ({
  actions = [],
  ventures = [],
  userMessage = ''
} = {}) => {
  const byClientId = new Map(
    (Array.isArray(ventures) ? ventures : [])
      .filter((venture) => venture?.clientId)
      .map((venture) => [String(venture.clientId), venture])
  );
  return (Array.isArray(actions) ? actions : [])
    .map((action) => {
      const clientId = String(action?.client_id || '');
      const venture = byClientId.get(clientId);
      if (!venture) return null;
      const [sanitized] = __sanitizeFeedChatActions({
        actions: [action],
        validTransactionIds: venture.validTransactionIds || [],
        knownFacts: venture.knownFacts || [],
        feedRows: venture.feedRows || [],
        userMessage
      });
      return { ...sanitized, client_id: clientId, client_name: venture.clientName || null };
    })
    .filter(Boolean);
};

export const generateFirmFeedChatReply = async ({
  context,
  history = [],
  userMessage,
  ventures = [],
  __callAnthropic,
  signal
} = {}) => {
  const reply = await generateStructuredAnthropicReply({
    systemPrompt: __FIRM_FEED_CHAT_SYSTEM_PROMPT,
    responseSchema: FIRM_FEED_CHAT_RESPONSE_SCHEMA,
    contextAck: 'Understood. I have every venture\'s feed context. What should we do?',
    context,
    history,
    userMessage,
    ...(__callAnthropic ? { __callAnthropic } : {}),
    signal
  });
  if (reply.kind !== 'ok') return reply;
  // G0.3 anomaly accounting: the firm sanitizer's whole-action drops are
  // exactly the unknown-venture path (the per-client sanitizer maps 1:1,
  // never dropping whole actions), and per-action id drops ride the
  // dropped_transaction_ids markers. Summarized here so the route can
  // write an anomaly audit row when the model hallucinated a venture or
  // reached across one — the card-level markers alone leave no queryable
  // trace once the thread scrolls.
  const rawActions = Array.isArray(reply.actions) ? reply.actions : [];
  const sanitizedActions = __sanitizeFirmFeedChatActions({ actions: rawActions, ventures, userMessage });
  return __validateTriageReceipt({
    ...reply,
    actions: sanitizedActions.map((action) => withCodingPolicyReceipts(action,
      context?.ventures?.find((venture) => venture.client_id === action.client_id))),
    action_anomalies: {
      dropped_unknown_venture_actions: rawActions.length - sanitizedActions.length,
      dropped_transaction_ids: sanitizedActions.reduce(
        (sum, action) => sum + (action.dropped_transaction_ids || 0),
        0
      )
    }
  });
};
