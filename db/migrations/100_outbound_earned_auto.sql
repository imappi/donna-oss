-- 100 — The D1 earned-auto ladder (outbound actions; execution plan §4 D1,
-- RESOLVED Kari 2026-07-24: decide-and-notify with an EARNED-AUTO ladder).
--
-- One row per (firm, client, action_type): the per-action-type × per-client
-- clean-send counter behind flag graduation. The ladder NEVER opens a third
-- config path — graduation and suspension both write through the EXISTING
-- audited config-plane stage writer (clientConfig.setClientFlagStage), which
-- still refuses 'auto' for any flag in AUTO_FORBIDDEN_FLAGS. A ladder that
-- reaches its target while the flag's terminal is still vetoed rests at
-- state='earned' — recorded, digest-visible, ON KARI (its two-terminal home)
-- — and graduates automatically only after the veto is lifted by a deliberate
-- PR removing the flag from AUTO_FORBIDDEN_FLAGS.
--
-- The counted set (defined here, enforced in earnedAutoLadder.js — do not
-- shade it):
--   clean send  = an EXECUTED action whose send receipt cites
--                 'per_send_owner_approval' (the owner approved the exact
--                 draft and it went out unchanged).
--   correction  = an owner (non-system) decline of a held draft, an owner
--                 cancel of a scheduled/approved action, an owner edit of a
--                 held draft (recorder reserved — no edit surface yet), an
--                 owner reply-if-wrong on a notified send (recorder reserved
--                 for the reply surfaces), or an owner post-send reversal
--                 (recorder reserved). A correction resets clean_streak to 0;
--                 after graduation it also suspends the ladder-minted 'auto'
--                 row back to 'canary' (the 040/095 auto-suspend-on-correction
--                 pattern) — a manually-staged 'auto' row is never touched.
--
-- clean_target is the config-plane tuning value for N (default in code:
-- DEFAULT_CLEAN_SEND_TARGET, in the 5–10 band). Per-row override via the
-- audited setter — never an env pair (the rollout-flags rail).
--
-- Everything dies with its client via the client_id FK cascade (090/091
-- convention). RLS-native.

create table if not exists outbound_earned_auto (
  id text primary key,
  firm_id text not null references firms(id) on delete cascade,
  client_id text not null references clients(id) on delete cascade,
  -- The closed outbound action-type enum (091's vocabulary).
  action_type text not null
    check (action_type in ('issue_invoice', 'send_quote', 'send_receivable_reminder', 'send_payable_notice')),
  clean_streak integer not null default 0 check (clean_streak >= 0),
  total_clean integer not null default 0 check (total_clean >= 0),
  corrections_count integer not null default 0 check (corrections_count >= 0),
  -- Per-client-and-type override of the clean-send target N; null = the code
  -- default (DEFAULT_CLEAN_SEND_TARGET).
  clean_target integer check (clean_target is null or clean_target >= 1),
  -- counting → earned (target reached, terminal still vetoed — rests on Kari)
  -- → graduated (stage 'auto' written through the audited writer). A counted
  -- correction returns any state to counting (and suspends a ladder-minted
  -- 'auto' row).
  state text not null default 'counting'
    check (state in ('counting', 'earned', 'graduated')),
  earned_at timestamptz,
  graduated_at timestamptz,
  last_clean_receipt_id text,
  last_correction jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists outbound_earned_auto_key_idx
  on outbound_earned_auto(firm_id, client_id, action_type);
create index if not exists outbound_earned_auto_state_idx
  on outbound_earned_auto(firm_id, client_id, state);

-- The graduation writes carry honest provenance: 'earned_auto' joins the 042
-- source vocabulary (used by BOTH the graduation write and the post-correction
-- suspension write). Widened here, additively — the 042 file is history.
alter table client_capability_config
  drop constraint if exists client_capability_config_source_check;
alter table client_capability_config
  add constraint client_capability_config_source_check
  check (source in ('default', 'cohort', 'manual', 'emergency_override', 'earned_auto'));

-- ── RLS-native (mirror 090–095) ──────────────────────────────────────────────
alter table outbound_earned_auto enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on outbound_earned_auto from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on outbound_earned_auto from authenticated;
  end if;
end $$;
