// Marketing inbound — pure vocabulary, webhook signature verification, and
// deterministic classification for M3 (reply ingestion). The loop this
// serves: send → reply received → thread matched → classified → CRM updated —
// today the system can send but cannot hear; this module is the hearing.
//
// Doctrine:
//   - DETERMINISTIC ONLY. Bounces, complaints, unsubscribes, out-of-office
//     and auto-replies are header/keyword arithmetic — handled here. Semantic
//     classes (interest, objection, referral) are M4's strong-model triage;
//     until then a matched human reply classifies 'reply' and reaches the
//     founder unjudged (forwarded + surfaced), never auto-answered.
//   - Signature IS the auth. The webhook endpoint is public; every request
//     must carry a valid Svix signature (Resend's webhook transport) over the
//     RAW body. No secret configured ⇒ the route fails closed.
//   - Nothing silent: every stored event carries its classification, its
//     match, and the exact actions taken (the row is the receipt).
//
// Pure module: no DB, no network. Verified API/signature shapes (2026-07-24):
// Resend `email.received` carries metadata only (data.email_id/from/to/
// subject); the body is retrieved via GET /emails/receiving/{id}; webhooks
// are Svix-signed: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}`
// keyed with the base64-DECODED portion of the `whsec_...` secret, base64
// output, matched against the space-delimited `v1,<sig>` entries in
// `svix-signature`, ±300s timestamp tolerance.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const HANDLED_INBOUND_EVENTS = Object.freeze([
  'email.received',
  'email.bounced',
  'email.complained'
]);

export const INBOUND_CLASSIFICATIONS = Object.freeze([
  'reply', // matched human mail — the founder's (and later M4's) to answer
  'unsubscribe_request',
  'bounce',
  'complaint',
  'out_of_office',
  'auto_reply',
  'unmatched' // human mail from an address we know nothing about
]);

// ── Svix signature verification (manual — no svix dependency) ───────────────

export const verifySvixSignature = ({
  secret,
  svixId,
  svixTimestamp,
  svixSignature,
  rawBody,
  now = new Date(),
  toleranceSeconds = 300
} = {}) => {
  if (!secret) return { ok: false, reason: 'no signing secret configured' };
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, reason: 'missing svix signature headers' };
  }
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed svix-timestamp' };
  const nowSec = (now instanceof Date ? now.getTime() : new Date(now).getTime()) / 1000;
  if (Math.abs(nowSec - ts) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp outside tolerance (replay guard)' };
  }
  let key;
  try {
    key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  } catch {
    return { ok: false, reason: 'malformed signing secret' };
  }
  if (!key.length) return { ok: false, reason: 'malformed signing secret' };

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');
  const expectedBuf = Buffer.from(expected);

  const candidates = String(svixSignature)
    .split(/\s+/)
    .map((entry) => entry.split(',', 2))
    .filter(([version]) => version === 'v1')
    .map(([, sig]) => sig)
    .filter(Boolean);

  for (const candidate of candidates) {
    const candidateBuf = Buffer.from(candidate);
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'signature mismatch' };
};

// ── Header access (retrieved-header shape is provider-defined; be liberal) ──

export const headerValue = (headers, name) => {
  if (!headers) return null;
  const wanted = String(name).toLowerCase();
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const key = String(entry?.name ?? entry?.key ?? '').toLowerCase();
      if (key === wanted) return entry?.value ?? null;
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === wanted) return value ?? null;
    }
  }
  return null;
};

export const parseThreading = (headers) => ({
  message_id: headerValue(headers, 'message-id'),
  in_reply_to: headerValue(headers, 'in-reply-to'),
  references_header: headerValue(headers, 'references')
});

// ── Deterministic classification ────────────────────────────────────────────

const OOO_PATTERN =
  /\b(out of (the )?office|on (annual|parental|sick)? ?leave|away from (the )?office|automatic reply|auto[- ]?reply|autoreply|autosvar|poissaolo)\b/i;

const UNSUBSCRIBE_PATTERN =
  /\b(unsubscribe|opt[- ]?out|stop (emailing|contacting|sending)|remove me from)\b/i;

const isAutoSubmitted = (headers) => {
  const autoSubmitted = String(headerValue(headers, 'auto-submitted') || '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  const precedence = String(headerValue(headers, 'precedence') || '').toLowerCase();
  if (['bulk', 'junk', 'auto_reply', 'list'].includes(precedence)) return true;
  if (headerValue(headers, 'x-autoreply') || headerValue(headers, 'x-autorespond')) return true;
  return false;
};

// Classify one inbound event. `matched` = did the from-address resolve to a
// known lead/prospect. Order matters: transport verdicts (bounce/complaint)
// come from the event type; automated-mail signals beat keyword matches (an
// OOO footer often contains "unsubscribe"); unsubscribe beats reply.
export const classifyInbound = ({ eventType, subject = '', textBody = '', headers = null, matched = false } = {}) => {
  if (eventType === 'email.bounced') return 'bounce';
  if (eventType === 'email.complained') return 'complaint';

  const subjectText = String(subject || '');
  // Keyword scans read the head of the body — quoted history below the reply
  // routinely contains our own unsubscribe footer.
  const bodyHead = String(textBody || '').slice(0, 2000);

  if (isAutoSubmitted(headers)) return 'auto_reply';
  if (OOO_PATTERN.test(subjectText) || OOO_PATTERN.test(bodyHead.slice(0, 500))) return 'out_of_office';
  if (UNSUBSCRIBE_PATTERN.test(subjectText) || UNSUBSCRIBE_PATTERN.test(bodyHead.slice(0, 500))) {
    return 'unsubscribe_request';
  }
  return matched ? 'reply' : 'unmatched';
};

// ── Deterministic action plan (executed + receipted by the writer) ──────────

export const planInboundActions = ({ classification, fromEmail = null, recipients = [] } = {}) => {
  const actions = [];
  const clean = (email) => String(email || '').trim().toLowerCase();
  if (classification === 'bounce') {
    for (const recipient of recipients.map(clean).filter(Boolean)) {
      actions.push({ action: 'suppress', email: recipient, reason: 'bounced' });
    }
  }
  if (classification === 'complaint') {
    for (const recipient of recipients.map(clean).filter(Boolean)) {
      actions.push({ action: 'suppress', email: recipient, reason: 'complaint' });
    }
  }
  if (classification === 'unsubscribe_request' && clean(fromEmail)) {
    actions.push({ action: 'suppress', email: clean(fromEmail), reason: 'unsubscribed' });
  }
  return actions;
};

// Which classifications the founder should SEE in his inbox (human mail and
// explicit asks — not transport noise).
export const FORWARDED_CLASSIFICATIONS = Object.freeze(['reply', 'unmatched', 'unsubscribe_request']);
