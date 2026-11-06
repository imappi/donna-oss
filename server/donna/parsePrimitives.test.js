import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeIsoCurrency, normalizeIsoDate, normalizeIsoOrDayFirstDate, normalizeValidIsoDate } from './parsePrimitives.js';

test('shared mechanical parse primitives pin legacy edge cases', () => {
  assert.equal(normalizeIsoDate('2026-02-30T12:00:00Z'), '2026-02-30');
  assert.equal(normalizeValidIsoDate('2026-02-30'), null);
  assert.equal(normalizeIsoDate(''), null);
  assert.equal(normalizeIsoOrDayFirstDate('31/07/2026'), '2026-07-31');
  assert.equal(normalizeIsoOrDayFirstDate('31/07/2026', { allowDayFirst: false }), null);
  assert.equal(normalizeIsoCurrency(' gbp '), 'GBP');
  assert.equal(normalizeIsoCurrency('pounds'), null);
});
