// Refuse-layer for owner-channel (WhatsApp / SMS) evidence-ask questions.
//
// The template copy tells owners "never send passwords, bank/card numbers, or
// IDs", but a copy line does not stop Donna from *asking* for one. This module
// is the deterministic guardrail that runs before an ask goes out over a
// messaging channel: it length-caps and de-newlines the dynamic question, and
// it refuses to send an ask that solicits a sensitive identifier over an
// unsecured channel (those fall back to the portal/email path instead).
//
// Pure + dependency-free so it is unit-testable in the sandbox.

export const OWNER_QUESTION_MAX_LEN = 120;

// Collapse whitespace/newlines, trim, and cap length (single-line, one ask).
export const sanitizeQuestionShort = (raw, { maxLen = OWNER_QUESTION_MAX_LEN } = {}) => {
  const collapsed = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
};

// Phrase/word-boundary patterns for asks that solicit a secret credential, a
// full financial number, or a government ID. Deliberately specific: a false
// positive only downgrades the ask to the portal (still reaches the owner),
// while a false negative sends the very thing we are trying to keep off WA.
export const SENSITIVE_ASK_PATTERNS = [
  /\bpasswords?\b/i,
  /\bpasscode\b/i,
  /\bpin\b/i,
  /\bcvv\b/i,
  /\bcvc\b/i,
  /\bsecurity code\b/i,
  /\b(?:credit|debit)?\s?card number\b/i,
  /\bfull card\b/i,
  /\bcard details\b/i,
  /\b(?:bank )?account number\b/i,
  /\bfull account\b/i,
  /\brouting number\b/i,
  /\bsort code\b/i,
  /\biban\b/i,
  /\bsocial security\b/i,
  /\bssn\b/i,
  /\bpassport\b/i,
  /\bdriver'?s licen[sc]e\b/i,
  /\bdriving licen[sc]e\b/i,
  /\bnational insurance\b/i,
  /\b(?:online banking|bank login|banking login|log ?in credentials|username and password)\b/i
];

export const questionSolicitsSensitiveInfo = (raw) => {
  const text = String(raw ?? '');
  return SENSITIVE_ASK_PATTERNS.some((pattern) => pattern.test(text));
};

// Prepare a raw ask question for an owner messaging channel.
// Returns { text, blocked, reason }:
//  - text:    the sanitized/capped question safe to place in a template param
//  - blocked: true if the ask solicits sensitive info (do NOT send over WA/SMS;
//             record a visible portal/email fallback instead)
//  - reason:  a stable ledger failure_reason when blocked
export const prepareOwnerAskQuestion = (raw) => {
  const blocked = questionSolicitsSensitiveInfo(raw);
  return {
    text: sanitizeQuestionShort(raw),
    blocked,
    reason: blocked ? 'sensitive_ask_portal_only' : null
  };
};
