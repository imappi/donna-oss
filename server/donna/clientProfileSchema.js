// Known-keys validator for clients.profile partial-merge writes.
//
// The partial-merge endpoint (POST /api/donna/firms/clients/:id/profile)
// shipped in PR #234 takes an arbitrary jsonb patch and merges it. That
// stays generic — adding a new key still doesn't need code changes on
// the writer. This validator sits in front of it:
//
//   1. Enforces enum membership for known keys (services_engaged ids,
//      jurisdiction codes, accounting_system values).
//   2. Normalises non-canonical aliases (uk → gb) so the storage value
//      is the ISO 3166-1 alpha-2 form.
//   3. Rejects writes to fields that are server-computed and must not
//      come from operator input (jurisdiction_detected,
//      jurisdiction_signals, accounting_system_connection) — including
//      provenance (who/when), which the server stamps from the
//      authenticated principal so it can't be spoofed by the FE
//      (services_engaged_set_by/_at, accounting_system_set_by/_at,
//      jurisdiction_confirmed_by/_at).
//   4. Preserves unknown keys forward-compat (a future field can land
//      without a validator update) but logs them on the returned
//      warnings array.
//
// See docs/jurisdiction-services-accounting-plan.md for the full
// design.

import { ACCOUNTING_PROFILE_KEYS, normalizeAccountingProfilePatch } from '../../src/lib/accountingProfile.js';
import { sanitizeAssistantName } from './assistantIdentity.js';
import { normalizeCountryProfileValue, PROFILE_VALIDATION_REGISTRY } from './profileValidationRegistry.js';
import { canonicalizeClientProfilePatchLegalForm } from './clientLegalForm.js';
import { toUtcIsoDay } from './dates.js';

// Canonical service ids — keep in sync with src/lib/clientAxes.js.
const SERVICE_IDS = new Set([
  'bank_reconciliation',
  'sales_invoicing',
  'bills_and_expenses',
  'payroll',
  'loan_tracking',
  'tax_filing',
  'compliance_filings',
  'secretarial',
  'management_accounts'
]);

// Jurisdiction codes — ISO 3166-1 alpha-2 lowercased. Free-form
// underneath, but we recognise the supported set and normalise the
// common non-ISO alias `uk` → `gb`.
const JURISDICTION_ALIAS = { uk: 'gb' };
const KNOWN_JURISDICTIONS = new Set([
  'sg', 'us', 'gb', 'hk', 'au', 'nz', 'my', 'id', 'ph', 'de', 'ca', 'fi',
  'ae' // pack-authored market since 2026-08-30; live lane 2026-08-31
]);

const ACCOUNTING_SYSTEMS = new Set(['xero', 'qbo', 'procountor', 'none']);

// The phone business register's vocabulary. mobile/mobileBusinessSetup.js
// owns the contract (LEGAL_FORMS, BUSINESS_STAGES); the schema keeps its own
// copy so this module does not import the phone adapter, and
// clientProfileSchema.test.js pins the two equal.
const BUSINESS_REGISTER_LEGAL_FORMS = Object.freeze(['sole_trader', 'limited_company', 'other']);
const BUSINESS_REGISTER_SOURCES = Object.freeze(['prh_ytj', 'owner']);
const BUSINESS_SETUP_STAGES = Object.freeze(['new', 'existing']);
const BUSINESS_REGISTER_KEYS = Object.freeze(['business_id', 'legal_form', 'legal_form_code', 'registered_address', 'source',
  'fetched_at', 'authority_verified', 'confirmed_by', 'confirmed_at', 'terminal']);
const BUSINESS_SETUP_KEYS = Object.freeze(['business_stage', 'suggestion_dismissed']);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

// A plain object carrying exactly `keys` (all present, nothing else).
const exactObject = (value, label, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throwBadRequest(`${label} must be an object.`);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) throwBadRequest(`${label} may not carry ${extra.map((key) => JSON.stringify(key)).join(', ')}.`);
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throwBadRequest(`${label} is missing ${missing.join(', ')}.`);
  return value;
};

