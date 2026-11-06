// Document chat — PR 27.
//
// Conversational case-resolution surface for the document artifact.
// The LLM returns conversational text plus zero-or-more *proposed*
// actions. The firm executes them via separate write paths (PR 28+
// will wire link_transaction; PR 29 will wire notes, immaterial,
// and evidence requests). PR 27 ships the chat plumbing only —
// messages are persisted, action cards render, but Apply buttons
// are disabled. No backend writes other than chat messages.
//
// LLM provider: OpenAI Responses API with strict JSON-schema
// structured output. Direct fetch, matching the receipt /
// supplierBill / bankLineClassifier pattern (no SDK dependency).
//
// Persistence: `document_chat_messages` (migration 015) keyed on
// (firm_id, client_id, document_id). Reopening an artifact resumes
// the thread. Transaction-search and filter state stays local in
// the UI — only messages and proposed/applied actions persist.
//
// Action schema (v1) — six explicit types plus a `future_action`
// slot so the model can propose actions we haven't implemented yet
// without breaking the strict schema. The frontend renders all
// types, but Apply is disabled until the corresponding writer
// lands.

import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { toIsoDay } from './dates.js';

// Match-reasoning and client-question drafting are judgment calls, not
// bulk filtering — a nano-class default here was the Failure-A
// anti-pattern (CLAUDE.md). OPENAI_MODEL_CHAT stays the override knob.
const DEFAULT_MODEL = 'gpt-5.4';
const MAX_HISTORY_MESSAGES = 24;
const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_CANDIDATE_TX_SUMMARIES = 30;

// ─── Public action vocabulary ────────────────────────────────────────────

// v1 actions supported in the schema. The first six are the
// near-term targets in the user-stated direction (PR 27 ships them
// as proposed-only; PRs 28-29 wire the Apply paths). `future_action`
// is the explicit slot for things the model wants to propose that
// we haven't designed yet — the UI renders these as "Apply not yet
// supported" with the model's free-text `future_type` description.
export const DOCUMENT_CHAT_ACTION_TYPES = Object.freeze([
  'explain_match_reasoning',
  'search_transactions',
  'link_transaction',
  'draft_evidence_request',
  'leave_review_note',
  'mark_immaterial',
  'correct_document_field',
  'future_action'
]);

// Actions whose Apply path is wired. PR 27 shipped this empty;
// PR 28 added `link_transaction` (the existing manual
// reconciliation-match writer, `createManualReconciliationMatchInDb`).
// G1(a) (godmode build-spec PR-8) wires the remaining three through
// the SAME spine to EXISTING writers (INV-1, no new writers):
//   draft_evidence_request → createClientEvidenceRequestInDb with the
//     document anchor (the FI-9 doc-first pattern, per-document dedup);
//   mark_immaterial → updateDocumentInDb carrying an `immaterial`
//     payload verdict, gated by evaluateMarkImmaterialPreflight below;
//   leave_review_note → updateDocumentInDb (payload.reviewer_note,
//     the same single-key-overwrite shape feed chat uses on the
//     review queue).
//
// The frontend reads this set (via the GET endpoint response) to
// decide whether to enable an Apply button. Server-side, the
// /apply endpoint also re-validates the action type is in this
// list so a stale FE can't trigger a not-yet-wired writer.
export const DOCUMENT_CHAT_APPLIABLE_ACTION_TYPES = Object.freeze([
  'link_transaction',
  'draft_evidence_request',
  'leave_review_note',
  'mark_immaterial',
  'correct_document_field'
]);

// The message lookup has already verified firm/client/document scope. Bind
// its persisted document identity for the shared capability amount resolver;
// model-authored target IDs never supply the authority context.
export const bindDocumentChatCorrectionTarget = (message) => {
  if (!message?.document_id || !Array.isArray(message.payload?.actions)) return message;
  return { ...message, payload: { ...message.payload, actions: message.payload.actions.map((action) => (
    action?.type === 'correct_document_field' ? {
      type: action.type, status: action.status, reason: action.reason,
      field_path: action.field_path, corrected_value: action.corrected_value,
      document_id: message.document_id
    } : action
  )) } };
};

