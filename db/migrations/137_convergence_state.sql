-- 137 — persisted convergence state (RT-13,
-- docs/plan-2026-09-01-runtime-refactor-slices.md §5; audit F-14 + the
-- writer-side half of F-08).
--
-- The two-terminal law (CLAUDE.md, the FIRST principle) was a READ-TIME
-- projection over ~10 fields spread across transactions, the review queue,
-- matches, evaluations and asks — plus a hand-mirrored SQL hanging count in
-- parseDocumentsDb.js kept in lock-step by comment. Every writer decided on
-- its own whether a row now rests. This migration persists the verdict:
--
--   transactions.convergence_state  'auto_reconciled' | 'on_owner' | 'hanging'
--   transactions.convergence_reason the projection's reason key
--   transactions.convergence_as_of  when the row was last derived
--   (the same three columns on documents; NULL = not a reconcile row —
--   an in-flight parse, a matched document, a statement, a collapsed
--   duplicate — never a fabricated terminal)
--
-- The DERIVATION STAYS IN JS. server/donna/reconcileConvergenceState.js's
-- deriveConvergenceState is the one law, and its persistence section
-- (applyConvergenceState) is the only writer of these columns. This
-- migration computes NOTHING about convergence; what it adds on the write
-- plane is a MARK: AFTER triggers on the six input tables record which
-- transaction / document owes a re-derivation (`convergence_marks`, keyed
-- on the writing transaction's xid). The connection hook in firmDb.js's
-- withFirmDbClient settles a transaction's marks right before its COMMIT
-- and sweeps committed marks after every connection use; the nightly
-- convergence-drift-nightly function recomputes every row and reports
-- drift as a receipt, never rewriting. This is the 131 fence's shape — SQL
-- records the fact, JS keeps the policy — chosen because the inputs are
-- written from ~40 sites across ~20 modules and the write-through has to
-- be structural to be honest.
--
-- Idempotent: every step is `if not exists` / `drop … if exists` / `create
-- or replace`, so a re-run on an already-migrated database is a no-op.

alter table transactions
  add column if not exists convergence_state text,
  add column if not exists convergence_reason text,
  add column if not exists convergence_as_of timestamptz;

alter table transactions drop constraint if exists transactions_convergence_state_valid;
alter table transactions add constraint transactions_convergence_state_valid
  check (convergence_state is null or convergence_state in ('auto_reconciled', 'on_owner', 'hanging'));

alter table documents
  add column if not exists convergence_state text,
  add column if not exists convergence_reason text,
  add column if not exists convergence_as_of timestamptz;

alter table documents drop constraint if exists documents_convergence_state_valid;
alter table documents add constraint documents_convergence_state_valid
  check (convergence_state is null or convergence_state in ('auto_reconciled', 'on_owner', 'hanging'));

create index if not exists idx_transactions_convergence_state
  on transactions (firm_id, client_id, convergence_state);
create index if not exists idx_documents_convergence_state
  on documents (firm_id, client_id, convergence_state);

-- The marks: one row per input change, consumed by the settle that
-- re-derives the target. Transient by construction (a converged book has
-- an empty table); `marked_xid` is what lets the commit-time settle claim
-- exactly the marks its own transaction wrote.
create table if not exists convergence_marks (
  id bigserial primary key,
  firm_id text not null,
  client_id text,
  target_type text not null check (target_type in ('transaction', 'document')),
  target_id text not null,
  source text not null,
  marked_at timestamptz not null default now(),
  marked_xid xid8 not null default pg_current_xact_id()
);
create index if not exists idx_convergence_marks_xid on convergence_marks (marked_xid);
create index if not exists idx_convergence_marks_firm on convergence_marks (firm_id, client_id, id);

-- Post-032 lockdown: the marks are runtime-internal (the settle claims them
-- through the service connection); no anon / authenticated access.
alter table convergence_marks enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on convergence_marks from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on convergence_marks from authenticated;
  end if;
end $$;

create or replace function convergence_mark(
  p_firm_id text, p_client_id text, p_target_type text, p_target_id text, p_source text
) returns void
  language plpgsql as $$
begin
  if p_firm_id is null or p_target_id is null or p_target_type is null then
    return;
  end if;
  insert into convergence_marks (firm_id, client_id, target_type, target_id, source)
  values (p_firm_id, p_client_id, p_target_type, p_target_id, p_source);
end;
$$;

-- transactions: the row's own axes (reconciliation_status, the coded
-- account, the payload that carries ai_suggestion_status / review_state /
-- account_name). The settle writes only the convergence_* columns, which
-- are deliberately NOT in this list, so it never re-marks its own write.
create or replace function convergence_mark_from_transaction() returns trigger
  language plpgsql as $$
begin
  perform convergence_mark(new.firm_id, new.client_id, 'transaction', new.id, 'transactions');
  return null;
end;
$$;
drop trigger if exists transactions_convergence_mark on transactions;
create trigger transactions_convergence_mark
  after insert or update of reconciliation_status, account_code, payload, status, category, money_in, money_out
  on transactions
  for each row execute function convergence_mark_from_transaction();

-- documents: parse lifecycle, duplicate identity, the amount, the payload
-- (no_line_disposition holder, parse_hold).
create or replace function convergence_mark_from_document() returns trigger
  language plpgsql as $$
begin
  perform convergence_mark(new.firm_id, new.client_id, 'document', new.id, 'documents');
  return null;
end;
$$;
drop trigger if exists documents_convergence_mark on documents;
create trigger documents_convergence_mark
  after insert or update of parse_status, parse_error, parse_summary, duplicate_of, total_amount,
    document_type, payload, status, payment_status
  on documents
  for each row execute function convergence_mark_from_document();

