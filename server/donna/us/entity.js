// US-1 — United States legal-form and state resolver with KEEP-layer guards.
//
// CANONICAL bridge from the persisted `profile.entity_type` / top-level
// `entity_type` to the internal axis the US statutory modules speak. Same shape
// as `singapore/entity.js` and `finland/entity.js` — pure data + pure compute,
// no DB, no network, no LLM.
//
// What this module will NOT do: guess a legal form, guess a state, decide a tax
// treatment, or file/transmit anything. Every producer that needs a fact it
// cannot resolve refuses with a typed 409 rather than defaulting.
//
// The persisted vocabulary MIRRORS `ENTITY_TYPES_BY_JURISDICTION.us` in
// `src/lib/clientAxes.js` (verified in sync at build time) — keep the two
// together, exactly as the SG and FI resolvers do.

export const US_ENTITY_TYPES = Object.freeze([
  'us-llc',
  'us-c-corp',
  'us-s-corp',
  'us-sole-prop',
  'us-partnership'
]);

// The strict-posture flag, born on the config control plane per CLAUDE.md's
// rollout rail (NOT an env pair). OFF by default (`envFallback: () => false`),
// so the strict flip ships DARK: an unknown legal form stays permissive until a
// `client_capability_config` row turns it on. Mirrors
// SINGAPORE_ENTITY_FAIL_CLOSED_FLAG_KEY exactly.
export const US_ENTITY_FAIL_CLOSED_FLAG_KEY = 'US_ENTITY_FAIL_CLOSED';

// The internal axis the statutory modules branch on. Federal return form and
// the Delaware obligation both key off this, never off the display string.
const ENTITY_AXIS = Object.freeze({
  'us-llc': 'llc',
  'us-c-corp': 'c_corp',
  'us-s-corp': 's_corp',
  'us-sole-prop': 'sole_prop',
  'us-partnership': 'partnership'
});

// ISO 3166-2:US subdivisions Donna recognises: the 50 states plus DC.
// Territories (PR, GU, VI, AS, MP) are deliberately ABSENT — their filing
// regimes differ, and a silent inclusion would let a producer borrow a state
// cadence that does not apply to them.
export const US_STATE_CODES = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC'
]);

const STATE_SET = new Set(US_STATE_CODES);

// Reads either the top-level column or the validated `profile` blob — the same
// two homes `singaporeEntityType` reads, so a caller does not have to know
// which shape it was handed.
const raw = (client, key) => {
  const value = client?.[key] ?? client?.profile?.[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
};

// The persisted legal form → internal axis, or null when it is absent or
// belongs to another jurisdiction. Null means "unknown", never a default.
export const usEntityType = (client = {}) => ENTITY_AXIS[raw(client, 'entity_type')] || null;

// ISO 3166-2 US subdivision only (`jurisdiction_subdivision`, validated to the
// `us-ca` shape by clientProfileSchema). Unknown/missing/territory ⇒ null;
// callers use assertUsStateResolved where producing an artifact REQUIRES it.
export const usStateCode = (client = {}) => {
  const match = /^us-([a-z]{2})$/.exec(raw(client, 'jurisdiction_subdivision') || '');
  const code = match?.[1]?.toUpperCase() || null;
  return code && STATE_SET.has(code) ? code : null;
};

const refusal = (message, code, extra = {}) =>
  Object.assign(new Error(message), { statusCode: 409, code, ...extra });

// Refuses when the state cannot be resolved. Used by every surface whose output
// depends on WHICH state — there is no "default state".
export const assertUsStateResolved = ({ client, surface = 'This US statutory surface' } = {}) => {
  const state = usStateCode(client);
  if (!state) {
    throw refusal(
      `${surface} cannot resolve a supported US state (50 states plus DC); set jurisdiction_subdivision before continuing.`,
      'US_STATE_UNKNOWN',
      { state: 'unknown' }
    );
  }
  return state;
};

// The entity guard. `failClosedOnUnknown` is the caller's expression of the
// US_ENTITY_FAIL_CLOSED stage: false (default, dark) lets an unknown form pass
// through as null so nothing regresses; true refuses. A form that IS known but
// not allowed always refuses, at either stage.
export const assertUsEntityOnly = ({
  client,
  allowed = [],
  surface = 'This US statutory surface',
  failClosedOnUnknown = false
} = {}) => {
  const axis = usEntityType(client);
  if (!axis && !failClosedOnUnknown) return null;
  if (!axis) {
    throw refusal(`${surface} cannot resolve the client's US legal form.`, 'US_ENTITY_TYPE_UNKNOWN', {
      entityType: 'unknown'
    });
  }
  if (!allowed.includes(axis)) {
    throw refusal(`${surface} does not apply to entity type ${axis}.`, 'US_ENTITY_UNSUPPORTED', {
      entityType: axis
    });
  }
  return axis;
};

export const assertUsCorporationOnly = (options = {}) =>
  assertUsEntityOnly({ ...options, allowed: ['c_corp', 's_corp'] });

export const assertUsPartnershipReturnOnly = (options = {}) =>
  assertUsEntityOnly({ ...options, allowed: ['partnership', 'llc'] });

export const assertUsSoleProprietorOnly = (options = {}) =>
  assertUsEntityOnly({ ...options, allowed: ['sole_prop'] });

// An EIN is nine digits, customarily displayed NN-NNNNNNN. This is a STRUCTURAL
// check only: it says the string is SHAPED like an EIN, never that the IRS
// issued it or that it belongs to this business. Callers must not treat a true
// here as verification.
// Authority: IRS, "Understanding Your EIN"; as of 2026-07-27.
export const EIN_FORMAT_PROVENANCE = Object.freeze({
  authority: 'IRS — Understanding Your EIN',
  asOf: '2026-07-27',
  validation: 'structural_only'
});

export const isValidEin = (value) => /^\d{2}-\d{7}$/.test(String(value || '').trim());
