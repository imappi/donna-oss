// SG-13 — Singapore legal-form (entity type) resolver + KEEP-layer refusal guards.
// Pure DATA + pure compute, mirroring finland/entity.js 1:1. This module is the
// CANONICAL bridge from the persisted `profile.entity_type` (the free-form,
// FE-wired, jurisdiction-prefixed vocabulary in src/lib/clientAxes.js) to the
// internal sole_prop/pte_ltd/llp axis the Singapore statutory modules branch on.
//
// WHY a server-side resolver separate from src/lib/clientAxes.js: the Singapore
// statutory writers read `clients.profile` directly and must NOT depend on a
// front-end module. This is a self-contained reader over the same stored form.
//
// The supported Singapore legal-form vocabulary. `sg-pte` is the private limited
// company (Pte Ltd — the dominant form, the Oy analogue); `sg-sole-prop` the
// sole proprietorship; `sg-llp` the limited liability partnership. Mirrors
// ENTITY_TYPES_BY_JURISDICTION.sg in src/lib/clientAxes.js — keep the two in
// sync. `sg-llc` remains a readable legacy label but is NOT in the admitted
// intake vocabulary: it is not a Singapore statutory form (the local private
// company IS the Pte Ltd). It deliberately resolves to null here so a
// statutory surface never emits an artifact for an unrecognised form (the same
// posture as julkinen Oy / ky / ay being absent from the FI vocabulary).
// General partnerships (unlimited) are deliberately absent until designed.
export const SG_ENTITY_TYPES = Object.freeze(['sg-sole-prop', 'sg-pte', 'sg-llp']);

// The config-plane rollout gate for the fail-closed-on-unknown posture (born on
// the config plane per the flags rail — NOT an env pair). OFF by default
// (envFallback () => false), so the flip ships DARK: an unknown legal form stays
// permissive until a client_capability_config row turns the strict posture on.
export const SINGAPORE_ENTITY_FAIL_CLOSED_FLAG_KEY = 'SINGAPORE_ENTITY_FAIL_CLOSED';

// The internal axis the statutory modules speak. Corporate tax / ACRA surfaces
// branch on 'pte_ltd'; GST applies to every registered form.
const SG_ENTITY_TO_AXIS = Object.freeze({
  'sg-sole-prop': 'sole_prop',
  'sg-pte': 'pte_ltd',
  'sg-llp': 'llp'
});

// Read the raw stored legal form off a client row/shape. Accepts either the
// top-level `entity_type` column or `profile.entity_type` (the validated
// profile key), lowercased/trimmed — the same read shape as finland/entity.js,
// kept independent so the server has no FE import.
const readRawEntityType = (client = {}) => {
  const fromTop = client?.entity_type;
  const fromNested = client?.profile?.entity_type;
  const value = typeof fromTop === 'string'
    ? fromTop
    : typeof fromNested === 'string' ? fromNested : null;
  if (!value) return null;
  return value.trim().toLowerCase() || null;
};

// singaporeEntityType(client) → 'sole_prop' | 'pte_ltd' | 'llp' | null.
// Returns null for anything that is NOT a recognised Singapore legal form —
// including a missing value, a non-Singapore form like 'fi-oy', or the
// unsupported 'sg-llc' label. A null result means "this is not a Singapore
// statutory entity we recognise"; the CALLER decides what to do with that.
export const singaporeEntityType = (client = {}) => {
  const raw = readRawEntityType(client);
  if (!raw) return null;
  return SG_ENTITY_TO_AXIS[raw] || null;
};

// isSingaporePteLtd(client) — true only for an explicit `sg-pte` legal form.
export const isSingaporePteLtd = (client = {}) => singaporeEntityType(client) === 'pte_ltd';

// isSingaporeLegalFormConversion(stored, incoming) — true when BOTH the stored
// and the incoming legal form are recognised Singapore forms AND they differ (a
// real sole-prop↔Pte-Ltd conversion). Deliberately narrow: a null/non-Singapore
// incoming (an omitted entity_type on a re-provision, a foreign form) is NOT a
// "conversion" and never trips the guard.
export const isSingaporeLegalFormConversion = (storedEntityType, incomingEntityType) => {
  const stored = singaporeEntityType({ entity_type: storedEntityType });
  const incoming = singaporeEntityType({ entity_type: incomingEntityType });
  return Boolean(stored) && Boolean(incoming) && stored !== incoming;
};