// ─── mark_immaterial preflight (G1(a), the Keep layer) ───────────────────
//
// Deterministic refusals where arithmetic can rule — the same posture as
// the disposition lane's "auto_explain requires immaterial" guard, using
// the same ceiling (getDispositionMaterialityCeiling, finite default).
// Pure: the route supplies the document row + ceiling. Returns
//   { allowed, checks: [{kind, status: 'ok'|'blocked'|'warning', detail}],
//     consequence }
// Blocked → the action STAYS PROPOSED (422 with this verdict on the
// body); the operator corrects the document or narrows the claim.
// Recurrence is honestly `warning: unknown` in v1 — never a silent pass.
export const evaluateMarkImmaterialPreflight = ({
  document = {},
  action = {},
  ceiling = null
} = {}) => {
  const checks = [];
  const payload = (document.payload && typeof document.payload === 'object') ? document.payload : {};
  const rawAmount = document.total_amount ?? payload.total_amount ?? null;
  const amount = rawAmount == null || rawAmount === '' ? null : Math.abs(Number(rawAmount));

  if (!Number.isFinite(amount)) {
    checks.push({
      kind: 'amount_known',
      status: 'blocked',
      detail: 'The document has no readable total amount, so the immateriality claim cannot be verified by arithmetic. Correct the amount first.'
    });
  } else {
    checks.push({ kind: 'amount_known', status: 'ok', detail: `total_amount ${amount}` });
    if (Number.isFinite(ceiling) && amount > ceiling) {
      checks.push({
        kind: 'materiality_ceiling',
        status: 'blocked',
        detail: `Amount ${amount} exceeds the materiality ceiling ${ceiling} — material by arithmetic, not markable immaterial.`
      });
    } else if (Number.isFinite(ceiling)) {
      checks.push({ kind: 'materiality_ceiling', status: 'ok', detail: `${amount} ≤ ceiling ${ceiling}` });
    } else {
      checks.push({
        kind: 'materiality_ceiling',
        status: 'blocked',
        detail: 'No finite materiality ceiling is configured — refusing rather than guessing (the F1 posture: an unset ceiling never means infinity).'
      });
    }
    const claimed = action.threshold_amount == null ? null : Math.abs(Number(action.threshold_amount));
    if (Number.isFinite(claimed) && amount > claimed) {
      checks.push({
        kind: 'stated_threshold',
        status: 'blocked',
        detail: `Amount ${amount} exceeds the action's own stated threshold ${claimed}.`
      });
    } else if (Number.isFinite(claimed)) {
      checks.push({ kind: 'stated_threshold', status: 'ok', detail: `${amount} ≤ stated threshold ${claimed}` });
    }
  }

  const rawTax = document.tax_amount ?? payload.tax_amount ?? null;
  const tax = rawTax == null || rawTax === '' ? null : Math.abs(Number(rawTax));
  if (Number.isFinite(tax) && tax > 0) {
    checks.push({
      kind: 'tax_impact',
      status: 'blocked',
      detail: `The document carries a tax amount (${tax}) — marking it immaterial hides a tax-relevant record. Resolve it instead.`
    });
  } else {
    checks.push({ kind: 'tax_impact', status: 'ok', detail: 'no tax amount on the document' });
  }

  const summary = (document.parse_summary && typeof document.parse_summary === 'object' && document.parse_summary)
    || (payload.parse_summary && typeof payload.parse_summary === 'object' && payload.parse_summary)
    || {};
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  if (warnings.includes('amount_mismatch')) {
    checks.push({
      kind: 'red_flags',
      status: 'blocked',
      detail: 'The parse flagged amount_mismatch (subtotal + tax ≠ total) — an arithmetically suspect document cannot rest as immaterial.'
    });
  } else {
    checks.push({ kind: 'red_flags', status: 'ok', detail: warnings.length ? `warnings: ${warnings.join(', ')}` : 'no parse warnings' });
  }

  checks.push({
    kind: 'recurrence',
    status: 'warning',
    detail: 'Recurrence is not evaluated in v1 — if this vendor bills repeatedly, the aggregate may be material even when each document is not.'
  });

  const allowed = !checks.some((check) => check.status === 'blocked');
  return {
    allowed,
    checks,
    consequence: allowed
      ? 'Marks this document immaterial: it rests as reviewed-immaterial and no longer awaits resolution. No ledger entry, no match, and no owner ask is created. Reversible by clearing the flag.'
      : 'Refused: the document stays proposed-unresolved. Correct the blocking condition or resolve the document through a match, coding, or an owner ask.'
  };
};

