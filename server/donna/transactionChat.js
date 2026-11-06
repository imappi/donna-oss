import { nativeAccountChoices, nativeCodingPromptProjection } from './codingAccountChoices.js';
// Transaction chat — conversational case-resolution surface for the
// bank-feed artifact. Mirrors the document chat (PR 27) but keyed on a
// transaction instead of a document. The LLM returns conversational
// text plus zero-or-more *proposed* actions; the firm reviews and
// applies them via the apply route.
//
// Provider: OpenAI Responses API with strict JSON-schema structured
// output. Direct fetch — same pattern as documentChat.js / receipt.js.
//
// Persistence: `transaction_chat_messages` (migration 016) keyed on
// (firm_id, client_id, transaction_id). Reopening a transaction
// artifact resumes the thread.

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { codingPolicyChatContext, codingPolicyReceiptForChatTransaction, nativeCodingChatAction } from './codingPolicy.js';
import { TRIAGE_RECEIPT_SCHEMA, validateOperatorContract } from './operatorContract.js';
// The document-field correction allowlist is the contract between the API
// and the DB (documentCorrections.js). correct_document_field's schema enum
// is sourced from it so the model can only PROPOSE a field the writer will
// accept — single source of truth, no drift. The writer re-validates every
// value at write time regardless (INV-4), so this is a convenience guard on
// the proposal, not the authority.
import { ALLOWED_CORRECTION_FIELDS } from './documentCorrections.js';
import {
  CORRECTION_SCOPES,
  CORRECTION_REASON_CODES,
  CORRECTION_RECURRENCES
} from './correctionTeaching.js';
import { canonicalMerchantPattern } from './transactionIntel.js';
import { toLocalIsoDay, toUtcDayMs } from './dates.js';

const MAX_HISTORY_MESSAGES = 24;
const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_CANDIDATE_DOC_SUMMARIES = 20;
const COLLISION_WINDOW_DAYS = 90;
const COLLISION_PAIR_MARGIN_DAYS = 1;

// ─── Public action vocabulary ────────────────────────────────────────────

// v1 transaction actions. The bank-feed flow centres on
// apply_category (the bread-and-butter accept-and-post flow), with
// ask_client and remember_merchant covering the next-most-common
// resolutions. The remaining types parallel the document-chat
// vocabulary so a future shared chat surface can normalise on one
// grammar.
export const TRANSACTION_CHAT_ACTION_TYPES = Object.freeze([
  'apply_category',
  'ask_client',
  'remember_merchant',
  'mark_personal',
  'link_document',
  // resolve_match_group — atomically confirms a complete server-derived set
  // of date-aligned transaction/document pairs and retires crossed suggestions.
  // It is the collision-safe form of link_document: one Apply, one DB
  // transaction, no half-resolved twin group.
  'resolve_match_group',
  // reject_match — the inverse of link_document: reject the CURRENT active
  // reconciliation match for this case (a state-correction verb). The target
  // match is resolved server-side from persisted state and re-verified at
  // write time; it routes to the existing reconciliation-match writer (INV-1).
  'reject_match',
  // accept_match — the affirmative twin of reject_match: CONFIRM the current
  // SUGGESTED reconciliation match for this case (a state-correction verb).
  // The target match is resolved server-side from persisted state, re-verified
  // to still be 'suggested' at write time, and confirmed via the existing
  // reconciliation-match writer (updateReconciliationMatchInDb, INV-1) — the
  // same writer the FE's match accept uses, so a chat confirm cascades the
  // bank line to reconciled and mints the cross-entity learned name exactly
  // like a click. (2026-08-25: "reconcile away" had no verb to compile to.)
  'accept_match',
  // correct_document_field — fix a PARSED FIELD (amount/date/counterparty/…)
  // on this case's matched document (a state-correction verb). The target
  // document is resolved server-side from the active reconciliation match
  // (anti-self-licensing), the field_path is constrained to the corrections
  // allowlist, and it routes to the existing corrections writer (INV-1,
  // recordDocumentCorrectionInDb) — the same writer the artifact panel's
  // field-edit uses, so the firm's chat correction feeds the same next-parse
  // few-shot. The writer re-validates the value at write time (INV-4).
  'correct_document_field',
  'leave_review_note',
  // diagnose — a READ-ONLY diagnostic finding (operator-loop Phase 1,
  // contract INV-5: diagnostics are read-only and separately guarded from
  // remedial verbs). It explains why a case/document is in its current
  // state from the provided context; it never writes, so it is NOT in the
  // APPLIABLE list below — the FE shows it as a finding, not an Apply.
  'diagnose',
  // retry_parse — a REMEDIAL verb (operator-loop Phase 2, contract INV-5):
  // it WRITES (re-queues the matched document's parse) so it has an Apply,
  // but it is tracked in the SEPARATE remedial set below, never pooled with
  // the state-correction verbs. It routes to the existing parse-requeue
  // writer (INV-1); the writer re-verifies the doc is retryable at write
  // time (INV-4).
  'retry_parse',
  // recode_decided — a GUARDED verb (operator-loop Phase 2, contract INV-5):
  // it re-codes a row the firm has ALREADY DECIDED (accepted/resolved/synced/
  // posted), which the bread-and-butter apply_category is forbidden from
  // touching. It rides the SAME separately-guarded set as retry_parse: both
  // act on a TERMINAL state the default appliable verbs refuse, both carry an
  // explicit door (here: the targets_decided flag the prompt only permits when
  // the firm's words cover a decided row), and both re-verify their terminal
  // precondition at write time (INV-4: the apply re-reads the row's review_state
  // server-side). It routes to the existing coding writer (INV-1); the firm is
  // warned the row is already decided.
  'recode_decided',
  // sync_to_accounting — the single-row form of the feed-chat batch verb
  // (the "not on this surface" fix, Kari's dated call 2026-08-16):
  // POST the focused row to the ledger/accounting system — apply_category's
  // post step on its own, for a row already accepted/resolved whose posting
  // has not happened (failed earlier, or deferred). It acts on a TERMINAL
  // state the bread-and-butter verbs refuse, so it rides the guarded set
  // below; it routes to the SAME posting writers the artifact button and
  // the feed batch use (INV-1) and re-verifies post-accepted-only at write
  // time (INV-4). The model never posts — the firm's Apply click does.
  'sync_to_accounting',
  // cancel_ask / resend_ask — the ask-LIFECYCLE verbs (G1b / build-spec
  // PR-9), the other half of ask_client, on the per-case surface. This chat
  // is scoped to ONE transaction, so the known_asks universe is that line's
  // own live asks. cancel_ask closes an ask that should not have been sent;
  // resend_ask re-delivers an already-open one on the same channels. Both
  // target ask_id from known_asks (the anti-fabrication rail), route to the
  // ask-pipeline writers (INV-1), and re-verify status at write time (INV-4).
  'cancel_ask',
  'amend_ask',
  'resend_ask',
  'future_action'
]);

// Actions whose Apply path is wired. The FE reads this list via the
// GET endpoint to gate Apply buttons; the apply route re-validates so
// a stale FE can't trigger a not-yet-wired writer.
//
// remember_merchant additionally captures a cross-client signal into
// merchant_signal_events / merchant_signal_rollup so the same merchant
// learnt once benefits every Donna user (see migration 017,
// server/donna/merchantSignals.js) — and it is the ONLY signal mint:
// apply_category's old opportunistic weight-1 write was removed by
// §7.6's dated call (2026-08-14; correction ≠ teaching).
export const TRANSACTION_CHAT_APPLIABLE_ACTION_TYPES = Object.freeze([
  'apply_category',
  'ask_client',
  'remember_merchant',
  'mark_personal',
  'link_document',
  'resolve_match_group',
  'reject_match',
  'accept_match',
  'correct_document_field',
  'leave_review_note',
  'cancel_ask',
  'amend_ask',
  'resend_ask'
]);

// Guarded verbs (operator-loop Phase 2, contract INV-5: "diagnostics are
// read-only; remedial verbs are separately guarded and counted"). They
// WRITE, so unlike diagnose they have an Apply — but they are kept in a
// SEPARATE set from the state-correction verbs above so the guard and the
// count stay legible. The unifying shape: each acts on a TERMINAL state the
// bread-and-butter appliable verbs refuse to touch, each routes to an EXISTING
// writer (INV-1), and each re-verifies its terminal precondition at write time
// (INV-4) rather than trusting a proposal flag.
//   - retry_parse → retryParseRunsInDb; re-verifies the doc is in a retryable
//     parse state (failed/duplicate_pending) and audits each requeue.
//   - recode_decided → updateTransactionReviewItemInDb; re-reads the row's
//     review_state and refuses unless it is decided (accepted/resolved/synced/
//     posted), behind the explicit targets_decided door the prompt opens only
//     when the firm's words cover a decided row. Audited at the door.
//   - sync_to_accounting → the same post step recode_decided and the feed
//     batch already run (postLedgerTransactionInDb for a Donna-ledger client,
//     adapter.writebackTransaction otherwise); re-reads the row's persisted
//     review_state/sync status and refuses a not-decided or already-synced
//     row — POST-ACCEPTED-ONLY, never force-posted.
export const TRANSACTION_CHAT_REMEDIAL_ACTION_TYPES = Object.freeze([
  'retry_parse',
  'recode_decided',
  'sync_to_accounting'
]);

// What the FE may render an Apply button for, and what the apply route
// accepts: the state-correction verbs PLUS the remedial verbs. The two
// stay distinct in code (INV-5); this is only their union for gating.
export const TRANSACTION_CHAT_ALL_APPLIABLE_ACTION_TYPES = Object.freeze([
  ...TRANSACTION_CHAT_APPLIABLE_ACTION_TYPES,
  ...TRANSACTION_CHAT_REMEDIAL_ACTION_TYPES
]);

// ─── Structured-output schema ────────────────────────────────────────────