// assertSingaporeLegalFormNotMutatedAfterPosting — the immutable-after-posting +
// no-in-place-conversion guard (the FI D-FI13-1 point-4 pattern). A Singapore
// legal-form change is handled by Donna as a new client and a cutover. This
// product rule is not a verified statement about every statutory conversion
// or succession of assets/liabilities. It must be modelled as a cutover, NEVER
// an entity_type edit on the posted book. Throws a typed 409 pointing at that
// workflow when a recognised-form conversion is attempted on a client that
// already has posted entries. A pre-books correction (no posted entries) is
// allowed, and a non-conversion is a no-op.
export const assertSingaporeLegalFormNotMutatedAfterPosting = ({
  storedEntityType,
  incomingEntityType,
  hasPostedEntries,
  code
} = {}) => {
  if (!isSingaporeLegalFormConversion(storedEntityType, incomingEntityType)) return;
  if (!hasPostedEntries) return;
  const error = new Error(
    `This client's Singapore legal form (${storedEntityType}) cannot be changed in ` +
    `place after entries have been posted. A change of legal form ` +
    `requires a separate entity/cutover assessment — ` +
    `model it as a new client plus a cutover, not an entity_type edit.`
  );
  error.statusCode = 409;
  error.code = code || 'SINGAPORE_ENTITY_TYPE_IMMUTABLE';
  error.storedEntityType = storedEntityType;
  error.incomingEntityType = incomingEntityType;
  throw error;
};

export const SG_ENTITY_TAX_PROVENANCE = Object.freeze({
  "sole_proprietor": {
    "url": "https://www.iras.gov.sg/taxes/individual-income-tax/self-employed-and-partnerships/tax-obligations-of-self-employed-persons/filing-responsibilities-of-self-employed-persons-(including-individual-partners)",
    "title": "Filing responsibilities of self-employed individuals",
    "quote": "individual Income Tax Return (Form B/B1)",
    "as_of": "2026-09-24",
    "confirmedAgainstPrimary": true
  },
  "partnership": {
    "url": "https://www.iras.gov.sg/taxes/individual-income-tax/self-employed-and-partnerships/tax-obligations-of-partnerships/basic-guide-for-partnerships",
    "title": "Basic guide for partnerships",
    "quote": "partnership Income Tax Return (Form P)",
    "as_of": "2026-09-24",
    "confirmedAgainstPrimary": true
  }
});

// assertSingaporeCompanyOnly({ client, code, surface, failClosedOnUnknown,
// unknownCode }) — the reusable KEEP-layer fail-safe for Pte-Ltd-only statutory
// surfaces (corporate income tax, ECI, ACRA annual return, XBRL). Two refusals,
// mirroring finland/entity.js assertFinlandToiminimiOnly's structure with the
// axis inverted (here the COMPANY is the supported lane):
//  1. a recognised NON-company form (sole_prop / llp) — ALWAYS throws
//     (unconditional): the surface would otherwise emit a legally wrong
//     artifact (a sole proprietor's income is assessed on the OWNER's personal
//     tax return, an LLP's on the partners' — neither files ECI / Form C-S).
//  2. `unknown` — throws ONLY when `failClosedOnUnknown` is true (the config-
//     gated strict posture): the client's legal form is not a recognised
//     Singapore form, so the surface cannot safely produce a statutory
//     artifact. With the flip OFF (the default), an unknown form passes
//     through as null and the caller decides.
// Refusals stamp `error.entityType` so a caller can mint the right blocker.
// Returns the resolved axis on the non-refusing path.
export const assertSingaporeCompanyOnly = ({
  client,
  code,
  surface = 'This Singapore statutory surface',
  failClosedOnUnknown = false,
  unknownCode
} = {}) => {
  const axis = singaporeEntityType(client);
  if (axis === 'sole_prop' || axis === 'llp') {
    const error = new Error(
      `${surface} is built for a Singapore private limited company (Pte Ltd) and does not ` +
      `apply to a ${axis === 'sole_prop' ? 'sole proprietorship' : 'limited liability partnership'}. ` +
      `${axis === 'sole_prop'
        ? "A sole proprietor's business income is assessed on the owner's personal income tax return (Form B/B1), not through ECI/Form C-S."
        : "An LLP's income is assessed on the partners, not the entity — it files Form P, not ECI/Form C-S."}`
    );
    error.statusCode = 409;
    error.code = code || 'SINGAPORE_ENTITY_UNSUPPORTED';
    error.entityType = axis;
    throw error;
  }
  if (axis === null && failClosedOnUnknown) {
    const error = new Error(
      `${surface} cannot resolve the client's Singapore legal form ` +
      `(sole proprietorship / Pte Ltd / LLP) and will not produce a statutory ` +
      `artifact without it. Set the client's legal form before continuing.`
    );
    error.statusCode = 409;
    error.code = unknownCode || 'SINGAPORE_ENTITY_TYPE_UNKNOWN';
    error.entityType = 'unknown';
    throw error;
  }
  return axis;
};

