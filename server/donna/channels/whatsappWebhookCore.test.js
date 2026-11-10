import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  extractAskRef,
  extractBindingToken,
  hashPhoneE164,
  normalizePhoneE164,
  shortAskRef,
  verifyMetaWebhookSignature,
  whatsappEnvAllowsClient
} from './whatsappWebhookCore.js';

test('verifyMetaWebhookSignature accepts a valid sha256 signature', () => {
  const secret = 'test-secret';
  const rawBody = JSON.stringify({ hello: 'world' });
  const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  assert.equal(verifyMetaWebhookSignature({ rawBody, signature, secret }), true);
});

test('verifyMetaWebhookSignature rejects wrong secret, missing/malformed header, and length mismatch', () => {
  const rawBody = '{}';
  const signature = `sha256=${createHmac('sha256', 'right').update(rawBody).digest('hex')}`;
  assert.equal(verifyMetaWebhookSignature({ rawBody, signature, secret: 'wrong' }), false);
  assert.equal(verifyMetaWebhookSignature({ rawBody, signature: '', secret: 'right' }), false);
  assert.equal(verifyMetaWebhookSignature({ rawBody, signature: 'not-sha256', secret: 'right' }), false);
  assert.equal(verifyMetaWebhookSignature({ rawBody, signature: 'sha256=abc', secret: 'right' }), false);
});

test('extractBindingToken accepts connect/token commands and rejects short garbage', () => {
  const token = 'abcdefghijklmnopqrstuvwxyzABCDEF';
  assert.equal(extractBindingToken(`connect ${token}`), token);
  assert.equal(extractBindingToken(`token ${token}`), token);
  assert.equal(extractBindingToken('connect short'), '');
  assert.equal(extractBindingToken('hello world'), '');
  assert.equal(extractBindingToken(''), '');
});

test('extractAskRef extracts explicit Ref tokens only', () => {
  assert.equal(extractAskRef('paid personally. Ref: ab12-cd34'), 'AB12CD34');
  assert.equal(extractAskRef('Ref # 23def456'), '23DEF456');
  assert.equal(extractAskRef('no anchor here'), '');
});

test('extractAskRef reads "ref" as a whole word with Finnish letters counted as letters', () => {
  // JavaScript's \b does not treat ä or ö as letters, so "ref" at the end of a
  // longer word was read as an anchor, and an id running into ä was cut short.
  assert.equal(extractAskRef('tyhjäref AB12CD'), '');
  assert.equal(extractAskRef('Ref AB12ä'), '');
  assert.equal(extractAskRef('Ref: AB12CD, kiitos'), 'AB12CD');
  assert.equal(extractAskRef('maksoin itse (ref ab12-cd34)'), 'AB12CD34');
  assert.equal(extractAskRef('ref\u00A0AB12CD'), 'AB12CD');
});

test('normalizePhoneE164 and salted hash are stable across formatting variants', () => {
  const formatted = '+44 (7700) 900-123';
  const normalized = '+447700900123';
  assert.equal(normalizePhoneE164(formatted), normalized);
  assert.equal(hashPhoneE164(formatted, { salt: 'salt' }), hashPhoneE164(normalized, { salt: 'salt' }));
  assert.notEqual(hashPhoneE164(normalized, { salt: 'salt-a' }), hashPhoneE164(normalized, { salt: 'salt-b' }));
});

test('whatsappEnvAllowsClient is fail-closed and allowlist-scoped', () => {
  assert.equal(whatsappEnvAllowsClient('honeybee', { WHATSAPP_ENABLED: 'false', WHATSAPP_CLIENTS: 'honeybee' }), false);
  assert.equal(whatsappEnvAllowsClient('honeybee', { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'honeybee,other' }), true);
  assert.equal(whatsappEnvAllowsClient('missing', { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'honeybee' }), false);
  assert.equal(whatsappEnvAllowsClient('honeybee', { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: '' }), false);
});

test('shortAskRef returns stable uppercase last-8 alnum and non-empty fallback', () => {
  assert.equal(shortAskRef('ask_abc-123-def456'), '23DEF456');
  assert.equal(shortAskRef(''), 'ASK');
  assert.equal(shortAskRef('---'), 'ASK');
});
