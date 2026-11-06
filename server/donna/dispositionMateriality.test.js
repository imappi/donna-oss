// F1 — the deterministic disposition immateriality ceiling (leaf module).
// The parser-side application is pinned in bankLineDispositionLlm.test.js /
// documentDispositionLlm.test.js; this file pins the resolver's contract as
// re-shaped by RT-11b (2026-09-02): the ceiling FOLLOWS THE PACK
// (`reconciliation.disposition_ceiling`, in the pack's home currency), env is
// the only override, no pack ⇒ the F1 unset marker (fail closed), and the
// comparator's never-invent-a-downgrade contract for a missing AMOUNT.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getDispositionMaterialityPolicy,
  getDispositionMaterialityCeiling,
  exceedsMaterialityCeiling
} from './dispositionMateriality.js';

test('getDispositionMaterialityPolicy — the ceiling follows the client\'s pack in home currency; env is the only override; no pack ⇒ unset (RT-11b)', () => {
  const saved = { ...process.env };
  try {
    delete process.env.DISPOSITION_MATERIALITY_CEILING;
    assert.deepEqual(getDispositionMaterialityPolicy({ jurisdiction: 'GB' }), { ceiling: 500, source: 'pack:gb', currency: 'GBP' });
    assert.deepEqual(getDispositionMaterialityPolicy({ jurisdiction: 'UK' }), { ceiling: 500, source: 'pack:gb', currency: 'GBP' }, 'legacy stored UK aliases to the gb pack');
    assert.deepEqual(getDispositionMaterialityPolicy({ jurisdiction: 'ae' }), { ceiling: 500, source: 'pack:ae', currency: 'AED' });
    assert.deepEqual(getDispositionMaterialityPolicy({ jurisdiction: 'fi' }), { ceiling: 500, source: 'pack:fi', currency: 'EUR' });
    assert.deepEqual(getDispositionMaterialityPolicy({ jurisdiction: 'us' }), { ceiling: 500, source: 'pack:us', currency: 'USD' });
    assert.equal(getDispositionMaterialityCeiling({ jurisdiction: 'ae' }), 500, 'the number-only reader is the same resolution');

    assert.deepEqual(getDispositionMaterialityPolicy({ jurisdiction: 'SG' }), { ceiling: 500, source: 'pack:sg', currency: 'SGD' });
    const packless = getDispositionMaterialityPolicy({ jurisdiction: 'AU' });
    assert.ok(Number.isNaN(packless.ceiling), 'no pack ⇒ NaN, the F1 unset marker — never an invented number, never ∞');
    assert.equal(packless.source, 'unset');
    assert.equal(packless.currency, null);
    assert.ok(Number.isNaN(getDispositionMaterialityCeiling()), 'no jurisdiction ⇒ unset');
    assert.ok(Number.isNaN(getDispositionMaterialityCeiling({ jurisdiction: null })));

    process.env.DISPOSITION_MATERIALITY_CEILING = '750';
    assert.deepEqual(getDispositionMaterialityPolicy({ jurisdiction: 'GB' }), { ceiling: 750, source: 'env', currency: null }, 'a set env value wins over the pack');
    assert.equal(getDispositionMaterialityCeiling({ jurisdiction: 'AU' }), 750, 'env also covers a packless jurisdiction');

    // The poisoned-env class from the 2026-07-06 addendum: a literal string
    // "null" (or any non-number / non-positive value) is NOT an override —
    // the pack still governs.
    for (const bad of ['null', '', 'Infinity', '-5', '0', 'nope']) {
      process.env.DISPOSITION_MATERIALITY_CEILING = bad;
      assert.deepEqual(getDispositionMaterialityPolicy({ jurisdiction: 'GB' }), { ceiling: 500, source: 'pack:gb', currency: 'GBP' }, `"${bad}" is not an override`);
    }
  } finally {
    process.env = saved;
  }
});

test('exceedsMaterialityCeiling — fires only on a real comparable amount; an UNSET ceiling fails closed (F1)', () => {
  assert.equal(exceedsMaterialityCeiling(500.01, 500), true);
  assert.equal(exceedsMaterialityCeiling(500, 500), false, 'at the ceiling is not above it');
  assert.equal(exceedsMaterialityCeiling(55.98, 500), false);
  // No comparable amount → the guard never invents a downgrade (the
  // confidence floor / needs_human defaults own the malformed lanes).
  assert.equal(exceedsMaterialityCeiling(null, 500), false);
  assert.equal(exceedsMaterialityCeiling('nope', 500), false);
  assert.equal(exceedsMaterialityCeiling(null, NaN), false);
  // null = no ceiling handed in: the guard is not armed (the parsers' opt-out —
  // the owner-reply leg, a unit test without a ceiling).
  assert.equal(exceedsMaterialityCeiling(900, null), false);
  // NaN = the resolver's UNSET marker (no pack, no env): fail CLOSED — a real
  // amount can never be proved immaterial against a ceiling nobody declared.
  assert.equal(exceedsMaterialityCeiling(900, NaN), true, 'unset ⇒ exceeds: the F1 polarity, never ∞');
  assert.equal(exceedsMaterialityCeiling(0.01, NaN), true);
  assert.equal(exceedsMaterialityCeiling(900, Infinity), true, 'Infinity is not a declared ceiling either');
});

test('exceedsMaterialityCeiling — compares the amount raw against the home-currency ceiling (no FX table; RT-11b)', () => {
  // The USD conversion table left with the USD code default: the ceiling is
  // now declared in the pack's home currency and the compare is the same
  // currency-blind arithmetic Gate E applies to the bank line's own amount.
  // The receipt names the ceiling's currency; the cross-currency compare is
  // the named gap (handoff), not a hidden approximation.
  assert.equal(exceedsMaterialityCeiling(490, 500), false);
  assert.equal(exceedsMaterialityCeiling(510, 500), true);
  // A third argument (the retired currency) changes nothing — nothing converts.
  assert.equal(exceedsMaterialityCeiling(490, 500, 'GBP'), false, '490 GBP against a 500 line is not above it — no table decides otherwise');
  assert.equal(exceedsMaterialityCeiling(458, 500, 'PLN'), false);
  assert.equal(exceedsMaterialityCeiling('', 500), false, 'an empty amount is missing, not zero');
  assert.equal(exceedsMaterialityCeiling(undefined, NaN), false, 'a missing amount never fires, even against the unset marker');
});