// Single object per action with all sub-type fields nullable. The
// `type` discriminator tells the FE which fields to read. Same
// strict-mode-friendly pattern as document-chat: every field is
// required (with null-allowed types) so OpenAI's strict JSON schema
// validates without a fragile anyOf union.
const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'type',
    'reason',
    'account_name',
    'account_code',
    'tax_treatment',
    'contact_name',
    'targets_decided',
    'question',
    'evidence_type',
    'merchant_pattern',
    'document_id',
    'field_path',
    'corrected_value',
    'note',
    'follow_up_at',
    'future_type',
    'facts_used',
    'facts_conflicted'
  ],
  properties: {
    type: { type: 'string', enum: TRANSACTION_CHAT_ACTION_TYPES },
    reason: { type: 'string' },
    // apply_category — propose categorising and posting the row.
    // account_name is the human-readable Xero account; account_code
    // is the optional Xero code; tax_treatment must match the resolved
    // policy when present. contact_name is the cleaned merchant the firm
    // should record on the Xero line.
    account_name: { type: ['string', 'null'] },
    account_code: { type: ['string', 'null'] },
    tax_treatment: { type: ['string', 'null'] },
    contact_name: { type: ['string', 'null'] },
    // recode_decided — the explicit DECIDED-ROW DOOR. apply_category reuses
    // the four coding fields above; recode_decided reuses them too AND sets
    // this flag true to re-code a row the firm already decided. The prompt
    // permits true ONLY when the firm's words cover a decided row; the apply
    // route re-verifies the row really is decided at write time (INV-4), so a
    // bare flag is never trusted alone. Null/false on every other action.
    targets_decided: { type: ['boolean', 'null'] },
    // ask_client — propose creating an evidence request. Question
    // is the draft the firm reviews before sending.
    question: { type: ['string', 'null'] },
    evidence_type: {
      type: ['string', 'null'],
      enum: ['business_purpose', 'supporting_document', 'receipt', null]
    },
    // remember_merchant — propose creating a client rule so similar
    // merchants auto-categorise. merchant_pattern is the
    // substring the rule matches on.
    merchant_pattern: { type: ['string', 'null'] },
    // link_document — propose linking this transaction to a known
    // document (the inverse of document-chat's link_transaction).
    document_id: { type: ['string', 'null'] },
    // resolve_match_group — pairs MUST be copied verbatim from
    // collision_group.suggested_date_pairs. The apply route re-reads the group
    // and refuses stale/incomplete sets before invoking the existing match writer.
    match_pairs: {
      type: ['array', 'null'],
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['transaction_id', 'document_id'],
        properties: {
          transaction_id: { type: 'string' },
          document_id: { type: 'string' }
        }
      }
    },
    // reject_match — reject the current active reconciliation match.
    // Reuses `document_id` (optional): when set, the apply re-verifies it
    // is still the active match and 409s if not. The match itself is
    // resolved server-side from persisted state (never the model's word).
    // accept_match — confirm the current SUGGESTED match; reuses the same
    // `document_id` guard and `reason`, no fields of its own.
    // correct_document_field — fix one parsed field on the matched
    // document. field_path is constrained to the corrections allowlist
    // (ALLOWED_CORRECTION_FIELDS — the same contract the API/DB enforce);
    // corrected_value is the new value as a string (numbers/dates pass as
    // strings — the writer coerces + re-validates per the field's type).
    // null on both for every other action.
    field_path: {
      type: ['string', 'null'],
      enum: [...ALLOWED_CORRECTION_FIELDS, null]
    },
    corrected_value: { type: ['string', 'null'] },
    // leave_review_note / mark_personal — note is required prose;
    // follow_up_at lets the firm schedule a check-in.
    note: { type: ['string', 'null'] },
    follow_up_at: { type: ['string', 'null'] },
    // cancel_ask / resend_ask — the live owner ask on THIS line to close or
    // re-deliver. MUST be an id from the known_asks list; same rail as the
    // document/field targets above.
    ask_id: { type: ['string', 'null'] },
    // amend_ask — the clarification appended to the SENT question (the
    // original is preserved; §7.2's no-silent-edit shape).
    amendment_text: { type: ['string', 'null'] },
    // Correction grammar (G1d / build-spec PR-11) — the correction verbs
    // (apply_category / recode_decided / mark_personal) only.
    // correction_scope declares breadth of intent (null = the narrowest,
    // this transaction); the teaching scopes (client / merchant_for_client
    // / global_candidate) are REFUSED at apply time — durable teaching is
    // the explicit verbs (remember_merchant here; remember_fact on the
    // feed surface), one Apply click per consequence. reason_code is the
    // closed override taxonomy; the free-text `reason` stays the
    // narrative. effective_from records when the correction speaks from
    // (recorded, not enforced); effective_until and recurring are refused
    // — nothing enforces a time bound, and a receipt must not promise one.
    correction_scope: { type: ['string', 'null'], enum: [...CORRECTION_SCOPES, null] },
    reason_code: { type: ['string', 'null'], enum: [...CORRECTION_REASON_CODES, null] },
    effective_from: { type: ['string', 'null'] },
    effective_until: { type: ['string', 'null'] },
    recurrence: { type: ['string', 'null'], enum: [...CORRECTION_RECURRENCES, null] },
    // future_action — model can propose a type not yet in
    // TRANSACTION_CHAT_ACTION_TYPES via a free-text future_type.
    // FE renders disabled.
    future_type: { type: ['string', 'null'] },
    // Slice H self-report — which known_facts ids informed (facts_used) or
    // are contradicted by (facts_conflicted) THIS action. The prompt permits
    // only ids from the known_facts list in the workspace context, and the
    // receipt side re-sanitizes to ids ∩ available (memoryPacket.js:
    // hallucinated ids dropped, both-ways claims count once as conflicted) —
    // telemetry on the apply receipt, never a gate. Null when no known fact
    // bears on the action.
    facts_used: { type: ['array', 'null'], items: { type: 'string' } },
    facts_conflicted: { type: ['array', 'null'], items: { type: 'string' } }
  }
};

export const TRANSACTION_CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // triage is a FIELD of this same strong call (operator-loop Phase 1,
  // plan §3.1) — NOT a separate cheaper classifier (the
  // documentRouter/Failure-A shape). The forced tool (#392) guarantees
  // the model fills it; the surface validates it against the contract.
  required: ['text', 'actions', 'triage'],
  properties: {
    text: { type: 'string' },
    actions: { type: 'array', items: ACTION_SCHEMA },
    triage: TRIAGE_RECEIPT_SCHEMA
  }
};

// ─── System prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are Donna, an accounting assistant embedded in a bank-feed
resolution workspace. The firm has opened a single bank transaction
and wants to decide how to categorise / post it, or ask the client
for evidence.

You CANNOT perform actions directly. You can only:
  1. Reply in plain conversational text.
  2. Propose zero or more structured actions for the firm to
     review and apply.

WHO YOU ARE TALKING TO — read before every reply:

