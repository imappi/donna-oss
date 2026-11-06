// GB — United Kingdom legal-form resolver with KEEP-layer guards (gap 6, the
// entity-type leg). Closes the asymmetry that `src/lib/clientAxes.js` has
// declared four GB legal forms since the pack landed while `server/donna/` had
// no GB resolver at all, so nothing server-side could branch on a GB client's
// legal form or refuse when it could not resolve one.
//
// CANONICAL bridge from the persisted `profile.entity_type` / top-level
// `entity_type` to the internal axis the GB statutory modules speak. Same shape
// as `us/entity.js`, `singapore/entity.js` and `finland/entity.js` — pure data +
// pure compute, no DB, no network, no LLM.
//
// What this module will NOT do: guess a legal form, guess a constituent
// country, decide a tax treatment, or file/transmit anything. Every producer
// that needs a fact it cannot resolve refuses with a typed 409 rather than
// defaulting.
//
// The persisted vocabulary MIRRORS `ENTITY_TYPES_BY_JURISDICTION.gb` in
// `src/lib/clientAxes.js` (pinned by a drift test) — keep the two together,
// exactly as the US resolver does.

export const GB_ENTITY_TYPES = Object.freeze([
  'gb-ltd',
  'gb-llp',
  'gb-sole-trader',
  'gb-partnership'
]);

// The strict-posture flag, born on the config control plane per CLAUDE.md's
// rollout rail (NOT an env pair). OFF by default (`envFallback: () => false`),
// so the strict flip ships DARK: an unknown legal form stays permissive until a
// `client_capability_config` row turns it on. Mirrors
// US_ENTITY_FAIL_CLOSED_FLAG_KEY exactly.
export const GB_ENTITY_FAIL_CLOSED_FLAG_KEY = 'GB_ENTITY_FAIL_CLOSED';

// The internal axis the statutory modules branch on, never the display string.
// The split that matters most in the UK is INCORPORATED (Companies House
// filings, corporation tax) vs UNINCORPORATED (Self Assessment, no confirmation
// statement) — the confirmation-statement and corporation-tax duties the GB
// pack declares both key off this distinction.
const ENTITY_AXIS = Object.freeze({
  'gb-ltd': 'ltd',
  'gb-llp': 'llp',
  'gb-sole-trader': 'sole_trader',
  'gb-partnership': 'partnership'
});

// Companies House registers LTDs and LLPs; the two unincorporated forms have no
// company number and no confirmation statement.
export const GB_INCORPORATED_AXES = Object.freeze(['ltd', 'llp']);
export const GB_UNINCORPORATED_AXES = Object.freeze(['sole_trader', 'partnership']);

// ISO 3166-2:GB constituent countries. Kept deliberately small — this is NOT a
// county/council table, and `jurisdiction_subdivision` is only validated to the
// lenient `cc-sub` shape upstream, so an unrecognised value resolves to null
// rather than being trusted through.
export const GB_CONSTITUENT_COUNTRIES = Object.freeze(['ENG', 'SCT', 'WLS', 'NIR']);

const COUNTRY_SET = new Set(GB_CONSTITUENT_COUNTRIES);

