// Donna — universal @mentions: the per-principal notification reads (slice 4,
// docs/design-donna-universal-mentions.md §7, D10).
//
// The Mentions lane is a UNION of two reads, deliberately:
//   1. mention_notifications rows (124) — mention/assign entries + unread
//      state (delivery state; a lost row hides nothing load-bearing);
//   2. OPEN SEAT ASKS addressed to the principal, LIVE from
//      client_evidence_requests — the store of record. An ask waiting on a
//      named human must never depend on a delivery row to be visible.
//
// Reads are always scoped to the CALLING principal: there is no
// "list someone else's notifications" surface, and mark-read touches only
// the caller's own rows. Client-scope filtering happens at render time by
// the caller's entity eligibility (the ids returned all carry client_id).

import { queryFirmDb, DEFAULT_FIRM_ID } from '../firmDb.js';

const principalRef = (principal = {}) => ({
  type: String(principal?.principalType || principal?.principal_type || '').trim(),
  id: String(principal?.principalId || principal?.principal_id || '').trim()
});

export const listMentionNotifications = async ({
  firmId = DEFAULT_FIRM_ID, principal, unreadOnly = false, limit = 100
} = {}) => {
  const { type, id } = principalRef(principal);
  if (!type || !id) return [];
  const result = await queryFirmDb(
    `select id, firm_id, client_id, principal_type, principal_id, kind,
            artifact_type, artifact_id, actor_id, actor_display, excerpt,
            message_id, ask_id, read_at, created_at
       from mention_notifications
      where firm_id = $1 and principal_type = $2 and principal_id = $3
        ${unreadOnly ? 'and read_at is null' : ''}
      order by created_at desc
      limit $4`,
    [firmId, type, id, Math.max(1, Math.min(Number(limit) || 100, 500))]
  );
  return result.rows || [];
};

export const countUnreadMentionNotifications = async ({
  firmId = DEFAULT_FIRM_ID, principal
} = {}) => {
  const { type, id } = principalRef(principal);
  if (!type || !id) return 0;
  const result = await queryFirmDb(
    `select count(*)::int as unread
       from mention_notifications
      where firm_id = $1 and principal_type = $2 and principal_id = $3
        and read_at is null`,
    [firmId, type, id]
  );
  return Number(result.rows?.[0]?.unread || 0);
};

// ids = null marks everything of the caller's read. Only the caller's own
// rows are reachable — the WHERE carries the principal unconditionally.
export const markMentionNotificationsRead = async ({
  firmId = DEFAULT_FIRM_ID, principal, ids = null
} = {}) => {
  const { type, id } = principalRef(principal);
  if (!type || !id) return { updated: 0 };
  const list = Array.isArray(ids) ? ids.filter(Boolean).map(String) : null;
  const result = await queryFirmDb(
    `update mention_notifications
        set read_at = now()
      where firm_id = $1 and principal_type = $2 and principal_id = $3
        and read_at is null
        ${list ? 'and id = any($4::text[])' : ''}
      returning id`,
    list ? [firmId, type, id, list] : [firmId, type, id]
  );
  return { updated: result.rows?.length || 0 };
};

// The live half of the lane: open seat asks addressed to this principal.
// Status draft/open = the question still rests on the addressee (lock-step
// with OPEN_OWNER_ASK_STATUSES); 'replied' has left them.
export const listOpenSeatAsksForPrincipal = async ({
  firmId = DEFAULT_FIRM_ID, principal, limit = 100
} = {}) => {
  const { type, id } = principalRef(principal);
  if (!type || !id) return [];
  // The document anchor rides request_payload.document_id (the doc-first
  // drain's lane; transaction_id is the only artifact column) — lock-step
  // with openOwnerAskDocIdsFrom in src/lib/documentsInbox.js. An ask on a
  // standing subject (a physical count line, an account role) has neither:
  // it is labelled by its canonical anchor's typed rung (buildCanonicalAnchor),
  // and anything else carries no label rather than a borrowed 'document'.
  const result = await queryFirmDb(
    `select cer.id, cer.firm_id, cer.client_id, cer.transaction_id,
            cer.request_payload->>'document_id' as document_id,
            cer.question, cer.status, cer.created_by, cer.created_at, cer.evidence_type,
            -- A ledger adjustment a firm member must post: the lane renders
            -- these stored facts through its catalog message.
            cer.request_payload->'ledger_adjustment' as ledger_adjustment,
            case when cer.transaction_id is not null then 'transaction'
                 when cer.request_payload->>'document_id' is not null then 'document'
                 when cer.canonical_anchor like 'physical\\_count\\_line:%' then 'physical_count_line'
                 when cer.canonical_anchor like 'account\\_role:%' then 'account_role'
            end as artifact_type,
            coalesce(cer.transaction_id, cer.request_payload->>'document_id',
                     case when cer.canonical_anchor like 'physical\\_count\\_line:%' or cer.canonical_anchor like 'account\\_role:%'
                          then substr(cer.canonical_anchor, strpos(cer.canonical_anchor, ':') + 1) end) as artifact_id
       from client_evidence_requests cer
      where cer.firm_id = $1
        and cer.audience = 'seat'
        and cer.addressee_principal_type = $2
        and cer.addressee_principal_id = $3
        and cer.status in ('draft', 'open')
      order by cer.created_at desc
      limit $4`,
    [firmId, type, id, Math.max(1, Math.min(Number(limit) || 100, 500))]
  );
  return result.rows || [];
};