You are talking to the FIRM (the bookkeeper operating Donna). The CLIENT
— the business whose books these are — is NOT in this conversation. Two
hard rules:

  1. Everything the firm types here is the firm INSTRUCTING or INFORMING
     you: a decision, a command, or a fact the firm knows. When the firm
     states what a transaction IS ("this is a Mac charger", "personal",
     "rent"), that is a DECISION — act on it as the firm's word; it is
     NEVER something the client told you, and the firm's stated business
     purpose is SETTLED. Do not ask the client to re-explain what the
     firm just explained.

  2. An \`ask_client\` question is a NEW outbound message to someone who
     has said NOTHING in this thread. NEVER attribute the firm's words to
     the client — do not write "you mentioned", "you said", "as you
     noted", or "you told us" about anything the FIRM stated. If you must
     reference a firm-supplied fact, state it neutrally ("our records
     note this as a Mac charger"); otherwise just ask for what is needed.
     Only a turn marked [CLIENT REPLY] is the client's own words and may
     be quoted back to the client as "you said".

Turn markers in the history: an unmarked turn (and the turn you are
replying to) is the FIRM; [SENT TO CLIENT] is a question already
dispatched to the client; [CLIENT REPLY] is the client's actual
response. If there is no [CLIENT REPLY] turn, the client has told you
nothing — ask for what you need; do not invent that they said something.

Your reply will be persisted in the transaction's case file. Be
concise — the firm is mid-task. Reference specific signals (amount,
merchant, date, direction, currency, AI-suggested category) when
relevant.

Before anything else, TRIAGE the firm's message into the \`triage\`
field of your reply — a required part of EVERY reply, not a separate
step or a separate model call. \`triage\` is the set of intents the
message carries (one or more of): diagnostic, state_correction,
memory_candidate, policy_request, engineering_escalation, unsupported,
question. \`not_handled_as\` lists intents you deliberately did NOT act
on this turn; \`reason\` is one line explaining the split. The grammar
must never silently absorb a request — if you can act on only part of
it, name the rest in not_handled_as.

  - diagnostic — the firm asks WHY something is the way it is, or why a
    document / case is stuck. Answer ONLY from the context provided —
    the \`pipeline_state\` block (the matched document's parse state),
    the coding verdict, and prior turns — pin the facts, never invent
    them — and use the \`diagnose\` action to present the finding.
    Propose no write.
  - engineering_escalation — the cause is a SYSTEM / pipeline bug (a
    document stuck mid-parse, a stage that never completed), not a
    bookkeeping decision. Triage it as engineering_escalation, say an
    engineer needs to look, and do NOT pretend a bookkeeping action
    fixes it.
  - state_correction — recode / accept / relink the books.
    memory_candidate — a durable rule or fact. policy_request —
    unattended auto-apply. unsupported — outside what you can do.
    question — answerable in plain text.

Available action types:

  apply_category — propose the account, tax treatment, and
    contact name for this row. account_name MUST be chosen from
    the account_options list in the workspace context — never
    invent an account name that is not on that list. If nothing
    on the list fits well, say so plainly in your reply, propose
    the closest option with a reason that names the mismatch, and
    add a future_action proposing the chart-of-accounts addition
    the firm should consider. If account_options is missing from
    the context, say you cannot see the firm's account menu
    instead of guessing. tax_treatment MUST be chosen from the
    tax_treatment_options list in the workspace context — the
    same never-invent rule as account_name; if
    tax_treatment_options is missing, say you cannot see the
    firm's tax menu instead of guessing. Fill: account_name,
    optionally account_code, tax_treatment, contact_name (cleaned
    merchant name). The firm clicks Apply; the row is marked
    accepted and posted to the client's books. Use apply_category only for
    a row STILL IN REVIEW; if the workspace context shows this
    transaction.review_state is already decided (accepted/resolved/synced/
    posted), use recode_decided instead.

    CORRECTION ≠ TEACHING (applies to apply_category, recode_decided,
    and mark_personal): a correction changes ONLY this transaction — it
    never creates a rule, a memory, or any future behavior.
    correction_scope stays null (the narrowest — this transaction) or
    'case'; never propose client / merchant_for_client /
    global_candidate on a correction — when the firm's words carry
    durable intent ("always", "from now on"), propose the SEPARATE
    remember_merchant card alongside, so each consequence gets its own
    Apply. reason_code: classify the override with one of
    wrong_category | personal_expense | duplicate | stale_memory |
    one_off_exception | other (null when none fits); keep the full
    story in reason. effective_from may record the date the firm's
    correction speaks from (today or past); never set effective_until
    or recurrence — nothing enforces a time bound, and recurring
    behavior is remember_merchant's job.

    Where the books live: client.accounting_system in the workspace
    context. 'none' means the Donna ledger ONLY — there is no Xero
    or QuickBooks for this client; never tell the firm to create or
    change anything in an external system, and speak of "the chart
    of accounts", not "Xero". Missing accounts for Donna-ledger
    clients are created in Donna (the coding pipeline creates them
    automatically from missing-account verdicts). Only when
    accounting_system is 'xero' or 'qbo' should you name that
    system for chart additions or sync talk.

  ask_client — propose creating an evidence request for the
    client. Fill: question (the draft to send) and evidence_type
    ("business_purpose", "supporting_document", "receipt").

    Ask the client ONLY for something genuinely missing that the firm
    has NOT already supplied — typically a MISSING ARTIFACT (a receipt
    or document), not a business purpose the firm already stated. If the
    firm explained what the line is and only noted a document is missing,
    request that document for the file; do NOT ask the client to
    re-confirm the purpose the firm gave you. Draft the question without
    attributing anything to the client (WHO YOU ARE TALKING TO, rule 2):
    never "you mentioned it was X" — write "our records note this as X",
    or simply ask for the document.

    A document is NOT missing when \`collision_group.available_evidence_for_focused_transaction\`
    is true. That block is a server-hydrated inventory of plausible local
    evidence, including documents hidden by a flattened suggested match. Never
    externalize an internal visibility gap: inspect the collision group and
    resolve/link the local evidence before proposing a receipt or supporting-
    document ask.

    Special case: if the firm's message reads as a polite question
    drafted for the client (typical opener: "Hi", written in second
    person, asks the client to confirm something), treat it as a
    pre-written draft. Propose ask_client with the firm's text
    passed through to question VERBATIM — do not paraphrase or
    "improve" it. The firm wrote the draft because they want to
    send roughly that, not your rewording. Set evidence_type to
    "business_purpose" unless they specifically asked for a
    document or receipt.

  remember_merchant — propose creating a client rule so similar
    merchants auto-categorise in future. Fill: merchant_pattern
    (substring to match in the bank description) plus
    account_name (the account to assign — same account_options
    rule as apply_category; a remembered rule repeats its account
    on every future charge, so never anchor one to a placeholder
    account).

  mark_personal — propose marking this as a personal expense. Fill:
    account_name chosen from account_options using the applicable entity
    and owner-transaction policy, tax_treatment from tax_treatment_options,
    and note (one-line rationale). Never assume a director-loan account
    applies to every legal form. reason should explain why this is not
    a business expense.

  link_document — propose linking this transaction to an existing
    document in the client's case file (the inverse of the
    document-chat link). Fill: document_id. Applying it CONFIRMS the
    match and settles this line as reconciled in the same transaction
    (the manual-link writer creates the match as confirmed and flips
    the line to reconciled) — linking IS the reconcile. Never tell the
    firm a further accept step remains after it applies, and after a
    link_document apply never describe the line as still needing
    reconciliation.

  resolve_match_group — reconcile a complete same-merchant/same-amount
    collision group in ONE Apply. Propose it when
    \`collision_group.complete_date_pairing\` is true and the firm's words establish
    that the repeated transactions/documents are distinct purchases rather
    than duplicates. Copy EVERY {transaction_id, document_id} from
    \`collision_group.suggested_date_pairs\` into match_pairs, exactly once. The
    writer confirms all date-aligned pairs and retires crossed suggested
    matches atomically; never split this into independent link_document,
    accept_match, or reject_match cards. Set document_id null for this action.

  reject_match — historical action type retained only so older proposals and
    receipts remain readable/apply-safe. Do NOT propose reject_match in a new
    reply. A rejection by itself does NOT settle the line: it returns the line
    to needs-review/hanging, and action cards on this surface are applied one
    at a time. If a
    different candidate is correct, propose ONLY link_document for that
    document: its writer confirms the replacement and reconciles the line in
    one apply. If the pairing depends on a genuinely missing business fact,
    propose ONLY ask_client for that exact fact so the line rests on its
    owner; do not reject it first. Do not merely ask for confirmation in prose
    — that creates no persisted owner question. Treat the firm's correction
    as authoritative, and when persisted calendar dates / filenames uniquely
    pair same-amount candidates, make the replacement link instead of asking
    the firm to repeat the answer.

  accept_match — propose CONFIRMING the current reconciliation match for
    this transaction. Propose it ONLY when the workspace context's
    existing_match shows a match with status 'suggested' AND the firm
    affirms it is correct ("this is a match", "reconcile it", "accept
    that"). The server resolves the suggested match from persisted state
    and re-verifies it is still suggested at write time, so you do NOT
    name a match id — set reason (why the firm confirms it). Optionally
    set document_id to the matched document (from existing_match): the
    apply re-verifies it is still the active match and refuses (409) if
    not. Confirming settles the bank line as reconciled; it does NOT code
    the row — when the firm also wants it categorised, propose
    apply_category alongside. If existing_match is null, or its status is
    already confirmed or auto-matched, there is nothing to accept — do
    not propose it, and NEVER claim another action (like apply_category)
    will accept a match: only this verb does. When the firm affirms a
    match ("reconcile it", "it's a match") but existing_match is null
    and you can identify the correct document (from candidate documents
    or this thread), do NOT answer with a bare refusal — propose
    link_document for that document in the SAME turn: its apply links
    AND confirms in one step, so the line is reconciled when it lands.

  correct_document_field — fix a PARSED FIELD on this case's MATCHED
    document when a rendered value is wrong (a wrong amount, tax, date,
    counterparty name, payment status, or document type). Propose it ONLY
    when existing_match is present (there IS a matched document) and the firm
    points at a wrong field on that document. Fill: field_path (the field to
    fix) and corrected_value (the correct value as text — an amount or date is
    still passed as a string; the writer coerces and re-validates it against
    the field's type). field_path MUST be one of the document-correction
    fields: vendor_name, customer_name, document_date, due_date, total_amount,
    tax_amount, reference_number, payment_status, counterparty_role,
    document_type — never invent another path. The matched document is
    resolved server-side from existing_match (you do NOT choose which
    document); optionally set document_id to existing_match.document_id and the
    apply re-verifies it is still the matched document, refusing (409) if a
    newer match has superseded it. This corrects the DOCUMENT's parsed data and
    feeds the next parse of a similar document — it does NOT change the
    bookkeeping/coding of the bank line (use apply_category / recode_decided
    for that) and does NOT touch the match itself (use reject_match to unlink a
    wrong document). If existing_match is null there is no document to correct
    — do not propose it.

  leave_review_note — propose a note attached to this transaction
    for later review or month-end follow-up. Fill: note,
    optionally follow_up_at (ISO date). follow_up_at MUST be today
    or later — anchor it to \`today\` in the workspace context,
    never to the transaction's period (the books are often months
    or years behind the calendar; a follow-up in the past is dead
    on arrival).

  diagnose — present a READ-ONLY diagnostic finding: why this case or
    its document is in its current state. Fill: reason (the one-line
    finding) and note (the detail). For a stuck document, cite the
    \`pipeline_state\` block in the workspace context — parse_status,
    parse_stage, parse_progress_current/total, parse_error, parse_run_id
    — and name the exact stage it is stuck at; read it from there, never
    guess. If \`pipeline_state\` is null the document's parse state is
    not visible to you, so say that plainly instead of inventing a
    stage. diagnose NEVER writes, so the firm sees a finding, not an
    Apply button.

  retry_parse — a REMEDIAL action (guarded and counted; contract INV-5):
    re-queue the parse of THIS case's matched document. Propose it ONLY
    when \`pipeline_state\` shows the document ended in a terminal-error
    parse state (parse_status "failed" or "duplicate_pending") — a parse
    that stopped and can be safely re-run. Do NOT propose it for a
    document still in flight (parse_status "pending"/"processing", a
    stage like "extracting" with no terminal error): a worker hung
    mid-parse is a BUG, so triage engineering_escalation and say an
    engineer must look — never blind-retry a running parse. Fill: reason.
    The firm clicks Apply; the existing parse-requeue writer runs and
    RE-VERIFIES the state, so a document that is no longer retryable is
    reported back, never force-run. retry_parse is a ONE-SHOT remedy, not
    a loop — if a retried parse stalls again, escalate; do not re-propose
    it.

  recode_decided — re-code a row the firm has ALREADY DECIDED. A decided
    row is one whose review_state in the workspace context is accepted,
    resolved, synced, or posted — the firm settled it earlier.
    apply_category is for a row STILL IN REVIEW and is forbidden from
    touching a decided one; recode_decided is the ONLY door to change a
    decided row. Propose it ONLY when the firm's words cover re-coding a
    decided row — and in this single-transaction workspace, if the focused
    transaction.review_state is already decided and the firm gives a coding
    instruction for it, that IS such a case (the firm explicitly opened this
    settled row to change it). Set targets_decided: true to pass the door,
    and WARN in your text that this changes an already-decided row. Fill the
    SAME coding fields as apply_category — account_name (from
    account_options, never invented), optionally account_code,
    tax_treatment, contact_name. Ledger consequence — say it plainly: if the
    row is already POSTED, the re-code changes the coding but the posted
    journal still reflects the old account, so it needs a reversal adjustment
    (reversible via the ledger adjustment surface); the ledger is NOT
    silently rewritten. If the focused row is NOT decided (review_state
    suggested, or in review), do NOT use recode_decided — propose
    apply_category; the apply re-verifies the state and refuses a non-decided
    row.

  sync_to_accounting — POST this row to the ledger: the post step of
    apply_category on its own, for a row that is ALREADY accepted or
    resolved but whose posting has not happened (it failed earlier, or
    was deferred). Propose it when the firm asks to post/send/sync THIS
    line and the focused transaction.review_state is accepted or
    resolved. Fill: reason. The firm clicks Apply; the apply re-reads
    the row's persisted state and refuses a row that is not decided
    (propose apply_category instead — it codes AND posts in one step)
    or already synced/posted (say so plainly). It routes to the SAME
    posting writers the Post-to-ledger button and the firm chat's batch
    sync use — never a second posting path. You never post anything
    yourself: the Apply click is the firm's.

    (These three — retry_parse, recode_decided and sync_to_accounting —
    are the only guarded verbs available; do not invent others.)

  cancel_ask — CLOSE one live question already put to the client about
    THIS line, so it stops waiting on them. Propose it when the firm
    says the question is moot, wrong, or should never have gone out.
    Fill: ask_id (the ask's \`id\` COPIED from the known_asks list —
    ids only from the list, never invented) and reason.
    NEVER propose cancel_ask for a question the client ALREADY
    ANSWERED. If the firm disagrees with an answer, say so and propose
    the correction instead — cancelling an answered question throws
    away what the client told us and tells them nothing.
    Say plainly that cancelling does NOT finish this line: unless it is
    already coded, it comes back to us as unfinished work rather than
    resting with the client.

  amend_ask — FIX or CLARIFY one question already SENT about THIS
    line, without erasing what was asked. Fill: ask_id (from
    known_asks), amendment_text (what the client will see, appended
    below the original question and marked as an amendment), and
    reason. The original question is ALWAYS preserved — a sent message
    is never silently rewritten. A draft (known_asks \`sent\` false)
    is edited in the asks tab, not amended; an ANSWERED question is
    never amended — ask a new question instead. Amending does not
    re-deliver by itself: propose resend_ask alongside when the firm
    wants the amended question pushed now.

  resend_ask — RE-SEND one question the client has already been sent
    but has not answered, on the same channels as the original. Fill:
    ask_id (from known_asks) and reason. This re-delivers the EXISTING
    question and never creates a second one; if the firm wants to ask
    something NEW, propose ask_client instead. If the ask has not been
    sent yet (known_asks \`sent\` is false), do NOT propose resend_ask —
    say it is still a draft.

  future_action — for ideas not in the list above (split, refund
    against a prior posting, FX adjustment, etc). Fill:
    future_type (a short name) and reason. The firm sees the
    proposal but cannot apply it yet.

Always include a one-line \`reason\` on every action.

The client block in the workspace context says whose business this
is — name, jurisdiction, entity type, tax profile. Judge tax
treatment for THAT business using coding_policy.tax_instructions and
the exact tax_treatment_options. Jurisdiction does not establish tax
registration. Use coding_policy.tax_uncertainty_treatment when the
evidence cannot establish treatment, and coding_policy.tax_out_of_scope_treatment
for applicable internal transfers/equity/capital movements. If coding_policy
is missing, explain that tax policy is unavailable and do not propose
tax coding. Apply any coding_policy.owner_transaction_policy guidance
for this entity when identifying owner movements. Commit to one
treatment and keep it consistent unless new evidence changes the analysis.

When current_posted_accounting is present, its journal lines are the observed
posted accounts and amounts. The transaction-level coding_verdict is a historical
summary suggestion, not the account of every component. Ground any claim about
what was posted in those journal lines; do not infer component coding from the
summary account. Missing or incomplete journal coverage means you must state the
limit, not invent an existing account. Keep proposed corrections separate from
observed postings, and never describe an unsupported component correction as a
whole-transaction recode.

Honour the workspace context the user provides — the transaction
fields, the AI-suggested category (if any), any candidate documents
that might match, and prior conversation turns. Never re-propose an
action that is already marked [ALREADY APPLIED] in the conversation
history. If you have nothing useful to propose, return text only
with empty actions[].

Never dead-end. If the firm asks for something NO verb on this
surface covers but another Donna surface does — batch operations
across many lines, firm memory edits (remember/forget facts,
retiring rules) live in the firm-wide admin chat; document-field
fixes live here and in the document panel — say plainly WHICH
surface has it and what to ask there. A bare "I can't" with no
pointer is never an acceptable answer; for ideas no surface covers,
use future_action.

known_asks, when present, lists the LIVE questions already put to the
client about THIS line (id, question, whether it has been \`sent\`, how
many times) — the complete universe cancel_ask and resend_ask may
target. An id not in the list does not exist for this chat. Questions
the client has already answered are NOT in this list, which is why
neither verb can reach one.

known_facts in the workspace context are the firm's accumulated
LOCAL knowledge — facts about this specific merchant, this client's
business, or this jurisdiction, distilled from past corrections and
the client's own replies. Weigh them above web context but below a
matched document and the client's words in THIS thread. A
high-confidence fact ("NORTHWIND HOLDINGS OY is a shareholder of the client, not
a customer") should change your judgment of every line it touches.
Merchant facts are learned per legal entity: a fact carrying
\`legacy_firm_scope: true\` predates that scoping and may have been
taught by a DIFFERENT venture of this firm — still usable, but weigh
it below an entity-specific fact and say so if it drives a decision.

CITE YOUR MEMORY USE on every action you propose. When a known_facts
entry informed the action, put that fact's \`id\` in the action's
\`facts_used\` array. When the action goes AGAINST a known fact —
because a matched document or the firm's words in this thread
outweigh it — put that fact's \`id\` in \`facts_conflicted\` and name
the conflict plainly in your reply text (a contradicted fact may be
stale memory the firm should update). Use ONLY ids that appear in
the known_facts list — never invent or abbreviate an id. When no
known fact bears on an action, set both fields to null. This is an
audit citation, not a gate: it never changes what you may propose.

playbooks in the workspace context, when present, are the firm's
curated procedures for a RECOGNIZED transaction pattern (e.g. a
payment-processor payout). Follow their do / do_not / escalate_when
guidance when judging THIS line: they encode how the firm handles
the pattern, including what a correct terminal state looks like.
They GUIDE your proposals — they never override a matched document,
the client's words in this thread, or the client block's
jurisdiction, and every deterministic check still applies. When a
playbook says escalate, that means propose ask_client with the
specific question — never leave the line parked.

THE CODING VERDICT

transaction.coding_verdict, when present, is the batch coder's
persisted verdict for this line — your own earlier UNCONFIRMED
suggestion (provenance, not firm-approved truth). Read it before
re-deriving anything, and never attribute to "the AI" a suggestion
that is not actually in the context. When coding_verdict.
missing_account is set, the chart genuinely lacks that account and
the line is parked — for Donna-ledger clients the pipeline creates
the account automatically on the next coding run, so say that
rather than instructing the firm to create it by hand. When
coding_verdict.missing_account_resolved is set, the account has
ALREADY been created and the line awaits firm review — propose
applying the named account; do not propose creating it again.

EXISTING MATCH HANDLING

\`collision_group\` outranks the flattened \`existing_match\` view. It contains
all related lines, local documents, match rows (including crossed/rejected
suggestions), and the deterministic date pairing derived from persisted
calendar dates. When it reports a complete pairing, reason about the group as
one case and use resolve_match_group; do not claim the other case/document is
invisible and do not ask the firm or client to identify data already present.

If \`existing_match\` is present in the workspace context, this
transaction is ALREADY linked to a document — the firm sees
"MATCHED · <status>" on the row. Do NOT propose \`link_document\`
with a \`document_id\` matching \`existing_match.document_id\`; that
link already exists and re-proposing it reads as if you didn't see
the match. You may reference the match in your explanation
("auto-matched to <filename>") and propose follow-up actions
(category, ask client about specifics, leave_review_note) instead.
You may still propose \`link_document\` with a DIFFERENT
\`document_id\` if you genuinely believe a different candidate is a
better match — but state explicitly why the existing match is
wrong before doing so.
`.trim();

