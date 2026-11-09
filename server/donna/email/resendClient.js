// Resend — the ONLY module that talks to the Resend email API.
//
// Boundary (mirrors stripeBilling.js): all transactional email leaves Donna
// through sendEmail() here; callers never construct an email request themselves.
// Env-driven so the same code runs with a test key in preview and the live key
// in prod (CLAUDE.md "the model id is the receipt" — the env value IS the
// deployed reality).
//
// Fail-safe by construction: when RESEND_API_KEY is unset, sendEmail is a no-op
// that REPORTS { skipped: true } instead of throwing. A missing key must never
// break a caller in a launch-critical path (the auth-email hook, a billing
// webhook) — email-down should degrade to "no email sent", never to "signup
// 500s". Uses global fetch; no SDK dependency to install.

const env = (key) => String(process.env[key] || '').trim();

export const RESEND_API_URL = 'https://api.resend.com/emails';

const API_KEY = () => env('RESEND_API_KEY');

// Sender identity. The FROM address must be on the domain VERIFIED in Resend —
// that is `updates.donnamail.example` (the subdomain verified 2026-06-29 with DNS
// in Hostinger), NOT the bare donnamail.example, so the default lives there or
// Resend rejects the send as an unverified domain. donnamail.example is the brand
// domain we control (books.example's domain manager is not accessible). Replies route
// to kari@books.example, Donna's one mailbox (Kari, 2026-10-22: "I have no other
// emails for donna") — reply-to is a plain header, it needs no Resend
// verification, so it can be a books.example address even though we cannot SEND
// from books.example. Override either via env (EMAIL_FROM must stay on
// a Resend-verified domain).
export const defaultFrom = () => env('EMAIL_FROM') || 'Donna <donna@updates.donnamail.example>';
export const defaultReplyTo = () => env('EMAIL_REPLY_TO') || 'support@books.example';

// The configured sender with a different DISPLAY NAME, for mail written on a
// firm's behalf (owner question emails name the accounting firm). The ADDRESS
// is taken verbatim from the configured sender (`Name <addr>` or a bare
// address), so the verified sending domain never changes. The name is quoted
// (RFC 5322) because firm names carry commas and dots. A blank name returns
// the configured sender unchanged.
export const senderWithDisplayName = (displayName, configured = defaultFrom()) => {
  const name = String(displayName || '').replace(/[\r\n"\\<>]/g, ' ').replace(/\s+/g, ' ').trim();
  const raw = String(configured || '').trim();
  if (!name) return raw;
  const bracketed = raw.match(/<([^<>]+)>\s*$/);
  const address = (bracketed ? bracketed[1] : raw).trim();
  return address ? `"${name}" <${address}>` : raw;
};

// Email is ENABLED once the API key exists. When disabled the feature stays
// inert; nothing it gates is walled off.
export const isEmailEnabled = () => Boolean(API_KEY());

// Send one transactional email via the Resend API.
//
// Returns a plain result object, never throws for the expected failure modes:
//   { ok: true, id }                         — sent
//   { ok: false, skipped: true, reason }     — RESEND_API_KEY unset (inert)
//   { ok: false, error, status? }            — bad input or a Resend failure
//
// `deps` is injectable for tests (fetchImpl, apiKey); production omits it.
export const sendEmail = async ({
  to,
  subject,
  html,
  text,
  from,
  replyTo,
  headers,
  attachments,
  deps = {}
} = {}) => {
  const { fetchImpl = fetch, apiKey = API_KEY() } = deps;

  if (!apiKey) return { ok: false, skipped: true, reason: 'RESEND_NOT_CONFIGURED' };
  if (!to || !subject || (!html && !text)) {
    return { ok: false, error: 'sendEmail requires `to`, `subject`, and `html` or `text`.' };
  }

  const resolvedReplyTo = replyTo || defaultReplyTo();
  const payload = {
    from: from || defaultFrom(),
    to: Array.isArray(to) ? to : [to],
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(resolvedReplyTo ? { reply_to: resolvedReplyTo } : {}),
    ...(headers ? { headers } : {}),
    // Resend expects base64 content; callers pass { filename, content, contentType }
    // (e.g. the FI-10 Finvoice XML attachment).
    ...(Array.isArray(attachments) && attachments.length
      ? {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.isBuffer(a.content)
              ? a.content.toString('base64')
              : Buffer.from(String(a.content ?? ''), 'utf8').toString('base64'),
            ...(a.contentType ? { content_type: a.contentType } : {})
          }))
        }
      : {})
  };

  try {
    const response = await fetchImpl(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body?.message || body?.error || `Resend returned ${response.status}.`
      };
    }
    return { ok: true, id: body?.id || null };
  } catch (error) {
    return { ok: false, error: error?.message || 'Resend request failed.' };
  }
};

// Retrieve one RECEIVED (inbound) email's full content. The `email.received`
// webhook carries metadata only; the body/headers live behind this endpoint
// (verified against the Resend receiving reference, 2026-07-24). Same result
// idiom as sendEmail — never throws for expected failures.
export const RESEND_RECEIVING_URL = 'https://api.resend.com/emails/receiving';

export const getReceivedEmail = async (emailId, deps = {}) => {
  const { fetchImpl = fetch, apiKey = API_KEY() } = deps;
  if (!apiKey) return { ok: false, skipped: true, reason: 'RESEND_NOT_CONFIGURED' };
  if (!emailId) return { ok: false, error: 'getReceivedEmail requires an email id.' };
  try {
    const response = await fetchImpl(`${RESEND_RECEIVING_URL}/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: body?.message || body?.error || `Resend returned ${response.status}.`
      };
    }
    return { ok: true, email: body };
  } catch (error) {
    return { ok: false, error: error?.message || 'Resend request failed.' };
  }
};
