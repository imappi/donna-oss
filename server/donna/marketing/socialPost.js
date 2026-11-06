// Social posts — B1 of the social/buzz charter
// (docs/design-donna-social-buzz-charter.md; §4 calls made 2026-07-24:
// X first, @your_handle_here, B1 approved). This module is the PURE half:
// vocabulary and the deterministic post validator (the Keep layer).
//
// Doctrine (charter §5/§7, enforced here deterministically):
//   - The claim checklist is ONE source of truth (BANNED_CLAIMS +
//     listInventedPrices from marketingOutbound.js) — every outward Donna
//     voice refuses the same claims and the same invented prices.
//   - diagnostic_content NEVER cold-@-mentions anyone; @-mentions belong to
//     the (design-first-gated) robotic-hi ping lane alone.
//   - B1 mints ONLY diagnostic_content — the writer refuses ping minting
//     structurally; B2 opens that lane with its own dated go.
//   - Per-post approval is the only publish authority; publishing is a
//     human paste, receipted by the pasted URL (the DB writer refuses
//     'published' without one).

import { BANNED_CLAIMS, listInventedPrices } from './marketingOutbound.js';

export const SOCIAL_PLATFORMS = Object.freeze(['x']);

export const SOCIAL_POST_KINDS = Object.freeze([
  'diagnostic_content',
  'robotic_hi_ping' // schema-ready for B2; B1 writers refuse to mint it
]);

// B1's mintable subset — the structural gate on the ping lane.
export const MINTABLE_POST_KINDS = Object.freeze(['diagnostic_content']);

export const SOCIAL_POST_STATUSES = Object.freeze([
  'proposed',
  'approved',
  'published',
  'rejected',
  'superseded'
]);

// Terminal = the post has come to rest with a receipt (two-terminal-states:
// everything else is on-Kari — 'proposed' awaiting his call, 'approved'
// awaiting his paste).
export const TERMINAL_SOCIAL_POST_STATUSES = Object.freeze(['published', 'rejected', 'superseded']);

// X's standard character limit. Premium raises it; the knob is
// MARKETING_SOCIAL_CHAR_LIMIT (routes read env — tuning, not a gate).
export const SOCIAL_CHAR_LIMIT_DEFAULT = 280;

// A cold @-mention: "@handle" at start-of-text or after whitespace/paren.
// Mid-word @ (emails, "kari@books.example") deliberately does not match.
const MENTION_PATTERN = /(^|[\s(])@\w/;

// Validate one post's copy against the charter rails. Returns [] when clean,
// or human-readable violation strings. The caller refuses to mint (or to
// approve) a violating post — writer-level invariant, not advice.
export const validateSocialPostCopy = (
  { body = '', kind = 'diagnostic_content' } = {},
  { maxChars = SOCIAL_CHAR_LIMIT_DEFAULT } = {}
) => {
  const violations = [];
  const text = String(body);

  if (!SOCIAL_POST_KINDS.includes(kind)) {
    violations.push(`unknown post kind: ${kind}`);
  }
  if (!text.trim()) {
    violations.push('empty body');
  }
  if (text.length > maxChars) {
    violations.push(`body is ${text.length} chars (limit ${maxChars})`);
  }

  for (const { pattern, label } of BANNED_CLAIMS) {
    if (pattern.test(text)) violations.push(label);
  }
  violations.push(...listInventedPrices(text));

  if (kind === 'diagnostic_content' && MENTION_PATTERN.test(text)) {
    violations.push('diagnostic content must not @-mention anyone (charter §5: mentions belong to the ping lane alone)');
  }

  return violations;
};