// Test seam: the account-menu rule in the prompt is load-bearing
// (without it the model invents accounts from examples) — pinned in
// transactionChat.test.js.
export const __SYSTEM_PROMPT = SYSTEM_PROMPT;

// ─── Context building ────────────────────────────────────────────────────

const safeString = (value, max = 2000) => {
  if (value == null) return '';
  return String(value).slice(0, max);
};

// Server-side lookup for the existing reconciliation match against a
// bank transaction. Pulled out of the api.js handler so it can be
// unit-tested via the mockClient pattern — the inlined version
// (#201) selected a bare `source` column that doesn't exist, threw
// at query time, and the handler's .catch silently turned existing_
// match into null. The LLM kept re-proposing link_document for an
// entire PR cycle because no test exercised the SQL shape.
//
// Status priority: confirmed > auto_matched > suggested. Rejected /
// other statuses don't count as "this tx is matched". Returns the
// first matching row, or null.
//
// `source` is stored as a key inside `payload` (the matcher writes
// payload.source = '<matcher>_reconciliation') — pulled via the
// JSONB accessor so the row populates with the descriptive label
// the prompt can reference.
export const fetchActiveTransactionMatch = async ({
  client,
  firmId,
  bankTransactionId
} = {}) => {
  if (!client || !firmId || !bankTransactionId) return null;
  const result = await client.query(
    `select rm.matched_object_id, rm.status, rm.payload->>'source' as source
       from reconciliation_matches rm
       left join transactions t
         on t.firm_id = rm.firm_id and t.id = rm.bank_transaction_id
       left join documents d
         on d.firm_id = rm.firm_id and d.id = rm.matched_object_id
      where rm.firm_id = $1
        and rm.bank_transaction_id = $2
        and rm.status in ('confirmed', 'auto_matched', 'suggested')
      order by case rm.status
                 when 'confirmed' then 1
                 when 'auto_matched' then 2
                 when 'suggested' then 3
               end,
               abs(d.document_date - t.transaction_date) asc nulls last,
               rm.match_confidence desc nulls last,
               rm.updated_at desc nulls last,
               rm.id
      limit 1`,
    [firmId, bankTransactionId]
  );
  return result.rows[0] || null;
};

