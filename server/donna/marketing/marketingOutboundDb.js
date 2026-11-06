// Marketing outbound persistence (migration 050). Thin SQL over the shared
// firm-DB pool — firm-AGNOSTIC by design (047's line): nothing here joins
// firms/clients, and nothing in the books surfaces reads these tables.
//
// Write discipline (the rails, enforced here at the writer):
//   - Suppression is checked inside the same statement that matters — a
//     suppressed address cannot be drafted for or sent to.
//   - Minting a draft supersedes prior 'proposed' drafts for the same
//     lead+channel in the same transaction (no two live Apply buttons for one
//     lead — same supersede discipline as the chat proposal mint).
//   - The sent-flip and its receipt are one transaction: no receipt, no 'sent'.

import { randomUUID } from 'node:crypto';

import { queryFirmDb, withFirmDbClient } from '../firmDb.js';
import {
  DRAFT_STATUSES,
  LEAD_STATUSES,
  MARKETING_CHANNELS,
  SUPPRESSION_REASONS
} from './marketingOutbound.js';

const cleanEmail = (email = '') => String(email || '').trim().toLowerCase();

// ── Leads (marketing_waitlist + lifecycle columns) ───────────────────────────

// Waitlist leads with suppression state, newest first. `undrafted_only` keeps
// the generate endpoint idempotent-ish: leads that already have a live
// (proposed/approved) or sent draft on the channel are excluded.
export const listNurtureLeads = async ({ limit = 50, undraftedOnly = false, channel = 'waitlist_nurture' } = {}) => {
  const { rows } = await queryFirmDb(
    `select w.id, w.email, w.reason, w.source, w.status, w.created_at, w.last_touch_at,
            (s.id is not null) as suppressed
       from marketing_waitlist w
       left join marketing_suppression s on lower(s.email) = lower(w.email)
      where ($2::boolean = false or not exists (
              select 1 from marketing_draft d
               where lower(d.lead_email) = lower(w.email)
                 and d.channel = $3
                 and d.status in ('proposed', 'approved', 'sent')))
      order by w.created_at desc
      limit $1`,
    [limit, undraftedOnly, channel]
  );
  return rows;
};

export const touchLead = async ({ email, status = null } = {}) => {
  const nextStatus = LEAD_STATUSES.includes(status) ? status : null;
  await queryFirmDb(
    `update marketing_waitlist
        set last_touch_at = now(),
            status = coalesce($2, status)
      where lower(email) = lower($1)`,
    [cleanEmail(email), nextStatus]
  );
};

// ── Suppression ──────────────────────────────────────────────────────────────

export const isSuppressed = async (email) => {
  const { rows } = await queryFirmDb(
    'select 1 from marketing_suppression where lower(email) = lower($1) limit 1',
    [cleanEmail(email)]
  );
  return rows.length > 0;
};

export const addSuppression = async ({ email, reason = 'manual', source = 'manual' } = {}) => {
  const clean = cleanEmail(email);
  if (!clean) return { ok: false, error: 'email required' };
  const tag = SUPPRESSION_REASONS.includes(reason) ? reason : 'manual';
  await queryFirmDb(
    `insert into marketing_suppression (id, email, reason, source)
     values ($1, $2, $3, $4)
     on conflict (lower(email)) do nothing`,
    [randomUUID(), clean, tag, String(source || 'manual')]
  );
  await queryFirmDb(
    `update marketing_waitlist set status = 'suppressed', last_touch_at = now()
      where lower(email) = lower($1)`,
    [clean]
  );
  return { ok: true };
};

// ── Drafts ───────────────────────────────────────────────────────────────────

