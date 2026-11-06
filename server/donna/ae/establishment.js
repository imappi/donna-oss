// AE establishment facts — the write-boundary normalizer and the tolerant
// reader for the client-profile key `ae_establishment`. Two facts ride it,
// both consumed by the VAT201 preparation (ae/vatReturn.js):
//
//   emirate — the fixed-establishment emirate the general attribution rule
//     collapses every standard-rated supply onto for a single-establishment
//     client. Observable (the trade licence names the emirate), owner-
//     confirmable, durable.
//   qualifying_ecommerce_registrant — whether the client is a VATP033
//     qualifying registrant (e-commerce supplies over AED 100M/year, reported
//     by DESTINATION emirate). Tri-state: true refuses return preparation by
//     name (destination reporting is deliberately unsupported), false clears
//     the question, null/absent means not yet asked — and the return engine
//     only demands an answer when it matters.
//
// This is deliberately NARROWER than the free-zone axis proposed in
// docs/design-donna-ae-freezone-and-wafeq.md §2 (mainland vs free zone,
// authority, designated-zone flag): that axis awaits Kari's go, and neither
// fact here prejudges it — the emirate and the VATP033 status are needed by
// the VAT return under EVERY answer to the axis question. If the axis lands,
// it becomes a sibling key; nothing merges into this one silently.

import { isKnownAeEmirate } from './vatCodes.js';

const bad = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
};

const dateOnly = (value) => {
  if (value === null || value === undefined) return null;
  const raw = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

// normalizeAeEstablishment(record) — the write-boundary normalizer: accepts
// an owner/operator-shaped record, returns the canonical stored shape, throws
// a typed 400 on unusable input. The emirate is MANDATORY — a record without
// it says nothing the absence of the record doesn't already say.
export const normalizeAeEstablishment = (record = {}) => {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw bad('ae_establishment must be an object.');
  }
  const emirate = String(record.emirate || '').trim().toUpperCase();
  if (!emirate) throw bad('ae_establishment requires an emirate.');
  if (!isKnownAeEmirate(emirate)) {
    throw bad(`ae_establishment.emirate must be one of the seven emirates, got ${JSON.stringify(record.emirate)}.`);
  }
  const qualifying = record.qualifying_ecommerce_registrant;
  if (qualifying !== undefined && qualifying !== null && typeof qualifying !== 'boolean') {
    throw bad('ae_establishment.qualifying_ecommerce_registrant must be true, false, or null.');
  }
  const verifiedAt = record.verified_at === undefined ? null : dateOnly(record.verified_at);
  if (record.verified_at !== undefined && record.verified_at !== null && verifiedAt === null) {
    throw bad('ae_establishment.verified_at must be an ISO date.');
  }
  return {
    emirate,
    qualifying_ecommerce_registrant: qualifying === undefined ? null : qualifying,
    verified_from: record.verified_from ? String(record.verified_from) : null,
    verified_at: verifiedAt
  };
};

// resolveAeEstablishment(record) — the tolerant reader. Absence resolves to
// nulls (honest ignorance); the return engine decides when a null blocks
// (standard-rated supplies present) and when it does not (a zero-rated/nil
// period). An unknown stored emirate passes through so the engine's
// AE_VAT_EMIRATE_UNKNOWN refusal names the bad data instead of masking it.
export const resolveAeEstablishment = (record = null) => {
  if (!record || typeof record !== 'object') {
    return { emirate: null, qualifyingEcommerceRegistrant: null };
  }
  const emirate = String(record.emirate || '').trim().toUpperCase() || null;
  const qualifying = typeof record.qualifying_ecommerce_registrant === 'boolean'
    ? record.qualifying_ecommerce_registrant
    : null;
  return { emirate, qualifyingEcommerceRegistrant: qualifying };
};
