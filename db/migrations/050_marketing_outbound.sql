-- Marketing outbound spine — slice 1 of docs/design-donna-sales-marketing.md
-- (waitlist nurture loop: draft → Kari approves per-send → receipted send).
--
-- Doctrine (CLAUDE.md "Marketing sells by diagnosing" rail):
--   - Outbound is the most dangerous surface: every send is persisted,
--     attributed, and receipted; the suppression list is checked at the writer.
--   - Send authority is staged per channel (042's off→dry_run→shadow→canary→auto
--     vocabulary, pinned to clientConfig.CONFIG_STAGES in migrations.test.js).
--     No rows = 'off'. v1 ships with every channel at 'off': every send needs
--     an explicit per-send approval.
--   - Two-terminal-states for drafts: a draft rests only as 'proposed' (on
--     Kari) or terminal ('sent' with a receipt / 'rejected' / 'superseded').
--     'approved' is a transient hop while the send executes.
--   - Lead data stays firm-agnostic (047's line): nothing here references
--     firms/clients, and the browser roles are revoked (server-owned, RLS).

-- ── Suppression — checked before ANY send; a hit refuses at the writer ──────
create table if not exists marketing_suppression (
  id text primary key,
  email text not null,
  -- unsubscribed | bounced | complaint | manual (writer-normalized; no CHECK,
  -- mirroring 047's reason column — a new source must never reject a suppress).
  reason text not null default 'manual',
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

create unique index if not exists marketing_suppression_email_uniq
  on marketing_suppression(lower(email));

-- ── Drafts — LLM-generated proposals; the model id is part of the receipt ───
create table if not exists marketing_draft (
  id text primary key,
  lead_email text not null,
  -- The waitlist disqualify reason the copy was written for
  -- (inventory | restaurant | volume | other).
  segment text not null default 'other',
  channel text not null default 'waitlist_nurture',
  subject text not null,
  body text not null,
  -- Provider-RETURNED model id (CLAUDE.md "the model id is part of the
  -- receipt") — NOT the code default the caller requested.
  model text not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'superseded', 'sent')),
  -- Per-draft unsubscribe token; the public unsubscribe endpoint resolves it
  -- back to the lead and suppresses the address.
  unsubscribe_token text not null,
  supersedes text,
  send_error text,
  proposed_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz
);

create index if not exists marketing_draft_status_idx on marketing_draft(status);
create index if not exists marketing_draft_lead_idx on marketing_draft(lower(lead_email));
create unique index if not exists marketing_draft_unsub_token_uniq
  on marketing_draft(unsubscribe_token);

-- ── Send receipts — append-only; one per executed send ──────────────────────
create table if not exists marketing_send_receipt (
  id text primary key,
  draft_id text not null references marketing_draft(id),
  channel text not null,
  lead_email text not null,
  -- Who approved (operator attribution — email or token principal, never blank).
  approved_by text not null,
  -- Authority basis for the send: 'per_send' (v1's only value) or a
  -- 'stage:<name>' once Kari ever flips a channel stage.
  authority text not null default 'per_send',
  model text not null,
  transport_message_id text,
  rendered_subject text not null,
  rendered_body text not null,
  sent_at timestamptz not null default now()
);

create index if not exists marketing_send_receipt_draft_idx
  on marketing_send_receipt(draft_id);

-- ── Send authority — append-only stage history per channel ──────────────────
create table if not exists marketing_send_authority (
  id text primary key,
  channel text not null,
  stage text not null
    check (stage in ('off', 'dry_run', 'shadow', 'canary', 'auto')),
  changed_by text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists marketing_send_authority_channel_idx
  on marketing_send_authority(channel, created_at desc);

-- ── Waitlist lifecycle (extends 047) ─────────────────────────────────────────
-- new | active | on_kari | converted | suppressed | closed_unfit — enforced by
-- the writer module, no CHECK (047's posture: a public-adjacent table must
-- never reject a write over vocabulary drift).
alter table marketing_waitlist
  add column if not exists status text not null default 'new';
alter table marketing_waitlist
  add column if not exists last_touch_at timestamptz;

-- ── RLS-native (mirror 047) ──────────────────────────────────────────────────
-- Lead/outbound data is server-owned; the browser never queries it. ENABLE
-- (not FORCE) so the RLS-exempt owner role stays exempt; revoke the Supabase
-- browser roles. Guarded so a dev DB without those roles applies clean.
alter table marketing_suppression enable row level security;
alter table marketing_draft enable row level security;
alter table marketing_send_receipt enable row level security;
alter table marketing_send_authority enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on marketing_suppression from anon;
    revoke all on marketing_draft from anon;
    revoke all on marketing_send_receipt from anon;
    revoke all on marketing_send_authority from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on marketing_suppression from authenticated;
    revoke all on marketing_draft from authenticated;
    revoke all on marketing_send_receipt from authenticated;
    revoke all on marketing_send_authority from authenticated;
  end if;
end $$;