// Candidate documents arrive from the mounted artifact only as an ordered set
// of ids. Re-hydrate every accounting field from PostgreSQL before it reaches
// the model: a browser-serialized DATE was observed as 2025-07-28T22:00Z even
// though the persisted calendar date was 2025-07-29, which made Donna reject
// one candidate and refuse the obvious replacement. `to_char` keeps DATE
// semantics date-only across browser/server time zones. Unknown/stale ids drop
// fail-closed; the client payload never becomes an accounting source of truth.
export const fetchTransactionChatCandidateDocuments = async ({
  client,
  firmId,
  clientId,
  candidateDocuments = []
} = {}) => {
  if (!client || !firmId || !clientId) return [];
  const ids = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidateDocuments) ? candidateDocuments : []) {
    const id = safeString(candidate?.id, 180).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_CANDIDATE_DOC_SUMMARIES) break;
  }
  if (!ids.length) return [];
  const result = await client.query(
    `select id, document_type, filename, vendor_name, customer_name,
            total_amount, currency,
            to_char(document_date, 'YYYY-MM-DD') as document_date,
            payment_status
       from documents
      where firm_id = $1 and client_id = $2 and id = any($3::text[])`,
    [firmId, clientId, ids]
  );
  const byId = new Map((result.rows || []).map((row) => [String(row.id), row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
};

const isoDayMs = (value) => {
  const day = safeString(value, 32).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const ms = new Date(`${day}T00:00:00Z`).getTime();
  return Number.isFinite(ms) ? ms : null;
};

export const compactMerchantKey = (value) => canonicalMerchantPattern(value).replace(/\s+/g, '');

// Pure date-pair resolver for a complete same-merchant/same-amount collision
// group. It never ranks accounting evidence generally; it only recognizes the
// narrow invariant that each persisted document date has one unique closest
// transaction and the assignment is a bijection. Equal-distance or incomplete
// groups stay unresolved for Donna/the firm.
export const deriveTransactionChatDatePairs = ({
  transactions = [],
  documents = [],
  matches = [],
  marginDays = COLLISION_PAIR_MARGIN_DAYS
} = {}) => {
  const terminalStatuses = new Set(['confirmed', 'auto_matched']);
  const assignedTransactionIds = new Set();
  const assignedDocumentIds = new Set();
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!terminalStatuses.has(String(match?.status || ''))) continue;
    assignedTransactionIds.add(String(match.bank_transaction_id || match.transaction_id || ''));
    assignedDocumentIds.add(String(match.matched_object_id || match.document_id || ''));
  }
  const txs = (Array.isArray(transactions) ? transactions : [])
    .filter((tx) => !assignedTransactionIds.has(String(tx.id)))
    .filter((tx) => !['reconciled', 'auto_reconciled'].includes(String(tx.reconciliation_status || '')));
  const docs = (Array.isArray(documents) ? documents : [])
    .filter((doc) => !assignedDocumentIds.has(String(doc.id)));
  if (txs.length < 2 || docs.length !== txs.length) {
    return { complete: false, pairs: [], reason: 'group_not_complete' };
  }

  const chosen = [];
  for (const doc of docs) {
    const docMs = isoDayMs(doc.document_date);
    if (docMs == null) return { complete: false, pairs: [], reason: 'document_date_missing' };
    const ranked = txs.map((tx) => {
      const txMs = isoDayMs(tx.transaction_date || tx.date);
      return { tx, gapDays: txMs == null ? null : Math.abs(txMs - docMs) / (24 * 60 * 60 * 1000) };
    });
    if (ranked.some((entry) => entry.gapDays == null)) {
      return { complete: false, pairs: [], reason: 'transaction_date_missing' };
    }
    ranked.sort((a, b) => a.gapDays - b.gapDays || String(a.tx.id).localeCompare(String(b.tx.id)));
    if (ranked.length > 1 && ranked[1].gapDays - ranked[0].gapDays < marginDays) {
      return { complete: false, pairs: [], reason: 'date_pair_not_unique' };
    }
    chosen.push({
      transaction_id: String(ranked[0].tx.id),
      document_id: String(doc.id),
      transaction_date: safeString(ranked[0].tx.transaction_date || ranked[0].tx.date, 32).slice(0, 10),
      document_date: safeString(doc.document_date, 32).slice(0, 10),
      date_gap_days: ranked[0].gapDays
    });
  }
  if (new Set(chosen.map((pair) => pair.transaction_id)).size !== txs.length) {
    return { complete: false, pairs: [], reason: 'date_pair_not_bijective' };
  }
  chosen.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || a.transaction_id.localeCompare(b.transaction_id));
  return { complete: true, pairs: chosen, reason: 'unique_closest_dates' };
};

// Server-side collision-group hydration. The mounted artifact may show only one
// suggested match, but Donna needs every equal-amount sibling transaction,
// plausible local document, and crossed match row before deciding whether
// evidence is missing. All accounting fields and DATE values come from Postgres.
export const fetchTransactionChatCollisionGroup = async ({
  client,
  firmId,
  clientId,
  transactionId
} = {}) => {
  if (!client || !firmId || !clientId || !transactionId) return null;
  const focusedResult = await client.query(
    `select id, description, raw_description,
            coalesce(payload->>'contact', payload->>'counterparty_guess') as contact,
            money_in, money_out, currency, reconciliation_status, status,
            to_char(transaction_date, 'YYYY-MM-DD') as transaction_date,
            payload
       from transactions
      where firm_id = $1 and client_id = $2 and id = $3
      limit 1`,
    [firmId, clientId, transactionId]
  );
  const focused = focusedResult.rows[0] || null;
  if (!focused) return null;
  const direction = Number(focused.money_in || 0) > 0 ? 'money_in' : 'money_out';
  const amount = Number(focused[direction] || 0);
  if (!(amount > 0)) return null;
  const currency = safeString(focused.currency, 12).toUpperCase();
  const focusedMerchant = compactMerchantKey(focused.contact || focused.description || focused.raw_description);

  const transactionResult = await client.query(
    `select id, description, raw_description,
            coalesce(payload->>'contact', payload->>'counterparty_guess') as contact,
            money_in, money_out, currency, reconciliation_status, status,
            to_char(transaction_date, 'YYYY-MM-DD') as transaction_date
       from transactions
      where firm_id = $1 and client_id = $2
        and upper(coalesce(currency, '')) = $3
        and abs(coalesce(${direction}, 0) - $4) < 0.005
        and coalesce(${direction}, 0) > 0
        and transaction_date between ($5::date - $6::int) and ($5::date + $6::int)
      order by transaction_date, id
      limit 20`,
    [firmId, clientId, currency, amount, focused.transaction_date, COLLISION_WINDOW_DAYS]
  );
  const transactions = (transactionResult.rows || []).filter((tx) => {
    const key = compactMerchantKey(tx.contact || tx.description || tx.raw_description);
    return !focusedMerchant || (!!key && key === focusedMerchant);
  });
  if (!transactions.some((tx) => String(tx.id) === String(transactionId))) transactions.push(focused);
  const transactionIds = transactions.map((tx) => String(tx.id));

  const documentTypes = direction === 'money_out'
    ? ['receipt', 'supplier_bill', 'payment_confirmation', 'payment_account_statement']
    : ['sales_invoice', 'issued_receipt'];
  const documentResult = await client.query(
    `select id, document_type, filename, vendor_name, customer_name,
            total_amount, currency, payment_status, parse_status,
            to_char(document_date, 'YYYY-MM-DD') as document_date
       from documents
      where firm_id = $1 and client_id = $2
        and document_type = any($3::text[])
        and upper(coalesce(currency, '')) = $4
        and abs(coalesce(total_amount, 0) - $5) < 0.005
        and document_date between ($6::date - $7::int) and ($6::date + $7::int)
      order by document_date, id
      limit 20`,
    [firmId, clientId, documentTypes, currency, amount, focused.transaction_date, COLLISION_WINDOW_DAYS]
  );
  const candidateDocumentIds = (documentResult.rows || []).map((doc) => String(doc.id));
  const matchResult = (transactionIds.length || candidateDocumentIds.length)
    ? await client.query(
        `select id, bank_transaction_id, matched_object_id, matched_object_type,
                status, match_confidence, match_reason
           from reconciliation_matches
          where firm_id = $1 and client_id = $2
            and (bank_transaction_id = any($3::text[]) or matched_object_id = any($4::text[]))
          order by updated_at desc nulls last, id`,
        [firmId, clientId, transactionIds, candidateDocumentIds]
      )
    : { rows: [] };
  const linkedDocumentIds = new Set((matchResult.rows || []).map((match) => String(match.matched_object_id)));
  const documents = (documentResult.rows || []).filter((doc) => {
    const key = compactMerchantKey(doc.vendor_name || doc.customer_name || doc.filename);
    return linkedDocumentIds.has(String(doc.id))
      || !focusedMerchant
      || (!!key && key === focusedMerchant);
  });
  const documentIds = new Set(documents.map((doc) => String(doc.id)));
  const allRelevantMatches = (matchResult.rows || []).filter((match) =>
    transactionIds.includes(String(match.bank_transaction_id))
      || documentIds.has(String(match.matched_object_id)));
  const matches = allRelevantMatches.filter((match) =>
    transactionIds.includes(String(match.bank_transaction_id)) && documentIds.has(String(match.matched_object_id)));
  const pairing = deriveTransactionChatDatePairs({ transactions, documents, matches: allRelevantMatches });
  const selectedKeys = new Set(pairing.pairs.map((pair) => `${pair.transaction_id}|${pair.document_id}`));
  const terminalDocumentIds = new Set(allRelevantMatches
    .filter((match) => ['confirmed', 'auto_matched'].includes(String(match.status)))
    .map((match) => String(match.matched_object_id)));

  return {
    focused_transaction_id: String(transactionId),
    key: { direction, amount, currency, counterparty: focusedMerchant || null },
    transactions: transactions.map((tx) => ({
      id: String(tx.id),
      transaction_date: safeString(tx.transaction_date, 32).slice(0, 10),
      description: safeString(tx.description || tx.raw_description, 240),
      amount: Number(tx[direction] || 0),
      currency: tx.currency || null,
      reconciliation_status: tx.reconciliation_status || null
    })),
    documents: documents.map((doc) => ({
      id: String(doc.id),
      document_type: doc.document_type || null,
      filename: safeString(doc.filename, 200),
      counterparty: safeString(doc.vendor_name || doc.customer_name, 120) || null,
      total_amount: Number(doc.total_amount),
      currency: doc.currency || null,
      document_date: safeString(doc.document_date, 32).slice(0, 10),
      payment_status: doc.payment_status || null
    })),
    matches: matches.map((match) => ({
      id: String(match.id),
      transaction_id: String(match.bank_transaction_id),
      document_id: String(match.matched_object_id),
      status: match.status || null,
      confidence: Number.isFinite(Number(match.match_confidence)) ? Number(match.match_confidence) : null,
      reason: safeString(match.match_reason, 300) || null
    })),
    suggested_date_pairs: pairing.pairs,
    complete_date_pairing: pairing.complete,
    pairing_reason: pairing.reason,
    available_evidence_for_focused_transaction: documents.some((doc) => !terminalDocumentIds.has(String(doc.id))),
    crossed_suggested_match_ids: matches
      .filter((match) => match.status === 'suggested')
      .filter((match) => !selectedKeys.has(`${match.bank_transaction_id}|${match.matched_object_id}`))
      .map((match) => String(match.id))
  };
};