// Keys the validator KNOWS about. Each carries a normaliser that
// either returns the cleaned value, returns undefined to drop the
// key, or throws a 400 with a useful message.
const KNOWN_KEYS = {
  // Existing (kept untouched).
  applicable_intake_categories: (value) => {
    if (!Array.isArray(value)) throwBadRequest('applicable_intake_categories must be an array.');
    return value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
  },
  dismissed_tiles: (value) => {
    if (value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throwBadRequest('dismissed_tiles must be an object keyed by period.');
    }
    return value;
  },

  // In-portal business-name rename. Self-provisioned owners land with an
  // email-prefix placeholder name (e.g. "kari"); this lets them fix it.
  // The display name resolves `profile.companyName || clients.company_name`,
  // but the firm-facing display_name reader uses the raw column, so the
  // writer (updateClientProfileInDb) mirrors this value back into the
  // company_name column — same load-bearing-column-sync pattern as
  // `jurisdiction`. A rename can't blank the name: empty/whitespace 400s.
  companyName: (value) => {
    if (typeof value !== 'string') throwBadRequest('companyName must be a string.');
    const trimmed = value.trim();
    if (!trimmed) throwBadRequest('companyName must not be empty.');
    if (trimmed.length > 200) throwBadRequest('companyName must be 200 characters or fewer.');
    return trimmed;
  },

  // New in Phase 1.
  services_engaged: (value) => {
    if (!Array.isArray(value)) throwBadRequest('services_engaged must be an array.');
    const cleaned = [];
    for (const raw of value) {
      const id = typeof raw === 'string' ? raw.trim() : '';
      if (!id) continue;
      if (!SERVICE_IDS.has(id)) {
        throwBadRequest(`Unknown service id: ${JSON.stringify(id)}.`);
      }
      if (!cleaned.includes(id)) cleaned.push(id);
    }
    return cleaned;
  },

  // Reserved in Phase 1 — accept so a Phase 2a write doesn't 400, but
  // validate strictly. Storage form is ISO 3166-1 alpha-2 lowercased.
  jurisdiction: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('jurisdiction must be a string.');
    const lower = value.trim().toLowerCase();
    if (!lower) return null;
    if (lower === 'unknown') return 'unknown';
    const normalised = JURISDICTION_ALIAS[lower] || lower;
    // Accept any 2-letter lowercase code — `KNOWN_JURISDICTIONS` is only
    // for surfacing warnings, not gating writes (a new country shouldn't
    // require a validator update).
    if (!/^[a-z]{2}$/.test(normalised)) {
      throwBadRequest(`jurisdiction must be a 2-letter ISO code, got ${JSON.stringify(value)}.`);
    }
    return normalised;
  },
  jurisdiction_subdivision: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('jurisdiction_subdivision must be a string.');
    const lower = value.trim().toLowerCase();
    if (!lower) return null;
    // Lenient: ISO 3166-2 is `cc-sub`; we accept that shape but don't enforce
    // a per-country subdivision table.
    if (!/^[a-z]{2}-[a-z0-9]{1,3}$/.test(lower)) {
      throwBadRequest(`jurisdiction_subdivision must look like 'us-ca', got ${JSON.stringify(value)}.`);
    }
    return lower;
  },
  entity_type: (value, _warnings, { jurisdiction = null } = {}) => {
    if (value !== null && typeof value !== 'string') throwBadRequest('entity_type must be a string.');
    try {
      return canonicalizeClientProfilePatchLegalForm({ jurisdiction, value });
    } catch (error) {
      // Profile-patch validation has historically been a 400 contract. Keep
      // that transport status while preserving BF-2's stable code/details.
      error.statusCode = 400;
      throw error;
    }
  },
  // The camelCase legal form the Finnish pilot preparation writes
  // (hostedPilot.js: 'fi-oy'). Read beside entity_type by every legal-form
  // reader (clientLegalForm.js, countryLifecycleContext.js, …), so it takes the
  // same validation: canonicalised for the jurisdiction, an unknown form
  // refused, null clears. It is not mirrored into the entity_type column: the
  // pilot requires that column to be set already.
  entityType: (value, warnings, context) => {
    if (value !== null && typeof value !== 'string') throwBadRequest('entityType must be a string.');
    return KNOWN_KEYS.entity_type(value, warnings, context);
  },
  // The book's accounting currency, as the Finnish pilot preparation writes it
  // ('EUR'). An ISO 4217 code: three letters, stored upper-case; null clears.
  accountingCurrency: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('accountingCurrency must be a string.');
    const code = value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throwBadRequest(`accountingCurrency must be a three-letter ISO 4217 code, got ${JSON.stringify(value)}.`);
    return code;
  },
  incorporation_date: (value) => {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throwBadRequest('incorporation_date must be YYYY-MM-DD.');
    if (toUtcIsoDay(value) !== value) throwBadRequest('incorporation_date must be a valid date.');
    return value;
  },

  // D-PA-3 (design-donna-personal-agent.md §5) — the owner's chosen display
  // name for their assistant ("Tessa"). Sanitized (single line, conservative
  // charset, ≤24 chars) by assistantIdentity.js; an unusable value rejects
  // rather than silently falling back so the owner sees why. null clears
  // (→ 'Donna' at read time).
  assistant_name: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('assistant_name must be a string.');
    const sanitized = sanitizeAssistantName(value);
    if (!sanitized) throwBadRequest('assistant_name must contain letters or numbers (max 24 characters).');
    return sanitized;
  },

  accounting_system: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('accounting_system must be a string.');
    const lower = value.trim().toLowerCase();
    if (!lower) return null;
    if (!ACCOUNTING_SYSTEMS.has(lower)) {
      throwBadRequest(`Unknown accounting_system: ${JSON.stringify(value)}.`);
    }
    return lower;
  },

  // FI-10 (F-U1) — the owner's OWN seller identity, persisted from the invoice-
  // issuance chat when the owner supplies it (the profile lacked it), so Donna
  // stops re-asking every invoice. sellerContextFromClientRow reads these keys.
  // Lenient: trim + bound + reject non-strings; the issuance gates already
  // validate the SHAPE (ovtFromBusinessId / IBAN presence) before we get here.
  // null clears.
  businessId: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('businessId must be a string.');
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > 40) throwBadRequest('businessId must be 40 characters or fewer.');
    return trimmed;
  },
  iban: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('iban must be a string.');
    const trimmed = value.replace(/\s+/g, '').trim();
    if (!trimmed) return null;
    if (trimmed.length > 34) throwBadRequest('iban must be 34 characters or fewer.');
    return trimmed;
  },

  // The phone's business register (mobile/mobileBusinessSetup.js
  // setupPatchFor) writes these three keys. Validated to exactly the shape it
  // writes, so a malformed value is refused instead of preserved as an unknown
  // key. `legalName` also feeds clients.legal_names (the document router's
  // "us" anchor) through deriveClientIdentityColumns, so it is held to the
  // phone's own bound (1–1000 characters after trimming). null clears.
  legalName: (value) => {
    if (value === null) return null;
    if (typeof value !== 'string') throwBadRequest('legalName must be a string.');
    const trimmed = value.trim();
    if (!trimmed) throwBadRequest('legalName must not be empty.');
    if (trimmed.length > 1000) throwBadRequest('legalName must be 1000 characters or fewer.');
    return trimmed;
  },
  // What was confirmed, by whom and from which source. authority_verified is
  // always false: confirming details on this surface never verifies ownership.
  business_register: (value) => {
    if (value === null) return null;
    const record = exactObject(value, 'business_register', BUSINESS_REGISTER_KEYS);
    const text = (key, max, { allowEmpty = false, nullable = false } = {}) => {
      const field = record[key];
      if (field === null && nullable) return null;
      if (typeof field !== 'string') throwBadRequest(`business_register.${key} must be a string${nullable ? ' or null' : ''}.`);
      const trimmed = field.trim();
      if (!trimmed && !allowEmpty) throwBadRequest(`business_register.${key} must not be empty.`);
      if (trimmed.length > max) throwBadRequest(`business_register.${key} must be ${max} characters or fewer.`);
      return trimmed;
    };
    const instant = (key, { nullable = false } = {}) => {
      const field = record[key];
      if (field === null && nullable) return null;
      if (typeof field !== 'string' || !ISO_INSTANT.test(field) || Number.isNaN(Date.parse(field))) {
        throwBadRequest(`business_register.${key} must be an ISO 8601 timestamp${nullable ? ' or null' : ''}.`);
      }
      return field;
    };
    if (!BUSINESS_REGISTER_LEGAL_FORMS.includes(record.legal_form)) {
      throwBadRequest(`business_register.legal_form must be one of ${BUSINESS_REGISTER_LEGAL_FORMS.join(', ')}.`);
    }
    if (!BUSINESS_REGISTER_SOURCES.includes(record.source)) {
      throwBadRequest(`business_register.source must be one of ${BUSINESS_REGISTER_SOURCES.join(', ')}.`);
    }
    if (record.authority_verified !== false) throwBadRequest('business_register.authority_verified must be false.');
    if (typeof record.terminal !== 'string' || !/^[a-z_]{1,40}$/.test(record.terminal)) {
      throwBadRequest('business_register.terminal must be a short lowercase surface name.');
    }
    return {
      business_id: text('business_id', 40),
      legal_form: record.legal_form,
      legal_form_code: text('legal_form_code', 40, { nullable: true }),
      registered_address: text('registered_address', 1000, { allowEmpty: true }),
      source: record.source,
      fetched_at: instant('fetched_at', { nullable: true }),
      authority_verified: false,
      confirmed_by: text('confirmed_by', 200, { nullable: true }),
      confirmed_at: instant('confirmed_at'),
      terminal: record.terminal
    };
  },
  // The owner's setup answers: business stage and whether they put the
  // suggestion off.
  business_setup: (value) => {
    if (value === null) return null;
    const setup = exactObject(value, 'business_setup', BUSINESS_SETUP_KEYS);
    if (setup.business_stage !== null && !BUSINESS_SETUP_STAGES.includes(setup.business_stage)) {
      throwBadRequest(`business_setup.business_stage must be one of ${BUSINESS_SETUP_STAGES.join(', ')} or null.`);
    }
    if (typeof setup.suggestion_dismissed !== 'boolean') throwBadRequest('business_setup.suggestion_dismissed must be a boolean.');
    return { business_stage: setup.business_stage, suggestion_dismissed: setup.suggestion_dismissed };
  },

  // Provenance (services_engaged_set_by/_at, accounting_system_set_by/_at,
  // jurisdiction_confirmed_by/_at) is NOT operator-writable — it's
  // server-stamped from the authenticated principal in
  // updateClientProfileInDb when the corresponding choice
  // (services_engaged / accounting_system / jurisdiction) is written.
  // See SERVER_OWNED_KEYS.
};

