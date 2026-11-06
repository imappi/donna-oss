// Donna Keep-layer — the tax-code ↔ jurisdiction VALIDITY registry.
//
// One structural invariant: a proposed tax code must belong to the tax-code
// vocabulary the client's jurisdiction mandates. Jurisdiction is fixed at
// onboarding (`clients.jurisdiction`, ISO 3166-1 alpha-2, lowercased — see
// clientProfileSchema.js); every country has its OWN tax codes and its own
// supporting material, and they must never bleed across borders (Kari,
// 2026-07-23). This module is the single source of truth for "which codes are
// valid in which country," answered as SET MEMBERSHIP.
//
// This is VALIDITY, never TREATMENT. It decides "is 'GST 9%' even a Singapore
// code?" (structural — arithmetic/rules can rule it) — it does NOT decide
// "should this line be standard-rated or reverse-charged?" (judgment — the
// strong model's call; trust-the-strong-LLM). A foreign-jurisdiction code is a
// structural error of the same class as a hallucinated key: there is no
// scenario where an owner should be able to apply a Finnish ALV code onto a US
// ledger. So the preflight check built on this REFUSES (fail), unlike the
// judgment-adjacent risk-flag escalations.
//
// Country definitions enter through the explicit tax vocabulary registry.
// Historical machine-code sets remain available for persisted-row validation;
// proposal and apply use the exact resolved coding policy vocabulary.

import { TAX_VOCABULARY_REGISTRY } from './taxVocabularyRegistry.js';

// The stored canonical jurisdiction alias (clientProfileSchema.js
// JURISDICTION_ALIAS is the source of truth; mirrored here to stay a leaf, and
// pinned by taxCodeJurisdiction.test.js against that export so it cannot drift).
const JURISDICTION_ALIAS = Object.freeze({ uk: 'gb' });

// Normalise a raw jurisdiction to the stored canonical key, or null when there
// is no jurisdiction to decide against (empty / 'unknown' / not a 2-letter
// code). Mirrors clientProfileSchema.js's storage normalisation exactly, so a
// value read from `clients.jurisdiction` maps to the same key it was stored as.
export const normalizeJurisdictionKey = (jurisdiction) => {
  if (typeof jurisdiction !== 'string') return null;
  const lower = jurisdiction.trim().toLowerCase();
  if (!lower || lower === 'unknown') return null;
  const aliased = JURISDICTION_ALIAS[lower] || lower;
  return /^[a-z]{2}$/.test(aliased) ? aliased : null;
};

// Normalise a candidate code for membership: trim, lowercase, collapse internal
// whitespace runs to a single space. Machine codes (ALV_25_5_OUTPUT) have no
// spaces so this is a no-op for them; human treatment labels ('ALV 25,5 %',
// 'GST 9%') become insensitive to case and incidental spacing.
const normalizeCode = (code) => String(code).trim().toLowerCase().replace(/\s+/g, ' ');

// Build a jurisdiction entry: a human label + the frozen set of valid codes
// (normalised for lookup) alongside the raw list (for detail messages).
const mkEntry = (label, rawCodes, machineCodes = []) => {
  const raw = rawCodes.filter((c) => typeof c === 'string' && c.trim());
  return Object.freeze({
    label,
    codes: Object.freeze([...raw]),
    machineCodes: Object.freeze([...machineCodes]),
    _lookup: new Set(raw.map(normalizeCode))
  });
};

// Registered country definitions own their labels, treatments and historical codes.
// Shared validity is the same set-membership operation for every registration.
export const JURISDICTION_TAX_VOCABULARY = Object.freeze(Object.fromEntries(
  Object.entries(TAX_VOCABULARY_REGISTRY).map(([country, definition]) => [country,
    mkEntry(definition.label, definition.allCodes || definition.options, definition.machineCodes)
  ])
));

// The set of jurisdictions this registry can actually validate — exported so a
// caller (or a test) can tell "no entry = coverage gap" from "empty vocabulary."
export const KNOWN_TAX_CODE_JURISDICTIONS = Object.freeze(
  Object.keys(JURISDICTION_TAX_VOCABULARY)
);

// The vocabulary entry for a jurisdiction ({label, codes}), or null when the
// jurisdiction is unknown/unregistered.
export const jurisdictionVocabulary = (jurisdiction) => {
  const key = normalizeJurisdictionKey(jurisdiction);
  return key ? (JURISDICTION_TAX_VOCABULARY[key] || null) : null;
};

// classifyTaxCodeForJurisdiction — the structural verdict:
//   'valid'       — the code belongs to the jurisdiction's vocabulary
//   'foreign'     — the jurisdiction is registered but the code is NOT in it
//                   (a cross-jurisdiction leak; the thing the gate refuses)
//   'undecidable' — no code to check, no jurisdiction, or jurisdiction has no
//                   registered vocabulary (the coverage-gap omit)
export const classifyTaxCodeForJurisdiction = (taxCode, jurisdiction) => {
  const entry = jurisdictionVocabulary(jurisdiction);
  if (!entry) return 'undecidable';
  if (taxCode === null || taxCode === undefined) return 'undecidable';
  const norm = normalizeCode(taxCode);
  if (!norm) return 'undecidable';
  return entry._lookup.has(norm) ? 'valid' : 'foreign';
};

// Proposal labels belong to the resolved policy; old machine codes retain their
// existing country validity. A newly registered policy needs no branch here.
export const classifyTaxCodeForPolicy = (policy, taxCode) => {
  if (policy?.status !== 'resolved' || !normalizeJurisdictionKey(policy.jurisdiction)
    || !Array.isArray(policy.taxTreatmentOptions) || !policy.taxTreatmentOptions.length) return 'undecidable';
  if (taxCode == null || !normalizeCode(taxCode)) return 'undecidable';
  if (policy.taxTreatmentOptions.some((label) => normalizeCode(label) === normalizeCode(taxCode))) return 'valid';
  const machineCodes = jurisdictionVocabulary(policy.jurisdiction)?.machineCodes || [];
  return machineCodes.some((code) => normalizeCode(code) === normalizeCode(taxCode)) ? 'valid' : 'foreign';
};