// ---------------------------------------------------------------------------------
// UEN (Unique Entity Number) — structural validation.
// ---------------------------------------------------------------------------------
// The UEN is the SG business identifier (the Y-tunnus analogue) issued by ACRA/
// UEN issuance agencies. Three structural formats:
//   • Business registered with ACRA (ROB): 8 digits + 1 check letter (9 chars),
//     e.g. 53012345A — sole proprietorships / partnerships.
//   • Local company (ROC): 4-digit year + 5 digits + 1 check letter (10 chars),
//     e.g. 201812345K — the Pte Ltd form.
//   • Other entities: T/S/R + 2-digit year + 2-letter entity-type code +
//     4 digits + 1 check letter (10 chars), e.g. T08LL0001A — LLPs (LL),
//     societies, etc.
// No primary specification for the check-character algorithm was located, so
// validation here is STRUCTURAL ONLY (format classes) — same honesty posture as
// the unconfirmed statutory tables elsewhere in this vertical: never guess an
// unpublished checksum, never reject a real UEN on a guessed one.
export const UEN_FORMAT_PROVENANCE = Object.freeze({
  "url": "https://www.iras.gov.sg/media/docs/default-source/uploadedfiles/pdf/partnership-allocation-template-technical-faq.pdf?sfvrsn=f48639b5_12",
  "title": "FAQ — Partnership Allocation Template, page 2",
  "quote": "nnnnnnnnX",
  "as_of": "2026-09-24",
  "confirmedAgainstPrimary": false,
  "checkDigitValidated": false,
  "source": "IRAS confirms 9-character business, 10-character local-company and TyyPQnnnnX other UEN examples. The complete regex restrictions (19/20, S/R, every allowed type code) and check-character algorithm were not located in a primary specification; aggregate remains unconfirmed.",
  "confirmed_formats": [
    {
      "url": "https://www.iras.gov.sg/media/docs/default-source/uploadedfiles/pdf/partnership-allocation-template-technical-faq.pdf?sfvrsn=f48639b5_12",
      "title": "FAQ — Partnership Allocation Template, page 2",
      "quote": "nnnnnnnnX",
      "as_of": "2026-09-24",
      "confirmedAgainstPrimary": true
    },
    {
      "url": "https://www.iras.gov.sg/media/docs/default-source/uploadedfiles/pdf/partnership-allocation-template-technical-faq.pdf?sfvrsn=f48639b5_12",
      "title": "FAQ — Partnership Allocation Template, page 2",
      "quote": "yyyynnnnnX",
      "as_of": "2026-09-24",
      "confirmedAgainstPrimary": true
    },
    {
      "url": "https://www.iras.gov.sg/media/docs/default-source/uploadedfiles/pdf/partnership-allocation-template-technical-faq.pdf?sfvrsn=f48639b5_12",
      "title": "FAQ — Partnership Allocation Template, page 2",
      "quote": "TyyPQnnnnX",
      "as_of": "2026-09-24",
      "confirmedAgainstPrimary": true
    }
  ]
});

const UEN_PATTERNS = [
  /^\d{8}[A-Z]$/, // ROB — business
  /^(19|20)\d{2}\d{5}[A-Z]$/, // ROC — local company (year-prefixed)
  /^[TSR]\d{2}[A-Z]{2}\d{4}[A-Z]$/ // other entities (LLPs et al.)
];

// isValidUen(value) — structural UEN validation. Uppercases and trims; never
// throws. A passing value is "shaped like a UEN", not "verified against ACRA"
// (that verification is a Bizfile lookup, recorded with provenance).
export const isValidUen = (value) => {
  const uen = String(value || '').trim().toUpperCase();
  if (!uen) return false;
  return UEN_PATTERNS.some((re) => re.test(uen));
};

// uenFormatClass(value) → 'business' | 'local_company' | 'other_entity' | null.
// The format class is itself a weak entity-form signal (a ROC UEN implies a
// company) — exposed for the detector/profile surfaces, never authoritative
// (the persisted entity_type is).
export const uenFormatClass = (value) => {
  const uen = String(value || '').trim().toUpperCase();
  if (!uen) return null;
  if (UEN_PATTERNS[0].test(uen)) return 'business';
  if (UEN_PATTERNS[1].test(uen)) return 'local_company';
  if (UEN_PATTERNS[2].test(uen)) return 'other_entity';
  return null;
};
