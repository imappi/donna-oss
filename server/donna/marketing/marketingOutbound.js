// Marketing outbound — pure vocabulary, validators, and render helpers for the
// waitlist-nurture loop (slice 1 of docs/design-donna-sales-marketing.md).
//
// Doctrine this module enforces deterministically (the Keep layer — it does
// not substitute for the model's judgment, it refuses to let a draft violate
// the rails):
//   - Honest-promise claim checklist: no "human-reviewed", no
//     "human-monitored", no appointed-professional handoff, no guarantees, no
//     replaces-your-accountant, no set-and-forget (CLAUDE.md brand rail as
//     re-amended 2026-07-23: Donna runs the books herself — no human back
//     office, no bookkeeper reviewing or finishing the work).
//   - Prices in copy must be pricing.js numbers — never invented.
//   - Every email carries a working unsubscribe (even 1:1 sends — Kari,
//     2026-07-03); drafts without the placeholder are refused at mint.
//   - Non-deceptive subjects: no fake "Re:" / "Fwd:" threading.
//   - Send-authority stages reuse 042's CONFIG_STAGES vocabulary (no third
//     staging vocabulary); a channel with no history is 'off'.
//
// Everything here is pure (no DB, no network) so it is unit-testable and the
// SQL layer stays thin.

import { BANDS, RECURRING_MONTHLY_PRICE } from '../../../src/lib/pricing.js';
import { CONFIG_STAGES } from '../clientConfig.js';

// 'reply' (M4): response drafts to inbound mail — threaded, minted 'proposed',
// sent only through the same per-send approval path as everything else.
export const MARKETING_CHANNELS = Object.freeze(['waitlist_nurture', 'reply']);

export const DRAFT_STATUSES = Object.freeze([
  'proposed',
  'approved',
  'rejected',
  'superseded',
  'sent'
]);

// Terminal = the draft has come to rest (two-terminal-states: everything else
// is either ON-KARI ('proposed') or a transient hop ('approved', mid-send).
export const TERMINAL_DRAFT_STATUSES = Object.freeze(['rejected', 'superseded', 'sent']);

export const SUPPRESSION_REASONS = Object.freeze([
  'unsubscribed',
  'bounced',
  'complaint',
  'manual'
]);

export const LEAD_STATUSES = Object.freeze([
  'new',
  'active',
  'on_kari',
  'converted',
  'suppressed',
  'closed_unfit'
]);

// The waitlist disqualify reasons (047's vocabulary) double as nurture segments.
export const NURTURE_SEGMENTS = Object.freeze(['inventory', 'restaurant', 'volume', 'other']);

// Drafts must carry this placeholder; the real per-draft link is injected at
// send time (renderForSend). Refusing at mint keeps "unsubscribe on every
// send" a structural property, not a prompt hope.
export const UNSUBSCRIBE_PLACEHOLDER = '{{unsubscribe_url}}';

// ── Claim checklist (deterministic; a violation refuses the draft) ──────────

const dollarsAllowed = new Set([
  ...BANDS.map((b) => b.price),
  RECURRING_MONTHLY_PRICE
]);

// Exported (B1, social): the claim checklist is ONE source of truth across
// every outward Donna voice — email drafts here, public posts in
// socialPost.js. Add a banned claim once, every surface refuses it.
export const BANNED_CLAIMS = [
  { pattern: /human[\s-]?review/i, label: 'human-reviewed claim (2026-07-23 rail: no human back office, no bookkeeper reviewing or finishing the work)' },
  { pattern: /human[\s-]?monitor/i, label: 'human-monitored claim (retired 2026-07-13 promise; the self-service model has no human monitoring layer)' },
  { pattern: /appointed\s+professional/i, label: 'appointed-professional claim (retired 2026-07-13 model; there is no professional handoff)' },
  { pattern: /guarantee/i, label: 'guarantee language' },
  { pattern: /replaces?\s+your\s+accountant/i, label: 'replaces-your-accountant claim' },
  { pattern: /set[\s-]?and[\s-]?forget/i, label: 'set-and-forget claim' }
];

