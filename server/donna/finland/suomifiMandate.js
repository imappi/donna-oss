// G-3 (FI-15) — Suomi.fi mandate validity: the pure evaluator behind the ALV
// filing gate. A Suomi.fi-valtuudet mandate ("veroasioiden hoito") is the LEGAL
// authorization Verohallinto sees when Donna files for a client; the owner's
// WhatsApp "kyllä" is Donna's internal authority receipt. BOTH must hold before
// a statutory submission leaves the building (D-FI8-1,
// docs/design-donna-finland-fi8-omavero-adapter.md; gap G-3,
// docs/design-donna-finland-production-readiness.md).
//
// Deterministic, no I/O: the persisted suomifi_mandates row (migration 067) in,
// a CLOSED verdict out. Storage keeps only active|revoked; expiry is evaluated
// HERE at use time (the date is the receipt — no third resting state).

export const SUOMIFI_MANDATE_SCOPE_TAX = 'veroasioiden_hoito';

// Closed reason vocabulary — every invalid verdict names exactly one of these.
export const SUOMIFI_MANDATE_REASONS = Object.freeze([
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

// evaluateSuomifiMandate({ mandate, scope, onDate }) → { valid, reason }.
// `mandate` is the persisted row (or null); `onDate` any ISO date/timestamp —
// callers pass the filing moment so the verdict is reproducible after the fact.
export const evaluateSuomifiMandate = ({
  mandate = null,
  scope = SUOMIFI_MANDATE_SCOPE_TAX,
  onDate
} = {}) => {
  const at = dateOnly(onDate);
  if (!at) throw new Error('evaluateSuomifiMandate requires an onDate (ISO date or timestamp).');
  if (!mandate) return { valid: false, reason: 'no_mandate' };
  if (String(mandate.scope || '') !== String(scope)) return { valid: false, reason: 'wrong_scope' };
  if (mandate.status === 'revoked') return { valid: false, reason: 'revoked' };
  const grantedOn = dateOnly(mandate.granted_on);
  if (!grantedOn || grantedOn > at) return { valid: false, reason: 'not_yet_effective' };
  const expiresOn = dateOnly(mandate.expires_on);
  // Suomi.fi mandates run through their end date inclusive.
  if (expiresOn && expiresOn < at) return { valid: false, reason: 'expired' };
  return { valid: true, reason: 'valid' };
};

// assertSuomifiMandateValidForFiling — the gate's throwing form. One typed
// refusal code (ALV_FILING_MANDATE_REQUIRED) whatever the invalid reason: the
// filing path forks on the code, the reason rides `mandateReason` + message.
export const assertSuomifiMandateValidForFiling = ({
  mandate = null,
  scope = SUOMIFI_MANDATE_SCOPE_TAX,
  onDate
} = {}) => {
  const evaluation = evaluateSuomifiMandate({ mandate, scope, onDate });
  if (!evaluation.valid) {
    const error = new Error(
      `ALV filing requires a valid Suomi.fi mandate (${scope}); recorded mandate is ${evaluation.reason}.`
    );
    error.code = 'ALV_FILING_MANDATE_REQUIRED';
    error.mandateReason = evaluation.reason;
    throw error;
  }
  return evaluation;
};
