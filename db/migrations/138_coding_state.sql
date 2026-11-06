-- 138 — the ONE coding state (RT-16, docs/plan-2026-09-01-runtime-refactor-slices.md
-- §5 "Coding-state collapse"; audit F-14, the coding half).
--
-- Three coding vocabularies with no machine between them —
-- transaction_review_queue.review_state (004/008), payload.review_state on
-- the queue row AND the transaction, payload.ai_suggestion_status on the
-- transaction — collapse into one persisted column with an explicit machine
-- (server/donna/codingState.js, the ONE law; applyCodingTransition the ONE
-- writer):
--
--   transactions.coding_state        'proposed' | 'applied' | 'asked' | 'held'
--                                    | 'posted' | 'synced' | 'closed' | NULL
--   transactions.coding_state_as_of  when the state last changed
--
-- NULL is honest: nothing proposed, decided or asked for the line. The
-- review-queue row the transaction-intel pass mints is a CASE FILE (reason,
-- priority, ask anchors), never a coding state — so its review_state column
-- GOES (with its index and CHECK), and the payload labels go with it.
--
-- BACKFILL LAW (codingState.js codingStateFromLegacy — pinned on real PG by
-- codingStateBackfillPgLifecycle.test.js, every row of this table). Sources
-- per transaction: Q = the newest transaction-typed review-queue row (its
-- review_state column ∥ its payload.review_state, its status, whether its
-- payload carried a proposal), T = the transaction's payload.review_state,
-- R = payload.ai_suggestion_status, plus the markers the old read-time
-- derivation fell back to. Labels map onto the machine (suggested→proposed,
-- accepted/resolved→applied, asked_client/waiting→asked, held/posted/
-- synced/closed→themselves; R applied-family→applied, R 'suggested'→
-- proposed; a Xero sync marker→synced; a ledger journal→posted) and the
-- HIGHEST rank wins: closed(7) > synced(6) > posted(5) > held(4) > asked(3)
-- > applied(2) > proposed(1). The pre-138 readers merged the sources with
-- different precedences; the one thing they agreed on was that a more
-- advanced label anywhere meant the line had reached it.
--
--   # | labels found (Q col ∥ Q payload ∥ T ∥ R ∥ markers)            → coding_state
--   1 | any 'closed'                                                   → closed
--   2 | any 'synced', or xero_sync_status/xero_writeback_status
--     |   = 'synced', or xero_synced_at / synced_at present            → synced
--   3 | any 'posted', or ledger_status = 'posted', or a ledger_journal_id
--     |   with no other ledger_status                                  → posted
--   4 | any 'held'                                                     → held
--   5 | any 'asked_client' / 'waiting'                                 → asked
--   6 | any 'accepted' / 'resolved', or R ∈ {applied, alternative_applied,
--     |   reviewer_applied, auto_applied}                              → applied
--   7 | any 'suggested', or R = 'suggested', AND a proposal exists
--     |   (T.ai_suggestion / T.auto_categorize_source / R = 'suggested' /
--     |   Q.ai_suggestion / Q.auto_categorize_source / Q.proposed_account)  → proposed
--   8 | no label at all; status = 'needs_client' or
--     |   payload.transaction_status = 'needs_client' or
--     |   payload.evidence_request.status = 'open'                     → asked
--   9 | no label at all; Q.status ∈ {resolved, cancelled, closed, dismissed} → applied
--  10 | 'suggested' labels only, NO proposal anywhere (the case-file default) → NULL
--  11 | nothing                                                        → NULL
--
-- AFTER the backfill the legacy labels are STRIPPED (payload.review_state on
-- both tables; ai_suggestion_status = 'suggested' on both — the applied-
-- family values stay as the receipt of HOW a proposal was applied), so no
-- raw reader can resurrect a second copy of the state. The transactions
-- convergence trigger (137) gains coding_state in its column list: a coding
-- transition marks the row, and the settle re-derives the persisted verdict
-- in the same commit. The migration derives NO convergence verdict.
--
-- Idempotent: every step is `if not exists` / `drop … if exists`; the
-- backfill only touches rows never stamped (coding_state_as_of is null).

alter table transactions
  add column if not exists coding_state text,
  add column if not exists coding_state_as_of timestamptz;

alter table transactions drop constraint if exists transactions_coding_state_valid;
alter table transactions add constraint transactions_coding_state_valid
  check (coding_state is null or coding_state in ('proposed', 'applied', 'asked', 'held', 'posted', 'synced', 'closed'));

create index if not exists idx_transactions_coding_state
  on transactions (firm_id, client_id, coding_state);

