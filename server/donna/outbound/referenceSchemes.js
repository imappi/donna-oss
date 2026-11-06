// Reference-scheme MINT registry (the named M3 follow-up: FI viite minting in
// the outbound issuance builder). The issuance-side sibling of G12's capture
// registry (referenceCapture.js SCHEME_VALIDATORS): the engine is scheme-
// keyed, WHICH scheme applies is pack data (packs/<cc> reference.scheme), and
// a future reference-scheme country is pack data + one binding here — never
// an engine edit (the M3 country-abstraction rule, the "connectors" clause).
//
// The FI binding IS finland/verkkolasku.js — the same mint/validate the FI
// lane has always run (7-3-1 check digit, KEEP-layer arithmetic). Binding it
// here changes nothing in finland/: that lane keeps serving existing flows
// byte-identically (its own tests pin the arithmetic; this module adds a
// consumer, not an edit).
//
// AMERICA-FIRST GUARD (the G12 rider, honored here too): a scheme-less pack
// ('none' — US) costs one map lookup and returns a null reference — zero US
// behavior change, pinned by test.
//
// Keep-layer posture: deterministic arithmetic + fail-closed refusals. No LLM.

import {
  finnishReferenceNumber, isValidFinnishReferenceNumber
} from '../finland/verkkolasku.js';

// scheme name (packs.js KNOWN_REFERENCE_SCHEMES) → { mint, validate }.
// 'none' is deliberately absent: no scheme, no reference.
export const REFERENCE_SCHEME_BINDINGS = Object.freeze({
  fi_viitenumero: {
    mint: finnishReferenceNumber,
    validate: isValidFinnishReferenceNumber
  }
});

export const packReferenceScheme = (pack) => pack?.reference?.scheme || 'none';

// Mint the pack-scheme payment reference for an outbound invoice. The base is
// the allocated invoice number (the FI norm: viite base = invoice number).
// Returns { scheme, referenceNumber } — referenceNumber null for a scheme-
// less pack. A declared-but-unbound scheme REFUSES (fail-closed: pack data
// promising a reference the engine cannot mint must never produce a
// reference-less send), as does a mint the scheme's own validator rejects.
export const mintPackReferenceNumber = ({ pack, invoiceNumber } = {}) => {
  const scheme = packReferenceScheme(pack);
  if (scheme === 'none') return { scheme: 'none', referenceNumber: null };
  const binding = REFERENCE_SCHEME_BINDINGS[scheme];
  if (!binding) {
    const error = new Error(
      `Pack '${pack?.pack?.id}' declares reference scheme '${scheme}' with no mint binding.`);
    error.code = 'REFERENCE_SCHEME_UNBOUND';
    throw error;
  }
  const referenceNumber = binding.mint(invoiceNumber);
  if (!binding.validate(referenceNumber)) {
    const error = new Error(
      `Minted reference '${referenceNumber}' failed its own scheme validator ('${scheme}').`);
    error.code = 'REFERENCE_MINT_INVALID';
    throw error;
  }
  return { scheme, referenceNumber };
};