// ─── Structured-output schema ────────────────────────────────────────────

// Single object per action with all sub-type fields nullable. The
// `type` discriminator tells the FE which fields to read. This is
// the only shape that round-trips through OpenAI's strict mode
// without a fragile anyOf union — the existing receipt /
// supplierBill schemas use the same pattern.
//
// `reason` is required on every action regardless of type so the
// UI can always show the firm a one-line justification for the
// proposal.
const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'type',
    'reason',
    'summary',
    'signals',
    'blockers',
    'amount_eq',
    'date_from',
    'date_to',
    'description_contains',
    'currency',
    'direction',
    'transaction_id',
    'recipient',
    'question',
    'note',
    'follow_up_at',
    'threshold_amount',
    'field_path',
    'corrected_value',
    'future_type'
  ],
  properties: {
    type: { type: 'string', enum: DOCUMENT_CHAT_ACTION_TYPES },
    // One-line rationale shown on the action card. The model
    // explains why it's proposing this action.
    reason: { type: 'string' },
    // explain_match_reasoning
    summary: { type: ['string', 'null'] },
    signals: { type: ['array', 'null'], items: { type: 'string' } },
    blockers: { type: ['array', 'null'], items: { type: 'string' } },
    // search_transactions
    amount_eq: { type: ['number', 'null'] },
    date_from: { type: ['string', 'null'] },
    date_to: { type: ['string', 'null'] },
    description_contains: { type: ['string', 'null'] },
    currency: { type: ['string', 'null'] },
    direction: {
      type: ['string', 'null'],
      enum: ['money_in', 'money_out', null]
    },
    // link_transaction
    transaction_id: { type: ['string', 'null'] },
    // draft_evidence_request
    recipient: {
      type: ['string', 'null'],
      enum: ['customer', 'vendor', 'client_owner', null]
    },
    question: { type: ['string', 'null'] },
    // leave_review_note
    note: { type: ['string', 'null'] },
    follow_up_at: { type: ['string', 'null'] },
    // mark_immaterial
    threshold_amount: { type: ['number', 'null'] },
    // The document surface currently corrects denomination only. Other field
    // workflows retain their existing entry points and admission checks.
    field_path: { type: ['string', 'null'], enum: ['currency', null] },
    corrected_value: { type: ['string', 'null'] },
    // future_action — model can propose an action type not yet in
    // DOCUMENT_CHAT_ACTION_TYPES via free-text `future_type`. The
    // UI renders it disabled with the model's description.
    future_type: { type: ['string', 'null'] }
  }
};

export const DOCUMENT_CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'actions'],
  properties: {
    // Conversational reply rendered above the action cards. Plain
    // text only — no markdown rendering in v1 to keep the FE simple
    // and the LLM grounded in the workspace it's in.
    text: { type: 'string' },
    actions: { type: 'array', items: ACTION_SCHEMA }
  }
};

// ─── System prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are Donna, an accounting assistant embedded in a document
resolution workspace. The firm has opened a single document
(receipt, supplier bill, sales invoice, or contract) and wants to
either link it to a bank transaction or otherwise resolve it.

You CANNOT perform actions directly. You can only:
  1. Reply in plain conversational text.
  2. Propose zero or more structured actions for the firm to
     review and apply.