// Validate one draft's copy against the checklist. Returns [] when clean, or a
// list of human-readable violation strings. The caller refuses to mint (or to
// send) a draft with violations — this is a writer-level invariant, not advice.
// `isReply` (M4): a draft answering a REAL inbound message (linked via
// inbound_message_id) may carry a genuine "Re:" — the deceptive-threading
// refusal stays absolute for anything cold, and "Fwd:" is never legitimate.
export const validateDraftCopy = ({ subject = '', body = '' } = {}, { isReply = false } = {}) => {
  const violations = [];
  const combined = `${subject}\n${body}`;

  for (const { pattern, label } of BANNED_CLAIMS) {
    if (pattern.test(combined)) violations.push(label);
  }

  if (/^\s*fwd?\s*:/i.test(subject)) {
    violations.push('deceptive subject (fake Fwd: threading)');
  } else if (!isReply && /^\s*re\s*:/i.test(subject)) {
    violations.push('deceptive subject (fake Re: threading on a non-reply)');
  }
  if (!body.includes(UNSUBSCRIBE_PLACEHOLDER)) {
    violations.push(`missing ${UNSUBSCRIBE_PLACEHOLDER} placeholder (unsubscribe is mandatory, even 1:1)`);
  }

  violations.push(...listInventedPrices(combined));

  return violations;
};

// Any dollar figure that is not a pricing.js number is an invented price.
// Exported (B1): shared by the social-post validator — prices have ONE home.
export const listInventedPrices = (text = '') => {
  const violations = [];
  for (const match of String(text).matchAll(/\$\s?([\d,]+)/g)) {
    const amount = Number(match[1].replace(/,/g, ''));
    if (!dollarsAllowed.has(amount)) {
      violations.push(`price $${match[1]} is not a pricing.js price (allowed: ${[...dollarsAllowed].join(', ')})`);
    }
  }
  return violations;
};

// ── Send authority ───────────────────────────────────────────────────────────

// Latest stage for a channel from the append-only history rows (any order).
// No rows = 'off' — the safe default is structural, not configured.
export const resolveAuthorityStage = (rows = [], channel) => {
  let latest = null;
  for (const row of rows) {
    if (row?.channel !== channel) continue;
    const at = new Date(row.created_at || 0).getTime();
    if (!latest || at > latest.at) latest = { at, stage: row.stage };
  }
  const stage = latest?.stage;
  return CONFIG_STAGES.includes(stage) ? stage : 'off';
};

// v1: only canary/auto would ever allow a send without a per-send approval —
// and no code path in slice 1 calls this with anything but an approval in
// hand. It exists so the invariant has one name.
export const stageAllowsUnsupervisedSend = (stage) =>
  stage === 'canary' || stage === 'auto';

// ── Render for send ──────────────────────────────────────────────────────────

const escapeHtml = (text = '') =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const buildUnsubscribeUrl = (baseUrl, token) =>
  `${String(baseUrl || '').replace(/\/+$/, '')}/api/donna/marketing/unsubscribe?token=${encodeURIComponent(token)}`;

// Resolve draft copy into the exact payload that goes to the transport. The
// rendered content is what gets receipted — the receipt records what was
// actually sent, not what was proposed.
export const renderForSend = ({ draft, baseUrl }) => {
  const unsubscribeUrl = buildUnsubscribeUrl(baseUrl, draft.unsubscribe_token);
  const text = String(draft.body).split(UNSUBSCRIBE_PLACEHOLDER).join(unsubscribeUrl);
  const html = `${escapeHtml(String(draft.body))
    .split(UNSUBSCRIBE_PLACEHOLDER)
    .join(`<a href="${unsubscribeUrl}">unsubscribe</a>`)
    .replace(/\n/g, '<br />\n')}`;
  return {
    subject: String(draft.subject),
    text,
    html,
    unsubscribeUrl,
    headers: {
      // One-click unsubscribe headers — cheap now, mandatory if volume ever
      // approaches bulk-sender territory (Gmail sender rules).
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    }
  };
};
