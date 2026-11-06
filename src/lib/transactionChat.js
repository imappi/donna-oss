// Transaction chat — frontend pure helpers.
//
// Mirrors src/lib/documentChat.js but for the bank-feed chat surface.
// Action grammar is different (categorise, ask client, remember
// merchant) so the label map and describe function are dedicated.
// Generic helpers (actionSupportsApply, deriveActionCardState,
// formatChatTimestamp, mergeChatMessages, isNearBottom) are
// re-exported from documentChat.js so the shared chat scaffolding
// doesn't fork.

export {
  actionSupportsApply,
  deriveActionCardState,
  formatChatTimestamp,
  isNearBottom,
  mergeChatMessages
} from './documentChat.js';

const safeString = (value) => (value == null ? '' : String(value));

// Human-readable labels for each transaction-chat action `type`.
// Single source of truth — the chat UI reads from here. New action
// types added in follow-up PRs must register a label or render as the
// raw type string.
export const TRANSACTION_ACTION_TYPE_LABELS = Object.freeze({
  apply_category: 'Categorise & post',
  ask_client: 'Ask client',
  remember_merchant: 'Remember merchant',
  mark_personal: 'Mark as personal',
  link_document: 'Link to document',
  resolve_match_group: 'Pair & reconcile group',
  reject_match: 'Reject match',
  correct_document_field: 'Correct document field',
  leave_review_note: 'Leave a note',
  mark_evidence_owed: 'Mark waiting evidence',
  sync_to_accounting: 'Sync to accounting',
  retry_parse: 'Retry parse',
  recode_decided: 'Re-code (decided row)',
  future_action: 'Proposed (preview)'
});

// Guided rejection reasons shown directly above the transaction composer.
// Choosing one starts a Donna turn; it never mutates the match. Donna still
// has to return a structured reject_match proposal and the firm still has to
// apply that proposal, so the existing audited writer remains the only write
// path. The durable-pair choice says exactly what the rejected match row
// already guarantees: this document/transaction pair stays rejected and is
// not silently proposed again.
export const MATCH_REJECTION_CHOICES = Object.freeze([
  { id: 'wrong_document', label: 'Wrong document' },
  { id: 'wrong_transaction', label: 'Wrong transaction' },
  { id: 'already_settled', label: 'Already settled elsewhere' },
  { id: 'never_match', label: 'These should never be matched' },
  { id: 'other', label: 'Something else…' }
]);

const MATCH_REJECTION_PROMPTS = Object.freeze({
  wrong_document:
    'This is the wrong document. Help me reject this match.',
  wrong_transaction:
    'This is the wrong bank transaction. Help me reject this match.',
  already_settled:
    'This document was already settled elsewhere. Help me correct this match.',
  never_match:
    'These should never be matched. Help me reject this and remember the correction.'
});

export const matchRejectionPrompt = (choiceId) => MATCH_REJECTION_PROMPTS[choiceId] || null;

// The transaction artifact is focused on one row, but a compiled action can
// affect a wider transaction set (resolve_match_group is the first such verb).
// Project that exact target set into the shared feed apply lifecycle so every
// affected row gets an honest in-flight treatment while the receipt is pending.
export const transactionChatActionTargetIds = ({ action, focusedTransactionId = null } = {}) => {
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = safeString(value).trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  if (action?.type === 'resolve_match_group') {
    for (const pair of Array.isArray(action.match_pairs) ? action.match_pairs : []) {
      add(pair?.transaction_id);
    }
  } else {
    for (const id of Array.isArray(action?.transaction_ids) ? action.transaction_ids : []) add(id);
    add(action?.transaction_id);
  }
  if (!ids.length) add(focusedTransactionId);
  return ids;
};

// Produce 0..N detail lines describing the action's parameters so the
// firm can read the proposal at a glance. Type-aware, bounded so a
// runaway model can't break the layout.
const fieldLine = (label, value, max = 120) => {
  const str = safeString(value).trim();
  if (!str) return null;
  return `${label}: ${str.length > max ? `${str.slice(0, max)}…` : str}`;
};