WHO YOU ARE TALKING TO — read before every reply:

You are talking to the FIRM (the bookkeeper operating Donna). The
customer, vendor, or client owner a question might go to is NOT in
this conversation — only the firm is. Two hard rules:

  1. Everything the firm types here is the firm INSTRUCTING or
     INFORMING you: a decision, a command, or a fact the firm knows.
     When the firm states what this document IS ("a Mac charger",
     "personal", "rent") or notes an artifact is missing ("receipt
     missing"), that is the firm's word and is SETTLED — never
     something the customer, vendor, or owner told you. Do not ask
     them to re-explain what the firm just explained.

  2. A draft_evidence_request question is a NEW outbound message to
     someone who has said NOTHING in this thread.
     NEVER attribute the firm's words to the recipient — do not write
     "you mentioned", "you said", "as you noted", or "you told us"
     about anything the FIRM stated. If you must reference a
     firm-supplied fact, state it neutrally ("our records note this as
     a Mac charger"); otherwise just ask for what is needed. Only a
     turn marked [CLIENT REPLY] is the recipient's own words and may
     be quoted back as "you said".

Turn markers in the history: an unmarked turn (and the turn you are
replying to) is the FIRM; [CLIENT REPLY] is the recipient's actual
response. If there is no [CLIENT REPLY] turn, the recipient has told
you nothing — ask for what you need; do not invent that they said
something.

Your reply will be persisted in the document's case file. Be
concise — the firm is mid-task. Reference specific signals
(amount, date, vendor, currency, direction) when relevant.

Available action types:

  correct_document_field — for receipts and supplier bills only, confirm the document's currency from an explicit
    human correction. Fill field_path: "currency" and corrected_value: the
    confirmed ISO currency code, or null only when the person explicitly clears
    it. When the persisted currency is unknown, explain that the denomination
    must be confirmed here before posting. Never choose currency from country,
    company location, a filename, a bank account or absence. Do not ask for a
    document already present. The focused document is selected by the server;
    a posted document requires a ledger adjustment instead of a source edit.

  explain_match_reasoning — explain why a tx is or is not a credible
    match. Fill: summary, signals[], blockers[]. No backend write
    happens; the firm reads your reasoning.

  search_transactions — propose narrowing the Search All
    Transactions list. Fill any of: amount_eq, date_from, date_to,
    description_contains, currency, direction. The firm clicks
    Apply to narrow their view; no DB change.

  link_transaction — propose linking a specific bank transaction
    to this document. Fill: transaction_id. The firm reviews and
    clicks Apply; the existing manual-link writer runs. Applying it
    CONFIRMS the match and settles that bank line as reconciled in
    the same transaction — linking IS the reconcile; never tell the
    firm a further accept step remains after it applies.

  draft_evidence_request — propose asking the customer / vendor /
    client owner a question to unblock resolution. Fill: recipient,
    question. The firm reviews the draft and sends.

    Ask ONLY for something genuinely missing that the firm has NOT
    already supplied — typically a MISSING ARTIFACT (a receipt or
    supporting document), not a business purpose the firm already
    stated. If the firm explained what the document is and only noted
    a record is missing, request that record; do NOT ask the recipient
    to re-confirm the purpose the firm gave you. Draft the question
    without attributing anything to the recipient (WHO YOU ARE TALKING
    TO, rule 2): never "you mentioned it was X" — write "our records
    note this as X", or simply ask for the document.

  leave_review_note — propose a note attached to this document for
    later review or month-end follow-up. Fill: note, optionally
    follow_up_at (ISO date).

  mark_immaterial — propose marking the document immaterial (does
    not require resolution). Fill: threshold_amount if the firm
    has a stated materiality threshold; reason should explain why.

  future_action — for ideas not in the list above (split match,
    classification, duplicate detection, etc). Fill: future_type
    (a short name) and reason. The firm sees the proposal but
    cannot apply it yet.

Always include a one-line \`reason\` on every action.

Honour the workspace context the user provides — refer to the
parsed document fields, transaction candidates, and any prior
conversation turns. If you have nothing useful to propose, return
text only with empty actions[].
`.trim();

// The firm⇄client boundary (WHO YOU ARE TALKING TO) and the
// missing-artifact-only ask rule are load-bearing — pinned in
// documentChat.test.js so a future edit can't silently drop the #397
// fix on this third client-question surface.
export const __DOCUMENT_CHAT_SYSTEM_PROMPT = SYSTEM_PROMPT;

// ─── Context building ────────────────────────────────────────────────────

const safeString = (value, max = 2000) => {
  if (value == null) return '';
  return String(value).slice(0, max);
};

// Build the per-message context the model sees. Keeps free-text
// fields bounded so a malicious filename or huge candidate list
// can't blow up the token budget.
export const buildDocumentChatContext = ({
  document,
  candidates = []
} = {}) => {
  if (!document) return { document: null, candidates: [] };
  const counterparty = document.document_type === 'sales_invoice'
    ? document.customer_name || null
    : document.vendor_name
      || document?.parse_summary?.semantic?.merchant_display_name
      || null;
  const matchInfo = document.reconciliation_match || null;
  return {
    document: {
      id: document.id,
      document_type: document.document_type || null,
      filename: safeString(document.filename, 200),
      counterparty: counterparty ? safeString(counterparty, 120) : null,
      total_amount: Number.isFinite(Number(document.total_amount))
        ? Number(document.total_amount)
        : null,
      currency: document.currency || null,
      document_date: toIsoDay(document.document_date) || null,
      due_date: toIsoDay(document.due_date) || null,
      payment_status: document.payment_status || null,
      parse_status: document.parse_status || null,
      reconciliation_match: matchInfo || null,
      reconciliation_matches: document.reconciliation_matches || []
    },
    candidates: candidates
      .slice(0, MAX_CANDIDATE_TX_SUMMARIES)
      .map((tx) => ({
        id: tx.id,
        date: toIsoDay(tx.date || tx.transaction_date) || null,
        description: safeString(tx.description || tx.raw_description, 160),
        money_in: Number(tx.money_in || 0),
        money_out: Number(tx.money_out || 0),
        currency: tx.currency || null,
        reconciliation_status: tx.reconciliation_status || null
      }))
  };
};

// ─── OpenAI Responses API client ─────────────────────────────────────────

// Minimal dotenv fallback — mirrors the pattern in receipt.js /
// bankLineClassifier.js. Reads .env once per process.
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
    // best-effort dotenv fallback
  }
  dotEnvCache = vars;
  return vars;
};