-- reconciliation_matches: the bank line (cascade verdict, the INV-4 settled
-- set) and the matched document (a live match takes it out of the no-line
-- population).
create or replace function convergence_mark_from_match() returns trigger
  language plpgsql as $$
declare
  r reconciliation_matches%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  perform convergence_mark(r.firm_id, r.client_id, 'transaction', r.bank_transaction_id, 'reconciliation_matches');
  if r.matched_object_type is distinct from 'bank_line' and r.matched_object_id is not null then
    perform convergence_mark(r.firm_id, r.client_id, 'document', r.matched_object_id, 'reconciliation_matches');
  end if;
  return null;
end;
$$;
drop trigger if exists reconciliation_matches_convergence_mark on reconciliation_matches;
create trigger reconciliation_matches_convergence_mark
  after insert or update or delete on reconciliation_matches
  for each row execute function convergence_mark_from_match();

-- reconciliation_evaluations: the bank-line and document disposition
-- verdicts (and the 131 supersede, which lands here too).
create or replace function convergence_mark_from_evaluation() returns trigger
  language plpgsql as $$
declare
  r reconciliation_evaluations%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.target_type in ('transaction', 'document') then
    perform convergence_mark(r.firm_id, r.client_id, r.target_type, r.target_id, 'reconciliation_evaluations');
  end if;
  return null;
end;
$$;
drop trigger if exists reconciliation_evaluations_convergence_mark on reconciliation_evaluations;
create trigger reconciliation_evaluations_convergence_mark
  after insert or update or delete on reconciliation_evaluations
  for each row execute function convergence_mark_from_evaluation();

-- client_evidence_requests: the line the ask is on, every line a
-- consolidated statement ask anchors, the document a doc-anchored ask
-- names, and the review row an ask is anchored on (RT-10's totals ask).
create or replace function convergence_mark_from_ask() returns trigger
  language plpgsql as $$
declare
  r client_evidence_requests%rowtype;
  anchored text;
  review_tx text;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.transaction_id is not null then
    perform convergence_mark(r.firm_id, r.client_id, 'transaction', r.transaction_id, 'client_evidence_requests');
  end if;
  if r.request_payload is not null and jsonb_typeof(r.request_payload->'anchor_transaction_ids') = 'array' then
    for anchored in select jsonb_array_elements_text(r.request_payload->'anchor_transaction_ids') loop
      perform convergence_mark(r.firm_id, r.client_id, 'transaction', anchored, 'client_evidence_requests');
    end loop;
  end if;
  if r.request_payload is not null and (r.request_payload->>'document_id') is not null then
    perform convergence_mark(r.firm_id, r.client_id, 'document', r.request_payload->>'document_id', 'client_evidence_requests');
  end if;
  if r.review_item_id is not null then
    select coalesce(q.payload->>'transaction_id', q.item_id) into review_tx
      from transaction_review_queue q
     where q.id = r.review_item_id and q.firm_id = r.firm_id
       and q.item_type is distinct from 'document_line';
    if review_tx is not null then
      perform convergence_mark(r.firm_id, r.client_id, 'transaction', review_tx, 'client_evidence_requests');
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists client_evidence_requests_convergence_mark on client_evidence_requests;
create trigger client_evidence_requests_convergence_mark
  after insert or update or delete on client_evidence_requests
  for each row execute function convergence_mark_from_ask();

-- transaction_review_queue: the coding lifecycle row (review_state) that
-- represents its transaction in the feed; a document-anchored row names its
-- document.
create or replace function convergence_mark_from_review_item() returns trigger
  language plpgsql as $$
declare
  r transaction_review_queue%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.item_type is distinct from 'document_line' then
    perform convergence_mark(r.firm_id, r.client_id, 'transaction', coalesce(r.payload->>'transaction_id', r.item_id), 'transaction_review_queue');
  end if;
  if r.payload is not null and (r.payload->>'document_id') is not null then
    perform convergence_mark(r.firm_id, r.client_id, 'document', r.payload->>'document_id', 'transaction_review_queue');
  end if;
  return null;
end;
$$;
drop trigger if exists transaction_review_queue_convergence_mark on transaction_review_queue;
create trigger transaction_review_queue_convergence_mark
  after insert or update or delete on transaction_review_queue
  for each row execute function convergence_mark_from_review_item();

-- loop_goal_reports: the reconciliation GoalReport outranks the legacy
-- reconciliation_status column in every feed projection, so a new report on
-- a transaction's reconciliation case re-derives the line.
create or replace function convergence_mark_from_goal_report() returns trigger
  language plpgsql as $$
declare
  c record;
begin
  select firm_id, client_id, primary_object_type, primary_object_id into c
    from bookkeeping_cases where id = new.case_id;
  if found and c.primary_object_type = 'transaction' then
    perform convergence_mark(c.firm_id, c.client_id, 'transaction', c.primary_object_id, 'loop_goal_reports');
  end if;
  return null;
end;
$$;
drop trigger if exists loop_goal_reports_convergence_mark on loop_goal_reports;
create trigger loop_goal_reports_convergence_mark
  after insert on loop_goal_reports
  for each row execute function convergence_mark_from_goal_report();

-- Backfill: every existing row owes its first derivation. One mark each;
-- the first connection uses after deploy settle them in bounded passes
-- (the columns read NULL until then — "never derived", not a verdict).
insert into convergence_marks (firm_id, client_id, target_type, target_id, source)
select firm_id, client_id, 'transaction', id, 'migration_137'
  from transactions
 where convergence_as_of is null;
insert into convergence_marks (firm_id, client_id, target_type, target_id, source)
select firm_id, client_id, 'document', id, 'migration_137'
  from documents
 where convergence_as_of is null;
