// The read-only UI mirror of the server's affirmative "held for authority"
// proof (delegationGateProof in server/donna/reconciliationLlmCore.js): a
// SUGGESTED match whose ONLY withhold reason is the materiality ceiling, with
// gates A–D affirmatively true and E false. LOCK-STEP: heldMatchAuthority.test.js
// runs both predicates over the same receipts, so they cannot drift.
export const isMatchHeldForAuthority = (match) => {
  if (!match || match.status !== 'suggested') return false;
  const authorization = match.payload?.authorization;
  if (!authorization || typeof authorization !== 'object' || authorization.band !== 'suggested') return false;
  const reasons = Array.isArray(authorization.reasons) ? authorization.reasons : [];
  if (!reasons.length || !reasons.every((reason) => reason === 'above_materiality_ceiling')) return false;
  const gates = authorization.gates;
  if (!gates || typeof gates !== 'object') return false;
  return gates.A === true && gates.B === true && gates.C === true && gates.D === true && gates.E === false;
};

// Review date default for a new grant: 90 days out, as a yyyy-mm-dd input value.
export const defaultReviewDate = (now = new Date()) => {
  const date = new Date(now.getTime() + 90 * 86_400_000);
  return date.toISOString().slice(0, 10);
};

// Display parts of a grant's scope key (merchant:x|doc:y|acct:z) — the same
// reading as describeScopeKey in server/donna/reconciliationAuthorityRoutes.js.
export const describeGrantScope = (scopeKey) => {
  const parts = {};
  for (const piece of String(scopeKey || '').split('|')) {
    const idx = piece.indexOf(':');
    if (idx > 0) parts[piece.slice(0, idx)] = piece.slice(idx + 1);
  }
  return { merchant: parts.merchant || null, document_type: parts.doc || null, account: parts.acct || null };
};

// Which governance actions a grant offers, by status. Activating ones are
// unavailable while delegated authority is off for the client (they would be
// inert); narrowing ones always are.
export const grantActionsFor = (grant, { delegatedAuthorityActs = false } = {}) => {
  const activate = delegatedAuthorityActs;
  switch (grant?.status) {
    case 'proposed': return [...(activate ? ['approve'] : []), 'decline'];
    case 'active': return ['suspend', 'revoke'];
    case 'suspended': return [...(activate ? ['reactivate'] : []), 'revoke'];
    case 'revoked': return activate ? ['reactivate'] : [];
    default: return [];
  }
};

// A machine slug (supplier_bill, supplier-bill, match_rejected) read as words.
export const humanizeSlug = (value) => String(value || '').replace(/[_-]+/g, ' ').trim();
