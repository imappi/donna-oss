// AE establishment facts — write-boundary and reader invariants.

import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAeEstablishment, resolveAeEstablishment } from './establishment.js';

test('a full record normalizes: emirate uppercased, tri-state flag kept, verification carried', () => {
  const stored = normalizeAeEstablishment({
    emirate: ' dxb ',
    qualifying_ecommerce_registrant: false,
    verified_from: 'trade licence',
    verified_at: '2026-08-30'
  });
  assert.deepEqual(stored, {
    emirate: 'DXB',
    qualifying_ecommerce_registrant: false,
    verified_from: 'trade licence',
    verified_at: '2026-08-30'
  });
});

test('the VATP033 flag defaults to null — not asked is not a "no"', () => {
  assert.equal(normalizeAeEstablishment({ emirate: 'AUH' }).qualifying_ecommerce_registrant, null);
});

test('the emirate is mandatory and must be one of the seven', () => {
  assert.throws(() => normalizeAeEstablishment({}), /requires an emirate/);
  assert.throws(() => normalizeAeEstablishment({ emirate: 'LON' }), /seven emirates/);
});

test('a non-boolean VATP033 flag and a malformed verified_at refuse by name', () => {
  assert.throws(() => normalizeAeEstablishment({ emirate: 'DXB', qualifying_ecommerce_registrant: 'yes' }), /true, false, or null/);
  assert.throws(() => normalizeAeEstablishment({ emirate: 'DXB', verified_at: 'last week' }), /ISO date/);
});

test('the reader resolves absence to nulls — honest ignorance, never a default emirate', () => {
  assert.deepEqual(resolveAeEstablishment(null), { emirate: null, qualifyingEcommerceRegistrant: null });
  assert.deepEqual(resolveAeEstablishment(undefined), { emirate: null, qualifyingEcommerceRegistrant: null });
});

test('the reader passes an unknown stored emirate through so the engine names the bad data', () => {
  assert.equal(resolveAeEstablishment({ emirate: 'lon' }).emirate, 'LON');
});
