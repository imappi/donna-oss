// Reply-triage persistence (migration 097). Thin SQL over the shared pool;
// firm-agnostic (047's line). Verdicts are APPEND-ONLY: a re-triage inserts a
// new row; renderers read the latest per message (render-the-persisted-
// verdict). The insert refuses a malformed verdict (writer precondition) so
// nothing downstream ever renders an unvocabularied class.

import { randomUUID } from 'node:crypto';

import { queryFirmDb } from '../firmDb.js';
import { validateTriageVerdict } from './replyTriage.js';

// Messages awaiting a semantic verdict: human mail (M3's 'reply'/'unmatched'
// received events) with no triage row yet. Oldest first — the queue drains in
// arrival order.
export const listUntriagedInbound = async ({ limit = 10 } = {}) => {
  const { rows } = await queryFirmDb(
    `select m.*
       from marketing_inbound_message m
      where m.event_type = 'email.received'
        and m.classification in ('reply', 'unmatched')
        and not exists (
          select 1 from marketing_reply_triage t where t.inbound_message_id = m.id
        )
      order by m.created_at asc
      limit $1`,
    [limit]
  );
  return rows;
};

export const getInboundMessageById = async (messageId) => {
  const { rows } = await queryFirmDb(
    'select * from marketing_inbound_message where id = $1',
    [String(messageId || '')]
  );
  return rows[0] || null;
};

// The sender-context reads for the triage input (compressed, accounting-
// relevant view — never a raw dump into the prompt).
export const getWaitlistLead = async (email) => {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  const { rows } = await queryFirmDb(
    'select email, reason, status, created_at from marketing_waitlist where lower(email) = $1 limit 1',
    [clean]
  );
  return rows[0] || null;
};

// Insert one verdict (append-only). Refuses a malformed verdict — the CHECK
// constraints would too, but the writer names the violation instead of
// surfacing a bare SQL error.
export const insertTriageVerdict = async ({ inboundMessageId, verdict = {}, model } = {}) => {
  const violations = validateTriageVerdict(verdict);
  if (violations.length > 0) {
    throw new Error(`Refusing malformed triage verdict: ${violations.join('; ')}`);
  }
  if (!String(model || '').trim()) {
    throw new Error('Refusing a triage verdict without its model id (the receipt).');
  }
  const id = randomUUID();
  const { rows } = await queryFirmDb(
    `insert into marketing_reply_triage
       (id, inbound_message_id, semantic_class, confidence, summary,
        recommended_action, suggested_snooze_days, referred_contact, model)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      id,
      String(inboundMessageId),
      verdict.semantic_class,
      verdict.confidence,
      String(verdict.summary).trim(),
      verdict.recommended_action,
      Number.isFinite(Number(verdict.suggested_snooze_days)) ? Math.round(Number(verdict.suggested_snooze_days)) : null,
      verdict.referred_contact ? String(verdict.referred_contact).slice(0, 500) : null,
      String(model)
    ]
  );
  return rows[0];
};

// Record what the Keep layer actually DID about the verdict (the receipt half
// — same insert-act-record pattern as M3's recordInboundHandling).
export const recordTriageHandling = async ({ triageId, appliedActions = [], draftId = null, error = null } = {}) => {
  await queryFirmDb(
    `update marketing_reply_triage
        set applied_actions = $2, draft_id = $3, error = $4
      where id = $1`,
    [triageId, JSON.stringify(appliedActions), draftId, error ? String(error).slice(0, 500) : null]
  );
};

// not_now → push the prospect's clock out (capped by the caller via
// clampSnoozeDays). Deliberately narrow: only a prospect resting
// contacted_awaiting_reply carries a follow-up clock the reply can move; a
// held on_kari revisit date is Kari's own and stays his.
export const snoozeProspect = async ({ prospectId, days, now = new Date() } = {}) => {
  const at = new Date(now.getTime() + days * 86_400_000);
  const { rows } = await queryFirmDb(
    `update marketing_prospect
        set next_action_at = $2, updated_at = now()
      where id = $1 and status = 'contacted_awaiting_reply'
      returning id, status, next_action_at`,
    [String(prospectId), at.toISOString()]
  );
  return rows[0] || null;
};
