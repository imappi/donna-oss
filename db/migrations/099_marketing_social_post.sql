-- Marketing social posts — B1 of the social/buzz charter
-- (docs/design-donna-social-buzz-charter.md, §4 calls made 2026-07-24:
-- X first, Donna's own labeled handle @your_handle_here, B1 approved).
--
-- The email-drafts pattern applied to public posts: the strong model drafts,
-- every post rests 'proposed' under per-post approval, and NOTHING publishes
-- itself — Kari's manual copy-paste IS the publish, and the pasted post URL
-- is the receipt (no URL, no 'published'). Two-terminal-states: a post rests
-- on-Kari ('proposed', or 'approved' awaiting his paste) or terminal with a
-- receipt ('published'/'rejected'/'superseded').
--
-- The 'robotic_hi_ping' kind exists in the schema so B2 needs no migration,
-- but B1's writers mint ONLY 'diagnostic_content' — the ping lane is
-- design-first-gated (charter §6 B2).
--
-- Firm-agnostic (047's line): public-voice content only, no firm/client FK;
-- source_context must NEVER carry books data (charter §5).

create table if not exists marketing_social_post (
  id text primary key,
  platform text not null default 'x'
    check (platform in ('x')),
  kind text not null
    check (kind in ('diagnostic_content', 'robotic_hi_ping')),
  body text not null,
  -- Ping target (B2 only; null for content posts). Deterministically refused
  -- for diagnostic_content by the validator (no cold @-mentions in content).
  target_handle text,
  -- What idea/evidence seeded the post (aggregate/public only — never books
  -- data). Renders in the queue so Kari sees WHY Donna wrote it.
  source_context jsonb,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'published', 'rejected', 'superseded')),
  -- Provider-RETURNED model id (the receipt — CLAUDE.md rail).
  model text not null,
  supersedes text,
  proposed_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  -- The manual-publish receipt: the URL of the live post, pasted back by the
  -- human who published it. The writer refuses 'published' without it.
  published_url text,
  published_at timestamptz,
  published_by text
);

create index if not exists marketing_social_post_status_idx
  on marketing_social_post(status, proposed_at desc);

-- ── RLS-native (mirror 050/051/096/097) ─────────────────────────────────────
alter table marketing_social_post enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on marketing_social_post from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on marketing_social_post from authenticated;
  end if;
end $$;
