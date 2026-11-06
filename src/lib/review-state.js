// Canonical transaction-review workflow states. Backend-owned contract —
// values mirror what `/api/donna/firms/transaction-review/:id` accepts in
// `patch.review_state` (or camelCase `reviewState`).
//
// Order is the typical lifecycle:
//   suggested → accepted → synced
//   suggested → asked_client → waiting → resolved
//
// Display rename (Donna-first, Xero-as-mirror):
//   suggested        → "Suggested"
//   accepted/resolved → "Reviewed"
//   asked_client/waiting → "Asked"
//   synced / posted  → "Posted"           ← was "Synced"; we no longer imply
//                                            Xero bank-rec is complete
//   closed           → "Closed"
//   held             → "Held"
//
// Xero is rendered as a small, separate mirror chip — never as the lifecycle
// position. See getMirrorChip() below.
//
// Notes:
//  - Backend still supports legacy row status (open / closed / dismissed).
//    FE renders review_state as the *primary* workflow signal.
//  - Do NOT derive these from button labels — set them explicitly when an
//    action lands: Apply → accepted, Ask → waiting (after the request is
//    created), manual close → resolved, post-Xero writeback → synced (which
//    we surface as "Posted").
//  - 'posted', 'closed', 'held' are forward-looking values the BE may emit
//    once the Donna ledger lands; we render them now so the FE doesn't need
//    a follow-up change when they ship.

import { T, D } from '../components/shared/design-tokens.js';

export const REVIEW_STATES = Object.freeze([
  'suggested',
  'accepted',
  'asked_client',
  'waiting',
  'resolved',
  'synced',
  'posted',
  'closed',
  'held'
]);

export const REVIEW_STATE_SET = new Set(REVIEW_STATES);

export const isReviewState = (value) =>
  typeof value === 'string' && REVIEW_STATE_SET.has(value);

// Reader — review row first, payload fallback. Works for transaction rows too
// (transaction.review_state, then transaction.payload.review_state).
export const getReviewState = (item) => {
  if (!item || typeof item !== 'object') return null;
  const direct = item.review_state ?? item.reviewState;
  if (isReviewState(direct)) return direct;
  const fromPayload = item.payload?.review_state ?? item.payload?.reviewState;
  if (isReviewState(fromPayload)) return fromPayload;
  return null;
};

// Visual contract for badge rendering — kept here so every surface tints the
// same state the same way. fg = label colour, dot = the state's voice dot;
// bg is retained for shape-compat but is transparent everywhere under the
// three-voice law (Kari, 2026-08-05): color lives in the DOT, labels stay
// ink-family, washes are gone. Voices: warm accent dot = needs YOUR move;
// muted ink dot = settled / someone else's move; alert = genuine failure
// only (no review state qualifies — waiting on a client is not a failure).
//
// `label` is the long form (used in tooltips). `short` is the badge text.
export const REVIEW_STATE_META = Object.freeze({
  suggested: {
    label: 'AI suggested',
    short: 'Suggested',
    fg: D.ink,
    bg: 'transparent',
    dot: D.accentWarmFlat
  },
  accepted: {
    label: 'Reviewed by accountant',
    short: 'Reviewed',
    fg: D.inkSoft,
    bg: 'transparent',
    dot: D.inkMute
  },
  asked_client: {
    label: 'Asked client',
    short: 'Asked',
    fg: D.inkMute,
    bg: 'transparent',
    dot: D.inkMute
  },
  waiting: {
    label: 'Awaiting client',
    short: 'Asked',
    fg: D.inkMute,
    bg: 'transparent',
    dot: D.inkMute
  },
  resolved: {
    label: 'Reviewed by accountant',
    short: 'Reviewed',
    fg: D.inkSoft,
    bg: 'transparent',
    dot: D.inkMute
  },
  // 'synced' is the BE state for "writeback succeeded" — display as "Posted"
  // so we don't overstate Xero bank-rec completeness.
  synced: {
    label: 'Posted to accounting mirror',
    short: 'Posted',
    fg: D.inkSoft,
    bg: 'transparent',
    dot: D.inkMute
  },
  // Forward-looking — Donna-ledger states the BE will emit once it lands.
  posted: {
    label: 'Posted to Donna ledger',
    short: 'Posted',
    fg: D.inkSoft,
    bg: 'transparent',
    dot: D.inkMute
  },
  closed: {
    label: 'Closed in month-pack',
    short: 'Closed',
    fg: D.inkMute,
    bg: 'transparent',
    dot: D.inkMute
  },
  held: {
    label: 'Held / exception',
    short: 'Held',
    fg: D.inkMute,
    bg: 'transparent',
    dot: D.inkMute
  }
});

