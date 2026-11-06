// Document chat — frontend pure helpers (PR 27).
//
// Centralises the chrome around chat messages so the React
// component stays thin and the load-bearing logic (action labels,
// describe lines, supports-apply gate) is pinned by unit tests
// without needing jsdom.

const safeString = (value) => (value == null ? '' : String(value));

export const documentNeedsCurrencyConfirmation = (document) => (
  ['receipt', 'supplier_bill'].includes(document?.document_type)
  && Number(document?.total_amount) > 0
  && !safeString(document?.currency).trim()
  && !(document?.settlement_entry || document?.payload?.settlement_entry)?.journal_id
);

// ICU keys for each action `type`. The component owns rendering and
// direction isolation; this pure helper only maps the closed server enum
// to catalog identities. A future type may still render as its raw enum,
// isolated as an identifier, without inventing translated semantics.
export const ACTION_TYPE_MESSAGE_IDS = Object.freeze({
  explain_match_reasoning: 'document.action.type.explainMatch',
  search_transactions: 'document.action.type.searchTransactions',
  link_transaction: 'document.action.type.linkTransaction',
  draft_evidence_request: 'document.action.type.draftEvidenceRequest',
  leave_review_note: 'document.action.type.leaveReviewNote',
  mark_immaterial: 'document.action.type.markImmaterial',
  correct_document_field: 'operator.action.type.correctDocumentField',
  future_action: 'document.action.type.future'
});

// PR 27 contract: Apply is gated by the server's
// `appliable_action_types` list. The server is the source of
// truth — if the FE ever drifts, the disabled state below stays
// safe (we render disabled by default).
export const actionSupportsApply = (action, appliableTypes = []) => {
  if (!action || typeof action.type !== 'string') return false;
  if (!Array.isArray(appliableTypes)) return false;
  return appliableTypes.includes(action.type);
};

// Produce 0..N structured fields describing the action's parameters
// for the firm to read at a glance. Keeping labels as catalog ids and
// values separate lets React localize the former while isolating and
// formatting the latter according to its semantic kind.
//
// Output is bounded — only fields relevant to the action `type` are
// surfaced, and each line is capped so a malicious / runaway model
// can't break the layout.
const boundedValue = (value, max = 120) => {
  const str = safeString(value).trim();
  if (!str) return null;
  return str.length > max ? `${str.slice(0, max)}…` : str;
};

const detailField = (labelId, value, kind = 'text', max = 120) => {
  const bounded = boundedValue(value, max);
  return bounded ? { labelId, kind, value: bounded } : null;
};

