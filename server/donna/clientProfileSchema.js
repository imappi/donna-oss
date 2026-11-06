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
  SERVER_OWNED_KEYS: [...SERVER_OWNED_KEYS]
};
