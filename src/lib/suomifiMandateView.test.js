// G-3 follow-up (FI-15) — the Suomi.fi mandate strip's pure view model.
// The envelope is the server's persisted verdict (mandate row + dated
// evaluation); the view model must label it verbatim, never re-derive it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuomifiMandateViewModel } from './suomifiMandateView.js';

const validEnvelope = {
  scope: 'veroasioiden_hoito',
  mandate: {
    id: 'sfm-1',
    scope: 'veroasioiden_hoito',
    status: 'active',
    granted_on: '2026-05-04',
    expires_on: '2031-05-04',
    reference: 'SF-12345'
  },
  evaluation: { valid: true, reason: 'valid' },
  read_at: '2026-07-11T08:00:00.000Z'
};

test('non-envelope shapes hide the strip (null view model)', () => {
  assert.equal(buildSuomifiMandateViewModel(null), null);
  assert.equal(buildSuomifiMandateViewModel(undefined), null);
  assert.equal(buildSuomifiMandateViewModel('nope'), null);
  assert.equal(buildSuomifiMandateViewModel({}), null);
  assert.equal(buildSuomifiMandateViewModel({ mandate: null }), null);
});

test('a valid mandate renders ok tone with fi-formatted grant/expiry/reference', () => {
  const vm = buildSuomifiMandateViewModel(validEnvelope);
  assert.equal(vm.valid, true);
  assert.equal(vm.reason, 'valid');
  assert.equal(vm.tone, 'ok');
  assert.equal(vm.label, 'Voimassa');
  assert.equal(vm.scopeLabel, 'veroasioiden hoito');
  assert.equal(vm.detail, 'Myönnetty 4.5.2026 · päättyy 4.5.2031 · viite SF-12345');
  assert.equal(vm.hint, null);
});

test('valid mandate with no expiry or reference keeps only the grant date', () => {
  const vm = buildSuomifiMandateViewModel({
    ...validEnvelope,
    mandate: { ...validEnvelope.mandate, expires_on: null, reference: null }
  });
  assert.equal(vm.detail, 'Myönnetty 4.5.2026');
});

test('no_mandate renders amber with the owner-action hint and no detail', () => {
  const vm = buildSuomifiMandateViewModel({
    scope: 'veroasioiden_hoito',
    mandate: null,
    evaluation: { valid: false, reason: 'no_mandate' },
    read_at: '2026-07-11T08:00:00.000Z'
  });
  assert.equal(vm.valid, false);
  assert.equal(vm.tone, 'amber');
  assert.equal(vm.label, 'Ei valtuutusta');
  assert.equal(vm.detail, null);
  assert.match(vm.hint, /Suomi\.fi/);
});

test('expired and not_yet_effective label the dated failure and keep the mandate detail', () => {
  const expired = buildSuomifiMandateViewModel({
    ...validEnvelope,
    mandate: { ...validEnvelope.mandate, expires_on: '2026-06-30' },
    evaluation: { valid: false, reason: 'expired' }
  });
  assert.equal(expired.tone, 'amber');
  assert.equal(expired.label, 'Vanhentunut');
  assert.match(expired.detail, /päättyy 30\.6\.2026/);

  const early = buildSuomifiMandateViewModel({
    ...validEnvelope,
    mandate: { ...validEnvelope.mandate, granted_on: '2026-08-01' },
    evaluation: { valid: false, reason: 'not_yet_effective' }
  });
  assert.equal(early.label, 'Ei vielä voimassa');
  assert.match(early.detail, /Myönnetty 1\.8\.2026/);
});

test('the full closed reason vocabulary maps; an unknown reason renders as itself', () => {
  for (const reason of ['valid', 'no_mandate', 'wrong_scope', 'revoked', 'not_yet_effective', 'expired']) {
    const vm = buildSuomifiMandateViewModel({ ...validEnvelope, evaluation: { valid: reason === 'valid', reason } });
    assert.notEqual(vm.label, reason, `reason ${reason} should have a display label`);
  }
  const unknown = buildSuomifiMandateViewModel({ ...validEnvelope, evaluation: { valid: false, reason: 'weird_new_reason' } });
  assert.equal(unknown.label, 'weird_new_reason');
  assert.equal(unknown.tone, 'amber');
});

test('unknown scope renders as itself (surfacing beats prettiness)', () => {
  const vm = buildSuomifiMandateViewModel({ ...validEnvelope, scope: 'jokin_muu' });
  assert.equal(vm.scopeLabel, 'jokin_muu');
});