const getOpenAiConfig = () => {
  const dotEnv = readDotEnv();
  return {
    apiKey: process.env.OPENAI_API_KEY || dotEnv.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL_CHAT || process.env.OPENAI_MODEL || dotEnv.OPENAI_MODEL || DEFAULT_MODEL
  };
};

const outputTextFromResponse = (response = {}) => {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text;
    }
  }
  return '';
};

// Build the OpenAI `input` array from the chat thread. We collapse
// system messages into the system prompt, and feed user/assistant
// turns as alternating roles. The model sees only the last
// MAX_HISTORY_MESSAGES turns to keep the token bill bounded.
const buildOpenAiInput = ({ context, history, userMessage }) => {
  const recent = (history || []).slice(-MAX_HISTORY_MESSAGES);
  const input = [];
  // Workspace context turn — pinned at the top of each call so the
  // model always sees the current document and candidate pool. This
  // is more reliable than relying on chat history to carry context.
  input.push({
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: `WORKSPACE_CONTEXT (do not echo verbatim; reference values when useful):\n${JSON.stringify(context, null, 2)}`
      }
    ]
  });
  for (const msg of recent) {
    // A recipient reply is persisted as role:'system' (kind
    // 'client_reply_received'). Surface it behind a [CLIENT REPLY]
    // marker as an external-input user turn instead of dropping it, so
    // the model can reference what the recipient actually said AND tell
    // it apart from the FIRM's turns — the same fix the per-transaction
    // and feed chats carry (#397). Since G1(a) (build-spec PR-8) wired
    // draft_evidence_request's dispatch, replies to doc-anchored asks
    // can genuinely land here. Other system messages (e.g. the
    // failure notices this endpoint persists) stay out of the model
    // context.
    const isClientReply = msg.role === 'system' && msg.payload?.kind === 'client_reply_received';
    if (msg.role !== 'user' && msg.role !== 'assistant' && !isClientReply) continue;
    let text = safeString(msg.content, 4000);
    if (isClientReply) {
      text = `[CLIENT REPLY — the recipient's own words, not the firm]: ${text}`;
    }
    // A surfaced reply rides as a user turn (external input to the
    // model); the marker, not the role, carries the speaker identity.
    input.push({
      role: isClientReply ? 'user' : msg.role,
      content: [{ type: 'input_text', text }]
    });
  }
  input.push({
    role: 'user',
    content: [{ type: 'input_text', text: safeString(userMessage, MAX_USER_MESSAGE_CHARS) }]
  });
  return input;
};

