import { docTypeLabel } from './transactionMatchHero.js';

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

// ── Presentation ─────────────────────────────────────────────────────────
// Everything below turns a canonical value (an ISO date, an amount, a status
// or reason code) into what a person reads. The value itself never changes:
// dates go through the interface date formatter, amounts through the
// accounting amount formatter (currency placed by the locale), and every code
// through a catalog message. An unknown code never prints itself and never
// throws: it reads as that kind's catalog fallback.

const NO_VALUE = '\u2014';

const hasMessage = (intl, id) => Boolean(id)
  && Object.prototype.hasOwnProperty.call(intl?.messages || {}, id);

// `${prefix}.${code}` when the catalog has it, else the kind's fallback id.
const codeMessage = (intl, prefix, code, fallbackId, values) => {
  const id = code ? `${prefix}.${code}` : null;
  return intl.formatMessage({ id: hasMessage(intl, id) ? id : fallbackId }, values);
};

// A calendar day. Timestamps (created_at, last_used_at, suspension time)
// read as their UTC day, the same day the screen printed before; the
// formatter's own defaults place it in the reader's locale (Apr 20, 2025 /
// 20.4.2025). Unparseable → the dash.
export const authorityDate = (value, formatDate) => {
  if (!value) return NO_VALUE;
  try {
    return formatDate(String(value instanceof Date ? value.toISOString() : value).slice(0, 10));
  } catch {
    return NO_VALUE;
  }
};

// An amount with its currency, the way the match hero prints money: whole
// amounts without decimals; the locale decides the currency's form and place
// (GBP 1,200 / 1 200 £) and how a negative reads.
export const authorityAmount = (amount, currency, formatAmount) => {
  if (amount === null || amount === undefined || amount === '') return NO_VALUE;
  const n = Number(amount);
  if (!Number.isFinite(n)) return NO_VALUE;
  try {
    return formatAmount(n, {
      currency: String(currency || '').trim() || null,
      minimumFractionDigits: Math.abs(n) % 1 ? 2 : 0,
      maximumFractionDigits: 2
    });
  } catch {
    return NO_VALUE;
  }
};

// A document type, through the reconciliation area's own vocabulary
// (docTypeLabel, the match hero's labels and its fallback: a type the
// vocabulary does not know yet reads title-cased rather than blank). Scope
// keys carry the type as a hyphenated slug (supplier-bill), documents as
// snake case (supplier_bill); both name the same type.
export const authorityDocumentType = (intl, value) => {
  const code = String(value || '').trim().toLowerCase().replace(/-/g, '_');
  return code ? docTypeLabel(code, intl.formatMessage) : NO_VALUE;
};

export const authorityGrantStatus = (intl, status) =>
  codeMessage(intl, 'firm.reconAuthority.grants.status', status, 'firm.reconAuthority.grants.status.unknown');

export const authorityArchetype = (intl, archetype) =>
  codeMessage(intl, 'firm.reconAuthority.archetype', archetype, 'firm.reconAuthority.archetype.unknown');

export const authorityIneligibleReason = (intl, reason, existingStatus) =>
  codeMessage(intl, 'firm.reconAuthority.ineligible', reason, 'firm.reconAuthority.ineligible.unknown', {
    status: existingStatus ? authorityGrantStatus(intl, existingStatus) : NO_VALUE
  });

// Why a grant suspended itself (server/donna/db/reconcile.js →
// suspendGrantAfterCorrection). A rejected match reuses the operator
// receipt's "Match rejected"; anything else is a correction.
const SUSPENSION_CAUSE_MESSAGE_IDS = Object.freeze({
  match_rejected: 'operator.receipt.matchRejected',
  match_demoted: 'firm.reconAuthority.suspension.matchDemoted',
  post_grant_correction: 'firm.reconAuthority.suspension.corrected'
});
export const authoritySuspensionCause = (intl, reason) => intl.formatMessage({
  id: SUSPENSION_CAUSE_MESSAGE_IDS[reason] || 'firm.reconAuthority.suspension.corrected'
});

// Who granted it when no person is named on the row: the store's actor type
// (RUNTIME_MINT_ACTOR_TYPES), never the raw code.
export const authorityActor = (intl, actorId, actorType) => {
  const named = String(actorId || '').trim();
  if (named) return named;
  return codeMessage(intl, 'firm.reconAuthority.actor', actorType, 'firm.reconAuthority.actor.unknown');
};

// A refused write (the routes' and the store's error codes) as a sentence.
// Codes group by what the person can do about them; a code not listed here,
// or a network failure with no code, reads as the generic sentence — the
// server's English message is never shown in place of a catalog message.
const REFUSAL_MESSAGE_IDS = Object.freeze({
  NO_PRINCIPAL: 'firm.reconAuthority.refusal.notAllowed',
  UNNAMED_PRINCIPAL: 'firm.reconAuthority.refusal.notAllowed',
  NOT_FIRM_SIDE: 'firm.reconAuthority.refusal.notAllowed',
  CLIENT_SIDE_PRINCIPAL: 'firm.reconAuthority.refusal.notAllowed',
  EXTERNAL_SEAT: 'firm.reconAuthority.refusal.notAllowed',
  NOT_A_SEAT: 'firm.reconAuthority.refusal.notAllowed',
  CAPABILITY_REQUIRED: 'firm.reconAuthority.refusal.notAllowed',
  GRANT_AUTHORITY_REQUIRED: 'firm.reconAuthority.refusal.notAllowed',
  GRANT_ACTOR_REQUIRED: 'firm.reconAuthority.refusal.notAllowed',
  DELEGATED_AUTHORITY_OFF: 'firm.reconAuthority.ineligible.delegated_authority_off',
  GRANT_NOT_ACKNOWLEDGED: 'firm.reconAuthority.refusal.notAcknowledged',
  GRANT_DATE_INVALID: 'firm.reconAuthority.refusal.reviewDate',
  GRANT_TIME_BOUND_PAST: 'firm.reconAuthority.refusal.reviewDate',
  GRANT_TIME_BOUND_TOO_FAR: 'firm.reconAuthority.refusal.reviewDate',
  GRANT_TIME_BOUND_REQUIRED: 'firm.reconAuthority.refusal.reviewDate',
  GRANT_CEILING_REQUIRED: 'firm.reconAuthority.refusal.ceiling',
  GRANT_CEILING_BELOW_EXAMPLE: 'firm.reconAuthority.refusal.ceiling',
  GRANT_CURRENCY_MISMATCH: 'firm.reconAuthority.refusal.currency',
  GRANT_REASON_REQUIRED: 'firm.reconAuthority.refusal.reasonRequired',
  GRANT_NOT_FOUND: 'firm.reconAuthority.refusal.changed',
  GRANT_TRANSITION_ILLEGAL: 'firm.reconAuthority.refusal.changed',
  GRANT_TRANSITION_INVALID: 'firm.reconAuthority.refusal.changed',
  GRANT_ACTION_UNSUPPORTED: 'firm.reconAuthority.refusal.changed'
});
export const authorityRefusal = (intl, error) => {
  const code = error?.code || error?.body?.code || null;
  // A mint refused as no longer eligible carries the preview's reason.
  if (code === 'GRANT_NOT_ELIGIBLE') {
    const body = error?.body || {};
    return authorityIneligibleReason(intl, body.reason, body.existing_grant?.status);
  }
  return intl.formatMessage({ id: REFUSAL_MESSAGE_IDS[code] || 'firm.reconAuthority.refusal.unknown' });
};