// Structured presentation fields for the mounted transaction action card.
// The legacy string helper below remains for compatibility/tests, while this
// shape keeps translatable labels separate from persisted/model values so the
// React boundary can apply ICU copy plus the correct bidi primitive.
const boundedDetail = (labelId, value, kind = 'text', max = 120) => {
  const str = safeString(value).trim();
  if (!str) return null;
  return {
    labelId,
    kind,
    value: str.length > max ? `${str.slice(0, max)}…` : str
  };
};

export const describeTransactionActionDetails = (action) => {
  if (!action || typeof action !== 'object') return [];
  const details = [];
  switch (action.type) {
    case 'recode_decided':
    case 'apply_category': {
      if (action.type === 'recode_decided') details.push({
        labelId: null,
        kind: 'message',
        messageId: 'operator.action.warning.recodeDecided'
      });
      const account = boundedDetail('operator.action.detail.account', action.account_name, 'text', 80);
      if (account) details.push(account);
      const code = boundedDetail('operator.action.detail.code', action.account_code, 'identifier', 24);
      if (code) details.push(code);
      const tax = boundedDetail('operator.action.detail.tax', action.tax_treatment, 'identifier', 48);
      if (tax) details.push(tax);
      const contact = boundedDetail('operator.action.detail.contact', action.contact_name, 'text', 80);
      if (contact) details.push(contact);
      break;
    }
    case 'ask_client': {
      const evidence = boundedDetail('operator.action.detail.evidence', action.evidence_type, 'identifier', 48);
      if (evidence) details.push(evidence);
      const question = boundedDetail('operator.action.detail.request', action.question, 'text', 200);
      if (question) details.push(question);
      break;
    }
    case 'remember_merchant': {
      const pattern = boundedDetail('operator.action.detail.pattern', action.merchant_pattern, 'text', 80);
      if (pattern) details.push(pattern);
      const account = boundedDetail('operator.action.detail.account', action.account_name, 'text', 80);
      if (account) details.push(account);
      break;
    }
    case 'mark_personal': {
      const note = boundedDetail('operator.action.detail.note', action.note, 'text', 160);
      if (note) details.push(note);
      break;
    }
    case 'link_document':
    case 'reject_match': {
      if (action.type === 'reject_match') details.push({
        labelId: null,
        kind: 'message',
        messageId: 'operator.action.effect.rejectMatch'
      });
      const document = boundedDetail('operator.action.detail.document', action.document_id, 'identifier', 64);
      if (document) details.push(document);
      break;
    }
    case 'resolve_match_group': {
      const pairs = Array.isArray(action.match_pairs) ? action.match_pairs : [];
      for (const [index, pair] of pairs.slice(0, 6).entries()) {
        const transactionId = safeString(pair?.transaction_id).slice(0, 48);
        const documentId = safeString(pair?.document_id).slice(0, 48);
        if (transactionId && documentId) details.push({
          labelId: 'operator.action.detail.pair',
          labelValues: { index: index + 1 },
          kind: 'identifier_pair',
          value: { transactionId, documentId }
        });
      }
      break;
    }
    case 'correct_document_field': {
      const field = boundedDetail('operator.action.detail.field', action.field_path, 'identifier', 48);
      if (field) details.push(field);
      const value = boundedDetail('operator.action.detail.newValue', action.corrected_value, 'text', 80);
      if (value) details.push(value);
      const document = boundedDetail('operator.action.detail.document', action.document_id, 'identifier', 64);
      if (document) details.push(document);
      break;
    }
    case 'leave_review_note': {
      const note = boundedDetail('operator.action.detail.note', action.note, 'text', 160);
      if (note) details.push(note);
      const followUp = boundedDetail('operator.action.detail.followUp', action.follow_up_at, 'date', 10);
      if (followUp) details.push(followUp);
      break;
    }
    case 'future_action': {
      const type = boundedDetail('operator.action.detail.proposedType', action.future_type, 'identifier', 64);
      if (type) details.push(type);
      break;
    }
    default:
      break;
  }
  return details;
};