export const reviewStateMeta = (state) =>
  REVIEW_STATE_META[state] || {
    label: state || 'Unknown',
    short: state || 'Unknown',
    fg: D.inkMute,
    bg: 'transparent',
    dot: D.inkMute
  };

// Tooltip copy for the lifecycle badge, conditional on whether the row has
// crossed the Xero mirror. Codex called these out as the canonical strings.
//
//   no Xero ID:  "Posted to accounting mirror · Donna ledger posting coming next"
//   has Xero ID: "Exported to Xero mirror · Xero bank-rec is separate"
//
// For non-Posted states we fall back to the meta.label.
export const reviewStateTooltip = (state, { hasXeroBankTransactionId = false } = {}) => {
  if (state === 'synced' || state === 'posted') {
    return hasXeroBankTransactionId
      ? 'Exported to Xero mirror · Xero bank-rec is separate'
      : 'Posted to accounting mirror · Donna ledger posting coming next';
  }
  return reviewStateMeta(state).label;
};

// ── Xero mirror chip ─────────────────────────────────────────────────────────
//
// Renders separately from the lifecycle badge. Three modes:
//
//   ok    : xero_bank_transaction_id present, OR xero_writeback_status === 'synced'
//   alert : a writeback error / drift signal is present
//   none  : not exported (em-dash)
//
// Read tolerantly from either the review item, the transaction, or
// item.payload — same fallback shape the rest of this module uses.
const readField = (item, ...names) => {
  if (!item || typeof item !== 'object') return null;
  for (const n of names) {
    if (item[n] !== undefined && item[n] !== null && item[n] !== '') return item[n];
  }
  if (item.payload && typeof item.payload === 'object') {
    for (const n of names) {
      if (item.payload[n] !== undefined && item.payload[n] !== null && item.payload[n] !== '') {
        return item.payload[n];
      }
    }
  }
  return null;
};

export const getMirrorChip = (item) => {
  if (!item) {
    return { kind: 'none', label: '—', title: 'Not exported to Xero', fg: T.mutedSoft, bg: 'transparent' };
  }
  const xeroId = readField(
    item,
    'xero_bank_transaction_id',
    'xeroBankTransactionId',
    'xero_id',
    'xeroId'
  );
  const writebackStatus = readField(
    item,
    'xero_writeback_status',
    'xeroWritebackStatus',
    'writeback_status'
  );
  const errorCode = readField(
    item,
    'xero_writeback_error_code',
    'xero_error_code',
    'last_writeback_error_code'
  );
  const errorMessage = readField(
    item,
    'xero_writeback_error',
    'xero_error',
    'last_writeback_error'
  );
  if (errorCode || errorMessage) {
    return {
      kind: 'alert',
      label: errorCode === 'XERO_WRITEBACK_AMBIGUOUS_MATCH' ? 'Ambiguous' : 'Drift',
      title: errorMessage || `Xero mirror error · ${errorCode || 'unknown'}`,
      fg: T.alert,
      bg: T.alertSoft
    };
  }
  if (xeroId || writebackStatus === 'synced') {
    return {
      kind: 'ok',
      label: '✓ Xero',
      title: 'Exported to Xero mirror · Xero bank-rec is separate',
      fg: T.ok,
      bg: T.okSoft
    };
  }
  return {
    kind: 'none',
    label: '—',
    title: 'Not exported to Xero',
    fg: T.mutedSoft,
    bg: 'transparent'
  };
};

