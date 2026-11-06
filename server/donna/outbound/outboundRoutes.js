// Outbound HTTP surface (M1, G8 + G9). Two PUBLIC token-authenticated
// handlers, wired in api.js (the marketing-routes shape):
//
//   - handleOutboundUnsubscribe — the counterparty clicks it from a reminder.
//     Resolves the per-action bearer token, suppresses the recipient
//     (outbound_suppression, reason 'unsubscribed'), confirms in plain HTML.
//     The next send attempt gate-blocks and the chase stops with a receipted
//     cancel. Unsubscribe must never require auth (marketing rail).
//
//   - handleOutboundApproval — the OWNER's approve/decline tap from the G9
//     digest email (D10: email is the US workbench). The token is a bearer
//     capability delivered to the owner's own inbox — the same trust model as
//     the portal magic link. Approve flips hold_for_approval → approved
//     (approveOutboundAction, non-system principal — the approval IS the
//     authority the send receipt cites); decline cancels with a receipt and
//     stops the receivable case. Both are idempotent: a second tap reports
//     the already-decided state instead of re-deciding.
//
// Send invariants stay at the writers/executor; this layer resolves tokens,
// wraps each decision in one transaction, and reports.

import { withFirmDbClient } from '../firmDb.js';
import { verifySvixSignature } from '../marketing/marketingInbound.js';
import {
  addOutboundSuppression, approveOutboundAction, cancelOutboundAction
} from './actionStore.js';
import { syncReceivableCaseAfterCancel } from './receivableCases.js';
import {
  applyPayLinkWebhookEvent, constructPayLinkWebhookEvent, isPayLinkWebhookConfigured
} from './payLinks.js';
import { ingestOutboundReplyEvent } from './replyIngestion.js';

const PAGE_HTML = (message) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Donna</title></head>` +
  `<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">` +
  `<h1 style="font-size:1.3rem;">Donna</h1><p>${message}</p></body></html>`;

const sendPage = (res, status, message) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(PAGE_HTML(message));
};

const tokenFrom = (requestUrl) => String(requestUrl.searchParams.get('token') || '').trim();

const sendJson = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
};

const readRawBody = async (req, maxBytes = 1024 * 1024) => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (total > maxBytes) {
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8');
};

// D4 — the pay-link settlement webhook (Stripe Connect endpoint; the
// billing webhook's discipline: signature is the ONLY authentication, 400 on
// a bad signature so Stripe stops, 5xx on processing failure so it retries).
export const handleOutboundPayLinkWebhook = async (req, res, requestUrl, deps = {}) => {
  const withFirmDbClientFn = deps.withFirmDbClientFn || withFirmDbClient;
  const constructEventFn = deps.constructEventFn || constructPayLinkWebhookEvent;
  const applyFn = deps.applyFn || applyPayLinkWebhookEvent;
  const env = deps.env || process.env;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  if (!(deps.isConfiguredFn || isPayLinkWebhookConfigured)(env)) {
    sendJson(res, 503, { code: 'PAYLINK_WEBHOOK_NOT_CONFIGURED', error: 'Pay-link webhook is not configured.' });
    return;
  }
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: 'Could not read request body.' });
    return;
  }
  let event;
  try {
    event = await constructEventFn({ rawBody, signature: req.headers['stripe-signature'], env });
  } catch {
    sendJson(res, 400, { code: 'WEBHOOK_SIGNATURE_INVALID', error: 'Webhook signature verification failed.' });
    return;
  }
  try {
    const result = await withFirmDbClientFn((client) => applyFn({ client, event }));
    sendJson(res, 200, { received: true, handled: Boolean(result?.handled), deduped: Boolean(result?.deduped) });
  } catch {
    sendJson(res, 500, { received: true, error: 'Webhook processing failed.' });
  }
};

// reply_if_wrong v2 — the owner-reply inbound webhook (Resend email.received;
// the marketing inbound webhook's discipline: PUBLIC by necessity, the Svix
// signature over the RAW body IS the auth, fail-closed 503 without its own
// configured secret, non-2xx makes Svix redeliver, and the dedupe index makes
// redelivery of a handled event a receipted no-op). Deterministic — the LLM
// classification runs in the hourly sweep, never inline here.
export const handleOutboundReplyWebhook = async (req, res, requestUrl, deps = {}) => {
  const env = deps.env || process.env;
  const ingestFn = deps.ingestFn || ingestOutboundReplyEvent;
  const verifyFn = deps.verifyFn || verifySvixSignature;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return;
  }
  const secret = String(env.OUTBOUND_REPLY_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    sendJson(res, 503, {
      code: 'WEBHOOK_NOT_CONFIGURED',
      error: 'OUTBOUND_REPLY_WEBHOOK_SECRET is not set; the reply webhook refuses honestly.'
    });
    return;
  }
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message || 'bad request body' });
    return;
  }
  const verdict = verifyFn({
    secret,
    svixId: req.headers['svix-id'],
    svixTimestamp: req.headers['svix-timestamp'],
    svixSignature: req.headers['svix-signature'],
    rawBody
  });
  if (!verdict.ok) {
    sendJson(res, 401, { code: 'BAD_SIGNATURE', error: verdict.reason });
    return;
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    sendJson(res, 400, { error: 'Body is not valid JSON.' });
    return;
  }
  const eventType = String(event?.type || '');
  if (eventType !== 'email.received') {
    // Acknowledged, not stored — an unknown event must never 500 (Svix would
    // retry it forever) and never silently grow the stored vocabulary.
    sendJson(res, 200, { ok: true, ignored: eventType || 'unknown' });
    return;
  }
  try {
    const result = await ingestFn({ event, eventType, deps: { env, ...(deps.ingestDeps || {}) } });
    sendJson(res, result.retriable ? 502 : 200, result.body);
  } catch (error) {
    sendJson(res, 500, { error: error?.message || 'reply ingestion failed' });
  }
};