const defaultCallOpenAi = async ({ apiKey, model, input, signal }) =>
  fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    signal,
    body: JSON.stringify({
      model,
      store: false,
      instructions: SYSTEM_PROMPT,
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'document_chat_response',
          strict: true,
          schema: DOCUMENT_CHAT_RESPONSE_SCHEMA
        }
      }
    })
  });

// Discriminated-union return:
//   { kind: 'ok', text, actions, model }
//   { kind: 'failed', code, reason }
//
// `code` slugs (`openai_not_configured`, `openai_<status>`,
// `parse_error`, `validation_error`) mirror the extractor failure
// vocabulary so logging / categorization stays consistent across
// LLM-touching modules.
export const generateDocumentChatReply = async ({
  context,
  history = [],
  userMessage,
  __callOpenAi = defaultCallOpenAi,
  signal
} = {}) => {
  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    return { kind: 'failed', code: 'validation_error', reason: 'empty_user_message' };
  }
  const config = getOpenAiConfig();
  if (!config.apiKey) {
    return { kind: 'failed', code: 'openai_not_configured', reason: 'openai_not_configured' };
  }
  const input = buildOpenAiInput({ context, history, userMessage });
  let response;
  try {
    response = await __callOpenAi({
      apiKey: config.apiKey,
      model: config.model,
      input,
      signal
    });
  } catch (err) {
    return { kind: 'failed', code: 'openai_network', reason: err?.message || 'network_error' };
  }
  if (!response.ok) {
    return {
      kind: 'failed',
      code: `openai_${response.status || 'unknown'}`,
      reason: `openai_${response.status || 'unknown'}`
    };
  }
  let parsed;
  try {
    const raw = await response.json();
    const text = outputTextFromResponse(raw);
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: 'failed', code: 'parse_error', reason: err?.message || 'parse_error' };
  }
  if (!parsed || typeof parsed.text !== 'string' || !Array.isArray(parsed.actions)) {
    return { kind: 'failed', code: 'validation_error', reason: 'invalid_response_shape' };
  }
  return {
    kind: 'ok',
    text: parsed.text,
    actions: parsed.actions.map((a) => ({ ...a, status: 'proposed' })),
    model: config.model
  };
};

// ─── Persistence helpers (DB-side) ───────────────────────────────────────

// Synthesise a stable message id. Mirrors the makeMatchId
// convention elsewhere (slug + hash) so logs and audit trails stay
// scannable. `kind` is 'user' / 'assistant' / 'system' to keep the
// id self-describing.
const messageIdFor = ({ documentId, kind, createdAtMs }) => {
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const stamp = String(createdAtMs || Date.now());
  const raw = `${documentId}|${kind}|${stamp}|${crypto.randomBytes(4).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `chat-${slug(documentId)}-${kind}-${hash}`;
};

export const newMessageId = messageIdFor;