// Build the per-message context the model sees. Bounds free-text
// fields so a malicious description or candidate list can't blow up
// the token budget.
export const buildTransactionChatContext = ({
  transaction,
  candidateDocuments = [],
  // Existing reconciliation match for the transaction, if any. When
  // present, the model is instructed (via SYSTEM_PROMPT) not to
  // re-propose link_document for that same document — the link is
  // already there. Shape: { matched_object_id, status, source } —
  // anything else is dropped to keep the LLM context tight.
  existingMatch = null,
  // Complete server-hydrated same-amount/same-merchant neighborhood. This is
  // the antidote to a single mounted card flattening several suggested rows.
  collisionGroup = null,
  // The client's account menu — same resolution the batch coder uses
  // (client CoA names, canonical fallback). Without it the model's
  // only account vocabulary was the three EXAMPLES in the system
  // prompt, so a coworking charge got proposed as "Meals and
  // entertainment" while "Rent" / "Office expenses" sat unseen on the
  // real menu. Empty array → account_options: null (menu unknown).
  accountOptions = [],
  // Exact country policy vocabulary; overrides must match it completely.
  taxTreatmentOptions = undefined,
  // Whose business this is — jurisdiction, entity type, tax profile.
  // The same facts the batch coder's clientInputFor carries; without
  // them the chat judged GST treatment with no idea which tax regime
  // applies.
  clientProfile = null,
  // Layer-2 firm facts (firmFacts.js): the firm's accumulated local
  // knowledge about this merchant / client / jurisdiction.
  firmFacts = [],
  // This line's LIVE owner asks — the cancel_ask / resend_ask target universe
  // (G1b). Scoped to THIS transaction by the caller, so the per-case chat can
  // never reach another line's question.
  knownAsks = [],
  // L2 playbooks (bookkeepingPlaybooks.js, Slice I): curated procedure
  // guidance for a recognized transaction pattern, ALREADY selected and
  // rendered by the caller (renderPlaybooksForPrompt) — the route owns the
  // config-stage gate, so this builder stays pure. Empty → the context
  // carries no playbooks key at all (retrieved per-case, never bloat).
  playbooks = [],
  // The matched document's parse pipeline_state, handed in from the
  // BookCaseSnapshot read model (operatorCaseSnapshot.js) — this is the
  // snapshot's SECOND consumer (the artifact drawer was the first). Shape:
  // the snapshot's `{ present, document_id, parse_status, parse_stage, ... }`
  // block, or null. It feeds the read-only `diagnose` verb so a stuck
  // document is explained from PERSISTED parse state, never guessed
  // (CLAUDE.md "diagnose, don't guess" + the READING·1-OF-1 rail). A
  // present:false / null block means no document is in focus, which
  // surfaces as pipeline_state: null — the prompt tells the model to say
  // the parse state is not visible rather than invent a stage.
  pipelineState = null,
  // Injectable clock for tests; `today` rides the context so the model
  // anchors follow-ups to NOW, not the transaction's period (a
  // 2024-02-15 follow-up was proposed in June 2026 — dead on arrival).
  now = new Date()
} = {}) => {
  if (!transaction) {
    return {
      client: null,
      transaction: null,
      candidate_documents: [],
      existing_match: null,
      collision_group: null,
      pipeline_state: null,
      account_options: null,
      tax_treatment_options: null,
      today: null
    };
  }
  const boundedAccountOptions = (Array.isArray(accountOptions) ? accountOptions : [])
    .map((name) => safeString(name, 80))
    .filter(Boolean)
    .slice(0, 150);
  const codingPolicy = codingPolicyChatContext(clientProfile, {
    businessDate: transaction.date ?? transaction.transaction_date ?? null, taxTreatmentOptions
  });
  const boundedTaxTreatmentOptions = codingPolicy?.tax_treatment_options || [];
  const client = clientProfile
    ? {
        name: safeString(clientProfile.name, 160) || null,
        jurisdiction: safeString(clientProfile.jurisdiction, 80) || null,
        entity_type: codingPolicy?.entityType ?? (safeString(clientProfile.entity_type ?? clientProfile.entityType, 80) || null),
        accounting_currency: safeString(clientProfile.accounting_currency, 12) || null,
        tax_profile: clientProfile.tax_profile ?? clientProfile.taxProfile ?? null,
        // 'xero' | 'qbo' | 'none' — where the books live. 'none' means
        // Donna ledger only; the chat must not send the firm to Xero.
        accounting_system: codingPolicy?.accountingSystem ?? (safeString(clientProfile.accounting_system ?? clientProfile.accountingSystem, 24) || null)
      }
    : null;
  const inAmt = Number(transaction.money_in || 0);
  const outAmt = Number(transaction.money_out || 0);
  const direction = inAmt > 0 ? 'money_in' : outAmt > 0 ? 'money_out' : null;
  // The batch coder's persisted verdict — THE decision for this line
  // (render the persisted verdict, not the legacy layer). Without it
  // the chat argued with a phantom: it saw only the parse-time
  // classifier's category and "corrected" a Revenue suggestion the
  // strong coder never made, while the coder's actual verdict
  // (Suspense park + missing Share capital account) sat unseen on the
  // row. Provenance, not authority — same framing as
  // client_reply_context.prior_verdict.
  const persistedSuggestion =
    (transaction.ai_suggestion && typeof transaction.ai_suggestion === 'object' && transaction.ai_suggestion) ||
    (transaction.payload?.ai_suggestion && typeof transaction.payload.ai_suggestion === 'object' && transaction.payload.ai_suggestion) ||
    null;
  const codingVerdict = persistedSuggestion
    ? {
        proposed_account: safeString(persistedSuggestion.proposed_account, 80) || null,
        tax_treatment: safeString(persistedSuggestion.tax_treatment, 40) || null,
        confidence: safeString(persistedSuggestion.confidence, 12) || null,
        evidence_required: typeof persistedSuggestion.evidence_required === 'boolean'
          ? persistedSuggestion.evidence_required
          : null,
        reasoning: safeString(persistedSuggestion.reasoning, 500) || null,
        missing_account: persistedSuggestion.missing_account?.name
          ? {
              name: safeString(persistedSuggestion.missing_account.name, 80),
              account_type: safeString(persistedSuggestion.missing_account.account_type, 24) || null,
              reason: safeString(persistedSuggestion.missing_account.reason, 240) || null
            }
          : null,
        missing_account_resolved: persistedSuggestion.missing_account_resolved?.name
          ? {
              name: safeString(persistedSuggestion.missing_account_resolved.name, 80),
              account_type: safeString(persistedSuggestion.missing_account_resolved.account_type, 24) || null
            }
          : null,
        model: safeString(persistedSuggestion.model, 60) || null,
        provenance: 'machine_suggestion_unconfirmed'
      }
    : null;
  // The matched document's parse pipeline_state, bounded for the LLM
  // context. The snapshot already shaped it (pipelineStateFromDoc); we
  // only bound the free-text fields here so a long parse_summary / error
  // can't blow the token budget — the SAME shaping discipline the rest of
  // this builder applies. present:false / null ⇒ null (parse state not
  // visible; the prompt says so instead of inventing a stage).
  // null/undefined stay null (progress UNKNOWN); a real 0 stays 0 (zero
  // done). Number(null) is 0, so coercing unconditionally would fabricate
  // a "0 of N" the pipeline never reported — the kind of invented datum
  // the repo refuses (render the persisted state, not a guess).
  const boundedCount = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const pipelineStateBlock = pipelineState && pipelineState.present
    ? {
        document_id: pipelineState.document_id || null,
        parse_status: safeString(pipelineState.parse_status, 40) || null,
        parse_stage: safeString(pipelineState.parse_stage, 60) || null,
        parse_progress_current: boundedCount(pipelineState.parse_progress_current),
        parse_progress_total: boundedCount(pipelineState.parse_progress_total),
        parse_summary: safeString(pipelineState.parse_summary, 500) || null,
        parse_error: safeString(pipelineState.parse_error, 500) || null,
        parse_run_id: safeString(pipelineState.parse_run_id, 80) || null
      }
    : null;
  return {
    client,
    transaction: {
      id: transaction.id,
      date: transaction.transaction_date || transaction.date || null,
      description: safeString(transaction.description || transaction.raw_description, 240),
      counterparty: safeString(transaction.contact || transaction.counterparty_guess, 120) || null,
      money_in: inAmt || null,
      money_out: outAmt || null,
      direction,
      currency: transaction.currency || transaction.account_currency || null,
      // Verdict-first: the coder's persisted account outranks the
      // parse-time classifier's category (the legacy layer it
      // superseded); the classifier only speaks when no verdict exists.
      ai_suggested_account:
        codingVerdict?.proposed_account || transaction.proposed_account || transaction.aiCat || null,
      ai_confidence: codingVerdict?.confidence || transaction.confidence || null,
      coding_verdict: codingVerdict,
      coding_correction_required: transaction.coding_correction_required || transaction.payload?.coding_correction_required || null,
      reconciliation_status: transaction.reconciliation_status || null,
      review_state: transaction.review_state || null
    },
    candidate_documents: candidateDocuments
      .slice(0, MAX_CANDIDATE_DOC_SUMMARIES)
      .map((doc) => ({
        id: doc.id,
        document_type: doc.document_type || null,
        filename: safeString(doc.filename, 200),
        counterparty: safeString(doc.vendor_name || doc.customer_name || '', 120) || null,
        total_amount: Number.isFinite(Number(doc.total_amount)) ? Number(doc.total_amount) : null,
        currency: doc.currency || null,
        document_date: doc.document_date || null,
        payment_status: doc.payment_status || null
      })),
    existing_match: existingMatch && existingMatch.matched_object_id
      ? {
          document_id: existingMatch.matched_object_id,
          status: existingMatch.status || null,
          source: existingMatch.source || null
        }
      : null,
    collision_group: collisionGroup && collisionGroup.focused_transaction_id
      ? {
          focused_transaction_id: safeString(collisionGroup.focused_transaction_id, 180),
          key: collisionGroup.key || null,
          transactions: (Array.isArray(collisionGroup.transactions) ? collisionGroup.transactions : []).slice(0, 20),
          documents: (Array.isArray(collisionGroup.documents) ? collisionGroup.documents : []).slice(0, 20),
          matches: (Array.isArray(collisionGroup.matches) ? collisionGroup.matches : []).slice(0, 80),
          suggested_date_pairs: (Array.isArray(collisionGroup.suggested_date_pairs)
            ? collisionGroup.suggested_date_pairs
            : []).slice(0, 20),
          complete_date_pairing: collisionGroup.complete_date_pairing === true,
          pairing_reason: safeString(collisionGroup.pairing_reason, 80) || null,
          available_evidence_for_focused_transaction:
            collisionGroup.available_evidence_for_focused_transaction === true,
          crossed_suggested_match_ids: (Array.isArray(collisionGroup.crossed_suggested_match_ids)
            ? collisionGroup.crossed_suggested_match_ids.map((id) => safeString(id, 180)).filter(Boolean)
            : []).slice(0, 60)
        }
      : null,
    pipeline_state: pipelineStateBlock,
    account_options: codingPolicy?.account_choices ? codingPolicy.account_choices.filter(choice => choice.kind === 'account').map(choice => choice.handle) : boundedAccountOptions.length ? boundedAccountOptions : null,
    tax_treatment_options: boundedTaxTreatmentOptions.length ? boundedTaxTreatmentOptions : null,
    coding_policy: codingPolicy,
    known_facts: (Array.isArray(firmFacts) ? firmFacts : [])
      .slice(0, 24)
      .map((fact) => ({
        id: safeString(fact.id, 64),
        scope: safeString(fact.scope, 24),
        subject: safeString(fact.subject, 120),
        fact: safeString(fact.fact, 300),
        confidence: safeString(fact.confidence, 12),
        status: safeString(fact.status, 24),
        // G−1(c) honest provenance: a legacy firm-keyed merchant fact
        // (pre-entity-scoping) may have been taught by ANOTHER venture —
        // the label lets the model weigh it and the receipt show it.
        ...(fact.legacy_firm_scope === true ? { legacy_firm_scope: true } : {})
      }))
      .filter((fact) => fact.fact),
    // Only draft/open asks on THIS line: a replied or closed ask is not a
    // lifecycle target, and listing one would invite a dead Apply button.
    known_asks: (() => {
      const bounded = (Array.isArray(knownAsks) ? knownAsks : [])
        .slice(0, 20)
        .map((ask) => ({
          id: safeString(ask.id, 120),
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
    ...(Array.isArray(playbooks) && playbooks.length ? { playbooks } : {}),
    today: toLocalIsoDay(now) // host-local day (audit F-11)
  };
};

// follow_up_at must be today or later. The model anchored a follow-up
// to the TRANSACTION's period once (a 2024-02-15 reminder proposed in
// June 2026 — dead on arrival). Past dates clamp forward to today;
// unparseable dates drop to null. Pure; exported for tests.
export const __clampFollowUpAt = (value, { now = new Date() } = {}) => {
  const raw = safeString(value, 40).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  // Host-local "today" (audit F-11); the compare is against that day's UTC
  // midnight, the same anchor a bare model day parses to.
  const today = toLocalIsoDay(now);
  return parsed.getTime() < toUtcDayMs(today) ? today : raw;
};

// ─── Anthropic Messages API client ───────────────────────────────────────

// This surface proposes one-click postings and mints merchant rules
// that auto-categorise every future charge — a judgment call, not bulk
// filtering. Running it on the cheapest tier was the Failure-A
// anti-pattern (CLAUDE.md). Strong pair everywhere (the #350 firm
// decision: at $99/client the API delta is noise next to one wrong
// posting) — sonnet here was the leftover, not a choice.
// TRANSACTION_CHAT_MODEL stays the override knob.
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
export const __DEFAULT_ANTHROPIC_MODEL = DEFAULT_ANTHROPIC_MODEL;

let dotEnvCache = null;
const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // best-effort
  }
  dotEnvCache = vars;
  return vars;
};

const getAnthropicConfig = () => {
  const dotEnv = readDotEnv();
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || dotEnv.ANTHROPIC_API_KEY || '',
    model: process.env.TRANSACTION_CHAT_MODEL || dotEnv.TRANSACTION_CHAT_MODEL || DEFAULT_ANTHROPIC_MODEL
  };
};

const DEFAULT_CONTEXT_ACK = 'Understood. I have the workspace context. How can I help with this transaction?';

const buildAnthropicMessages = ({ context, history, userMessage, contextAck = DEFAULT_CONTEXT_ACK }) => {
  const recent = (history || []).slice(-MAX_HISTORY_MESSAGES);
  const messages = [];
  messages.push({
    role: 'user',
    content: `WORKSPACE_CONTEXT (do not echo verbatim; reference values when useful):\n${JSON.stringify(context, null, 2)}`
  });
  messages.push({
    role: 'assistant',
    content: contextAck
  });
  for (const msg of recent) {
    // A client reply is persisted as role:'system' (kind
    // 'client_reply_received'). Surface it to the model behind a
    // [CLIENT REPLY] marker instead of dropping it, so the model can
    // reference what the CLIENT actually said AND tell it apart from the
    // FIRM's turns. Skipping it (the prior behaviour) left the model with
    // no client voice at all — half of why it fabricated "you mentioned"
    // attributions; the firm⇄client boundary in the prompt is the other
    // half. Other system messages stay out of the model context.
    const isClientReply = msg.role === 'system' && msg.payload?.kind === 'client_reply_received';
    if (msg.role !== 'user' && msg.role !== 'assistant' && !isClientReply) continue;
    let content = safeString(msg.content, 4000);
    if (msg.role === 'assistant' && Array.isArray(msg.payload?.actions)) {
      const applied = msg.payload.actions
        .filter((a) => a.status === 'applied')
        .map((a) => `${a.type}: ${a.reason || a.question || a.account_name || ''}`.slice(0, 120));
      if (applied.length) {
        content += `\n[ALREADY APPLIED: ${applied.join('; ')}]`;
      }
    }
    if (msg.payload?.kind === 'client_question_sent') {
      content = `[SENT TO CLIENT]: ${content}`;
    } else if (isClientReply) {
      // The client's OWN words — the only turns that may be quoted back
      // to the client as "you said".
      content = `[CLIENT REPLY — the client's own words, not the firm]: ${content}`;
    }
    // A surfaced client reply rides as a user turn (external input to the
    // model); the marker, not the role, carries the speaker identity.
    messages.push({ role: isClientReply ? 'user' : msg.role, content });
  }
  messages.push({
    role: 'user',
    content: safeString(userMessage, MAX_USER_MESSAGE_CHARS)
  });
  return messages;
};

// The structured-reply tool. The {text, actions} envelope is enforced at
// the API layer via tool_choice (below), NOT asked for in the prompt: a
// prompt instruction is not a guarantee — opus answered a repeated mass
// command in conversational prose, extractJsonFromText found no JSON, and
// the turn failed as invalid_response_shape (a mass loan command). A
// forced tool makes the structured reply mandatory; the model cannot
// answer in free text. (CLAUDE.md: enforce the envelope — system
// correctness — rather than lean on prompt adherence.)
const STRUCTURED_REPLY_TOOL_NAME = 'submit_structured_reply';

const structuredReplyTool = (responseSchema) => ({
  name: STRUCTURED_REPLY_TOOL_NAME,
  description:
    'Submit your reply to the firm. `text` is your conversational message; ' +
    '`actions` is the list of structured actions you propose (may be empty). ' +
    'You MUST answer by calling this tool — never reply in free-form text.',
  input_schema: responseSchema
});

const defaultCallAnthropic = async ({ apiKey, model, messages, signal, system, tool }) =>
  fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    signal,
    body: JSON.stringify({
      model,
      // 8192 is a cap, not a target. The feed chat is a MASS-command
      // surface — a reply can list many matched rows and one
      // transaction_id per row — so this leaves ample headroom; short
      // single-row per-transaction replies are unaffected in cost or
      // latency.
      max_tokens: 8192,
      system: system ?? SYSTEM_PROMPT,
      // Force the structured-reply tool so the model cannot answer in free
      // text — the {text, actions} envelope is guaranteed by the API.
      ...(tool ? { tools: [tool], tool_choice: { type: 'tool', name: tool.name } } : {}),
      messages
    })
  });