export const describeAction = (action) => {
  if (!action || typeof action !== 'object') return [];
  const lines = [];
  switch (action.type) {
    case 'correct_document_field': {
      const field = detailField('operator.action.detail.field', action.field_path, 'identifier', 48);
      if (field) lines.push(field);
      lines.push({ labelId: 'operator.action.detail.newValue', kind: 'identifier', value: action.corrected_value == null ? '—' : boundedValue(action.corrected_value, 12) });
      break;
    }
    case 'explain_match_reasoning': {
      const summary = detailField('document.action.detail.summary', action.summary);
      if (summary) lines.push(summary);
      const signals = Array.isArray(action.signals) ? action.signals.filter(Boolean) : [];
      if (signals.length) lines.push({
        labelId: 'document.action.detail.signals',
        kind: 'identifier_list',
        value: signals.slice(0, 6).map((value) => boundedValue(value, 64)).filter(Boolean)
      });
      const blockers = Array.isArray(action.blockers) ? action.blockers.filter(Boolean) : [];
      if (blockers.length) lines.push({
        labelId: 'document.action.detail.blockers',
        kind: 'identifier_list',
        value: blockers.slice(0, 6).map((value) => boundedValue(value, 64)).filter(Boolean)
      });
      break;
    }
    case 'search_transactions': {
      if (action.amount_eq != null && Number.isFinite(Number(action.amount_eq))) lines.push({
        labelId: 'document.action.detail.amount',
        kind: 'amount',
        value: Number(action.amount_eq),
        currency: boundedValue(action.currency, 12)
      });
      const dateFrom = boundedValue(action.date_from, 10);
      const dateTo = boundedValue(action.date_to, 10);
      if (dateFrom || dateTo) lines.push({
        labelId: 'document.action.detail.date',
        kind: 'date_range',
        value: { from: dateFrom, to: dateTo }
      });
      const desc = detailField('document.action.detail.description', action.description_contains, 'text', 80);
      if (desc) lines.push(desc);
      const currency = detailField('document.action.detail.currency', action.currency, 'identifier', 12);
      if (currency) lines.push(currency);
      const direction = detailField('document.action.detail.direction', action.direction, 'direction', 32);
      if (direction) lines.push(direction);
      break;
    }
    case 'link_transaction': {
      const txId = detailField('document.action.detail.transaction', action.transaction_id, 'identifier', 64);
      if (txId) lines.push(txId);
      break;
    }
    case 'draft_evidence_request': {
      const recipient = detailField('document.action.detail.recipient', action.recipient, 'recipient', 64);
      if (recipient) lines.push(recipient);
      const q = detailField('document.action.detail.question', action.question, 'text', 160);
      if (q) lines.push(q);
      break;
    }
    case 'leave_review_note': {
      const note = detailField('document.action.detail.note', action.note, 'text', 160);
      if (note) lines.push(note);
      const followUp = detailField('document.action.detail.followUp', action.follow_up_at, 'date', 10);
      if (followUp) lines.push(followUp);
      break;
    }
    case 'mark_immaterial': {
      if (action.threshold_amount != null && Number.isFinite(Number(action.threshold_amount))) lines.push({
        labelId: 'document.action.detail.materialityThreshold',
        kind: 'amount',
        value: Number(action.threshold_amount),
        currency: boundedValue(action.currency, 12)
      });
      break;
    }
    case 'future_action': {
      const t = detailField('document.action.detail.proposedType', action.future_type, 'identifier', 64);
      if (t) lines.push(t);
      break;
    }
    default:
      // Unknown action type — render no detail lines. The chrome
      // (type label + reason) still shows so the firm sees the
      // proposal even when the FE doesn't recognise the type.
      break;
  }
  return lines;
};

// PR 28 — derive the action-card UI state machine from the action
// + the per-card apply state. Pure function so the four-way state
// (proposed / applying / applied / coming-soon) is testable
// without rendering React.
//
// Inputs:
//   action          — the persisted action object (has .type, .status)
//   appliableTypes  — server's appliable_action_types allowlist
//   applyState      — { status: 'applying'|'error'|null, error?: string }
//                     (from the chat component's per-action map)
//   hasOnApply      — boolean: parent provided an onApply handler
//
// Returns: { phase, enabled, buttonMessageId, statusMessageId,
//            statusIsApplied, error, errorMessageId, supportsApply }
//
// `phase` values:
//   'applied'      → already applied; render no button, green pill
//   'superseded'   → a newer turn proposed a replacement of the same
//                    type; the server marked this one superseded and
//                    its apply endpoint 409s it. Render inert (no
//                    button, greyed) so the stale proposal can't be
//                    clicked from a thread that has moved on.
//   'applying'     → in-flight; show spinner-ish label, disabled
//   'ready'        → proposed, type wired, parent provided onApply
//   'unsupported'  → type not in appliable set; disabled and unavailable
//   'no-handler'   → type wired but parent didn't pass onApply; disabled
export const deriveActionCardState = ({ action, appliableTypes = [], applyState = null, hasOnApply = false } = {}) => {
  const persistedStatus = action?.status || 'proposed';
  const isApplied = persistedStatus === 'applied';
  const isSuperseded = persistedStatus === 'superseded';
  const supportsApply = actionSupportsApply(action, appliableTypes);
  const inFlight = applyState?.status === 'applying';
  const errorState = applyState?.status === 'error' ? (applyState.error || null) : null;
  const errorMessageId = applyState?.status === 'error' && !applyState.error
    ? 'document.action.error.applyFailed'
    : null;

  let phase;
  if (isApplied) {
    phase = 'applied';
  } else if (isSuperseded) {
    phase = 'superseded';
  } else if (inFlight) {
    phase = 'applying';
  } else if (supportsApply && hasOnApply) {
    phase = 'ready';
  } else if (!supportsApply) {
    phase = 'unsupported';
  } else {
    phase = 'no-handler';
  }

  const buttonMessageId = phase === 'applied'
    ? 'document.action.button.applied'
    : phase === 'applying'
      ? 'document.action.button.applying'
      : phase === 'ready'
        ? 'document.action.button.apply'
        : phase === 'no-handler'
          ? 'document.action.button.apply'
          : 'document.action.button.comingSoon';

  const statusMessageId = isApplied
    ? 'document.action.status.applied'
    : isSuperseded
      ? 'document.action.status.superseded'
      : 'document.action.status.proposed';

  return {
    phase,
    enabled: phase === 'ready',
    buttonMessageId,
    statusMessageId,
    statusIsApplied: isApplied,
    statusIsSuperseded: isSuperseded,
    error: errorState,
    errorMessageId,
    supportsApply
  };
};

