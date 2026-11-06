-- Ask identity (the 2026-07-29 KUILI BARBACOA loop) — make "ONE active ask per
-- (canonical anchor, blocker code, generation)" a DATABASE invariant instead of
-- a read-then-write the schema never refused.
--
-- What happened: the owner uploaded a receipt, was asked what the charge was
-- for, re-uploaded the SAME receipt, and was asked again with a new Ref. Both
-- asks sat 'open' at once for one physical receipt.
--
-- The F-19 dedupe in createClientEvidenceRequestWithClient was not broken; it
-- was anchored on the wrong thing. It keyed on `document:<document.id>`, and
-- every Telegram upload mints a fresh document id (derived from the Telegram
-- message id, unique per send). Two uploads of one receipt are two documents,
-- two anchors, and two legitimately-distinct asks under that rule.
--
-- The contract this migration enforces:
--   * an UPLOAD stays an immutable artifact. No document row is merged,
--     rewritten or deleted here; every send keeps its bytes and its audit trail.
--   * DUPLICATES map onto one canonical document (byte-identical, tenant-scoped
--     via the existing documents(firm_id, client_id, checksum_sha256) index from
--     011) or one canonical CASE (same extracted vendor/date/total/currency when
--     the bytes differ, e.g. a re-photograph). The ASK anchors on that.
--   * an ACTIVE ask is unique per (firm, client, canonical_anchor, blocker_code,
--     generation) — never per upload id, never per raw hash alone, and never per
--     question text, because two drafters can word one question differently and
--     that must not mint two asks.
--
-- 'draft', 'open' and 'replied' are the live states; 'resolved' and 'cancelled'
-- are terminal history and may repeat freely, which is exactly what lets a
-- legitimate RE-ASK take the next generation rather than reopening closed
-- history.

-- 1. Identity columns. Nullable so every pre-existing row stays valid and the
--    partial index below simply does not cover rows we cannot key.
alter table client_evidence_requests
  add column if not exists canonical_anchor text,
  add column if not exists blocker_code text,
  add column if not exists generation integer not null default 0,
  -- The merge pointer. A duplicate ask is NEVER deleted: it is marked resolved
  -- and points at the survivor, so an already-issued Ref keeps resolving. The
  -- owner may have the losing Ref in his chat history; a reply quoting it must
  -- still land on the live question.
  add column if not exists merged_into text references client_evidence_requests(id) on delete set null;

create index if not exists client_evidence_requests_merged_into_idx
  on client_evidence_requests (merged_into)
  where merged_into is not null;

-- 2. Backfill the anchor for existing rows, strongest evidence first. This
--    mirrors buildCanonicalAnchor in server/donna/askIdentity.js exactly; the
--    two must not drift.
update client_evidence_requests
   set canonical_anchor = case
         when transaction_id is not null and transaction_id <> '' then 'transaction:' || transaction_id
         when review_item_id is not null and review_item_id <> '' then 'review_item:' || review_item_id
         when coalesce(request_payload->>'document_id', '') <> ''
           then 'document:' || (request_payload->>'document_id')
         else null
       end,
       blocker_code = coalesce(nullif(lower(regexp_replace(evidence_type, '[^a-zA-Z0-9]+', '_', 'g')), ''), 'supporting_document')
 where canonical_anchor is null;

-- 3. Repair before constraining (the 103 pattern). Any (firm, client, anchor,
--    blocker, generation) carrying more than one ACTIVE ask keeps its OLDEST —
--    the one whose Ref the owner saw first — and merges the rest into it.
--
--    Oldest, not newest, deliberately: 103 keeps the newest because a draft
--    supersedes, but an ASK is a question already put to a human. The first Ref
--    sent is the one most likely to be quoted in a reply, so it survives and the
--    later duplicates point at it. Neither Ref stops resolving either way,
--    because of merged_into.
with ranked as (
  select id,
         first_value(id) over (
           partition by firm_id, client_id, canonical_anchor, blocker_code, generation
           order by created_at asc, id asc
         ) as survivor_id,
         row_number() over (
           partition by firm_id, client_id, canonical_anchor, blocker_code, generation
           order by created_at asc, id asc
         ) as rn
    from client_evidence_requests
   where canonical_anchor is not null
     and status in ('draft', 'open', 'replied')
)
update client_evidence_requests r
   set status = 'resolved',
       merged_into = ranked.survivor_id,
       resolved_at = coalesce(r.resolved_at, now()),
       resolved_by = coalesce(r.resolved_by, 'system:ask-identity-merge'),
       request_payload = r.request_payload
         || jsonb_build_object('merged_into', ranked.survivor_id, 'merge_reason', 'duplicate_active_ask'),
       updated_at = now()
  from ranked
 where r.id = ranked.id
   and ranked.rn > 1;

-- 4. The refusal itself. Partial: only ACTIVE rows occupy an anchor, and only
--    rows we could key are covered.
create unique index if not exists client_evidence_requests_active_anchor_idx
  on client_evidence_requests (firm_id, client_id, canonical_anchor, blocker_code, generation)
  where canonical_anchor is not null and status in ('draft', 'open', 'replied');