export const describeTransactionAction = (action) => {
  if (!action || typeof action !== 'object') return [];
  const lines = [];
  switch (action.type) {
    case 'recode_decided':
    case 'apply_category': {
      // recode_decided reuses apply_category's coding fields; the only extra
      // is the decided-row warning so the firm reads the blast radius before
      // applying (the door is enforced server-side, not by this label).
      if (action.type === 'recode_decided') {
        lines.push('Changes an already-decided row');
      }
      const acct = fieldLine('Account', action.account_name, 80);
      if (acct) lines.push(acct);
      if (action.account_code) lines.push(`Code: ${action.account_code}`);
      if (action.tax_treatment) lines.push(`Tax: ${action.tax_treatment}`);
      const contact = fieldLine('Contact', action.contact_name, 80);
      if (contact) lines.push(contact);
      break;
    }
    case 'ask_client': {
      if (action.evidence_type) lines.push(`Evidence: ${action.evidence_type}`);
      const q = fieldLine('Question', action.question, 200);
      if (q) lines.push(q);
      break;
    }
    case 'remember_merchant': {
      const pattern = fieldLine('Pattern', action.merchant_pattern, 80);
      if (pattern) lines.push(pattern);
      const acct = fieldLine('Account', action.account_name, 80);
      if (acct) lines.push(acct);
      break;
    }
    case 'mark_personal': {
      const note = fieldLine('Note', action.note, 160);
      if (note) lines.push(note);
      break;
    }
    case 'link_document': {
      const doc = fieldLine('Document', action.document_id, 64);
      if (doc) lines.push(doc);
      break;
    }
    case 'resolve_match_group': {
      const pairs = Array.isArray(action.match_pairs) ? action.match_pairs : [];
      for (const [index, pair] of pairs.slice(0, 6).entries()) {
        const tx = safeString(pair?.transaction_id).slice(0, 48);
        const doc = safeString(pair?.document_id).slice(0, 48);
        if (tx && doc) lines.push(`Pair ${index + 1}: ${tx} → ${doc}`);
      }
      break;
    }
    case 'reject_match': {
      // The active match is resolved server-side; document_id is an
      // optional re-verification hint. Surface the blast radius (and the
      // named doc, when present) so the firm reads it before applying.
      lines.push('Rejects the current reconciliation match');
      const doc = fieldLine('Document', action.document_id, 64);
      if (doc) lines.push(doc);
      break;
    }
    case 'correct_document_field': {
      // The matched document is resolved server-side; surface the field being
      // fixed and its new value so the firm reads the proposal at a glance
      // (document_id, when present, is an optional re-verification hint).
      const field = fieldLine('Field', action.field_path, 48);
      if (field) lines.push(field);
      const value = fieldLine('New value', action.corrected_value, 80);
      if (value) lines.push(value);
      const doc = fieldLine('Document', action.document_id, 64);
      if (doc) lines.push(doc);
      break;
    }
    case 'leave_review_note': {
      const note = fieldLine('Note', action.note, 160);
      if (note) lines.push(note);
      if (action.follow_up_at) lines.push(`Follow-up: ${action.follow_up_at}`);
      break;
    }
    case 'future_action': {
      const t = fieldLine('Proposed type', action.future_type, 64);
      if (t) lines.push(t);
      break;
    }
    default:
      break;
  }
  return lines;
};

// Pure: diff two message arrays and return the `client_reply_received`
// system messages present in `next` whose id is NOT present in `prev`.
// Powers the toast that fires when the transaction-chat polling tick
// detects an inbound client reply during this session.
//
// Why id-based rather than timestamp-based: the polling tick is
// idempotent (same server snapshot may arrive twice if the firm
// clicks refresh mid-poll); deduping by id keeps a single emit per
// reply regardless of how many times the merge runs.
export const findNewClientReplies = (prevMessages, nextMessages) => {
  const prevIds = new Set();
  if (Array.isArray(prevMessages)) {
    for (const msg of prevMessages) {
      if (msg && msg.id != null) prevIds.add(msg.id);
    }
  }
  if (!Array.isArray(nextMessages)) return [];
  const replies = [];
  for (const msg of nextMessages) {
    if (!msg || msg.id == null) continue;
    if (prevIds.has(msg.id)) continue;
    if (msg.role !== 'system') continue;
    if (msg.payload?.kind !== 'client_reply_received') continue;
    replies.push(msg);
  }
  return replies;
};
