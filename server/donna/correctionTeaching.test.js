// Correction scope + the correction≠teaching receipt (G1d, build-spec
// PR-11) — pure-module tests. Pins:
//   - the enums are CLOSED and the teaching/non-teaching split is total
//   - sanitize demotes FIELD-level (teaching scope, unenforceable time
//     bounds), never the action, and every demotion leaves a note
//   - the apply backstop refuses exactly what sanitize would demote
//   - the receipt is composed from ACTUAL outcomes: it never claims a
//     teaching that did not happen, and it states the FULL negative on
//     both surfaces — since §7.6 (2026-08-14) no correction verb has a
//     signal path anywhere, so feed and txn chat report identically

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CORRECTION_SCOPE_ACTION_TYPES,
  CORRECTION_SCOPES,
  NON_TEACHING_CORRECTION_SCOPES,
  TEACHING_CORRECTION_SCOPES,
  CORRECTION_REASON_CODES,
  CORRECTION_RECURRENCES,
  sanitizeCorrectionScopeFields,
  validateCorrectionFieldsForApply,
  buildCorrectionTeachingReceipt
} from './correctionTeaching.js';

test('the enums are closed and the scope split is total', () => {
  assert.deepEqual([...CORRECTION_SCOPE_ACTION_TYPES], ['apply_category', 'recode_decided', 'mark_personal']);
  assert.deepEqual([...CORRECTION_SCOPES], ['transaction', 'case', 'client', 'merchant_for_client', 'global_candidate']);
  assert.deepEqual(
    [...NON_TEACHING_CORRECTION_SCOPES, ...TEACHING_CORRECTION_SCOPES].sort(),
    [...CORRECTION_SCOPES].sort()
  );
  assert.deepEqual([...CORRECTION_REASON_CODES], ['wrong_category', 'personal_expense', 'duplicate', 'stale_memory', 'one_off_exception', 'other']);
  assert.deepEqual([...CORRECTION_RECURRENCES], ['one_off', 'recurring']);
});

test('sanitize: narrow scopes and valid taxonomy pass through untouched', () => {
  const action = {
    type: 'apply_category',
    correction_scope: 'case',
    reason_code: 'wrong_category',
    effective_from: '2026-08-01',
    effective_until: null,
    recurrence: 'one_off'
  };
  const out = sanitizeCorrectionScopeFields(action);
  assert.equal(out.correction_scope, 'case');
  assert.equal(out.reason_code, 'wrong_category');
  assert.equal(out.effective_from, '2026-08-01');
  assert.equal(out.recurrence, 'one_off');
  assert.equal('correction_notes' in out, false);
});

test('sanitize: every teaching scope demotes to the narrowest with a note naming the right verb', () => {
  for (const scope of TEACHING_CORRECTION_SCOPES) {
    const out = sanitizeCorrectionScopeFields({ type: 'apply_category', correction_scope: scope });
    assert.equal(out.correction_scope, null);
    assert.equal(out.correction_scope_demoted_from, scope);
    assert.equal(out.type, 'apply_category', 'field-level demotion never demotes the action');
    assert.equal(out.correction_notes.length, 1);
  }
  const client = sanitizeCorrectionScopeFields({ type: 'apply_category', correction_scope: 'client' });
  assert.match(client.correction_notes[0], /remember_fact/);
  const merchant = sanitizeCorrectionScopeFields({ type: 'apply_category', correction_scope: 'merchant_for_client' });
  assert.match(merchant.correction_notes[0], /remember_merchant/);
  const global = sanitizeCorrectionScopeFields({ type: 'apply_category', correction_scope: 'global_candidate' });
  assert.match(global.correction_notes[0], /§7\.6/);
});

test('sanitize: unenforceable time bounds and recurring are nulled with notes; invalid enums drop', () => {
  const out = sanitizeCorrectionScopeFields({
    type: 'recode_decided',
    correction_scope: 'everything',
    reason_code: 'because',
    effective_from: '2999-01-01',
    effective_until: '2026-12-31',
    recurrence: 'recurring'
  });
  assert.equal(out.correction_scope, null);
  assert.equal(out.reason_code, null);
  assert.equal(out.effective_from, null);
  assert.equal(out.effective_until, null);
  assert.equal(out.recurrence, null);
  assert.equal(out.correction_notes.length, 5);
});

test('sanitize: non-correction action types pass through untouched', () => {
  const action = { type: 'remember_merchant', correction_scope: 'global_candidate' };
  assert.equal(sanitizeCorrectionScopeFields(action), action);
});

test('apply backstop: refuses exactly what sanitize demotes, allows what it keeps', () => {
  assert.equal(validateCorrectionFieldsForApply({ type: 'apply_category' }), null);
  assert.equal(validateCorrectionFieldsForApply({ type: 'apply_category', correction_scope: 'transaction' }), null);
  assert.equal(
    validateCorrectionFieldsForApply({
      type: 'mark_personal', correction_scope: 'case', reason_code: 'personal_expense', effective_from: '2026-01-01', recurrence: 'one_off'
    }),
    null
  );
  for (const scope of TEACHING_CORRECTION_SCOPES) {
    assert.match(validateCorrectionFieldsForApply({ type: 'apply_category', correction_scope: scope }), /not appliable on a correction/);
  }
  assert.match(validateCorrectionFieldsForApply({ type: 'apply_category', correction_scope: 'bogus' }), /closed enum/);
  assert.match(validateCorrectionFieldsForApply({ type: 'recode_decided', reason_code: 'because' }), /closed taxonomy/);
  assert.match(validateCorrectionFieldsForApply({ type: 'apply_category', recurrence: 'recurring' }), /remember_merchant/);
  assert.match(validateCorrectionFieldsForApply({ type: 'apply_category', effective_until: '2026-12-31' }), /not enforced/);
  assert.match(validateCorrectionFieldsForApply({ type: 'apply_category', effective_from: '2999-01-01' }), /past-or-today/);
  // Non-correction types are not this guard's business.
  assert.equal(validateCorrectionFieldsForApply({ type: 'remember_merchant', correction_scope: 'global_candidate' }), null);
});

test('receipt: states the full negative, identically on both surfaces (§7.6)', () => {
  const feed = buildCorrectionTeachingReceipt({
    action: { type: 'apply_category', correction_scope: null, reason_code: 'wrong_category' },
    changedCount: 3
  });
  assert.equal(feed.correction_scope, 'transaction');
  assert.equal(feed.reason_code, 'wrong_category');
  assert.equal(feed.rule_minted, false);
  assert.equal(feed.memory_minted, false);
  assert.match(feed.text, /^Changed 3 transactions\./);
  assert.match(feed.text, /no merchant rule, firm memory, or cross-firm signal was created/);

  // The txn-chat surface states the SAME full negative — §7.6's dated
  // call (2026-08-14) deleted its post-stamp signal write, so the signal
  // negative is provable at writer time there too (the PR-9 lock-step
  // rule: one owner, both surfaces report word for word).
  const txn = buildCorrectionTeachingReceipt({
    action: { type: 'apply_category' },
    changedCount: 1
  });
  assert.match(txn.text, /^Changed this transaction\./);
  assert.match(txn.text, /no merchant rule, firm memory, or cross-firm signal was created/);
});

test('receipt: a teaching-claiming scope can never survive into the receipt', () => {
  const out = buildCorrectionTeachingReceipt({
    action: { type: 'apply_category', correction_scope: 'merchant_for_client', reason_code: 'nonsense' },
    changedCount: 1
  });
  assert.equal(out.correction_scope, 'transaction');
  assert.equal(out.reason_code, null);
});