export const handleOutboundUnsubscribe = async (req, res, requestUrl, deps = {}) => {
  const withFirmDbClientFn = deps.withFirmDbClientFn || withFirmDbClient;
  try {
    const token = tokenFrom(requestUrl);
    if (!token) {
      sendPage(res, 404, 'That unsubscribe link is not valid. Email support@books.example and a human will sort it out.');
      return;
    }
    await withFirmDbClientFn(async (client) => {
      const action = await client.query(
        'select * from outbound_actions where unsubscribe_token = $1',
        [token]
      ).then((r) => r.rows[0] || null);
      if (!action) {
        sendPage(res, 404, 'That unsubscribe link is not valid. Email support@books.example and a human will sort it out.');
        return;
      }
      // The address to suppress: what the send receipt says actually received
      // mail for this action; the party's active primary email as fallback.
      const recipient = await client.query(
        `select recipient from outbound_action_receipts
          where action_id = $1 and recipient is not null
          order by created_at desc limit 1`,
        [action.id]
      ).then((r) => r.rows[0]?.recipient || null);
      const fallback = recipient ? null : await client.query(
        `select normalized_value from party_channels
          where party_id = $1 and channel_kind = 'email' and valid_until is null
          order by is_primary desc limit 1`,
        [action.target_party_id]
      ).then((r) => r.rows[0]?.normalized_value || null);
      const value = recipient || fallback;
      if (!value) {
        sendPage(res, 200, 'There is no email address on file for this reminder — nothing to unsubscribe.');
        return;
      }
      await client.query('begin');
      try {
        await addOutboundSuppression(client, {
          firmId: action.firm_id, clientId: action.client_id,
          channelKind: 'email', value,
          reason: 'unsubscribed', source: `action:${action.id}`,
          actorType: 'counterparty'
        });
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
      sendPage(res, 200, "You're unsubscribed — no more payment reminders to this address from this sender. If something is wrong with the underlying invoice, reply to the original email.");
    });
  } catch {
    sendPage(res, 500, 'Something went wrong. Email support@books.example and a human will sort it out.');
  }
};

export const handleOutboundApproval = async (req, res, requestUrl, deps = {}) => {
  const withFirmDbClientFn = deps.withFirmDbClientFn || withFirmDbClient;
  try {
    const token = tokenFrom(requestUrl);
    const decision = String(requestUrl.searchParams.get('decision') || 'approve').trim().toLowerCase();
    if (!token || !['approve', 'decline'].includes(decision)) {
      sendPage(res, 404, 'That approval link is not valid.');
      return;
    }
    await withFirmDbClientFn(async (client) => {
      const action = await client.query(
        'select * from outbound_actions where approval_token = $1',
        [token]
      ).then((r) => r.rows[0] || null);
      if (!action) {
        sendPage(res, 404, 'That approval link is not valid.');
        return;
      }
      if (action.status !== 'hold_for_approval') {
        sendPage(res, 200, `This one is already handled — its current state is "${action.status}". Nothing further to do.`);
        return;
      }
      await client.query('begin');
      try {
        if (decision === 'approve') {
          const approved = await approveOutboundAction(client, {
            firmId: action.firm_id, clientId: action.client_id,
            actionId: action.id, actorType: 'owner', actorId: 'email_approval_link'
          });
          await client.query('commit');
          sendPage(res, 200, approved
            ? 'Approved — Donna will send it within the hour.'
            : 'This one is already handled. Nothing further to do.');
          return;
        }
        const cancelled = await cancelOutboundAction(client, {
          firmId: action.firm_id, clientId: action.client_id,
          actionId: action.id, reason: 'owner_declined',
          actorType: 'owner', actorId: 'email_approval_link',
          authority: 'per_send_owner_decline'
        });
        if (cancelled) {
          await syncReceivableCaseAfterCancel(client, {
            firmId: action.firm_id, clientId: action.client_id,
            action: cancelled, reasons: ['owner_declined']
          });
        }
        await client.query('commit');
        sendPage(res, 200, cancelled
          ? "Declined — Donna won't send this one, and the chase for this invoice is stopped. You can restart it anytime from your workspace or by telling Donna."
          : 'This one is already handled. Nothing further to do.');
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    });
  } catch (error) {
    if (error?.code === 'OUTBOUND_REQUESTED_LANGUAGE_UNAVAILABLE') {
      sendPage(res, 409, 'The requested language is not available yet. Choose a supported fallback in your workspace, or decline this send.');
      return;
    }
    sendPage(res, 500, 'Something went wrong. The action was not changed — try the link again in a minute.');
  }
};