// ── Apply payload helpers ────────────────────────────────────────────────────
//
// When the accountant Applies a category, the patch must carry the full Xero
// account identity (when available) — not just a display name. Backend keys:
//
//   category            → display name (kept for legacy readers)
//   account_code        → Xero account code
//   account_name        → Xero account name
//   account_label       → display label ("401 · IT & software", etc.)
//   xero_account_id     → Xero account UUID (when picker has it)
//   xero_account_code   → Xero account code (mirror of account_code)
//   xero_account_name   → Xero account name (mirror of account_name)
//   xero_tax_type       → Xero tax type (e.g. INPUT, OUTPUT, INPUTY24)
//
// The `xero_*` and bare `account_*` keys can carry the same values for
// straight Xero accounts; the BE accepts both and writes them through. We
// emit both forms because some downstream readers key off one or the other.
//
// `account` is whatever shape the picker hands back. We accept Xero
// snake_case (account_code), camelCase (accountCode), bare keys (code), and
// the natural Xero account shape (`code` / `name` / `tax_type`). Missing
// fields drop out — we never write null/undefined keys into the patch.

const KEY_MAPPING = [
  ['category', ['category', 'name', 'displayName']],
  ['account_code', ['account_code', 'code', 'accountCode']],
  ['account_name', ['account_name', 'name', 'accountName']],
  ['account_label', ['account_label', 'label', 'accountLabel']],
  ['xero_account_id', ['xero_account_id', 'xeroAccountId', 'id', 'account_id', 'accountId']],
  ['xero_account_code', ['xero_account_code', 'xeroAccountCode', 'code', 'account_code', 'accountCode']],
  ['xero_account_name', ['xero_account_name', 'xeroAccountName', 'name', 'account_name', 'accountName']],
  ['xero_tax_type', ['xero_tax_type', 'xeroTaxType', 'tax_type', 'taxType']]
];

// ── Document-line review (PR 3 of invoice-receipt-parsing-plan) ─────────────
//
// The document_lines table uses its own review_status vocabulary
// (needs_review | accepted | deferred) — distinct from the transaction
// FE workflow vocabulary above (suggested → accepted → ... → posted).
// The shared backend DTO (server/donna/reviewItem.js) carries an
// `item_type` discriminator so the FE can pick the right meta block.
//
// This block stays additive — the transaction-side helpers above keep
// their existing behaviour. Use `getReviewItemType(item)` to branch
// when rendering a review-queue row generically; for
// `item_type='document_line'` you typically want the line-level
// `review_status` (read from the document_lines row itself), not the
// queue-row status.

export const getReviewItemType = (item) => {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.item_type === 'string' && item.item_type.length) return item.item_type;
  // Heuristic fallback for legacy snapshots without the discriminator.
  if (item.payload?.document_id && item.item_id && String(item.item_id).startsWith(item.payload.document_id)) {
    return 'document_line';
  }
  return 'transaction';
};

export const DOCUMENT_LINE_REVIEW_STATUS_META = Object.freeze({
  needs_review: {
    label: 'Needs review',
    short: 'Needs review',
    fg: T.alert,
    bg: T.alertSoft,
    dot: T.alert
  },
  accepted: {
    label: 'Reviewed by accountant',
    short: 'Reviewed',
    fg: T.accent,
    bg: T.accentSoft,
    dot: T.accent
  },
  deferred: {
    label: 'Deferred',
    short: 'Deferred',
    fg: T.muted,
    bg: 'rgba(46,42,34,0.08)',
    dot: T.muted
  }
});

export const documentLineReviewStatusMeta = (status) =>
  DOCUMENT_LINE_REVIEW_STATUS_META[status] || DOCUMENT_LINE_REVIEW_STATUS_META.needs_review;

export const buildAcceptedPatch = (account) => {
  if (!account || typeof account !== 'object') return {};
  const patch = {};
  for (const [outKey, candidates] of KEY_MAPPING) {
    for (const candidate of candidates) {
      const value = account[candidate];
      if (value !== undefined && value !== null && value !== '') {
        patch[outKey] = value;
        break;
      }
    }
  }
  return patch;
};
