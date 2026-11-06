-- Product feedback from inside the app — the sidebar "Feedback" entry and
-- its modal (Kari, 2026-08-05). Meta-product lane, not books: a note ABOUT
-- Donna (bug / idea / thought) from whoever is using her, landing where the
-- maker actually reads it. Firm-scoped (the submitter is an authenticated
-- firm principal) but deliberately NOT joined into any books surface —
-- feedback is about the product, never part of a ledger.
--
-- Two-terminal-states, applied to this lane: a row's resting state 'new'
-- IS the terminal "on Kari" — there is no intermediate queue to drain.
-- 'seen' / 'resolved' are his receipts, written when he acts.

create table if not exists user_feedback (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  kind text not null check (kind in ('bug', 'idea', 'note')),
  message text not null,
  -- Where the submitter was when they wrote it (screen, entity, shell,
  -- viewport) — allowlisted server-side; makes bug notes reproducible.
  context jsonb not null default '{}'::jsonb,
  -- Principal attribution (email, or principal type when tokened) — the
  -- actor-attribution rail applies to the meta-product lane too.
  submitted_by text,
  status text not null default 'new' check (status in ('new', 'seen', 'resolved')),
  created_at timestamptz not null default now()
);

create index if not exists user_feedback_firm_idx
  on user_feedback(firm_id, status, created_at);

-- RLS — server-only table (the API reaches it through the pooled service
-- role); browser roles get nothing. ENABLE + guarded revoke, never FORCE
-- (the 037/042/100 house pattern).
alter table user_feedback enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on user_feedback from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on user_feedback from authenticated;
  end if;
end $$;
