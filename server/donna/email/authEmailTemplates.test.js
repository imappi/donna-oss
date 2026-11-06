import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAuthEmail, buildVerifyUrl } from './authEmailTemplates.js';

const SUPABASE_URL = 'https://proj.supabase.co';

test('buildVerifyUrl builds the standard GoTrue verify link', () => {
  const url = buildVerifyUrl({
    supabaseUrl: 'https://proj.supabase.co/',
    tokenHash: 'abc123',
    type: 'signup',
    redirectTo: 'https://app.donna.example/start'
  });
  assert.match(url, /^https:\/\/proj\.supabase\.co\/auth\/v1\/verify\?/);
  assert.match(url, /token=abc123/);
  assert.match(url, /type=signup/);
  assert.match(url, /redirect_to=https%3A%2F%2Fapp\.donna\.example%2Fstart/);
});

test('signup email: branded, correct subject + verify link, no Supabase footer', () => {
  const out = renderAuthEmail({
    emailActionType: 'signup',
    supabaseUrl: SUPABASE_URL,
    tokenHash: 'tok_signup',
    redirectTo: 'https://app.donna.example/start'
  });
  assert.match(out.subject, /Confirm your email/);
  assert.match(out.html, /Donna/);
  assert.match(out.html, /Example Operator/);
  assert.doesNotMatch(out.html, /Supabase/);
  assert.match(out.html, /type=signup/);
  assert.match(out.html, /tok_signup/);
});

test('recovery email uses the recovery verify type', () => {
  const out = renderAuthEmail({
    emailActionType: 'recovery',
    supabaseUrl: SUPABASE_URL,
    tokenHash: 'tok_rec',
    redirectTo: 'https://app.donna.example/reset-password'
  });
  assert.match(out.subject, /Reset your Donna password/);
  assert.match(out.html, /type=recovery/);
  assert.match(out.html, /reset-password/);
});

test('reauthentication renders the OTP code, not a link', () => {
  const out = renderAuthEmail({ emailActionType: 'reauthentication', token: '123456' });
  assert.match(out.subject, /verification code/);
  assert.match(out.html, /123456/);
  assert.doesNotMatch(out.html, /auth\/v1\/verify/);
});

test('unknown action falls back to a signup-style link email (never drops)', () => {
  const out = renderAuthEmail({
    emailActionType: 'some_future_type',
    supabaseUrl: SUPABASE_URL,
    tokenHash: 'tok_x',
    redirectTo: 'https://app.donna.example/start'
  });
  assert.ok(out.subject);
  assert.ok(out.html);
  assert.match(out.html, /auth\/v1\/verify/);
  assert.match(out.html, /tok_x/);
});

test('email_change falls back to token_hash_new when token_hash is absent', () => {
  const out = renderAuthEmail({
    emailActionType: 'email_change',
    supabaseUrl: SUPABASE_URL,
    tokenHashNew: 'tok_new',
    redirectTo: 'https://app.donna.example/start'
  });
  assert.match(out.html, /tok_new/);
  assert.match(out.html, /type=email_change/);
});

test('escapes user-influenced values to avoid HTML injection in the link', () => {
  const out = renderAuthEmail({
    emailActionType: 'signup',
    supabaseUrl: SUPABASE_URL,
    tokenHash: 'tok',
    redirectTo: 'https://x-com.example/start"><script>alert(1)</script>'
  });
  assert.doesNotMatch(out.html, /<script>alert/);
});
