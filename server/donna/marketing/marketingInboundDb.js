// Marketing inbound persistence (migration 096). Thin SQL over the shared
// pool; firm-agnostic (047's line). The insert is the webhook's idempotency
// point: the (provider, event_type, provider_email_id) unique index absorbs
// Svix redelivery — a duplicate insert returns null and the writer takes NO
// actions again (suppression is idempotent anyway, but the receipt must not
// double-count).

import { randomUUID } from 'node:crypto';

import { queryFirmDb } from '../firmDb.js';
import { INBOUND_CLASSIFICATIONS, HANDLED_INBOUND_EVENTS } from './marketingInbound.js';

export const insertInboundMessage = async ({
  provider = 'resend',
  eventType,
  providerEmailId = null,
  fromEmail = null,
  toEmail = null,
  subject = null,
  textBody = null,
  htmlBody = null,
  headers = null,
  messageId = null,
  inReplyTo = null,
  referencesHeader = null,
  classification,
  matchedLeadEmail = null,
  matchedProspectId = null,
  rawPayload = null,
  receivedAt = null
} = {}) => {
  if (!HANDLED_INBOUND_EVENTS.includes(eventType)) {
    throw new Error(`Unhandled inbound event type: ${eventType}`);
  }
  if (!INBOUND_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`Unknown inbound classification: ${classification}`);
  }
  const id = randomUUID();
  const { rows } = await queryFirmDb(
    `insert into marketing_inbound_message
       (id, provider, event_type, provider_email_id, from_email, to_email, subject,
        text_body, html_body, headers, message_id, in_reply_to, references_header,
        classification, matched_lead_email, matched_prospect_id, raw_payload, received_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     on conflict (provider, event_type, provider_email_id) where provider_email_id is not null
     do nothing
     returning *`,
    [
      id,
      provider,
      eventType,
      providerEmailId,
      fromEmail,
      toEmail,
      subject,
      textBody,
      htmlBody,
      headers ? JSON.stringify(headers) : null,
      messageId,
      inReplyTo,
      referencesHeader,
      classification,
      matchedLeadEmail,
      matchedProspectId,
      rawPayload ? JSON.stringify(rawPayload) : null,
      receivedAt
    ]
  );
  return rows[0] || null; // null = duplicate delivery (already receipted)
};

// Record what the writer actually DID about the message (the receipt half).
export const recordInboundHandling = async ({ messageId, handledActions = [], forwardedTo = null, error = null } = {}) => {
  await queryFirmDb(
    `update marketing_inbound_message
        set handled_actions = $2, forwarded_to = $3, error = $4
      where id = $1`,
    [messageId, JSON.stringify(handledActions), forwardedTo, error ? String(error).slice(0, 500) : null]
  );
};

// Inbound feed, each row carrying its LATEST persisted triage verdict (M4;
// append-only verdicts, newest wins — render-the-persisted-verdict, never a
// fresh per-render inference).
export const listInboundMessages = async ({ limit = 25 } = {}) => {
  const { rows } = await queryFirmDb(
    `select m.id, m.event_type, m.from_email, m.to_email, m.subject, m.classification,
            m.matched_lead_email, m.matched_prospect_id, m.handled_actions, m.forwarded_to,
            m.error, m.received_at, m.created_at,
            t.semantic_class as triage_class, t.confidence as triage_confidence,
            t.summary as triage_summary, t.recommended_action as triage_recommended_action,
            t.applied_actions as triage_applied_actions, t.draft_id as triage_draft_id,
            t.model as triage_model, t.created_at as triaged_at
       from marketing_inbound_message m
       left join lateral (
         select * from marketing_reply_triage t
          where t.inbound_message_id = m.id
          order by t.created_at desc
          limit 1
       ) t on true
      order by m.created_at desc
      limit $1`,
    [limit]
  );
  return rows;
};

// Match an inbound sender to what we know: a nurture lead (waitlist) and/or a
// live prospect contact. Deterministic; the RFC threading headers are stored
// for the day the outbound side records its Message-ID.
export const matchInboundSender = async (fromEmail) => {
  const email = String(fromEmail || '').trim().toLowerCase();
  if (!email) return { leadEmail: null, prospectId: null };
  const [leadResult, prospectResult] = await Promise.all([
    queryFirmDb('select email from marketing_waitlist where lower(email) = $1 limit 1', [email]),
    queryFirmDb(
      `select id from marketing_prospect
        where lower(contact_email) = $1
          and status not in ('closed_no_reply', 'converted', 'unfit', 'suppressed')
        order by updated_at desc limit 1`,
      [email]
    )
  ]);
  return {
    leadEmail: leadResult.rows[0]?.email || null,
    prospectId: prospectResult.rows[0]?.id || null
  };
};