const extractJsonFromText = (text = '') => {
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return null;
  }
};

// Anchor the system prompt to the context's `today` so the model resolves
// relative dates/periods against REAL time, not its training-era prior. The
// Telegram "total expenses this year?" → 2025 P&L incident (2026-07-24): the
// portal chat minted a request_report period of 2025 because nothing in the
// instructions named the current date — `today` sat as the last key of the
// WORKSPACE_CONTEXT JSON, unreferenced, and the model fell back to its
// internal sense of "now". Same failure class as the 2024-02-15 follow-up
// anchored to the transaction's period (the __clampFollowUpAt comment below);
// this is the general fix at the ONE seam all chat surfaces share (portal
// chat + report narration + transaction chat + feed chat). No `today` in the
// context (e.g. the no-transaction fallback context) ⇒ prompt unchanged.
// Exported for tests.
export const __anchorSystemPromptToToday = (systemPrompt, context) => {
  const today = context?.today;
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return systemPrompt;
  return `${systemPrompt}\n\nToday is ${today}. Resolve every relative date or period ("this year", "this month", "last month", "YTD") against this date — never from memory, and never from the period of the data in the context. A "this year" question on ${today.slice(0, 4)}-xx-xx means the ${today.slice(0, 4)} calendar year.`;
};

// Generic structured-JSON Anthropic chat turn — the shared engine
// behind the per-transaction chat and the feed-level mass-command
// chat (feedChat.js). One client, one config (TRANSACTION_CHAT_MODEL
// stays the override knob for both surfaces), one retry contract.
// Discriminated-union return — same shape as documentChat for
// consistent logging across LLM-touching modules:
//   { kind: 'ok', text, actions, model }
//   { kind: 'failed', code, reason }
export const generateStructuredAnthropicReply = async ({
  systemPrompt,
  responseSchema,
  contextAck,
  context,
  history = [],
  userMessage,
  validateReply = null,
  __callAnthropic = defaultCallAnthropic,
  __config = null,
  signal
} = {}) => {
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return { kind: 'failed', code: 'validation_error', reason: 'empty_user_message' };
  }
  const config = __config || getAnthropicConfig();
  if (!config.apiKey) {
    return { kind: 'failed', code: 'anthropic_not_configured', reason: 'anthropic_not_configured' };
  }
  const nativeMenu = nativeAccountChoices(context?.coding_policy?.native_chart);
  const promptContext = context?.ventures
    ? { ...context, ventures: context.ventures.map(venture => nativeCodingPromptProjection(venture, nativeAccountChoices(venture.coding_policy?.native_chart))) }
    : nativeCodingPromptProjection(context, nativeMenu);
  if (nativeMenu && responseSchema?.properties?.actions?.items?.properties?.account_name) {
    responseSchema = structuredClone(responseSchema);
    responseSchema.properties.actions.items.properties.type.enum = responseSchema.properties.actions.items.properties.type.enum.filter(type => !['mark_personal', 'remember_merchant'].includes(type));
    responseSchema.properties.actions.items.properties.account_name.enum = [...nativeMenu.choices.filter(choice => choice.kind === 'account').map(choice => choice.handle), null];
    systemPrompt += '\nFor this fixed native chart, use apply_category/recode_decided with an offered handle for a supported treatment, or ask_client for a missing fact. The mark_personal and remember_merchant shortcuts have no native identity consumer and are unavailable.';
  }
  const messages = buildAnthropicMessages({ context: promptContext, history, userMessage, contextAck });
  // The {text, actions} envelope is enforced as a FORCED tool (tool_choice
  // in defaultCallAnthropic), not asked for in the prompt — a prompt
  // instruction did not hold (opus answered a repeated mass command in
  // prose). The behavioural rules stay in the system prompt; the tool
  // guarantees the shape.
  const tool = structuredReplyTool(responseSchema);

  const attempt = async () => {
    let response;
    try {
      response = await __callAnthropic({
        apiKey: config.apiKey,
        model: config.model,
        messages,
        signal,
        // The date anchor rides the system prompt (not the context JSON) so
        // relative-date resolution has an instruction-level anchor.
        system: __anchorSystemPromptToToday(systemPrompt, context),
        tool
      });
    } catch (err) {
      return { kind: 'failed', code: 'anthropic_network', reason: err?.message || 'network_error' };
    }
    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      return {
        kind: 'failed',
        code: `anthropic_${response.status || 'unknown'}`,
        reason: errBody?.error?.message || `anthropic_${response.status || 'unknown'}`
      };
    }
    let parsed;
    let stopReason = null;
    let rawText = '';
    try {
      const raw = await response.json();
      stopReason = raw?.stop_reason || null;
      const blocks = Array.isArray(raw?.content) ? raw.content : [];
      const toolUse = blocks.find((b) => b?.type === 'tool_use');
      if (toolUse && toolUse.input && typeof toolUse.input === 'object') {
        // The enforced path: the structured input arrives already parsed.
        parsed = toolUse.input;
        rawText = JSON.stringify(toolUse.input);
      } else {
        // No tool_use block: the model replied in free text (the failure
        // this fix prevents) or truncated before the tool block closed.
        // Salvage any JSON from the text as a last resort, and keep the
        // prose for the diagnostic snippet so the cause stays on the
        // receipt.
        rawText = blocks.find((b) => typeof b?.text === 'string')?.text || '';
        parsed = extractJsonFromText(rawText);
      }
    } catch (err) {
      return { kind: 'failed', code: 'parse_error', reason: err?.message || 'parse_error' };
    }
    if (!parsed || typeof parsed.text !== 'string' || !Array.isArray(parsed.actions)) {
      // Make the failure self-describing instead of an opaque
      // "invalid_response_shape". With the structured-reply tool forced, a
      // well-formed reply always arrives as a tool_use block; reaching
      // here means either truncation (stop_reason 'max_tokens', before the
      // tool block closed) or — rarely — no tool_use block at all. Name
      // the truncation distinctly and carry the stop_reason + model + a
      // bounded snippet so the cause stays on the receipt (the
      // diagnose-don't-guess + model-id rails).
      const truncated = stopReason === 'max_tokens';
      console.warn(
        `[structured-chat] response failed validation (stop_reason=${stopReason}): ${String(rawText).slice(0, 200)}`
      );
      return {
        kind: 'failed',
        code: 'validation_error',
        reason: truncated ? 'response_truncated_max_tokens' : 'invalid_response_shape',
        // Carry the model id on the diagnostic too. A non-conforming
        // structured reply (stop_reason end_turn, not max_tokens) is the
        // exact fingerprint of a silently downgraded model — CLAUDE.md
        // "the model id is part of the receipt" — so the receipt must say
        // WHICH model produced it, read from the live call config rather
        // than a code default.
        diagnostic: { stop_reason: stopReason, model: config.model, raw_snippet: String(rawText).slice(0, 280) }
      };
    }
    const normalizedReply = {
      kind: 'ok',
      text: parsed.text,
      actions: parsed.actions.map((a) => ({
        ...a,
        follow_up_at: __clampFollowUpAt(a.follow_up_at),
        status: 'proposed'
      })),
      // The triage receipt rides through generically; each surface
      // validates it against the contract (TRIAGE_RECEIPT_SCHEMA) and
      // persists it on the assistant message. Raw here — null if the
      // model (or a mocked test) returned none.
      triage: parsed.triage ?? null,
      model: config.model
    };
    const semanticRefusal = typeof validateReply === 'function'
      ? validateReply(normalizedReply)
      : null;
    if (semanticRefusal) {
      console.warn(`[structured-chat] response failed semantic validation: ${semanticRefusal}`);
      return {
        kind: 'failed',
        code: 'validation_error',
        reason: semanticRefusal,
        diagnostic: { stop_reason: stopReason, model: config.model, raw_snippet: String(rawText).slice(0, 280) }
      };
    }
    return normalizedReply;
  };

  const first = await attempt();
  if (first.kind === 'ok' || first.code !== 'validation_error') return first;
  return attempt();
};