// Reads either the top-level column or the validated `profile` blob — the same
// two homes `usEntityType` reads, so a caller does not have to know which shape
// it was handed.
const raw = (client, key) => {
  const value = client?.[key] ?? client?.profile?.[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
};

// The persisted legal form → internal axis, or null when it is absent or
// belongs to another jurisdiction. Null means "unknown", never a default.
export const gbEntityType = (client = {}) => ENTITY_AXIS[raw(client, 'entity_type')] || null;

// The constituent country, or null. Unknown/missing ⇒ null; a caller that
// genuinely depends on it must assert rather than default.
//
// Why this exists at all rather than being dismissed as cosmetic: Northern
// Ireland diverges from Great Britain for VAT on GOODS under the Windsor
// Framework, and Scotland/NI have their own Companies House number prefixes.
// Nothing in this module acts on that divergence — it is named here so a later
// VAT slice has a resolved fact to branch on instead of inventing one.
export const gbConstituentCountry = (client = {}) => {
  const match = /^gb-([a-z]{3})$/.exec(raw(client, 'jurisdiction_subdivision') || '');
  const code = match?.[1]?.toUpperCase() || null;
  return code && COUNTRY_SET.has(code) ? code : null;
};

const refusal = (message, code, extra = {}) =>
  Object.assign(new Error(message), { statusCode: 409, code, ...extra });

// Refuses when the constituent country cannot be resolved. For surfaces whose
// output depends on WHICH country — there is no "default country", and
// defaulting to England is exactly the silent-wrongness this refuses.
export const assertGbConstituentCountryResolved = ({
  client, surface = 'This GB statutory surface'
} = {}) => {
  const country = gbConstituentCountry(client);
  if (!country) {
    throw refusal(
      `${surface} cannot resolve a UK constituent country (England, Scotland, Wales or Northern Ireland); set jurisdiction_subdivision before continuing.`,
      'GB_CONSTITUENT_COUNTRY_UNKNOWN',
      { constituentCountry: 'unknown' }
    );
  }
  return country;
};

// The entity guard. `failClosedOnUnknown` is the caller's expression of the
// GB_ENTITY_FAIL_CLOSED stage: false (default, dark) lets an unknown form pass
// through as null so nothing regresses; true refuses. A form that IS known but
// not allowed always refuses, at either stage.
export const assertGbEntityOnly = ({
  client,
  allowed = [],
  surface = 'This GB statutory surface',
  failClosedOnUnknown = false
} = {}) => {
  const axis = gbEntityType(client);
  if (!axis && !failClosedOnUnknown) return null;
  if (!axis) {
    throw refusal(`${surface} cannot resolve the client's UK legal form.`, 'GB_ENTITY_TYPE_UNKNOWN', {
      entityType: 'unknown'
    });
  }
  if (!allowed.includes(axis)) {
    throw refusal(`${surface} does not apply to entity type ${axis}.`, 'GB_ENTITY_UNSUPPORTED', {
      entityType: axis
    });
  }
  return axis;
};

// Companies House filings (confirmation statement, annual accounts).
export const assertGbIncorporatedOnly = (options = {}) =>
  assertGbEntityOnly({ ...options, allowed: [...GB_INCORPORATED_AXES] });

// Corporation tax is a company duty; an LLP is tax-transparent and its members
// are taxed individually, so it is deliberately NOT included here.
export const assertGbCorporationTaxOnly = (options = {}) =>
  assertGbEntityOnly({ ...options, allowed: ['ltd'] });

// Self Assessment covers the unincorporated forms.
export const assertGbSelfAssessmentOnly = (options = {}) =>
  assertGbEntityOnly({ ...options, allowed: [...GB_UNINCORPORATED_AXES] });

export const assertGbSoleTraderOnly = (options = {}) =>
  assertGbEntityOnly({ ...options, allowed: ['sole_trader'] });

// ── Structural format checks ────────────────────────────────────────────────
//
// Both checks below are STRUCTURAL ONLY: they say a string is SHAPED like the
// identifier, never that the registrar issued it or that it belongs to this
// business. Callers must not treat a true here as verification. Same posture,
// and same warning, as `isValidEin` in us/entity.js.

// A Companies House company number is 8 characters: either 8 digits (England &
// Wales) or a 2-letter prefix + 6 digits — SC (Scotland), NI (Northern
// Ireland), OC/SO/NC (the LLP series for E&W / Scotland / NI).
// Authority: Companies House; as of 2026-07-27.
export const COMPANY_NUMBER_FORMAT_PROVENANCE = Object.freeze({
  authority: 'Companies House — company number format',
  asOf: '2026-07-27',
  validation: 'structural_only'
});

export const isValidCompanyNumber = (value) =>
  /^(?:\d{8}|[A-Z]{2}\d{6})$/.test(String(value || '').trim().toUpperCase());

// A UK VAT registration number is 9 digits, conventionally shown with a GB
// prefix and often spaced/hyphenated. Two further real forms exist: branch
// traders carry 12 digits, and government departments / health authorities use
// the GBGD/GBHA + 3-digit series. All four are accepted structurally.
//
// This is the identifier gap 9 needs a persisted home for: nothing in the tree
// stores a seller's VAT number today, which is why core cannot yet build a
// correct invoice for either a registered OR a non-registered GB seller.
// Authority: HMRC VAT Notice 700 §16.6; as of 2026-07-27. Not primary-confirmed
// (gov.uk returns 403 through this environment's egress proxy) — structural
// only, so the risk of the unconfirmed read is bounded to shape.
export const VAT_NUMBER_FORMAT_PROVENANCE = Object.freeze({
  authority: 'HMRC — VAT Notice 700 §16.6',
  asOf: '2026-07-27',
  confirmedAgainstPrimary: false,
  validation: 'structural_only'
});

export const isValidGbVatNumber = (value) => {
  const cleaned = String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
  const bare = cleaned.startsWith('GB') ? cleaned.slice(2) : cleaned;
  if (/^(GD|HA)\d{3}$/.test(bare)) return true;
  return /^\d{9}$/.test(bare) || /^\d{12}$/.test(bare);
};