// Mint one proposed draft, superseding any prior live proposal for the same
// lead+channel in the same transaction. Refuses suppressed addresses.
// `inboundMessageId`/`prospectId` (M4): a channel-'reply' draft records which
// inbound message it answers (threading headers render from that row's stored
// RFC fields at send time) and, when matched, which prospect owns the thread.
export const insertDraft = async ({
  leadEmail,
  segment,
  channel = 'waitlist_nurture',
  subject,
  body,
  model,
  inboundMessageId = null,
  prospectId = null
} = {}) => {
  const clean = cleanEmail(leadEmail);
  if (!MARKETING_CHANNELS.includes(channel)) throw new Error(`Unknown marketing channel: ${channel}`);
  return withFirmDbClient(async (client) => {
    try {
      await client.query('begin');
      const suppressed = await client.query(
        'select 1 from marketing_suppression where lower(email) = lower($1) limit 1',
        [clean]
      );
      if (suppressed.rows.length > 0) {
        await client.query('rollback');
        return { ok: false, refused: 'suppressed' };
      }
      const superseded = await client.query(
        `update marketing_draft
            set status = 'superseded', decided_by = 'system:supersede', decided_at = now()
          where lower(lead_email) = lower($1) and channel = $2 and status = 'proposed'
          returning id`,
        [clean, channel]
      );
      const id = randomUUID();
      const { rows } = await client.query(
        `insert into marketing_draft
           (id, lead_email, segment, channel, subject, body, model, status, unsubscribe_token, supersedes,
            inbound_message_id, prospect_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'proposed', $8, $9, $10, $11)
         returning *`,
        [
          id,
          clean,
          String(segment || 'other'),
          channel,
          String(subject),
          String(body),
          String(model),
          randomUUID(),
          superseded.rows[0]?.id || null,
          inboundMessageId,
          prospectId
        ]
      );
      await client.query('commit');
      return { ok: true, draft: rows[0], supersededIds: superseded.rows.map((r) => r.id) };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
};

export const listDrafts = async ({ statuses = ['proposed'], limit = 100 } = {}) => {
  const wanted = statuses.filter((s) => DRAFT_STATUSES.includes(s));
  if (wanted.length === 0) return [];
  const { rows } = await queryFirmDb(
    `select * from marketing_draft where status = any($1) order by proposed_at desc limit $2`,
    [wanted, limit]
  );
  return rows;
};

export const getDraft = async (draftId) => {
  const { rows } = await queryFirmDb('select * from marketing_draft where id = $1', [draftId]);
  return rows[0] || null;
};

export const getDraftByUnsubscribeToken = async (token) => {
  const { rows } = await queryFirmDb(
    'select * from marketing_draft where unsubscribe_token = $1',
    [String(token || '')]
  );
  return rows[0] || null;
};

// Reject a proposed draft (terminal; the rejection is training signal).
export const rejectDraft = async ({ draftId, actor } = {}) => {
  const { rows } = await queryFirmDb(
    `update marketing_draft
        set status = 'rejected', decided_by = $2, decided_at = now()
      where id = $1 and status = 'proposed'
      returning *`,
    [draftId, String(actor || 'unknown')]
  );
  return rows[0] || null;
};

// Guarded proposed→approved hop. Returns null if the draft was not proposed
// (already decided/superseded) — the caller treats that as a stale click.
export const markApproved = async ({ draftId, actor } = {}) => {
  const { rows } = await queryFirmDb(
    `update marketing_draft
        set status = 'approved', decided_by = $2, decided_at = now()
      where id = $1 and status = 'proposed'
      returning *`,
    [draftId, String(actor || 'unknown')]
  );
  return rows[0] || null;
};

// Record a failed send attempt; the draft stays 'approved' and visible.
export const markSendError = async ({ draftId, error } = {}) => {
  await queryFirmDb(
    `update marketing_draft set send_error = $2 where id = $1`,
    [draftId, String(error || 'send failed').slice(0, 500)]
  );
};

// The sent-flip and its receipt commit together: no receipt row, no 'sent'
// status. Audit-as-precondition, applied to outbound.
export const finalizeSend = async ({
  draftId,
  approvedBy,
  authority = 'per_send',
  transportMessageId = null,
  renderedSubject,
  renderedBody
} = {}) =>
  withFirmDbClient(async (client) => {
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `update marketing_draft
            set status = 'sent', send_error = null
          where id = $1 and status = 'approved'
          returning *`,
        [draftId]
      );
      const draft = rows[0];
      if (!draft) {
        await client.query('rollback');
        return { ok: false, error: 'Draft is not in the approved state.' };
      }
      const receiptId = randomUUID();
      await client.query(
        `insert into marketing_send_receipt
           (id, draft_id, channel, lead_email, approved_by, authority, model,
            transport_message_id, rendered_subject, rendered_body)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          receiptId,
          draftId,
          draft.channel,
          draft.lead_email,
          String(approvedBy || 'unknown'),
          String(authority),
          draft.model,
          transportMessageId,
          String(renderedSubject),
          String(renderedBody)
        ]
      );
      await client.query(
        `update marketing_waitlist set status = 'active', last_touch_at = now()
          where lower(email) = lower($1)`,
        [draft.lead_email]
      );
      await client.query('commit');
      return { ok: true, draft, receiptId };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });

export const listReceipts = async ({ limit = 50 } = {}) => {
  const { rows } = await queryFirmDb(
    'select * from marketing_send_receipt order by sent_at desc limit $1',
    [limit]
  );
  return rows;
};

// ── Send authority ───────────────────────────────────────────────────────────

export const listAuthorityRows = async () => {
  const { rows } = await queryFirmDb(
    'select channel, stage, changed_by, note, created_at from marketing_send_authority order by created_at asc',
    []
  );
  return rows;
};
