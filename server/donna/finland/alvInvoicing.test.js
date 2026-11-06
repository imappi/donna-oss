// FI-13 13.4 PR2 — the issuance-side ALV activation resolver (D-FI13-17).
// node --test server/donna/finland/alvInvoicing.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { FINLAND_ALV_INVOICING_FLAG_KEY, resolveIssuanceAlvContext } from './alvInvoicing.js';

const REG = { status: 'registered', registered_from: '2025-01-01', verified_at: '2025-01-15' };

test('pins the config-plane flag key', () => {
  assert.equal(FINLAND_ALV_INVOICING_FLAG_KEY, 'FINLAND_ALV_INVOICING');
});

test('flag OFF ⇒ ALV never active, every line is rate 0 (byte-identical to today)', () => {
  const ctx = resolveIssuanceAlvContext({ registration: REG, asOf: '2026-06-01', flagActs: false });
  assert.equal(ctx.alvActive, false);
  assert.equal(ctx.alvRegistered, false);
  assert.equal(ctx.standardRate, 0);
  assert.equal(ctx.rateSet, null);
  assert.equal(ctx.resolveLineRate(25.5), 0);
  assert.equal(ctx.resolveLineRate(13.5), 0);
});

test('flag ON + effective registration ⇒ active at the era standard rate', () => {
  const ctx = resolveIssuanceAlvContext({ registration: REG, asOf: '2026-06-01', flagActs: true });
  assert.equal(ctx.alvActive, true);
  assert.equal(ctx.alvRegistered, true);
  assert.equal(ctx.standardRate, 25.5); // 2026 era
});

test('resolveLineRate: an allowed rate passes; a bogus proposal defaults to standard; 0 stays exempt', () => {
  const ctx = resolveIssuanceAlvContext({ registration: REG, asOf: '2026-06-01', flagActs: true });
  assert.equal(ctx.resolveLineRate(25.5), 25.5); // standard
  assert.equal(ctx.resolveLineRate(13.5), 13.5); // a 2026 reduced rate
  assert.equal(ctx.resolveLineRate(10), 10);     // a 2026 reduced rate
  assert.equal(ctx.resolveLineRate(0), 0);       // a genuinely exempt line
  assert.equal(ctx.resolveLineRate(7), 25.5);    // not a real rate ⇒ default to standard (never silently under-charge)
  assert.equal(ctx.resolveLineRate('nonsense'), 25.5);
  assert.equal(ctx.resolveLineRate(14), 25.5);   // 14 is a 2024-era reduced rate, NOT valid in 2026 ⇒ standard
});

test('flag ON but no registration covering the date ⇒ not active', () => {
  assert.equal(resolveIssuanceAlvContext({ registration: REG, asOf: '2024-06-01', flagActs: true }).alvActive, false);
  assert.equal(resolveIssuanceAlvContext({ registration: { status: 'not_registered' }, asOf: '2026-06-01', flagActs: true }).alvActive, false);
});

test('is fail-safe and form-independent: garbage / absent registration ⇒ exempt, never throws', () => {
  assert.doesNotThrow(() => resolveIssuanceAlvContext());
  assert.equal(resolveIssuanceAlvContext({ registration: 'x', asOf: '2026-06-01', flagActs: true }).alvActive, false);
  assert.equal(resolveIssuanceAlvContext({ flagActs: true, asOf: '2026-06-01' }).alvActive, false);
  // No entity_type input anywhere — the gate is flag + registration + date only.
});

test('an unverified registration still activates ALV but the context is confirmedAgainstPrimary:false', () => {
  const unverified = { status: 'registered', registered_from: '2025-01-01' };
  const ctx = resolveIssuanceAlvContext({ registration: unverified, asOf: '2026-06-01', flagActs: true });
  assert.equal(ctx.alvActive, true);
  assert.equal(ctx.confirmedAgainstPrimary, false);
});