// Format a chat-message timestamp (ISO string) as a compact
// "HH:MM" label. Returns "—" on missing/unparseable input so the
// UI doesn't render raw ISO.
export const formatChatTimestamp = (raw, formatter = null) => {
  if (!raw) return '—';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '—';
  try {
    if (typeof formatter === 'function') return formatter(parsed);
    return `${String(parsed.getUTCHours()).padStart(2, '0')}:${String(parsed.getUTCMinutes()).padStart(2, '0')}`;
  } catch {
    return '—';
  }
};

// mergeChatMessages — fold a server snapshot into the in-memory list
// for the polling refresh path. Pure: no React, no side effects.
// Used by both the transaction-chat and document-chat artifacts —
// lives here (rather than in transactionChat.js) because the merge
// semantics are chat-shape-generic, not transaction-specific.
//
// Rules:
//   - existing items not present on the server are KEPT (defensive —
//     if a server snapshot drops a row we already showed, hold onto it
//     rather than yanking it out from under the firm)
//   - incoming items whose id matches an existing row REPLACE the
//     local copy (server is canonical for updates — e.g. an action's
//     status flipping proposed → applied)
//   - incoming items with unseen ids APPEND
//   - merged list is re-sorted by created_at ascending; ties keep
//     existing-first stable order
//
// State boundary: callers must only feed and consume `messages` (and
// out-of-band `appliable_action_types`). draft, sendMode, submitting,
// sendError, applyState are NEVER touched by the refresh path —
// keeping this helper pure makes that invariant trivial to enforce.
export const mergeChatMessages = (existing, incoming) => {
  const existingArr = Array.isArray(existing) ? existing : [];
  const incomingArr = Array.isArray(incoming) ? incoming : [];
  const incomingById = new Map();
  for (const msg of incomingArr) {
    if (msg && msg.id != null) incomingById.set(msg.id, msg);
  }
  const seenIds = new Set();
  const merged = [];
  for (const msg of existingArr) {
    if (!msg) continue;
    const id = msg.id;
    if (id != null && incomingById.has(id)) {
      merged.push(incomingById.get(id));
      seenIds.add(id);
    } else {
      merged.push(msg);
      if (id != null) seenIds.add(id);
    }
  }
  for (const msg of incomingArr) {
    if (!msg || msg.id == null) continue;
    if (seenIds.has(msg.id)) continue;
    merged.push(msg);
    seenIds.add(msg.id);
  }
  return merged
    .map((msg, idx) => ({ msg, idx }))
    .sort((a, b) => {
      const ta = Date.parse(a.msg?.created_at || '') || 0;
      const tb = Date.parse(b.msg?.created_at || '') || 0;
      if (ta !== tb) return ta - tb;
      return a.idx - b.idx;
    })
    .map(({ msg }) => msg);
};

// isNearBottom — true when the user is within `threshold` px of the
// bottom of a scrolling container. Gates the auto-scroll-on-new-message
// pin so a firm reading older messages doesn't get yanked to the
// bottom when a polled reply arrives.
//
// A null element is treated as near-bottom so the very first commit
// (before the ref attaches) still auto-pins.
export const isNearBottom = (scrollEl, threshold = 80) => {
  if (!scrollEl) return true;
  const distance = scrollEl.scrollHeight - (scrollEl.scrollTop + scrollEl.clientHeight);
  return distance <= threshold;
};
