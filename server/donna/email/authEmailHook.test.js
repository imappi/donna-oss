import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';

import {
  verifyHookSignature,
  handleAuthEmailHookPayload,
  isAuthEmailHookEnabled
} from './authEmailHook.js';

// Build a valid Standard-Webhooks signed request the way Supabase does.
const SECRET_B64 = Buffer.from('super-secret-key').toString('base64');
const sign = ({ id, timestamp, body, secretB64 = SECRET_B64 }) => {
  const key = Buffer.from(secretB64, 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${sig}`;
};

const nowMs = 1_700_000_000_000;
const nowTs = Math.floor(nowMs / 1000);

test('isAuthEmailHookEnabled requires BOTH the hook secret and the Resend key', () => {
  const prevSecret = process.env.SEND_EMAIL_HOOK_SECRET;
  const prevKey = process.env.RESEND_API_KEY;
  delete process.env.SEND_EMAIL_HOOK_SECRET;
  delete process.env.RESEND_API_KEY;
  assert.equal(isAuthEmailHookEnabled(), false);
  process.env.SEND_EMAIL_HOOK_SECRET = 'whsec_x';
  assert.equal(isAuthEmailHookEnabled(), false);
  process.env.RESEND_API_KEY = 're_x';
  assert.equal(isAuthEmailHookEnabled(), true);
  if (prevSecret === undefined) delete process.env.SEND_EMAIL_HOOK_SECRET; else process.env.SEND_EMAIL_HOOK_SECRET = prevSecret;
  if (prevKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prevKey;
});

test('verifyHookSignature accepts a valid signature (with whsec_ prefix on the secret)', () => {
  const rawBody = '{"hello":"world"}';
  const headers = {
    'webhook-id': 'msg_1',
    'webhook-timestamp': String(nowTs),
    'webhook-signature': sign({ id: 'msg_1', timestamp: nowTs, body: rawBody })
  };
  assert.equal(
    verifyHookSignature({ rawBody, headers, secret: `whsec_${SECRET_B64}`, nowMs }),
    true
  );
});

test('verifyHookSignature also handles the v1,whsec_ dashboard format', () => {
  const rawBody = '{"a":1}';
  const headers = {
    'webhook-id': 'msg_2',
    'webhook-timestamp': String(nowTs),
    'webhook-signature': sign({ id: 'msg_2', timestamp: nowTs, body: rawBody })
  };
  assert.equal(
    verifyHookSignature({ rawBody, headers, secret: `v1,whsec_${SECRET_B64}`, nowMs }),
    true
  );
});

test('verifyHookSignature rejects a tampered body', () => {
  const headers = {
    'webhook-id': 'msg_3',
    'webhook-timestamp': String(nowTs),
    'webhook-signature': sign({ id: 'msg_3', timestamp: nowTs, body: '{"real":1}' })
  };
  assert.throws(
    () => verifyHookSignature({ rawBody: '{"tampered":1}', headers, secret: SECRET_B64, nowMs }),
    /signature mismatch/
  );
});

test('verifyHookSignature rejects a stale timestamp (replay window)', () => {
  const staleTs = nowTs - 4000;
  const rawBody = '{"x":1}';
  const headers = {
    'webhook-id': 'msg_4',
    'webhook-timestamp': String(staleTs),
    'webhook-signature': sign({ id: 'msg_4', timestamp: staleTs, body: rawBody })
  };
  assert.throws(
    () => verifyHookSignature({ rawBody, headers, secret: SECRET_B64, nowMs }),
    /outside tolerance/
  );
});

test('verifyHookSignature rejects missing headers', () => {
  assert.throws(
    () => verifyHookSignature({ rawBody: '{}', headers: {}, secret: SECRET_B64, nowMs }),
    /Missing webhook signature headers/
  );
});

test('handleAuthEmailHookPayload renders + sends for a signup payload', async () => {
  let sent = null;
  const result = await handleAuthEmailHookPayload({
    payload: {
      user: { email: 'owner@biz-com.example' },
      email_data: { email_action_type: 'signup', token_hash: 'tok', redirect_to: 'https://app/start' }
    },
    supabaseUrl: 'https://proj.supabase.co',
    deps: { send: async (args) => { sent = args; return { ok: true, id: 'e1' }; } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'signup');
  assert.equal(sent.to, 'owner@biz-com.example');
  assert.match(sent.subject, /Confirm/);
  assert.match(sent.html, /type=signup/);
});

test('handleAuthEmailHookPayload reports !ok when the send fails', async () => {
  const result = await handleAuthEmailHookPayload({
    payload: {
      user: { email: 'a@b-com.example' },
      email_data: { email_action_type: 'recovery', token_hash: 't' }
    },
    supabaseUrl: 'https://proj.supabase.co',
    deps: { send: async () => ({ ok: false, error: 'domain not verified' }) }
  });
  assert.equal(result.ok, false);
  assert.equal(result.sendResult.error, 'domain not verified');
});

test('handleAuthEmailHookPayload rejects a payload missing email/action', async () => {
  const result = await handleAuthEmailHookPayload({
    payload: { user: {}, email_data: {} },
    supabaseUrl: 'https://proj.supabase.co',
    deps: { send: async () => ({ ok: true }) }
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing/);
});