-- ── Backfill: the mapping table above, in SQL ──────────────────────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_name = 'transaction_review_queue' and column_name = 'review_state'
  ) then
    with q as (
      select distinct on (q.firm_id, tx.transaction_id)
             q.firm_id,
             tx.transaction_id,
             q.review_state as q_state,
             q.payload->>'review_state' as q_payload_state,
             q.status as q_status,
             (q.payload ? 'ai_suggestion'
              or (q.payload->>'auto_categorize_source') is not null
              or (q.payload->>'proposed_account') is not null) as q_has_proposal
        from transaction_review_queue q
        cross join lateral (
          select coalesce(q.payload->>'transaction_id', case when q.item_type = 'transaction' then q.item_id end) as transaction_id
        ) tx
       where q.item_type is distinct from 'document_line'
         and q.item_type is distinct from 'document'
         and tx.transaction_id is not null
       order by q.firm_id, tx.transaction_id, q.updated_at desc nulls last, q.id desc
    ),
    mapped as (
      select t.firm_id, t.id,
             -- rank of every label found, highest wins; a 'proposed' label
             -- counts only when a proposal exists (row 7 vs row 10)
             (
               select max(rank) from (
                 values
                   (case when 'closed' in (q.q_state, q.q_payload_state, t.payload->>'review_state') then 7 end),
                   (case when 'synced' in (q.q_state, q.q_payload_state, t.payload->>'review_state')
                           or t.payload->>'xero_sync_status' = 'synced'
                           or t.payload->>'xero_writeback_status' = 'synced'
                           or (t.payload ? 'xero_synced_at') or (t.payload ? 'synced_at') then 6 end),
                   (case when 'posted' in (q.q_state, q.q_payload_state, t.payload->>'review_state')
                           or t.payload->>'ledger_status' = 'posted'
                           or (coalesce(t.payload->>'ledger_journal_id', '') <> '' and (t.payload->>'ledger_status') is null) then 5 end),
                   (case when 'held' in (q.q_state, q.q_payload_state, t.payload->>'review_state') then 4 end),
                   (case when q.q_state in ('asked_client', 'waiting')
                           or q.q_payload_state in ('asked_client', 'waiting')
                           or t.payload->>'review_state' in ('asked_client', 'waiting') then 3 end),
                   (case when q.q_state in ('accepted', 'resolved')
                           or q.q_payload_state in ('accepted', 'resolved')
                           or t.payload->>'review_state' in ('accepted', 'resolved')
                           or t.payload->>'ai_suggestion_status' in ('applied', 'alternative_applied', 'reviewer_applied', 'auto_applied') then 2 end),
                   (case when ('suggested' in (q.q_state, q.q_payload_state, t.payload->>'review_state')
                               or t.payload->>'ai_suggestion_status' = 'suggested')
                          and (
                            (t.payload ? 'ai_suggestion')
                            or (t.payload->>'auto_categorize_source') is not null
                            or t.payload->>'ai_suggestion_status' = 'suggested'
                            or coalesce(q.q_has_proposal, false)
                          ) then 1 end)
               ) as ranks(rank)
             ) as best_rank,
             (t.status = 'needs_client'
              or t.payload->>'transaction_status' = 'needs_client'
              or t.payload->'evidence_request'->>'status' = 'open') as needs_client,
             q.q_status
        from transactions t
        left join q on q.firm_id = t.firm_id and q.transaction_id = t.id
       where t.coding_state_as_of is null
    )
    update transactions t
       set coding_state = case m.best_rank
                            when 7 then 'closed'
                            when 6 then 'synced'
                            when 5 then 'posted'
                            when 4 then 'held'
                            when 3 then 'asked'
                            when 2 then 'applied'
                            when 1 then 'proposed'
                            else case
                              when m.needs_client then 'asked'
                              when m.q_status in ('resolved', 'cancelled', 'closed', 'dismissed') then 'applied'
                              else null
                            end
                          end,
           coding_state_as_of = now()
      from mapped m
     where t.firm_id = m.firm_id and t.id = m.id;
  end if;
end $$;

-- ── Strip the legacy labels: the column is the only copy ────────────────────
update transactions
   set payload = (payload - 'review_state' - 'reviewState')
 where payload ? 'review_state' or payload ? 'reviewState';

update transactions
   set payload = payload - 'ai_suggestion_status'
 where payload->>'ai_suggestion_status' = 'suggested';

update transaction_review_queue
   set payload = (payload - 'review_state' - 'reviewState')
 where payload ? 'review_state' or payload ? 'reviewState';

update transaction_review_queue
   set payload = payload - 'ai_suggestion_status'
 where payload->>'ai_suggestion_status' = 'suggested';

-- ── The queue's coding column goes ─────────────────────────────────────────
drop index if exists transaction_review_queue_firm_client_review_state_idx;
alter table transaction_review_queue drop constraint if exists transaction_review_queue_review_state_check;
alter table transaction_review_queue drop column if exists review_state;

-- ── A coding transition marks the row for the convergence settle (137) ──────
-- Same function, same shape; only the column list grows. The settle writes
-- only the convergence_* columns, which stay OUT of the list. Guarded on the
-- 137 function so a curated partial schema (the focused PG fixtures that
-- apply a handful of migrations) can take the column without the marks.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'convergence_mark_from_transaction') then
    execute 'drop trigger if exists transactions_convergence_mark on transactions';
    execute 'create trigger transactions_convergence_mark
      after insert or update of reconciliation_status, account_code, payload, status, category, money_in, money_out, coding_state
      on transactions
      for each row execute function convergence_mark_from_transaction()';
  end if;
end $$;
