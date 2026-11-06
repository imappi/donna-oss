// Supabase Send-Email Auth Hook — verify, render, send.
//
// When a "Send Email" hook is configured in the Supabase dashboard, GoTrue stops
// sending auth emails itself and POSTs every one to this endpoint instead. We
// verify the request (Standard Webhooks signature, the format Supabase uses),
// render the branded template from authEmailTemplates.js, and send it via Resend.
//
// IMPORTANT operational note: with a hook active there is NO automatic fallback
// to GoTrue's own templates — if this endpoint fails, the auth email is not
// sent and the auth action errors. So: signature failures 401 (never trust the
// payload), and a Resend failure 500 (so Supabase surfaces it / the user can
// retry) rather than a silent 200. The break-glass is to DISABLE the hook in the
// dashboard, which reverts to GoTrue + whatever SMTP is configured. This is all
// gated behind SEND_EMAIL_HOOK_SECRET + RESEND_API_KEY; unset = inert.

import { createHmac, timingSafeEqual } from 'node:crypto';

import { sendEmail } from './resendClient.js';
import { renderAuthEmail } from './authEmailTemplates.js';

const env = (key) => String(process.env[key] || '').trim();

const HOOK_SECRET = () => env('SEND_EMAIL_HOOK_SECRET');

// Active only when BOTH the hook secret and the Resend key exist — sending
// without verifying, or verifying with nothing to send, are both useless.
export const isAuthEmailHookEnabled = () => Boolean(HOOK_SECRET() && env('RESEND_API_KEY'));

// Supabase shows the hook secret as `v1,whsec_<base64>`. The signed key is the
// base64 payload after the prefix(es); decode it to raw bytes.
const decodeSecret = (secret) => {
  let s = String(secret || '').trim();
  if (s.startsWith('v1,')) s = s.slice(3);
  if (s.startsWith('whsec_')) s = s.slice(6);
  return Buffer.from(s, 'base64');
};

// Standard Webhooks verification: HMAC-SHA256 over `${id}.${timestamp}.${body}`,
// base64-compared (constant time) against any signature in the space-delimited
// `webhook-signature` header, with a replay window on `webhook-timestamp`.
// Throws on any failure; the caller maps that to 401.
export const verifyHookSignature = ({
  rawBody,
  headers = {},
  secret = HOOK_SECRET(),
  toleranceSeconds = 300,
  nowMs
} = {}) => {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) {
    throw new Error('Missing webhook signature headers.');
  }
  if (!secret) throw new Error('Hook secret is not configured.');

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) throw new Error('Invalid webhook timestamp.');
  const nowSeconds = Math.floor((typeof nowMs === 'number' ? nowMs : Date.now()) / 1000);
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) {
    throw new Error('Webhook timestamp outside tolerance.');
  }

  const key = decodeSecret(secret);
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected);

  const passed = String(signatureHeader)
    .split(' ')
    .some((part) => {
      const comma = part.indexOf(',');
      const sig = comma >= 0 ? part.slice(comma + 1) : part;
      const sigBuf = Buffer.from(sig);
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    });
  if (!passed) throw new Error('Webhook signature mismatch.');
  return true;
};

// Render + send for a verified payload. Returns a result object (never throws);
// the caller maps !ok to a 5xx so Supabase can retry. `deps` injectable for tests.
export const handleAuthEmailHookPayload = async ({ payload, supabaseUrl, deps = {} } = {}) => {
  const { send = sendEmail, render = renderAuthEmail } = deps;
  const user = payload?.user;
  const data = payload?.email_data;
  const to = user?.email;

  if (!to || !data?.email_action_type) {
    return { ok: false, error: 'Payload missing user.email or email_data.email_action_type.' };
  }

  const rendered = render({
    emailActionType: data.email_action_type,
    supabaseUrl,
    tokenHash: data.token_hash,
    tokenHashNew: data.token_hash_new,
    token: data.token,
    redirectTo: data.redirect_to
  });
  if (!rendered?.html || !rendered?.subject) {
    return { ok: false, error: `Could not render email for action "${data.email_action_type}".` };
  }

  const result = await send({ to, subject: rendered.subject, html: rendered.html });
  return {
    ok: Boolean(result.ok),
    action: data.email_action_type,
    sendResult: result
  };
};
