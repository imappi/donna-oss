// The reference-scheme MINT registry (FI viite in the outbound issuance
// builder — the named M3 follow-up). Pins:
//   - the FI binding IS finland/verkkolasku.js's mint/validate — function
//     identity, so the finland/ lane's arithmetic serves both lanes
//     byte-identically by construction;
//   - a minted viite carries the correct 7-3-1 check digit and passes the
//     scheme's own validator;
//   - AMERICA-FIRST: a scheme-less pack (US) exits with a null reference —
//     zero behavior change;
//   - a pack declaring a scheme the registry does not carry REFUSES
//     (fail-closed: pack data promising a reference the engine cannot mint
//     must never yield a reference-less send).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REFERENCE_SCHEME_BINDINGS, packReferenceScheme, mintPackReferenceNumber
} from './referenceSchemes.js';
import {
  finnishReferenceNumber, isValidFinnishReferenceNumber
} from '../finland/verkkolasku.js';
import { loadOutboundPack } from './packs.js';

test('the FI binding IS the finland/ lane arithmetic (function identity)', () => {
  assert.equal(REFERENCE_SCHEME_BINDINGS.fi_viitenumero.mint, finnishReferenceNumber,
    'mint is finland/verkkolasku.js finnishReferenceNumber itself');
  assert.equal(REFERENCE_SCHEME_BINDINGS.fi_viitenumero.validate, isValidFinnishReferenceNumber,
    'validate is finland/verkkolasku.js isValidFinnishReferenceNumber itself');
});

test('the FI pack mints a check-digit-valid viite from the invoice number', () => {
  const fi = loadOutboundPack('fi');
  assert.equal(packReferenceScheme(fi), 'fi_viitenumero');
  const { scheme, referenceNumber } = mintPackReferenceNumber({ pack: fi, invoiceNumber: '2026001' });
  assert.equal(scheme, 'fi_viitenumero');
  assert.equal(referenceNumber, '20260011', '7-3-1 check digit over base 2026001');
  assert.equal(isValidFinnishReferenceNumber(referenceNumber), true);
});

test('AMERICA-FIRST: the scheme-less US pack exits with a null reference', () => {
  const us = loadOutboundPack('us');
  assert.equal(packReferenceScheme(us), 'none');
  assert.deepEqual(
    mintPackReferenceNumber({ pack: us, invoiceNumber: '2026001' }),
    { scheme: 'none', referenceNumber: null }
  );
});

test('a declared-but-unbound scheme refuses fail-closed', () => {
  assert.throws(
    () => mintPackReferenceNumber({
      pack: { pack: { id: 'xx' }, reference: { scheme: 'xx_future_scheme' } },
      invoiceNumber: '2026001'
    }),
    (error) => error.code === 'REFERENCE_SCHEME_UNBOUND'
  );
});
