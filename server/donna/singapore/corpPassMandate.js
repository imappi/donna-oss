// SG G-3 — CorpPass authorization validity: the pure evaluator behind the SG
// filing gates, mirroring finland/suomifiMandate.js 1:1. A CorpPass
// authorization (the entity assigning the filer digital-service access to the
// relevant IRAS/ACRA e-Services) is the LEGAL authorization the authority sees
// when Donna files for a client; the owner's chat "yes" is Donna's internal
// authority receipt. BOTH must hold before a statutory submission leaves the
// building (the D-FI8-1 pattern, applied to Singapore).
//
// Deterministic, no I/O: the persisted corppass_mandates row (migration 089)
// in, a CLOSED verdict out. Storage keeps only active|revoked; expiry is
// evaluated HERE at use time (the date is the receipt — no third resting state).

// CorpPass digital-service scopes, keyed to the authority's own e-Service
// vocabulary (the authority's catalog, not ours — the suomifi 'veroasioiden_
// hoito' posture). The GST filing gate looks up 'iras_gst'; corporate tax
// 'iras_cit'; ACRA annual return / XBRL 'acra_filing'.
export const CORPPASS_SCOPE_GST = 'iras_gst';
export const CORPPASS_SCOPE_CIT = 'iras_cit';
export const CORPPASS_SCOPE_ACRA = 'acra_filing';

export const CORPPASS_SCOPES = Object.freeze([
  CORPPASS_SCOPE_GST,
  CORPPASS_SCOPE_CIT,
  CORPPASS_SCOPE_ACRA
]);

// The corppass_mandates lifecycle vocabulary (CLOSED, two-state — the 067
// pattern). Pinned by migrations.test.js against the 089 CHECK constraint.
export const CORPPASS_MANDATE_STATUSES = Object.freeze(['active', 'revoked']);

// Closed reason vocabulary — every invalid verdict names exactly one of these.
export const CORPPASS_MANDATE_REASONS = Object.freeze([
  'valid',
  'no_mandate',
  'wrong_scope',
  'revoked',
  'not_yet_effective',
  'expired'
]);

const dateOnly = (value) => {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// evaluateCorpPassMandate({ mandate, scope, onDate }) → { valid, reason }.
// `mandate` is the persisted row (or null); `onDate` any ISO date/timestamp —
// callers pass the filing moment so the verdict is reproducible after the fact.
export const evaluateCorpPassMandate = ({
  mandate = null,
  scope = CORPPASS_SCOPE_GST,
  onDate
} = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('evaluateCorpPassMandate requires an onDate (ISO date or timestamp).');
  if (!mandate) return { valid: false, reason: 'no_mandate' };
  if (String(mandate.scope || '') !== String(scope)) return { valid: false, reason: 'wrong_scope' };
  if (mandate.status === 'revoked') return { valid: false, reason: 'revoked' };
  const grantedOn = dateOnly(mandate.granted_on);
  if (!grantedOn || grantedOn > at) return { valid: false, reason: 'not_yet_effective' };
  const expiresOn = dateOnly(mandate.expires_on);
  // CorpPass authorizations run through their end date inclusive.
  if (expiresOn && expiresOn < at) return { valid: false, reason: 'expired' };
  return { valid: true, reason: 'valid' };
};

// assertCorpPassMandateValidForFiling — the gate's throwing form. One typed
// refusal code (SG_FILING_CORPPASS_REQUIRED) whatever the invalid reason: the
// filing path forks on the code, the reason rides `mandateReason` + message.
// Fail-closed: no recorded authorization ⇒ no transmit, ever.
export const assertCorpPassMandateValidForFiling = ({
  mandate = null,
  scope = CORPPASS_SCOPE_GST,
  onDate
} = {}) => {
  const evaluation = evaluateCorpPassMandate({ mandate, scope, onDate });
  if (!evaluation.valid) {
    const error = new Error(
      `Singapore statutory filing requires a valid CorpPass authorization (${scope}); recorded authorization is ${evaluation.reason}.`
    );
    error.code = 'SG_FILING_CORPPASS_REQUIRED';
    error.mandateReason = evaluation.reason;
    throw error;
  }
  return evaluation;
};
