import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeQuestionShort,
  questionSolicitsSensitiveInfo,
  prepareOwnerAskQuestion,
  OWNER_QUESTION_MAX_LEN
} from './askSafety.js';

test('sanitizeQuestionShort collapses whitespace/newlines and trims', () => {
  assert.equal(sanitizeQuestionShort('  receipt   for\nthe IKEA\t purchase  '), 'receipt for the IKEA purchase');
  assert.equal(sanitizeQuestionShort(null), '');
  assert.equal(sanitizeQuestionShort(undefined), '');
});

test('sanitizeQuestionShort caps at OWNER_QUESTION_MAX_LEN with an ellipsis', () => {
  const long = 'a'.repeat(200);
  const out = sanitizeQuestionShort(long);
  assert.equal(out.length, OWNER_QUESTION_MAX_LEN);
  assert.ok(out.endsWith('…'));
  const short = 'a'.repeat(OWNER_QUESTION_MAX_LEN);
  assert.equal(sanitizeQuestionShort(short), short); // exactly at the cap is untouched
});

test('questionSolicitsSensitiveInfo flags credential / full-number / ID asks', () => {
  for (const q of [
    'what is your online banking password?',
    'please share the full card number',
    'reply with your card CVV',
    'send your bank account number',
    'what is the sort code?',
    'we need your IBAN',
    'reply with your SSN',
    'upload your passport',
    'send your national insurance number',
    "photo of your driver's license"
  ]) {
    assert.equal(questionSolicitsSensitiveInfo(q), true, `should block: ${q}`);
  }
});

test('questionSolicitsSensitiveInfo does not flag ordinary bookkeeping asks', () => {
  for (const q of [
    'receipt for $42.80 at IKEA on Jun 14',
    'what was this Stripe payout for?',
    'is the card reader purchase a business expense?',
    'invoice for the June consulting work'
  ]) {
    assert.equal(questionSolicitsSensitiveInfo(q), false, `should allow: ${q}`);
  }
});

test('prepareOwnerAskQuestion returns sanitized text and a block verdict', () => {
  const ok = prepareOwnerAskQuestion('  receipt\nfor IKEA  ');
  assert.deepEqual(ok, { text: 'receipt for IKEA', blocked: false, reason: null });

  const blocked = prepareOwnerAskQuestion('reply with your full card number');
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'sensitive_ask_portal_only');
});