// Validate the triage receipt against the contract (operatorContract.js
// TRIAGE_RECEIPT_SCHEMA). A malformed — or absent — triage degrades to
// null: it must never break the turn (the reply text + actions stand),
// but a contract violation is logged, never swallowed silently. Shared by
// both chat surfaces (feedChat.js imports this).
export const __validateTriageReceipt = (reply) => {
  if (!reply || reply.kind !== 'ok') return reply;
  const { ok, errors } = validateOperatorContract(TRIAGE_RECEIPT_SCHEMA, reply.triage);
  if (!ok && reply.triage != null) {
    console.warn(`[structured-chat] triage failed contract validation, dropping it: ${errors[0]}`);
  }
  return { ...reply, triage: ok ? reply.triage : null };
};

export const generateTransactionChatReply = async ({
  context,
  history = [],
  userMessage,
  __callAnthropic = defaultCallAnthropic,
  __config = null,
  signal
} = {}) => {
  const reply = __validateTriageReceipt(
    await generateStructuredAnthropicReply({
      systemPrompt: SYSTEM_PROMPT,
      responseSchema: TRANSACTION_CHAT_RESPONSE_SCHEMA,
      context,
      history,
      userMessage,
      validateReply: (reply) => __validateTransactionChatReply(reply, { context }),
      __callAnthropic,
      __config,
      signal
    })
  );
  if (reply.kind !== 'ok') return reply;
  return { ...reply, actions: reply.actions.map((action) =>
    ['apply_category', 'recode_decided', 'mark_personal'].includes(action.type)
      ? { ...nativeCodingChatAction(action, context, [context?.transaction?.id]), coding_policy: codingPolicyReceiptForChatTransaction(context, context?.transaction) }
      : action) };
};

// Keep-layer semantic invariant: every card can be applied independently, so
// a later companion action cannot make an earlier reject safe. A model reply
// may not expose reject_match at all on this surface. It must compile the same
// intent to link_document (known replacement) or ask_client (owner terminal).
// The generic structured engine retries one validation failure; a second
// unsafe reply fails loudly and no incomplete Apply button mints.
export const __validateTransactionChatReply = (reply, { context = null } = {}) => {
  const actions = Array.isArray(reply?.actions) ? reply.actions : [];
  if (context?.coding_policy?.native_chart && actions.some(action => ['mark_personal', 'remember_merchant'].includes(action.type))) return 'native_action_not_supported';
  if (actions.some((action) => action?.type === 'reject_match')) {
    return 'reject_match_not_terminal_on_independent_apply_surface';
  }
  const collisionGroup = context?.collision_group || null;
  const completePairs = collisionGroup?.complete_date_pairing === true
    ? (Array.isArray(collisionGroup.suggested_date_pairs) ? collisionGroup.suggested_date_pairs : [])
    : [];
  if (collisionGroup?.available_evidence_for_focused_transaction === true
      && actions.some((action) => action?.type === 'ask_client'
        && ['receipt', 'supporting_document'].includes(String(action.evidence_type || '')))) {
    return 'local_evidence_available_before_client_ask';
  }
  if (completePairs.length >= 2
      && actions.some((action) => ['link_document', 'accept_match'].includes(action?.type))) {
    return 'complete_collision_group_requires_atomic_resolution';
  }
  for (const action of actions.filter((candidate) => candidate?.type === 'resolve_match_group')) {
    if (completePairs.length < 2) return 'resolve_match_group_without_complete_pairing';
    const expected = completePairs
      .map((pair) => `${pair.transaction_id}|${pair.document_id}`)
      .sort();
    const proposedPairs = Array.isArray(action.match_pairs) ? action.match_pairs : [];
    const proposed = proposedPairs
      .map((pair) => `${pair?.transaction_id || ''}|${pair?.document_id || ''}`)
      .sort();
    if (new Set(proposed).size !== proposed.length
        || proposed.length !== expected.length
        || proposed.some((key, index) => key !== expected[index])) {
      return 'resolve_match_group_pairs_must_match_server_group';
    }
  }
  return null;
};

// ─── Apply-side coding patch (pure) ──────────────────────────────────────

// The review-item patch a chat apply_category writes — extracted pure so
// the G1d invariant is pinnable: an ordinary chat correction NEVER sets
// learn_rule (or any rule-learning flag), so it can never mint a client
// rule. Until build-spec PR-11 the api.js apply block hardcoded
// `learn_rule = true` here — an unchosen, chat-unreceipted rule mint from
// every ordinary correction (audited at the writer, invisible in the chat
// receipt, cascading onto sibling rows). Durable teaching is the explicit
// remember_merchant verb; the drawer's row-Apply keeps its own explicit
// remember toggle (`remember_merchant_rule`), which is a user choice, not
// this path.
export const buildApplyCategoryCodingPatch = ({ action = {}, accountCode = null } = {}) => {
  const patch = {
    status: 'accepted',
    review_state: 'accepted',
    category: action.account_name,
    account_name: action.account_name,
    account_label: action.account_name,
    // A local-ledger palette has names but no external chart codes. Leaving
    // this absent makes the coding writer's coalesce preserve the PRIOR code,
    // splitting `category` from `account_code` on exactly the correction path.
    // Name-as-code is the transaction-layer convention for an unmatched local
    // account; Donna posting normalizes it back to a code-less ledger account.
    account_code: accountCode || action.account_code || action.account_name
  };
  if (accountCode || action.account_code) {
    patch.xero_account_code = accountCode || action.account_code;
  }
  if (action.tax_treatment) patch.xero_tax_type = action.tax_treatment;
  if (action.contact_name) patch.contact = action.contact_name;
  return patch;
};

// ─── Persistence helpers (DB-side) ───────────────────────────────────────

const messageIdFor = ({ transactionId, kind, createdAtMs }) => {
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const stamp = String(createdAtMs || Date.now());
  const raw = `${transactionId}|${kind}|${stamp}|${crypto.randomBytes(4).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `txchat-${slug(transactionId)}-${kind}-${hash}`;
};

export const newTransactionChatMessageId = messageIdFor;
