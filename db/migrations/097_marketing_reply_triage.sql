-- Marketing reply triage — M4 of the closed-commercial-loop arc, as RESCOPED
-- 2026-07-24 (Kari): reply triage + drafted responses; booking machinery is a
-- non-goal (see design-donna-sales-marketing.md, M-arc dated calls).
--
-- The strong model reads a persisted inbound message (M3's `reply`/`unmatched`
-- rows) and writes a persisted VERDICT here: semantic class, summary,
-- recommended action, provider-returned model id (the receipt). Verdicts are
-- APPEND-ONLY — a re-triage is a new row, latest wins (render-the-persisted-
-- verdict reads the newest per message). The deterministic Keep layer decides
-- what the verdict is allowed to cause (escalate-only classes never draft;
-- snoozes are capped; suppression goes through the sanctioned writer) and
-- receipts what it DID in applied_actions on the same row.
--
-- Firm-agnostic (047's line): lead-facing data only, no firm/client FK.

create table if not exists marketing_reply_triage (
  id text primary key,
  inbound_message_id text not null references marketing_inbound_message(id),
  -- Semantic vocabulary (writer-enforced + CHECK; pinned to replyTriage.js).
  semantic_class text not null
    check (semantic_class in (
      'positive_interest', 'question', 'objection', 'referral', 'not_now',
      'wrong_person', 'hostile_or_sensitive', 'investor_or_press', 'other'
    )),
  confidence text not null
    check (confidence in ('low', 'medium', 'high')),
  -- One-two lines for the UI: what this reply says, in Donna's words.
  summary text not null,
  recommended_action text not null
    check (recommended_action in (
      'draft_reply', 'escalate_to_kari', 'record_only', 'suppress'
    )),
  -- Class-specific extractions (deterministically bounded by the writer).
  suggested_snooze_days integer,
  referred_contact text,
  -- What the Keep layer actually DID about the verdict (the receipt half):
  -- e.g. [{"action":"mint_draft","draft_id":"..."},{"action":"snooze","days":30}]
  applied_actions jsonb not null default '[]'::jsonb,
  -- The response draft this verdict minted, when it did (stays 'proposed'
  -- on marketing_draft; per-send approval is the only send authority).
  draft_id text references marketing_draft(id),
  error text,
  -- Provider-RETURNED model id (CLAUDE.md: the model id is part of the receipt).
  model text not null,
  created_at timestamptz not null default now()
);

create index if not exists marketing_reply_triage_message_idx
  on marketing_reply_triage(inbound_message_id, created_at desc);

create index if not exists marketing_reply_triage_class_idx
  on marketing_reply_triage(semantic_class, created_at desc);

-- Response-draft linkage: a reply draft knows which inbound message it answers
-- (threading headers render from the inbound row's stored RFC fields) and, when
-- the sender matched a prospect, which prospect the conversation belongs to.
alter table marketing_draft
  add column if not exists inbound_message_id text references marketing_inbound_message(id);
alter table marketing_draft
  add column if not exists prospect_id text references marketing_prospect(id);

create index if not exists marketing_draft_inbound_message_idx
  on marketing_draft(inbound_message_id)
  where inbound_message_id is not null;

-- ── RLS-native (mirror 050/051/096) ─────────────────────────────────────────
alter table marketing_reply_triage enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on marketing_reply_triage from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on marketing_reply_triage from authenticated;
  end if;
end $$;