// Keys that must NEVER come from operator-driven writes. The detector /
// connector / snapshot pipeline owns these. Writes get rejected up
// front with a 400 instead of being silently merged.
const SERVER_OWNED_KEYS = new Set([
  'gst_registration_revision',
  'jurisdiction_detected',
  'jurisdiction_detected_confidence',
  'jurisdiction_signals',
  // Provenance — server-stamped from the authenticated principal, never
  // taken from operator input (would otherwise be spoofable).
  'services_engaged_set_by',
  'services_engaged_set_at',
  'jurisdiction_confirmed_by',
  'jurisdiction_confirmed_at',
  'accounting_system_set_by',
  'accounting_system_set_at',
  'accounting_system_connection',
  'accounting_system_status',
  'accounting_system_connection_id'
]);

const throwBadRequest = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
};

// Validates + normalises a partial-merge patch. Returns the patch to
// actually write (with aliases normalised, junk dropped) plus a list of
// non-fatal warnings (unknown keys, etc.) the caller can log.
//
// Throws 400 with a useful message on:
//   - patch isn't an object
//   - a known key has the wrong shape / enum value
//   - the patch carries a server-owned key
export const validateAndNormaliseProfilePatch = (patch, { jurisdiction = null, registry = PROFILE_VALIDATION_REGISTRY, nativeLineage = null } = {}) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throwBadRequest('profile_patch must be a non-null object.');
  }

  const out = {};
  const warnings = [];
  const legalFormJurisdiction = Object.prototype.hasOwnProperty.call(patch, 'jurisdiction')
    ? KNOWN_KEYS.jurisdiction(patch.jurisdiction, warnings)
    : jurisdiction;

  const accountingPatch = normalizeAccountingProfilePatch(patch);
  for (const [key, value] of Object.entries(accountingPatch)) {
    if (ACCOUNTING_PROFILE_KEYS.includes(key)) { out[key] = value; continue; }
    if (SERVER_OWNED_KEYS.has(key)) {
      throwBadRequest(`profile_patch may not write server-owned key ${JSON.stringify(key)}.`);
    }
    if (Object.prototype.hasOwnProperty.call(KNOWN_KEYS, key)) {
      const normalised = KNOWN_KEYS[key](value, warnings, { jurisdiction: legalFormJurisdiction });
      if (normalised !== undefined) out[key] = normalised;
      continue;
    }
    const countryValue = normalizeCountryProfileValue({ key, value, jurisdiction: legalFormJurisdiction, warnings, registry, nativeLineage });
    if (countryValue.handled) {
      if (countryValue.value !== undefined) out[key] = countryValue.value;
      continue;
    }
    // Unknown key — preserve forward-compat. Tell the caller so it can
    // be logged, but don't reject.
    warnings.push(`Unknown profile key preserved: ${key}.`);
    out[key] = value;
  }

  return { patch: out, warnings };
};

// Exposed for tests + introspection.
export const __SCHEMA__ = {
  SERVICE_IDS: [...SERVICE_IDS],
  ACCOUNTING_SYSTEMS: [...ACCOUNTING_SYSTEMS],
  KNOWN_JURISDICTIONS: [...KNOWN_JURISDICTIONS],
  JURISDICTION_ALIAS: { ...JURISDICTION_ALIAS },
  SERVER_OWNED_KEYS: [...SERVER_OWNED_KEYS],
  BUSINESS_REGISTER_LEGAL_FORMS: [...BUSINESS_REGISTER_LEGAL_FORMS],
  BUSINESS_REGISTER_SOURCES: [...BUSINESS_REGISTER_SOURCES],
  BUSINESS_SETUP_STAGES: [...BUSINESS_SETUP_STAGES]
};
